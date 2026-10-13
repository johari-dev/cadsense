// @effect-diagnostics nodeBuiltinImport:off
// The SolidWorks fixtures are generated with node:zlib, the same codec SolidWorks writes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  LocalCadError,
  OnshapeDocumentId,
  OnshapeProjectSource,
  ProjectId,
  type OrchestrationProjectShell,
} from "@cadsense/contracts";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OnshapeCadRoots } from "../onshape/OnshapeCadRoots.ts";
import { OnshapeSnapshotAcquisition } from "../onshape/OnshapeSnapshotAcquisition.ts";
import { CadDiskSpace, CadSnapshotStore, make as makeStore } from "../cad/CadSnapshotStore.ts";
import { pruneCadSnapshots } from "../cad/CadSnapshotRetention.ts";
import {
  CadProjectQuiescence,
  CadUserOperations,
  layer as cadUserOperationsLayer,
} from "../cad/CadUserOperations.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LocalCadImport from "./LocalCadImport.ts";
import { LocalCadProjects, layer as localCadProjectsLayer } from "./LocalCadProjects.ts";
import * as SolidWorksBridge from "./SolidWorksBridge.ts";
import { planSolidWorksFiles, readSolidWorksReferences } from "./SolidWorksFiles.ts";

const FIXTURE = new URL("./testFixtures/dm1-id-214.stp", import.meta.url).pathname;
const onshapeSource = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  workspaceType: "w",
  workspaceId: "b".repeat(24),
  configuration: "",
});
const unused = () => Effect.die("Onshape is not used by local CAD projects");

const engine = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-local-cad-" })),
  Layer.provideMerge(NodeServices.layer),
);
const store = Layer.effect(CadSnapshotStore, makeStore).pipe(
  Layer.provide(Layer.succeed(CadDiskSpace, { availableBytes: () => Effect.succeed(10 ** 12) })),
);
const onshape = Layer.mergeAll(
  Layer.succeed(OnshapeCadRoots, { discover: unused }),
  Layer.succeed(OnshapeSnapshotAcquisition, { acquire: unused }),
  // Native agent shutdown is not under test; no agent runs exist here.
  Layer.succeed(CadProjectQuiescence, { confirm: () => Effect.void }),
);

/** Everything but the SolidWorks host, which the two suites below choose. */
const withSolidWorks = (solidWorks: Layer.Layer<SolidWorksBridge.SolidWorks>) =>
  localCadProjectsLayer.pipe(
    Layer.provideMerge(cadUserOperationsLayer),
    Layer.provideMerge(LocalCadImport.layer),
    Layer.provideMerge(solidWorks),
    Layer.provideMerge(store),
    Layer.provideMerge(onshape),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(engine),
  );
// The real bridge, which finds SolidWorks on this machine or its Windows host when there is one.
const layer = withSolidWorks(SolidWorksBridge.layer);
// The real bridge on a machine without Windows, so without SolidWorks.
const noSolidWorksLayer = withSolidWorks(
  Layer.effect(SolidWorksBridge.SolidWorks, SolidWorksBridge.make(null)),
);
/**
 * A SolidWorks 2015+ file: one raw-DEFLATE block per entry, each behind the 26-byte header and
 * nibble-swapped name SolidWorks writes. Enough for the reader, which only needs the file list.
 */
const solidWorksFile = (blocks: Readonly<Record<string, string>>) =>
  Buffer.concat(
    Object.entries(blocks).flatMap(([name, text]) => {
      const plain = Buffer.from(text, "utf8");
      const packed = NodeZlib.deflateRawSync(plain);
      const header = Buffer.alloc(26);
      header.set([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
      header.writeUInt32LE(NodeZlib.crc32(plain), 10);
      header.writeUInt32LE(packed.length, 14);
      header.writeUInt32LE(plain.length, 18);
      header.writeUInt32LE(name.length, 22);
      const swapped = Buffer.from(name, "latin1").map((byte) => ((byte >> 4) | (byte << 4)) & 0xff);
      return [header, swapped, packed];
    }),
  );

/** An assembly's file list: the assembly first, then the parts it uses, as SolidWorks saves it. */
const fileList = (assembly: string, parts: readonly string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swHeader>${[assembly, ...parts]
    .map(
      (path, index) =>
        `<swFile id="f${index}" swDocType="${index === 0 ? "ASSEMBLY" : "PART"}" swPath="${path}"/>`,
    )
    .join(
      "",
    )}</swHeader><swModelList><swModel id="m0" swFileRef="f0"/></swModelList><swConfigurationList><swConfiguration id="c0" swModelRef="m0"/></swConfigurationList></swSolidWorks>`;

/**
 * A folder of generated SolidWorks files. `Frame v2.SLDASM` was saved as `Frame.SLDASM` and uses
 * Bracket (beside it), Plate (missing), and a 3D Interconnect STEP insert. `Panel.SLDASM` uses only
 * Bracket. `Legacy.SLDASM` has no file list, like a pre-2015 file.
 */
const makeSolidWorksFolder = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-solidworks-" });
  yield* fs.makeDirectory(path.join(root, "cad"), { recursive: true });
  const write = (name: string, bytes: Uint8Array) => fs.writeFile(path.join(root, name), bytes);
  yield* write(
    "cad/Frame v2.SLDASM",
    solidWorksFile({
      PreviewPNG: "not a png",
      "swXmlContents/COMPINSTANCETREE": fileList("H:\\Robot\\Frame.SLDASM", [
        "H:\\Robot\\Bracket.SLDPRT",
        "H:\\Robot\\Plate &amp; Rib.SLDPRT",
        "C:\\Users\\me\\AppData\\Local\\Temp\\swx42\\IC~~\\Vendor Bolt.STEP.SLDPRT",
      ]),
    }),
  );
  yield* write(
    "cad/Panel.SLDASM",
    solidWorksFile({
      "swXmlContents/COMPINSTANCETREE": fileList("H:\\Robot\\Panel.SLDASM", [
        "H:\\Robot\\BRACKET.sldprt",
      ]),
    }),
  );
  yield* write("cad/Bracket.SLDPRT", solidWorksFile({ "Contents/Config-0-Partition": "part" }));
  yield* write("cad/Legacy.SLDASM", new TextEncoder().encode("not a 2015 or later file"));
  yield* write(
    "cad/Rig.SLDASM",
    solidWorksFile({
      "swXmlContents/COMPINSTANCETREE": fileList(
        "H:\\Robot\\Rig.SLDASM",
        Array.from(
          { length: 8 },
          (_, index) => `H:\\Robot\\Vendor bracket with a long name ${index}.SLDPRT`,
        ),
      ),
    }),
  );
  return root;
});
/**
 * A folder with the fixture under models/, a corrupt STEP file, a text file, and STEP files in
 * directories the scan must skip.
 */
const makeFolder = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-folder-" });
  for (const dir of ["models", "parts", "node_modules/pkg", ".git"])
    yield* fs.makeDirectory(path.join(root, dir), { recursive: true });
  yield* fs.copyFile(FIXTURE, path.join(root, "models/dm1.step"));
  yield* fs.writeFileString(path.join(root, "parts/broken.STP"), "ISO-10303-21;\nnot a model\n");
  yield* fs.writeFileString(path.join(root, "notes.txt"), "not CAD");
  yield* fs.copyFile(FIXTURE, path.join(root, "node_modules/pkg/vendored.step"));
  yield* fs.copyFile(FIXTURE, path.join(root, ".git/object.step"));
  return root;
});

const getProject = Effect.fn(function* (projectId: ProjectId) {
  const query = yield* ProjectionSnapshotQuery;
  return Option.getOrThrow(yield* query.getProjectShellById(projectId));
});

/**
 * Waits for the project's CAD operation to end; `operationId` pins which one when known. Up to
 * ten minutes, since a SolidWorks conversion includes starting SolidWorks.
 */
const settle = Effect.fn(function* (projectId: ProjectId, operationId?: string) {
  for (let attempt = 0; attempt < 12_000; attempt++) {
    const project = yield* getProject(projectId);
    const outcome = project.cad?.lastOutcome;
    if (
      !project.cad?.operation &&
      outcome &&
      (operationId === undefined || outcome.operationId === operationId)
    )
      return project;
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die("CAD operation did not settle");
});

const catalogRoot = (project: OrchestrationProjectShell, name: string) => {
  const root = project.cad?.catalog?.roots.find((entry) => entry.name === name);
  assert.isDefined(root, `catalog has ${name}`);
  return root!;
};

const sync = Effect.fn(function* (project: OrchestrationProjectShell, name: string) {
  const operations = yield* CadUserOperations;
  const root = catalogRoot(project, name);
  const { operationId } = yield* operations.start({
    projectId: project.id,
    kind: "sync",
    root: { elementId: root.elementId, kind: root.kind, configuration: "default" },
  });
  return yield* settle(project.id, operationId);
});

const createError = Effect.fn(function* (workspaceRoot: string, filePath: string) {
  const projects = yield* LocalCadProjects;
  const error = yield* Effect.flip(
    projects.create({
      projectId: ProjectId.make(`local-cad-rejected-${filePath.length}`),
      title: "Rejected",
      workspaceRoot,
      filePath,
    }),
  );
  assert.instanceOf(error, LocalCadError);
  return error.reason;
});

/** A folder project with no CAD linked, as the CAD panel's file prompt sees it. */
const makeFolderProject = Effect.fn(function* (projectId: ProjectId, workspaceRoot: string) {
  yield* (yield* OrchestrationEngineService).dispatch({
    type: "project.create",
    commandId: CommandId.make(`create-${projectId}`),
    projectId,
    title: "Folder",
    workspaceRoot,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
});

const setFileError = Effect.fn(function* (projectId: ProjectId, filePath: string) {
  const error = yield* Effect.flip((yield* LocalCadProjects).setFile({ projectId, filePath }));
  assert.instanceOf(error, LocalCadError);
  return error.reason;
});

// Real clock: imports run in a worker thread and the tests poll for their outcome.
it.layer(layer, { timeout: 120_000, excludeTestServices: true })("local CAD projects", (it) => {
  it.effect("lists only STEP and IGES files outside skipped directories", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const result = yield* (yield* LocalCadProjects).listFiles({ workspaceRoot: root });
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        ["models/dm1.step", "parts/broken.STP"],
      );
      assert.strictEqual(result.truncated, false);
      assert.isAbove(result.files[0]!.byteLength, 80_000);
    }).pipe(Effect.scoped),
  );

  it.effect("creates a project and imports the chosen file with its assembly structure", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-create");
      const created = yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      assert.strictEqual(created.projectId, projectId);

      const project = yield* settle(projectId);
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.onshapeSource, undefined);
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      // The sync rescanned the folder, so other files are selectable without a refresh.
      assert.deepStrictEqual(
        project.cad?.catalog?.roots.map((entry) => entry.name),
        ["models/dm1.step", "parts/broken.STP"],
      );
      assert.strictEqual(
        project.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(project, "models/dm1.step").elementId,
      );
      const synced = project.cad?.roots ?? [];
      assert.strictEqual(synced.length, 1);
      assert.isNotNull(synced[0]!.current);

      const manifest = yield* (yield* CadSnapshotStore).load(synced[0]!.current!.snapshotId);
      assert.strictEqual(manifest.root.host, "local");
      assert.strictEqual(manifest.parts.length, 7);
      assert.strictEqual(manifest.assets.length, 7);
      const names = manifest.nodes.map((node) => node.occurrencePath.at(-1) ?? node.name).sort();
      assert.deepStrictEqual(names, [
        "bolt",
        "bolt#2",
        "bolt#3",
        "dm1",
        "dm1.step",
        "l-bracket",
        "nut",
        "nut#2",
        "nut#3",
      ]);
      // Parts carry the STEP product name and color for the hierarchy and find-parts.
      const bolt = manifest.parts.find((part) => part.metadata?.name === "bolt");
      assert.isDefined(bolt);
      assert.isNotNull(bolt!.metadata?.appearance ?? null);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the comment revision for an unchanged file and node IDs across a re-export",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshots = yield* CadSnapshotStore;
        const root = yield* makeFolder();
        const projectId = ProjectId.make("local-cad-resync");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Bracket",
          workspaceRoot: root,
          filePath: "models/dm1.step",
        });
        const first = yield* settle(projectId);
        const firstManifest = yield* snapshots.load(first.cad!.roots[0]!.current!.snapshotId);

        const unchanged = yield* sync(first, "models/dm1.step");
        const unchangedRoot = unchanged.cad!.roots[0]!;
        assert.notStrictEqual(unchangedRoot.current!.snapshotId, firstManifest.snapshotId);
        assert.strictEqual(unchangedRoot.rollback?.snapshotId, firstManifest.snapshotId);
        const unchangedManifest = yield* snapshots.load(unchangedRoot.current!.snapshotId);
        assert.strictEqual(
          cadCommentModelDescriptor(unchangedManifest),
          cadCommentModelDescriptor(firstManifest),
        );

        // A re-export with a new header timestamp is a new revision of the same structure.
        const file = path.join(root, "models/dm1.step");
        const text = yield* fs.readFileString(file);
        yield* fs.writeFileString(file, text.replace("FILE_NAME(", "FILE_NAME( /* re-export */ "));
        const changed = yield* sync(unchanged, "models/dm1.step");
        const changedManifest = yield* snapshots.load(changed.cad!.roots[0]!.current!.snapshotId);
        assert.notStrictEqual(
          changedManifest.root.microversionId,
          firstManifest.root.microversionId,
        );
        assert.strictEqual(changedManifest.rootId, firstManifest.rootId);
        assert.deepStrictEqual(
          changedManifest.nodes.map((node) => node.id).sort(),
          firstManifest.nodes.map((node) => node.id).sort(),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("fails a corrupt or missing file without touching the current snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-failures");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      const ready = yield* settle(projectId);
      const current = ready.cad!.roots[0]!.current!.snapshotId;

      const corrupt = yield* sync(ready, "parts/broken.STP");
      assert.strictEqual(corrupt.cad?.lastOutcome?.status, "failed");
      assert.match(corrupt.cad?.lastOutcome?.reason ?? "", /could not read/i);
      const brokenRoot = corrupt.cad!.roots.find(
        (entry) => entry.elementId === catalogRoot(ready, "parts/broken.STP").elementId,
      );
      assert.strictEqual(brokenRoot?.current, null);

      yield* fs.remove(path.join(root, "models/dm1.step"));
      const missing = yield* sync(corrupt, "models/dm1.step");
      assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
      assert.match(missing.cad?.lastOutcome?.reason ?? "", /no longer in the project folder/i);
      assert.strictEqual(missing.cad!.roots[0]!.current?.snapshotId, current);
    }).pipe(Effect.scoped),
  );

  it.effect("lists the folder after a failed first import so another file can be chosen", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-failed-first-import");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Broken",
        workspaceRoot: root,
        filePath: "parts/broken.STP",
      });
      const failed = yield* settle(projectId);
      assert.strictEqual(failed.cad?.lastOutcome?.status, "failed");
      assert.strictEqual(failed.cad?.roots[0]?.current, null);
      assert.strictEqual(
        failed.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(failed, "parts/broken.STP").elementId,
      );
      const recovered = yield* sync(failed, "models/dm1.step");
      assert.strictEqual(recovered.cad?.lastOutcome?.status, "succeeded");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects paths outside the folder, unsupported files, and missing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-outside-" });
      yield* fs.copyFile(FIXTURE, path.join(outside, "outside.step"));
      yield* fs.symlink(path.join(outside, "outside.step"), path.join(root, "models/link.step"));

      assert.strictEqual(yield* createError(root, "../outside.step"), "outside-folder");
      assert.strictEqual(
        yield* createError(root, path.join(outside, "outside.step")),
        "outside-folder",
      );
      assert.strictEqual(yield* createError(root, "models/link.step"), "outside-folder");
      assert.strictEqual(yield* createError(root, "notes.txt"), "unsupported-file");
      assert.strictEqual(yield* createError(root, "models/missing.step"), "file-not-found");
      assert.strictEqual(yield* createError(path.join(root, "nope"), "a.step"), "folder-not-found");
      const projects = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      assert.isFalse(projects.projects.some((project) => project.title === "Rejected"));
    }).pipe(Effect.scoped),
  );

  it.effect("attaches to an existing folder project and rejects Onshape folders", () =>
    Effect.gen(function* () {
      const engineService = yield* OrchestrationEngineService;
      const root = yield* makeFolder();
      const folderProjectId = ProjectId.make("local-cad-existing-folder");
      yield* engineService.dispatch({
        type: "project.create",
        commandId: CommandId.make("local-cad-existing-folder"),
        projectId: folderProjectId,
        title: "Existing",
        workspaceRoot: root,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      const attached = yield* (yield* LocalCadProjects).create({
        projectId: ProjectId.make("local-cad-would-duplicate"),
        title: "Duplicate",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      assert.strictEqual(attached.projectId, folderProjectId);
      const project = yield* settle(folderProjectId);
      assert.strictEqual(project.title, "Existing");
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");

      const onshapeRoot = yield* makeFolder();
      yield* engineService.dispatch({
        type: "project.onshape.create",
        commandId: CommandId.make("local-cad-onshape-folder"),
        projectId: ProjectId.make("local-cad-onshape-folder"),
        title: "Onshape",
        workspaceRoot: onshapeRoot,
        defaultModelSelection: null,
        onshapeSource,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.strictEqual(yield* createError(onshapeRoot, "models/dm1.step"), "onshape-project");
    }).pipe(Effect.scoped),
  );

  it.effect("links a natively picked absolute path in a plain folder project and imports it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-set-file-absolute");
      yield* makeFolderProject(projectId, root);
      assert.strictEqual((yield* getProject(projectId)).localCadSource, undefined);

      const result = yield* (yield* LocalCadProjects).setFile({
        projectId,
        filePath: path.join(root, "models/dm1.step"),
      });
      assert.strictEqual(result.projectId, projectId);
      const project = yield* settle(projectId);
      // Stored workspace-relative, so the project survives the folder moving.
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      assert.isNotNull(project.cad?.roots[0]?.current ?? null);
    }).pipe(Effect.scoped),
  );

  it.effect("switches a linked project to another picked file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      yield* fs.copyFile(FIXTURE, path.join(root, "parts/second.stp"));
      const projectId = ProjectId.make("local-cad-set-file-switch");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      const first = yield* settle(projectId);

      yield* (yield* LocalCadProjects).setFile({ projectId, filePath: "parts/second.stp" });
      const project = yield* settle(projectId);
      assert.notStrictEqual(
        project.cad?.lastOutcome?.operationId,
        first.cad?.lastOutcome?.operationId,
      );
      assert.deepStrictEqual(project.localCadSource, { filePath: "parts/second.stp" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      assert.strictEqual(
        project.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(project, "parts/second.stp").elementId,
      );
      assert.strictEqual(project.cad?.roots.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects picked files outside the folder, non-CAD files, and non-folder projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const engineService = yield* OrchestrationEngineService;
      const root = yield* makeFolder();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-outside-" });
      yield* fs.copyFile(FIXTURE, path.join(outside, "outside.step"));
      yield* fs.symlink(path.join(outside, "outside.step"), path.join(root, "models/link.step"));
      const projectId = ProjectId.make("local-cad-set-file-rejected");
      yield* makeFolderProject(projectId, root);

      assert.strictEqual(
        yield* setFileError(projectId, path.join(outside, "outside.step")),
        "outside-folder",
      );
      assert.strictEqual(
        yield* setFileError(projectId, path.join(root, "models/link.step")),
        "outside-folder",
      );
      assert.strictEqual(
        yield* setFileError(projectId, path.join(root, "notes.txt")),
        "unsupported-file",
      );
      assert.strictEqual(
        yield* setFileError(ProjectId.make("local-cad-no-such-project"), "models/dm1.step"),
        "project-not-found",
      );
      assert.strictEqual((yield* getProject(projectId)).localCadSource, undefined);

      const onshapeProjectId = ProjectId.make("local-cad-set-file-onshape");
      yield* engineService.dispatch({
        type: "project.onshape.create",
        commandId: CommandId.make("local-cad-set-file-onshape"),
        projectId: onshapeProjectId,
        title: "Onshape",
        workspaceRoot: yield* makeFolder(),
        defaultModelSelection: null,
        // A second document: the first Onshape test project still owns `onshapeSource`.
        onshapeSource: { ...onshapeSource, documentId: OnshapeDocumentId.make("c".repeat(24)) },
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.strictEqual(
        yield* setFileError(onshapeProjectId, "models/dm1.step"),
        "onshape-project",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("prunes a deleted local CAD project's snapshots", () =>
    Effect.gen(function* () {
      const engineService = yield* OrchestrationEngineService;
      const snapshots = yield* CadSnapshotStore;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-delete");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      yield* settle(projectId);
      const owned = (yield* snapshots.list()).filter((entry) => entry.projectId === projectId);
      assert.strictEqual(owned.length, 1);

      yield* engineService.dispatch({
        type: "project.delete",
        commandId: CommandId.make("local-cad-delete"),
        projectId,
      });
      yield* pruneCadSnapshots(projectId);
      const remaining = (yield* snapshots.list()).filter((entry) => entry.projectId === projectId);
      assert.strictEqual(remaining.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("lists SolidWorks parts and assemblies with the other CAD files", () =>
    Effect.gen(function* () {
      const root = yield* makeSolidWorksFolder();
      const result = yield* (yield* LocalCadProjects).listFiles({ workspaceRoot: root });
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [
          "cad/Bracket.SLDPRT",
          "cad/Frame v2.SLDASM",
          "cad/Legacy.SLDASM",
          "cad/Panel.SLDASM",
          "cad/Rig.SLDASM",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names the files an assembly is missing before starting SolidWorks", () =>
    Effect.gen(function* () {
      const root = yield* makeSolidWorksFolder();
      const projectId = ProjectId.make("local-cad-solidworks-missing");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Frame",
        workspaceRoot: root,
        filePath: "cad/Frame v2.SLDASM",
      });
      const missing = yield* settle(projectId);
      assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
      // The assembly's own old name, the bracket beside it, and the Interconnect insert all
      // resolve. Only the plate is missing. These generated files would make SolidWorks fail,
      // so reaching this message shows SolidWorks never opened them.
      assert.strictEqual(
        missing.cad?.lastOutcome?.reason,
        "This assembly uses files that are not in the project folder: Plate & Rib.SLDPRT. Add them, then Sync. Existing imported CAD is unchanged.",
      );

      const legacy = yield* sync(missing, "cad/Legacy.SLDASM");
      assert.strictEqual(legacy.cad?.lastOutcome?.status, "failed");
      assert.match(legacy.cad?.lastOutcome?.reason ?? "", /SolidWorks 2015 or later/);

      // Many long names still fit the outcome's 256 characters, so the failure is recorded.
      const many = yield* sync(legacy, "cad/Rig.SLDASM");
      assert.strictEqual(many.cad?.lastOutcome?.status, "failed");
      const reason = many.cad?.lastOutcome?.reason ?? "";
      assert.isAtMost(reason.length, 256);
      assert.match(reason, /^This assembly uses files that are not in the project folder: Vendor/);
      assert.match(reason, /… Existing imported CAD is unchanged\.$/);
    }).pipe(Effect.scoped),
  );

  // Live: opens real SolidWorks files in the SolidWorks installed on this machine or its Windows
  // host. Set CADSENSE_SOLIDWORKS_DIR (a folder holding an assembly and the files it uses),
  // CADSENSE_SOLIDWORKS_ASSEMBLY (its name there), and optionally CADSENSE_SOLIDWORKS_EMPTY_PART
  // (a part with only sketches). SolidWorks quits afterwards unless it was already running.
  const live = {
    dir: process.env.CADSENSE_SOLIDWORKS_DIR,
    assembly: process.env.CADSENSE_SOLIDWORKS_ASSEMBLY,
    emptyPart: process.env.CADSENSE_SOLIDWORKS_EMPTY_PART,
  };
  const skipLive = !live.dir || !live.assembly;

  /** A fresh folder with the live assembly and the files it uses, less `leaveOut`. */
  const makeLiveFolder = Effect.fn(function* (leaveOut?: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-live-" });
    const references = readSolidWorksReferences(
      NodeFS.readFileSync(path.join(live.dir!, live.assembly!)),
    );
    assert.isNotNull(references);
    const { files, missing } = planSolidWorksFiles({
      assemblyPath: live.assembly!,
      references: references!,
      folderFiles: NodeFS.readdirSync(live.dir!),
    });
    assert.deepStrictEqual(missing, []);
    for (const name of [live.assembly!, ...files])
      if (name !== leaveOut) yield* fs.copyFile(path.join(live.dir!, name), path.join(root, name));
    return { root, uses: files };
  });

  it.effect.skipIf(skipLive)(
    "converts a real assembly with SolidWorks, then re-exports only what changed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshots = yield* CadSnapshotStore;
        const { root, uses } = yield* makeLiveFolder();
        const projectId = ProjectId.make("local-cad-solidworks-live");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "SolidWorks",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        const first = yield* settle(projectId);
        assert.strictEqual(
          first.cad?.lastOutcome?.status,
          "succeeded",
          first.cad?.lastOutcome?.reason ?? undefined,
        );
        const manifest = yield* snapshots.load(first.cad!.roots[0]!.current!.snapshotId);
        assert.isAtLeast(manifest.parts.length, 2);
        // SolidWorks placed the components: at least one is not at the origin unrotated.
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].join();
        assert.isTrue(
          manifest.nodes.some((node) => node.kind === "part" && node.transform.join() !== identity),
        );

        // Unchanged files: the same snapshot, so SolidWorks did not run.
        const unchanged = yield* sync(first, live.assembly!);
        assert.strictEqual(unchanged.cad?.lastOutcome?.status, "succeeded");
        assert.strictEqual(unchanged.cad!.roots[0]!.current?.snapshotId, manifest.snapshotId);
        assert.strictEqual(
          cadCommentModelDescriptor(yield* snapshots.load(manifest.snapshotId)),
          cadCommentModelDescriptor(manifest),
        );

        // Swap in another real part under one used name: a new revision where only that part
        // is exported again and every other part keeps its geometry.
        const other = NodeFS.readdirSync(live.dir!).find(
          (name) => /\.sldprt$/i.test(name) && !uses.includes(name),
        );
        assert.isDefined(other);
        yield* fs.copyFile(path.join(live.dir!, other!), path.join(root, uses[0]!));
        const changed = yield* sync(unchanged, live.assembly!);
        assert.strictEqual(
          changed.cad?.lastOutcome?.status,
          "succeeded",
          changed.cad?.lastOutcome?.reason ?? undefined,
        );
        const next = yield* snapshots.load(changed.cad!.roots[0]!.current!.snapshotId);
        assert.notStrictEqual(next.root.microversionId, manifest.root.microversionId);
        const before = new Set(manifest.parts.map((part) => part.geometryKey));
        const kept = next.parts.filter((part) => before.has(part.geometryKey));
        assert.strictEqual(kept.length, next.parts.length - 1);
        assert.isTrue(
          kept.every(
            (part) =>
              next.assets.find((asset) => asset.geometryKey === part.geometryKey)?.sha256 ===
              manifest.assets.find((asset) => asset.geometryKey === part.geometryKey)?.sha256,
          ),
        );
      }).pipe(Effect.scoped),
    10 * 60_000,
  );

  it.effect.skipIf(skipLive)(
    "names a real assembly's missing part before starting SolidWorks",
    () =>
      Effect.gen(function* () {
        const references = readSolidWorksReferences(
          NodeFS.readFileSync(`${live.dir}/${live.assembly}`),
        );
        const { files } = planSolidWorksFiles({
          assemblyPath: live.assembly!,
          references: references!,
          folderFiles: NodeFS.readdirSync(live.dir!),
        });
        const { root } = yield* makeLiveFolder(files[0]);
        const projectId = ProjectId.make("local-cad-solidworks-live-missing");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Missing",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        const project = yield* settle(projectId);
        assert.strictEqual(project.cad?.lastOutcome?.status, "failed");
        assert.include(project.cad?.lastOutcome?.reason ?? "", files[0]!);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(skipLive)(
    "cancels a SolidWorks conversion and leaves SolidWorks as it found it",
    () =>
      Effect.gen(function* () {
        const host = yield* SolidWorksBridge.detectSolidWorksHost;
        assert.isNotNull(host);
        // tasklist sits in System32, three levels above WindowsPowerShell\v1.0\powershell.exe.
        const tasklist = NodePath.join(host!.powershell, "../../../tasklist.exe");
        const running = () =>
          NodeChildProcess.execFileSync(tasklist, ["/FI", "IMAGENAME eq SLDWORKS.exe", "/NH"])
            .toString()
            .includes("SLDWORKS.exe");
        const jobs = () =>
          NodeFS.readdirSync(host!.serverRoot).filter((name) => /^[0-9a-f-]{36}$/.test(name));
        const wasRunning = running();
        const { root } = yield* makeLiveFolder();
        const projectId = ProjectId.make("local-cad-solidworks-live-cancel");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Cancelled",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        // Cancel as soon as the files are staged for SolidWorks.
        for (let attempt = 0; jobs().length === 0; attempt++) {
          if (attempt > 600) return yield* Effect.die("The conversion never started");
          yield* Effect.sleep("50 millis");
        }
        const operation = (yield* getProject(projectId)).cad?.operation;
        assert.isDefined(operation ?? undefined);
        yield* (yield* CadUserOperations).cancel(projectId, operation!.operationId);
        const cancelled = yield* settle(projectId, operation!.operationId);
        assert.strictEqual(cancelled.cad?.lastOutcome?.status, "cancelled");
        assert.deepStrictEqual(jobs(), []);
        assert.strictEqual(running(), wasRunning);
      }).pipe(Effect.scoped),
    5 * 60_000,
  );

  it.effect.skipIf(skipLive || !live.emptyPart)(
    "says a SolidWorks part with only sketches has no geometry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-live-" });
        const name = path.basename(live.emptyPart!);
        yield* fs.copyFile(live.emptyPart!, path.join(root, name));
        const projectId = ProjectId.make("local-cad-solidworks-live-empty");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Sketch",
          workspaceRoot: root,
          filePath: name,
        });
        const project = yield* settle(projectId);
        assert.strictEqual(project.cad?.lastOutcome?.status, "failed");
        assert.match(project.cad?.lastOutcome?.reason ?? "", /no solid geometry/);
      }).pipe(Effect.scoped),
    5 * 60_000,
  );
});

it.layer(noSolidWorksLayer, { timeout: 120_000, excludeTestServices: true })(
  "local CAD projects without SolidWorks",
  (it) => {
    it.effect("says SolidWorks files need SolidWorks, and STEP still works", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeSolidWorksFolder();
        yield* fs.copyFile(FIXTURE, path.join(root, "cad/frame.step"));
        const projectId = ProjectId.make("local-cad-solidworks-unavailable");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Panel",
          workspaceRoot: root,
          filePath: "cad/Panel.SLDASM",
        });
        const assembly = yield* settle(projectId);
        assert.strictEqual(assembly.cad?.lastOutcome?.status, "failed");
        assert.strictEqual(
          assembly.cad?.lastOutcome?.reason,
          "Opening SolidWorks files needs SolidWorks installed on this computer. Install it, or save a STEP copy from SolidWorks and pick that. Existing imported CAD is unchanged.",
        );
        const part = yield* sync(assembly, "cad/Bracket.SLDPRT");
        assert.match(part.cad?.lastOutcome?.reason ?? "", /needs SolidWorks installed/);
        const step = yield* sync(part, "cad/frame.step");
        assert.strictEqual(step.cad?.lastOutcome?.status, "succeeded");
      }).pipe(Effect.scoped),
    );
  },
);
