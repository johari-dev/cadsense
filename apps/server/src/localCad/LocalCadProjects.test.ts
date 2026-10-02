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
const layer = localCadProjectsLayer.pipe(
  Layer.provideMerge(cadUserOperationsLayer),
  Layer.provideMerge(LocalCadImport.layer),
  Layer.provideMerge(store),
  Layer.provideMerge(onshape),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(engine),
);

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

/** Waits for the project's CAD operation to end; `operationId` pins which one when known. */
const settle = Effect.fn(function* (projectId: ProjectId, operationId?: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
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
});
