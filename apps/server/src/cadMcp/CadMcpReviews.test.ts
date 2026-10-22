import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId } from "@cadsense/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CadRenderBroker from "../cad/CadRenderBroker.ts";
import { CadDiskSpace, CadSnapshotStore, make as makeStore } from "../cad/CadSnapshotStore.ts";
import { CadProjectQuiescence, layer as cadUserOperationsLayer } from "../cad/CadUserOperations.ts";
import * as CadViewing from "../cad/CadViewing.ts";
import { ServerConfig } from "../config.ts";
import { localCadElementId } from "../localCad/LocalCadFiles.ts";
import * as LocalCadImport from "../localCad/LocalCadImport.ts";
import { layer as localCadProjectsLayer } from "../localCad/LocalCadProjects.ts";
import * as SolidWorksBridge from "../localCad/SolidWorksBridge.ts";
import { OnshapeCadRoots } from "../onshape/OnshapeCadRoots.ts";
import { OnshapeConnections } from "../onshape/OnshapeConnections.ts";
import { OnshapeProjects } from "../onshape/OnshapeProjects.ts";
import { OnshapeSnapshotAcquisition } from "../onshape/OnshapeSnapshotAcquisition.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeCadMcpReviews, onshapeUrlProblem } from "./CadMcpReviews.ts";
import { cadMcpToolDefinitions } from "./CadMcpTools.ts";

// Ways cad_open's offline URL check can fail: a valid tab URL rejected, a dropped /e/ tab or a
// short ID left for a network error to hide, or a non-document path accepted.
const tab =
  "https://cad.onshape.com/documents/0e6a45fa6581191bfeed4d0a/m/437281c10d1a49799e4ed01d/e/ed9df6627855dacf7d96be26";

describe("onshapeUrlProblem", () => {
  it("accepts workspace, version, and microversion tab URLs", () => {
    for (const kind of ["w", "v", "m"])
      expect(onshapeUrlProblem(tab.replace("/m/", `/${kind}/`))).toBe(null);
  });

  it("names a dropped tab, which models do when they copy a long URL", () => {
    expect(
      onshapeUrlProblem(
        "https://cad.onshape.com/documents/0e6a45fa6581191bfeed4d0a/m/437281c10d1a49799e4ed01e",
      ),
    ).toContain("not a tab");
  });

  it("names the ID that lost characters", () => {
    expect(onshapeUrlProblem(tab.replace("4ed01d", "4ed01"))).toContain(
      "ID after /m/ has 23 characters",
    );
  });

  it("rejects paths that are not Onshape documents", () => {
    expect(onshapeUrlProblem("https://cad.onshape.com/folders/abc")).not.toBe(null);
    expect(onshapeUrlProblem("not a url")).not.toBe(null);
  });
});

// Ways cad_open can fail for a local CAD file:
// - A client does not offer cad_open for a local file, because the schema and description only
//   name Onshape.
// - A relative path resolves against something other than the working directory.
// - A missing file or folder, an unsupported extension, a file outside the folder, or a bad mix of
//   url, file, and folder hangs, makes a project, or returns no reason.
// - Opening an unchanged file imports it again, or a second call makes a second project for the
//   same folder.
// - A re-exported file, or another file in the same folder, keeps showing the old model because
//   the old review is reused.
// - An import that outlasts the call's wait blocks the client, and the next call starts a second
//   import, fails as busy, or loses the first import's failure.
// - A failed import hangs, retries by itself, or returns without its reason.
// - Any of it needs an Onshape key. Every Onshape service below dies when called.
const FIXTURE = new URL("../localCad/testFixtures/dm1-id-214.stp", import.meta.url).pathname;
const onshapeUnused = () => Effect.die("A local CAD file needs no Onshape");

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-mcp-local-" })),
  Layer.provideMerge(NodeServices.layer),
);
const store = Layer.effect(CadSnapshotStore, makeStore).pipe(
  Layer.provide(Layer.succeed(CadDiskSpace, { availableBytes: () => Effect.succeed(10 ** 12) })),
);
const onshape = Layer.mergeAll(
  Layer.succeed(OnshapeConnections, {
    readBinary: onshapeUnused,
    readJson: onshapeUnused,
    list: onshapeUnused,
    create: onshapeUnused,
    rename: onshapeUnused,
    replaceCredentials: onshapeUnused,
    remove: onshapeUnused,
  }),
  Layer.succeed(OnshapeProjects, { create: onshapeUnused, setConnection: onshapeUnused }),
  Layer.succeed(OnshapeCadRoots, { discover: onshapeUnused }),
  Layer.succeed(OnshapeSnapshotAcquisition, { acquire: onshapeUnused }),
  // Native agent shutdown is not under test; no agent runs exist here.
  Layer.succeed(CadProjectQuiescence, { confirm: () => Effect.void }),
);
// Every import waits on this first, so a test can hold one in flight.
let importGate: Effect.Effect<void> = Effect.void;
const gatedImport = Layer.effect(
  LocalCadImport.LocalCadImport,
  LocalCadImport.make.pipe(
    Effect.map((service) =>
      LocalCadImport.LocalCadImport.of({
        ...service,
        acquire: (input) =>
          Effect.suspend(() => importGate).pipe(Effect.andThen(service.acquire(input))),
      }),
    ),
  ),
);
const layer = Layer.mergeAll(localCadProjectsLayer, CadViewing.layer, CadRenderBroker.layer).pipe(
  Layer.provideMerge(cadUserOperationsLayer),
  Layer.provideMerge(gatedImport),
  // These tests open STEP files only, so no SolidWorks is found.
  Layer.provideMerge(
    Layer.effect(SolidWorksBridge.SolidWorks, SolidWorksBridge.make({ host: null })),
  ),
  Layer.provideMerge(store),
  Layer.provideMerge(onshape),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(engine),
);

const decodeReady = Schema.decodeUnknownEffect(
  Schema.Struct({
    status: Schema.Literal("ready"),
    reviewId: Schema.String,
    reportPath: Schema.String,
    context: Schema.Unknown,
  }),
);
const decodeImporting = Schema.decodeUnknownEffect(
  Schema.Struct({ status: Schema.Literal("importing"), details: Schema.String }),
);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ reason: Schema.String, details: Schema.String }),
);
const decodeToolSchema = Schema.decodeUnknownSync(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** The reviews of one `cadsense mcp` process with no Onshape key and no Chromium. */
const makeReviews = (importWaitMs?: number) =>
  makeCadMcpReviews({
    apiKey: Option.none(),
    renderHost: { ensure: Effect.void },
    clientName: () => "test",
    ...(importWaitMs === undefined ? {} : { importWaitMs }),
  });
type Reviews = Effect.Success<ReturnType<typeof makeReviews>>;

const openResult = Effect.fn(function* (reviews: Reviews, input: object) {
  const result = yield* reviews.call("cad_open", input);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  return { isError: result.isError, value: result.structuredContent, text };
});
const openReady = Effect.fn(function* (reviews: Reviews, input: object) {
  const result = yield* openResult(reviews, input);
  assert.isFalse(result.isError, result.text);
  return yield* decodeReady(result.value);
});
const openImporting = Effect.fn(function* (reviews: Reviews, input: object) {
  const result = yield* openResult(reviews, input);
  assert.isFalse(result.isError, result.text);
  return yield* decodeImporting(result.value);
});
const openFailure = Effect.fn(function* (reviews: Reviews, input: object) {
  const result = yield* openResult(reviews, input);
  assert.isTrue(result.isError, result.text);
  return yield* decodeFailure(result.value);
});

/** The active projects whose folder is `folder` or inside it. */
const projectsUnder = Effect.fn(function* (folder: string) {
  const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
  return model.projects.filter(
    (project) => project.deletedAt === null && project.workspaceRoot.startsWith(folder),
  );
});
const projectFor = Effect.fn(function* (folder: string) {
  const projects = yield* projectsUnder(folder);
  assert.strictEqual(projects.length, 1, `one project for ${folder}`);
  const shell = yield* (yield* ProjectionSnapshotQuery).getProjectShellById(projects[0]!.id);
  return Option.getOrThrow(shell);
});

/** Waits for the project's CAD operation to end. */
const settle = Effect.fn(function* (projectId: ProjectId) {
  const query = yield* ProjectionSnapshotQuery;
  for (let attempt = 0; attempt < 1200; attempt++) {
    const project = Option.getOrThrow(yield* query.getProjectShellById(projectId));
    if (!project.cad?.operation && project.cad?.lastOutcome) return project;
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die("CAD operation did not settle");
});

/** A temporary folder with the fixture at models/part.step, a corrupt STEP file, and a text file. */
const makeFolder = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-mcp-local-folder-" });
  yield* fs.makeDirectory(path.join(root, "models"));
  yield* fs.makeDirectory(path.join(root, "other"));
  yield* fs.copyFile(FIXTURE, path.join(root, "models/part.step"));
  yield* fs.writeFileString(path.join(root, "broken.step"), "ISO-10303-21;\nnot a model\n");
  yield* fs.writeFileString(path.join(root, "notes.txt"), "not CAD");
  return { root, models: path.join(root, "models"), part: path.join(root, "models/part.step") };
});

describe("cad_open tool definition", () => {
  it("offers local CAD files beside Onshape URLs", () => {
    const open = cadMcpToolDefinitions.find((tool) => tool.name === "cad_open");
    assert.isDefined(open);
    const schema = decodeToolSchema(open!.inputSchema);
    expect(Object.keys(schema.properties).sort()).toEqual(["file", "folder", "title", "url"]);
    expect(open!.description).toMatch(/STEP/);
    expect(open!.description).toMatch(/cad\.onshape\.com/);
  });
});

// Real clock: imports run in a worker thread and cad_open polls for their outcome.
it.layer(layer, { timeout: 120_000, excludeTestServices: true })(
  "cad_open with a local file",
  (it) => {
    it.effect(
      "imports a file given relative to the working directory into its folder's project, with no Onshape key",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const folder = yield* makeFolder();
          const reviews = yield* makeReviews();
          const opened = yield* openReady(reviews, {
            file: path.relative(process.cwd(), folder.part),
          });
          const project = yield* projectFor(folder.root);
          assert.strictEqual(project.workspaceRoot, folder.models);
          assert.strictEqual(project.localCadSource?.filePath, "part.step");
          assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
          assert.isNotNull(opened.context);
          const report = yield* fs.readFileString(opened.reportPath);
          assert.include(report, "part.step");
        }).pipe(Effect.scoped),
    );

    it.effect("uses the folder input as the project folder", () =>
      Effect.gen(function* () {
        const folder = yield* makeFolder();
        const reviews = yield* makeReviews();
        yield* openReady(reviews, { file: folder.part, folder: folder.root });
        const project = yield* projectFor(folder.root);
        assert.strictEqual(project.workspaceRoot, folder.root);
        assert.strictEqual(project.localCadSource?.filePath, "models/part.step");
      }).pipe(Effect.scoped),
    );

    it.effect("reopens an unchanged file in the same review without importing it again", () =>
      Effect.gen(function* () {
        const folder = yield* makeFolder();
        const reviews = yield* makeReviews();
        const first = yield* openReady(reviews, { file: folder.part });
        const imported = yield* projectFor(folder.root);
        const second = yield* openReady(reviews, { file: folder.part });
        const after = yield* projectFor(folder.root);
        assert.strictEqual(second.reviewId, first.reviewId);
        assert.strictEqual(
          after.cad?.lastOutcome?.operationId,
          imported.cad?.lastOutcome?.operationId,
        );
        // A new process with the same data directory skips the import too.
        const restarted = yield* makeReviews();
        yield* openReady(restarted, { file: folder.part });
        const later = yield* projectFor(folder.root);
        assert.strictEqual(
          later.cad?.lastOutcome?.operationId,
          imported.cad?.lastOutcome?.operationId,
        );
      }).pipe(Effect.scoped),
    );

    it.effect(
      "imports a re-exported file and another file in the folder, each in a new review",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = yield* makeFolder();
          const reviews = yield* makeReviews();
          const first = yield* openReady(reviews, { file: folder.part });
          const before = yield* projectFor(folder.root);
          const partRoot = (project: typeof before) =>
            project.cad?.roots.find((root) => root.elementId === localCadElementId("part.step"));

          // A re-export: same path, new bytes.
          yield* fs.writeFileString(folder.part, "\n", { flag: "a" });
          const reexported = yield* openReady(reviews, { file: folder.part });
          const changed = yield* projectFor(folder.root);
          assert.notStrictEqual(reexported.reviewId, first.reviewId);
          assert.notStrictEqual(
            partRoot(changed)?.current?.microversionId,
            partRoot(before)?.current?.microversionId,
          );

          const other = path.join(folder.models, "other.step");
          yield* fs.copyFile(FIXTURE, other);
          const switched = yield* openReady(reviews, { file: other });
          const relinked = yield* projectFor(folder.root);
          assert.strictEqual(relinked.id, before.id);
          assert.strictEqual(relinked.localCadSource?.filePath, "other.step");
          assert.notStrictEqual(switched.reviewId, reexported.reviewId);
          assert.isNotNull(
            relinked.cad?.roots.find((root) => root.elementId === localCadElementId("other.step"))
              ?.current,
          );
        }).pipe(Effect.scoped),
    );

    it.effect("rejects bad input and paths with a reason, without making a project", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        const reviews = yield* makeReviews();
        const reason = (input: object) =>
          openFailure(reviews, input).pipe(Effect.map((failure) => failure.reason));
        assert.strictEqual(yield* reason({}), "invalid-input");
        assert.strictEqual(yield* reason({ url: tab, file: folder.part }), "invalid-input");
        assert.strictEqual(yield* reason({ url: tab, folder: folder.root }), "invalid-input");
        assert.strictEqual(
          yield* reason({ file: path.join(folder.models, "missing.step") }),
          "file-not-found",
        );
        assert.strictEqual(
          yield* reason({ file: path.join(folder.root, "nope/part.step") }),
          "file-not-found",
        );
        assert.strictEqual(
          yield* reason({ file: folder.part, folder: path.join(folder.root, "nope") }),
          "folder-not-found",
        );
        const unsupported = yield* openFailure(reviews, {
          file: path.join(folder.root, "notes.txt"),
        });
        assert.strictEqual(unsupported.reason, "unsupported-file");
        assert.include(unsupported.details, ".step");
        const outside = yield* openFailure(reviews, {
          file: folder.part,
          folder: path.join(folder.root, "other"),
        });
        assert.strictEqual(outside.reason, "outside-folder");
        assert.include(outside.details, folder.part);
        assert.deepStrictEqual(yield* projectsUnder(folder.root), []);
      }).pipe(Effect.scoped),
    );

    it.effect("returns a failed import's reason and does not retry it by itself", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        const reviews = yield* makeReviews();
        const failure = yield* openFailure(reviews, {
          file: path.join(folder.root, "broken.step"),
        });
        assert.strictEqual(failure.reason, "import-failed");
        assert.match(failure.details, /could not read/i);
        const project = yield* projectFor(folder.root);
        assert.isNull(project.cad?.operation ?? null);
        assert.strictEqual(project.cad?.lastOutcome?.status, "failed");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "answers importing when an import outlasts the wait, and the next calls wait on that import",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const folder = yield* makeFolder();
          const reviews = yield* makeReviews(0);

          const gate = yield* Deferred.make<void>();
          importGate = Deferred.await(gate);
          yield* openImporting(reviews, { file: folder.part });
          const inFlight = (yield* projectFor(folder.root)).cad?.operation?.operationId;
          assert.isDefined(inFlight);
          yield* openImporting(reviews, { file: folder.part });
          assert.strictEqual(
            (yield* projectFor(folder.root)).cad?.operation?.operationId,
            inFlight,
          );
          yield* Deferred.succeed(gate, undefined);
          const imported = yield* settle((yield* projectFor(folder.root)).id);
          yield* openReady(reviews, { file: folder.part });
          assert.strictEqual(
            (yield* projectFor(folder.root)).cad?.lastOutcome?.operationId,
            imported.cad?.lastOutcome?.operationId,
          );

          // The call after a failed import reports that failure instead of starting another.
          const second = yield* makeFolder();
          const broken = path.join(second.root, "broken.step");
          const brokenGate = yield* Deferred.make<void>();
          importGate = Deferred.await(brokenGate);
          yield* openImporting(reviews, { file: broken });
          yield* Deferred.succeed(brokenGate, undefined);
          const failed = yield* settle((yield* projectFor(second.root)).id);
          const failure = yield* openFailure(reviews, { file: broken });
          assert.strictEqual(failure.reason, "import-failed");
          assert.match(failure.details, /could not read/i);
          const after = yield* projectFor(second.root);
          assert.isNull(after.cad?.operation ?? null);
          assert.strictEqual(
            after.cad?.lastOutcome?.operationId,
            failed.cad?.lastOutcome?.operationId,
          );
        }).pipe(Effect.ensuring(Effect.sync(() => (importGate = Effect.void))), Effect.scoped),
    );

    // A finished import counts only for the file it read. A re-export after it, before the next
    // call, is imported rather than opening the older model.
    it.effect("imports again when the file changed after the import a call waited on", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* makeFolder();
        const reviews = yield* makeReviews(0);
        const gate = yield* Deferred.make<void>();
        importGate = Deferred.await(gate);
        yield* openImporting(reviews, { file: folder.part });
        yield* Deferred.succeed(gate, undefined);
        const imported = yield* settle((yield* projectFor(folder.root)).id);

        yield* fs.writeFileString(folder.part, "\n", { flag: "a" });
        yield* openImporting(reviews, { file: folder.part });
        const reimported = yield* settle(imported.id);
        assert.notStrictEqual(
          reimported.cad?.lastOutcome?.operationId,
          imported.cad?.lastOutcome?.operationId,
        );
        assert.notStrictEqual(
          reimported.cad?.roots[0]?.current?.microversionId,
          imported.cad?.roots[0]?.current?.microversionId,
        );
        yield* openReady(reviews, { file: folder.part });
      }).pipe(Effect.ensuring(Effect.sync(() => (importGate = Effect.void))), Effect.scoped),
    );
  },
);
