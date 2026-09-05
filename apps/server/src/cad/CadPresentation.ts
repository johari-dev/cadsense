import {
  CadViewError,
  CommandId,
  isCadThreadRunActive,
  type ThreadId,
  type CadViewState,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { readLatestCadCapture, readCadUserView } from "./CadSessionPersistence.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { rebaseCadView } from "./CadViewState.ts";

export class CadPresentation extends Context.Service<
  CadPresentation,
  {
    readonly settle: (threadId: ThreadId) => Effect.Effect<boolean, CadViewError>;
  }
>()("@cadsense/server/cad/CadPresentation") {}
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });
export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const store = yield* CadSnapshotStore;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const settle = Effect.fn("CadPresentation.settle")(function* (threadId: ThreadId) {
    const thread = yield* query.getThreadShellById(threadId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(thread) || isCadThreadRunActive(thread.value)) return false;
    const project = yield* query
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return false;
    const pending = project.value.cad?.pendingPresentations?.find(
      (item) => item.threadId === threadId,
    );
    if (!pending) return false;
    const captured = yield* readLatestCadCapture(threadId, pending.turnId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(unavailable),
    );
    if (!captured || captured.record.capture.captureId !== pending.captureId)
      return yield* unavailable();
    const userView = yield* readCadUserView(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(unavailable),
    );
    const expectedUserRevision = userView?.view.revision ?? null;
    const root = project.value.cad?.roots.find((item) => item.rootId === pending.rootId);
    let view: CadViewState | null = null;
    if (root?.current) {
      view = yield* store
        .withPinned(root.current.snapshotId, (manifest) =>
          Effect.succeed({
            ...rebaseCadView(captured.view, manifest),
            revision: expectedUserRevision === null ? 0 : expectedUserRevision + 1,
          }),
        )
        .pipe(Effect.orElseSucceed(() => null));
    }
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
    const accepted = yield* engine
      .dispatch({
        type: "thread.cad.presentation.settle",
        commandId: CommandId.make(id),
        threadId,
        captureId: pending.captureId,
        expectedUserRevision,
        view,
      })
      .pipe(
        Effect.map(() => true),
        Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
        Effect.mapError(unavailable),
      );
    return accepted;
  });
  return CadPresentation.of({ settle });
});

export const layer = Layer.effect(CadPresentation, make);
export const reactorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* CadPresentation;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    // Acquire before reading persisted candidates: startup cannot miss a completion in between.
    const subscription = yield* engine.subscribeDomainEvents;
    const pending = new Set<ThreadId>();
    const settle = (threadId: ThreadId) =>
      service.settle(threadId).pipe(
        Effect.catch(() => Effect.logWarning("CAD presentation remains pending", { threadId })),
        Effect.asVoid,
      );
    yield* forkParked(
      Effect.gen(function* () {
        const model = yield* query.getCommandReadModel();
        for (const project of model.projects)
          for (const candidate of project.cad?.pendingPresentations ?? [])
            pending.add(candidate.threadId);
        for (const threadId of pending) yield* settle(threadId);
        yield* Stream.runForEach(Stream.fromSubscription(subscription), (event) => {
          if (event.type === "thread.cad-capture-recorded") {
            pending.add(event.payload.threadId);
            return settle(event.payload.threadId);
          }
          if (event.type === "thread.cad-presentation-settled") {
            pending.delete(event.payload.threadId);
            return Effect.void;
          }
          if (event.aggregateKind !== "thread" || !pending.has(event.aggregateId as ThreadId))
            return Effect.void;
          if (
            event.type === "thread.session-set" ||
            event.type === "thread.turn-lifecycle-settled" ||
            event.type === "thread.turn-start-settled" ||
            (event.type === "thread.activity-appended" &&
              event.payload.activity.kind.startsWith("task."))
          )
            return settle(event.aggregateId as ThreadId);
          return Effect.void;
        });
      }).pipe(Effect.catch(() => Effect.logError("CAD presentation recovery failed"))),
    );
  }),
);
