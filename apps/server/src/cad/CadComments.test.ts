import {
  parsePartStudioSnapshotDraft,
  completeSnapshotManifest,
  snapshotRootId,
} from "../onshape/OnshapeSnapshotManifest.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CadSnapshotManifest,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OnshapeProjectSource,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { initialCadView } from "./CadViewState.ts";
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
import { make as makeComments } from "./CadComments.ts";
import { make as makeStore, CadDiskSpace, CadSnapshotStore } from "./CadSnapshotStore.ts";
import { CadRenderBroker } from "./CadRenderBroker.ts";
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
const rawSnapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
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
      kind: "part",
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
const makeSnapshot = Effect.gen(function* () {
  const root = { ...rawSnapshot.root, kind: "part-studio" as const };
  const draft = yield* parsePartStudioSnapshotDraft(
    { ...rawSnapshot, root, rootId: snapshotRootId(root) },
    [{ partId: "A", name: "Intake", bodyType: "solid" }],
  );
  return yield* completeSnapshotManifest(draft, [
    {
      geometryKey: draft.parts[0]!.geometryKey,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      byteLength: 4,
      relativePath: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.glb",
      format: "glb",
    },
  ]);
});
const dependencies = Layer.mergeAll(
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
const harness = Effect.fn(function* () {
  const snapshot = yield* makeSnapshot;
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
  for (let index = 0; index < 1; index++) {
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

  const store = yield* makeStore.pipe(
    Effect.provideService(CadDiskSpace, { availableBytes: () => Effect.succeed(10 ** 12) }),
  );
  yield* store.putAsset(new Uint8Array([1, 2, 3, 4]));
  yield* store.publish(snapshot);
  const broker = CadRenderBroker.of({
    runsForThread: () => Effect.succeed([]),
    endRun: () => Effect.void,
    connect: () => Stream.empty,
    readJob: unused,
    readAsset: unused,
    complete: unused,
    fail: unused,
    capture: (input) =>
      Effect.succeed({
        png: new Uint8Array([1, 2, 3]),
        receipt: {
          snapshotId: input.state.snapshotId,
          revision: input.state.revision,
          pose: {
            position: [1, 1, 1],
            target: [0, 0, 0],
            up: [0, 0, 1],
            projection: "perspective",
            zoom: 1,
          },
          commentHits:
            input.commentWork?.kind === "locate"
              ? input.commentWork.picks.map((p) => ({
                  pickKey: p.pickKey,
                  reason: "candidate",
                  occurrenceId: p.intendedOccurrenceId,
                  point: [0, 0, 0],
                  normal: [0, 0, 1],
                }))
              : input.commentWork?.kind === "inspect"
                ? input.commentWork.targets.map((t) => ({
                    pickKey: t.candidateId,
                    reason: "visible",
                    occurrenceId: t.occurrenceId,
                    point: t.point,
                    normal: null,
                  }))
                : [],
        },
      }),
  });
  const service = yield* makeComments.pipe(
    Effect.provideService(CadSnapshotStore, store),
    Effect.provideService(CadRenderBroker, broker),
  );
  const query = yield* ProjectionSnapshotQuery;
  return { service, store, dispatch, query, snapshot };
});
const makeFinding = (snapshot: CadSnapshotManifest) => ({
  kind: "new",
  publicationKey: "missing-fastener",
  inspectedSnapshotId: snapshot.snapshotId,
  title: "Check this fastener",
  body: "The inspected attachment appears empty.",
  targets: [
    {
      kind: "part",
      label: "Intake",
      occurrenceId: snapshot.nodes.at(-1)!.id,
      preciseLocationLimitation: "The precise hole could not be verified.",
    },
  ],
});
it.effect(
  "persists a valid subset, fences stale catalogs and reviews, and reuses reviewed findings after activation ends",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const { snapshot } = h;
      const finding = makeFinding(snapshot);
      const publish = () =>
        Effect.scoped(
          Effect.gen(function* () {
            const a = yield* h.service.activate(threadId, "test", TurnId.make("turn"));
            return yield* a.invoke("cad_comments_publish", {
              expectedCatalogVersion: 0,
              items: [
                finding,
                {
                  ...finding,
                  publicationKey: "bad-link",
                  link: { kind: "correction", commentId: "missing", explanation: "bad" },
                },
              ],
            });
          }),
        );
      yield* publish();
      let model = yield* h.query.getCommandReadModel();
      assert.equal(model.cadComments?.length, 1);
      assert.equal(model.cadCommentReceipts?.length, 1);
      const comment = model.cadComments![0]!;
      const review = {
        threadId,
        commentId: comment.id,
        expectedVersion: 0,
        state: "resolved" as const,
        commandId: CommandId.make("review"),
      };
      yield* h.service.review(review);
      yield* h.service.review(review);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(h.service.review({ ...review, state: "dismissed" }))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.review({ ...review, commandId: CommandId.make("stale-review") }),
          ),
        ),
      );
      yield* publish(); // Retry after candidate activation expires: receipt is authoritative.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* h.service.activate(threadId, "test", TurnId.make("second"));
          yield* a.invoke("cad_comments_publish", {
            expectedCatalogVersion: 1,
            items: [
              {
                kind: "reuse",
                publicationKey: "again",
                inspectedSnapshotId: snapshot.snapshotId,
                reuseCommentId: comment.id,
              },
            ],
          });
        }),
      );
      model = yield* h.query.getCommandReadModel();
      assert.equal(model.cadComments?.length, 1);
      assert.equal(model.cadComments?.[0]?.state, "resolved");
      assert.equal(model.cadCommentReceipts?.length, 2);
      // The deletion list may have been calculated before publication. Final deletion rechecks durable references.
      yield* h.store.remove([snapshot.snapshotId], []);
      assert.equal((yield* h.store.load(snapshot.snapshotId)).snapshotId, snapshot.snapshotId);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.review({
              ...review,
              threadId: otherThreadId,
              commandId: CommandId.make("other"),
            }),
          ),
        ),
      );
      yield* h.dispatch({ type: "thread.delete", threadId });
      yield* h.store.remove([snapshot.snapshotId], []);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(h.store.load(snapshot.snapshotId))));
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

const locateResult = Schema.decodeUnknownSync(
  Schema.Struct({ results: Schema.Array(Schema.Struct({ candidateId: Schema.String })) }),
);
const inspectResult = Schema.decodeUnknownSync(
  Schema.Struct({ inspectionId: Schema.String, artifact: Schema.Struct({ path: Schema.String }) }),
);
it.effect(
  "requires alternate-view confirmation, binds historical publication, and retains evidence after scope release",
  () =>
    Effect.gen(function* () {
      const h = yield* harness(),
        contextId = "00000000-0000-4000-8000-000000000011",
        turnId = TurnId.make("point-turn");
      const { snapshot } = h;
      const finding = makeFinding(snapshot);
      const view = initialCadView(snapshot, 0);
      yield* h.dispatch({ type: "thread.cad.context.ensure", threadId, contextId, childKey: null });
      yield* h.dispatch({
        type: "thread.cad.view.set",
        threadId,
        contextId,
        expectedRevision: null,
        view,
      });
      yield* h.dispatch({
        type: "thread.cad.capture.record",
        threadId,
        contextId,
        turnId,
        capture: {
          captureId: "00000000-0000-4000-8000-000000000012",
          rootId: snapshot.rootId,
          snapshotId: snapshot.snapshotId,
          revision: 0,
          artifact: {
            path: "capture.png",
            mimeType: "image/png",
            width: 1280,
            height: 960,
            byteLength: 3,
            createdAt: now,
          },
          summary: "Source",
        },
        cameraPose: {
          position: [1, 1, 1],
          target: [0, 0, 0],
          up: [0, 0, 1],
          projection: "perspective",
          zoom: 1,
        },
      });
      let evidence = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* h.service.activate(threadId, contextId, turnId);
          const candidate = locateResult(
            (yield* a.invoke("cad_comment_locate", {
              captureId: "00000000-0000-4000-8000-000000000012",
              picks: [
                {
                  pickKey: "hole",
                  intendedOccurrenceId: snapshot.nodes.at(-1)!.id,
                  x: 640,
                  y: 480,
                },
              ],
            })).result,
          ).results[0]!;
          const item = {
            ...finding,
            targets: [
              {
                kind: "point",
                label: "Hole rim",
                candidateId: candidate.candidateId,
                inspectionId: "unverified",
                confirmationReason: "Looks right",
              },
            ],
          };
          yield* a.invoke("cad_comments_publish", { expectedCatalogVersion: 0, items: [item] });
          assert.equal((yield* h.query.getCommandReadModel()).cadComments?.length, 0);
          const inspection = inspectResult(
            (yield* a.invoke("cad_comment_inspect", { candidateIds: [candidate.candidateId] }))
              .result,
          );
          evidence = inspection.artifact.path;
          yield* h.dispatch({
            type: "thread.cad.presentation.settle",
            threadId,
            captureId: "00000000-0000-4000-8000-000000000012",
            expectedUserRevision: null,
            view: null,
          });
          // Advance the actual project twice: the inspected snapshot is no longer current or rollback.
          for (const n of [7, 8]) {
            const operationId = `00000000-0000-4000-8000-00000000000${n}`;
            yield* h.dispatch({
              type: "project.cad.operation.reserve",
              projectId,
              operationId,
              kind: "sync",
              root: {
                rootId: snapshot.rootId,
                elementId: snapshot.root.elementId,
                kind: snapshot.root.kind,
                configuration: "default",
              },
            });
            yield* h.dispatch({
              type: "project.cad.operation.complete",
              projectId,
              operationId,
              result: {
                kind: "sync",
                snapshot: {
                  snapshotId: operationId,
                  microversionId: source.workspaceId,
                  createdAt: now,
                  manifestBytes: 1,
                  assetBytes: 0,
                },
              },
            });
          }
          yield* a.invoke("cad_comments_publish", {
            expectedCatalogVersion: 0,
            items: [
              {
                ...item,
                targets: [
                  {
                    ...item.targets[0],
                    inspectionId: inspection.inspectionId,
                    confirmationReason:
                      "The alternate angle shows the actual rim, not the inner wall.",
                  },
                ],
              },
            ],
          });
        }),
      );
      const comment = (yield* h.query.getCommandReadModel()).cadComments?.[0];
      assert.equal(comment?.snapshotId, snapshot.snapshotId);
      assert.equal(comment?.targets[0]?.kind, "point");
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fs.exists(evidence));
      assert.isTrue(yield* fs.exists(evidence.replace(".png", ".json")));
      yield* h.store.remove([snapshot.snapshotId], []);
      assert.equal((yield* h.store.load(snapshot.snapshotId)).snapshotId, snapshot.snapshotId);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const other = yield* h.service.activate(otherThreadId, "other", turnId);
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                other.invoke("cad_comment_locate", {
                  captureId: "00000000-0000-4000-8000-000000000012",
                  picks: [
                    { pickKey: "x", intendedOccurrenceId: snapshot.nodes.at(-1)!.id, x: 1, y: 1 },
                  ],
                }),
              ),
            ),
          );
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
