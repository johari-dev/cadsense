import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeWorkspaceId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const testLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-cad-lifecycle-" })),
  Layer.provideMerge(NodeServices.layer),
);
const now = "2026-09-05T00:00:00.000Z";
const projectId = ProjectId.make("cad-project");
const threadId = ThreadId.make("cad-thread");
const messageId = MessageId.make("cad-message");
const operationId = "00000000-0000-4000-8000-000000000001";
const nextOperationId = "00000000-0000-4000-8000-000000000002";
const root = {
  rootId: "a".repeat(64),
  elementId: OnshapeElementId.make("a".repeat(24)),
  kind: "assembly" as const,
  configuration: "default",
};
const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.onshape.create",
    commandId: CommandId.make("create"),
    projectId,
    title: "CAD",
    workspaceRoot: "/managed/cad",
    defaultModelSelection: null,
    createdAt: now,
    onshapeSource: {
      connectionId: OnshapeConnectionId.make(operationId),
      host: "https://cad.onshape.com",
      documentId: OnshapeDocumentId.make("a".repeat(24)),
      workspaceType: "w",
      workspaceId: OnshapeWorkspaceId.make("b".repeat(24)),
      configuration: "default",
    },
  });
  yield* engine.dispatch({
    type: "project.onshape.workspace.ready",
    commandId: CommandId.make("ready"),
    projectId,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "CAD thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  });
  return engine;
});
const reserve = (id = operationId) => ({
  type: "project.cad.operation.reserve" as const,
  commandId: CommandId.make(`reserve-${id}`),
  projectId,
  operationId: id,
  kind: "sync" as const,
  root,
});
const startTurn = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("start"),
  threadId,
  message: { messageId, role: "user" as const, text: "Inspect CAD", attachments: [] },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: now,
};

it.effect("persists reservation and blocks starts, deletion, and connection replacement", () =>
  Effect.gen(function* () {
    const engine = yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    yield* engine.dispatch(reserve());
    assert.strictEqual(
      (yield* query.getCommandReadModel()).projects[0]?.cad?.operation?.operationId,
      operationId,
    );
    assert.strictEqual(
      (yield* Effect.flip(engine.dispatch(startTurn)))._tag,
      "OrchestrationCommandInvariantError",
    );
    assert.strictEqual(
      (yield* Effect.flip(
        engine.dispatch({ type: "project.delete", commandId: CommandId.make("delete"), projectId }),
      ))._tag,
      "OrchestrationCommandInvariantError",
    );
    assert.strictEqual(
      (yield* Effect.flip(
        engine.dispatch({
          type: "project.onshape.connection.set",
          commandId: CommandId.make("connection"),
          projectId,
          connectionId: OnshapeConnectionId.make(nextOperationId),
        }),
      ))._tag,
      "OrchestrationCommandInvariantError",
    );
  }).pipe(Effect.provide(testLayer)),
);
it.effect(
  "pending native receipt blocks reserve until completion, including event-before-response",
  () =>
    Effect.gen(function* () {
      const engine = yield* seed;
      const query = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch(startTurn);
      assert.strictEqual(
        (yield* query.getCommandReadModel()).threads[0]?.turnAdmission?.pending[0]?.messageId,
        messageId,
      );
      assert.strictEqual(
        (yield* Effect.flip(engine.dispatch(reserve())))._tag,
        "OrchestrationCommandInvariantError",
      );
      const turnId = TurnId.make("native-turn");
      yield* engine.dispatch({
        type: "thread.turn.lifecycle.settle",
        commandId: CommandId.make("complete-native"),
        threadId,
        turnId,
      });
      assert.lengthOf(
        (yield* query.getCommandReadModel()).threads[0]?.turnAdmission?.pending ?? [],
        1,
      );
      yield* engine.dispatch({
        type: "thread.turn.start.settle",
        commandId: CommandId.make("accept-native"),
        threadId,
        messageId,
        turnId,
      });
      assert.lengthOf(
        (yield* query.getCommandReadModel()).threads[0]?.turnAdmission?.pending ?? [],
        0,
      );
      yield* engine.dispatch(reserve(nextOperationId));
      const events = yield* Stream.runCollect((yield* OrchestrationEventStore).readAll());
      let replay = createEmptyReadModel(now);
      for (const event of events) replay = yield* projectEvent(replay, event);
      assert.deepStrictEqual(
        replay.threads[0]?.turnAdmission,
        (yield* query.getCommandReadModel()).threads[0]?.turnAdmission,
      );
    }).pipe(Effect.provide(testLayer)),
);
it.effect("keeps current and rollback on failure and rejects stale completion", () =>
  Effect.gen(function* () {
    const engine = yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    yield* engine.dispatch(reserve());
    const snapshot = {
      snapshotId: operationId,
      microversionId: OnshapeWorkspaceId.make("c".repeat(24)),
      createdAt: now,
      manifestBytes: 100,
      assetBytes: 200,
    };
    yield* engine.dispatch({
      type: "project.cad.operation.complete",
      commandId: CommandId.make("complete"),
      projectId,
      operationId,
      result: { kind: "sync", snapshot },
    });
    yield* engine.dispatch(reserve(nextOperationId));
    assert.strictEqual(
      (yield* Effect.flip(
        engine.dispatch({
          type: "project.cad.operation.complete",
          commandId: CommandId.make("stale"),
          projectId,
          operationId,
          result: { kind: "sync", snapshot },
        }),
      ))._tag,
      "OrchestrationCommandInvariantError",
    );
    yield* engine.dispatch({
      type: "project.cad.operation.end",
      commandId: CommandId.make("failed"),
      projectId,
      operationId: nextOperationId,
      status: "failed",
      reason: "Download failed.",
    });
    const cad = (yield* query.getCommandReadModel()).projects[0]?.cad;
    assert.deepStrictEqual(cad?.roots[0]?.current, snapshot);
    assert.strictEqual(cad?.roots[0]?.rollback, null);
    assert.strictEqual(cad?.operation, null);
    assert.strictEqual(cad?.lastOutcome?.status, "failed");
    const events = yield* Stream.runCollect((yield* OrchestrationEventStore).readAll());
    let replay = createEmptyReadModel(now);
    for (const event of events) replay = yield* projectEvent(replay, event);
    assert.deepStrictEqual(replay.projects[0]?.cad, cad);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("working descendants block admission but monitoring-only work does not", () =>
  Effect.gen(function* () {
    const engine = yield* seed;
    const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
    liveness.recordTaskLiveness({
      threadId,
      taskId: "child",
      taskType: undefined,
      status: "running",
      kind: "started",
    });
    assert.strictEqual(
      (yield* Effect.flip(engine.dispatch(reserve())))._tag,
      "OrchestrationCommandInvariantError",
    );
    liveness.recordTaskLiveness({
      threadId,
      taskId: "child",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "watch",
      taskType: "monitor",
      status: "running",
      kind: "started",
    });
    assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), "monitoring");
    yield* engine.dispatch(reserve(nextOperationId));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("disabled CAD retains snapshots and rejects new remote reservations", () =>
  Effect.gen(function* () {
    const engine = yield* seed;
    yield* engine.dispatch({
      type: "project.cad.enabled.set",
      commandId: CommandId.make("disable"),
      projectId,
      enabled: false,
    });
    assert.strictEqual(
      (yield* Effect.flip(engine.dispatch(reserve())))._tag,
      "OrchestrationCommandInvariantError",
    );
    yield* engine.dispatch({
      type: "project.cad.enabled.set",
      commandId: CommandId.make("enable"),
      projectId,
      enabled: true,
    });
    yield* engine.dispatch(reserve(nextOperationId));
  }).pipe(Effect.provide(testLayer)),
);
