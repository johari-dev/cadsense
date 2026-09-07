import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CadSnapshotManifest,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OnshapeProjectSource,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import { CadSnapshotStore, CadSnapshotStoreError } from "./CadSnapshotStore.ts";
import { initialCadView } from "./CadViewState.ts";
import { make } from "./CadViewing.ts";

const now = "2026-09-05T00:00:00Z";
const decodeSnapshot = Schema.decodeUnknownEffect(CadSnapshotManifest);
const projectId = ProjectId.make("cad-viewing-project");
const threadId = ThreadId.make("cad-viewing-thread");
const otherThreadId = ThreadId.make("cad-other-thread");
const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  workspaceType: "m",
  workspaceId: "b".repeat(24),
  configuration: "default",
});
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000002",
  rootId: "1".repeat(64),
  projectId,
  createdAt: now,
  root: {
    host: source.host,
    documentId: source.documentId,
    elementId: "c".repeat(24),
    kind: "assembly",
    originalRevision: { kind: "m", id: source.workspaceId },
    microversionId: source.workspaceId,
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [
    {
      id: "2".repeat(64),
      parentId: null,
      occurrencePath: [],
      instanceId: null,
      name: "Intake",
      kind: "assembly",
      suppressed: false,
      defaultVisible: true,
      sourcePartKey: null,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  parts: [],
  assets: [],
  dependencies: [],
});
const dependencies = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-cad-viewing-" })),
  Layer.provideMerge(NodeServices.layer),
);
const unused = () => Effect.die("Unexpected store operation");
type TestCommand = {
  [K in OrchestrationCommand["type"]]: Omit<
    Extract<OrchestrationCommand, { type: K }>,
    "commandId"
  >;
}[OrchestrationCommand["type"]];
const harness = Effect.fn(function* (multiple = false) {
  const engine = yield* OrchestrationEngineService;
  let sequence = 0;
  const dispatch = (command: TestCommand) =>
    engine.dispatch({ ...command, commandId: CommandId.make(`cad-view-test-${++sequence}`) });
  yield* dispatch({
    type: "project.onshape.create",
    projectId,
    title: "CAD",
    workspaceRoot: "C:/cad-view-test",
    defaultModelSelection: null,
    onshapeSource: source,
    createdAt: now,
  });
  yield* dispatch({ type: "project.onshape.workspace.ready", projectId });
  for (const id of [threadId, otherThreadId])
    yield* dispatch({
      type: "thread.create",
      projectId,
      threadId: id,
      title: "CAD",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });
  const snapshots = new Map([[snapshot.snapshotId, snapshot]]);
  for (let index = 0; index < (multiple ? 2 : 1); index++) {
    const manifest =
      index === 0
        ? snapshot
        : yield* decodeSnapshot({
            ...snapshot,
            snapshotId: "00000000-0000-4000-8000-000000000003",
            rootId: "3".repeat(64),
            root: { ...snapshot.root, elementId: "d".repeat(24) },
          });
    snapshots.set(manifest.snapshotId, manifest);
    const operationId = `00000000-0000-4000-8000-00000000000${index + 4}`;
    yield* dispatch({
      type: "project.cad.operation.reserve",
      projectId,
      operationId,
      kind: "sync",
      root: {
        rootId: manifest.rootId,
        elementId: manifest.root.elementId,
        kind: manifest.root.kind,
        configuration: "default",
      },
    });
    yield* dispatch({
      type: "project.cad.operation.complete",
      projectId,
      operationId,
      result: {
        kind: "sync",
        snapshot: {
          snapshotId: manifest.snapshotId,
          microversionId: source.workspaceId,
          createdAt: now,
          manifestBytes: 1,
          assetBytes: 0,
        },
      },
    });
  }
  let pins = 0;
  const store = CadSnapshotStore.of({
    checkReserve: unused,
    findGeometry: unused,
    putAsset: unused,
    publish: unused,
    load: unused,
    readAsset: unused,
    list: unused,
    remove: unused,
    withAcquisition: (effect) => effect,
    withPinned: (id, use) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = snapshots.get(id);
          if (!manifest) return yield* new CadSnapshotStoreError({ reason: "unavailable" });
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              pins++;
            }),
            () =>
              Effect.sync(() => {
                pins--;
              }),
          );
          return yield* use(manifest, unused);
        }),
      ),
  });
  const service = yield* make.pipe(Effect.provideService(CadSnapshotStore, store));
  return {
    service,
    recreate: make.pipe(Effect.provideService(CadSnapshotStore, store)),
    pins: () => pins,
    dispatch,
  };
});

it.effect("releases snapshot pins and permits a new activation after native-run interruption", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const contextId = yield* h.service.resolveContext(threadId);
    const ready = yield* Deferred.make<void>();
    const run = yield* h.service
      .withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(ready);
    assert.equal(h.pins(), 1);
    yield* Fiber.interrupt(run);
    assert.equal(h.pins(), 0);
    yield* h.service.withActivation(contextId, (tools) => tools.context());
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "rejects overlapping activations and expires tools when their owning activation ends",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      const expired = yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          assert.equal(h.pins(), 1);
          const overlap = yield* h.service
            .withActivation(contextId, () => Effect.die("Overlapping activation was admitted"))
            .pipe(Effect.flip);
          assert.equal(overlap.reason, "capability-unavailable");
          return tools;
        }),
      );
      assert.equal(h.pins(), 0);
      for (const operation of [
        expired.context().pipe(Effect.flip),
        expired.hierarchy({}).pipe(Effect.flip),
        expired
          .updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 1 }],
          })
          .pipe(Effect.flip),
      ]) {
        assert.equal((yield* operation).reason, "capability-unavailable");
      }
      assert.equal(h.pins(), 0);
      yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.explosion, 0);
          assert.equal(h.pins(), 1);
        }),
      );
      assert.equal(h.pins(), 0);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "persists private state, rejects stale/invalid batches, and releases activation pins",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      assert.equal(h.pins(), 0);
      yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.revision, 0);
          assert.equal(h.pins(), 1);
          const updated = yield* tools.updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 0.5 }],
          });
          assert.equal(updated.revision, 1);
          assert.equal(
            (yield* tools
              .updateView({ expectedRevision: 0, operations: [{ type: "explode", amount: 1 }] })
              .pipe(Effect.flip)).reason,
            "revision-conflict",
          );
          yield* tools
            .updateView({
              expectedRevision: 1,
              operations: [
                { type: "explode", amount: 1 },
                { type: "hide", occurrenceIds: ["f".repeat(64)] },
              ],
            })
            .pipe(Effect.flip);
          assert.equal((yield* tools.context()).state?.explosion, 0.5);
        }),
      );
      assert.equal(h.pins(), 0);
      const restarted = yield* h.recreate;
      assert.equal(yield* restarted.resolveContext(threadId), contextId);
      yield* restarted.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.explosion, 0.5);
        }),
      );
      const query = yield* ProjectionSnapshotQuery;
      assert.isUndefined((yield* query.getSnapshot()).cadSessions);
      assert.equal("cadSessions" in (yield* query.getShellSnapshot()), false);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "keeps native child and other-thread viewers independent with no initial ambiguous root",
  () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const primary = yield* h.service.resolveContext(threadId);
      const child = yield* h.service.resolveContext(threadId, "trusted-child");
      const other = yield* h.service.resolveContext(otherThreadId);
      assert.notEqual(primary, child);
      assert.notEqual(primary, other);
      yield* h.service.withActivation(primary, (tools) =>
        Effect.gen(function* () {
          const context = yield* tools.context();
          assert.isNull(context.state);
          assert.lengthOf(context.roots, 2);
          assert.equal(h.pins(), 0);
          const view = yield* tools.updateView({
            expectedRevision: 0,
            operations: [
              { type: "select-root", rootId: snapshot.rootId },
              { type: "explode", amount: 0.75 },
            ],
          });
          assert.equal(view.revision, 1);
        }),
      );
      for (const id of [child, other])
        yield* h.service.withActivation(id, (tools) =>
          Effect.gen(function* () {
            assert.isNull((yield* tools.context()).state);
          }),
        );
      assert.equal(h.pins(), 0);
      yield* h.service.saveUserView(threadId, null, initialCadView(snapshot));
      assert.isNull(yield* h.service.getUserView(otherThreadId));
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
