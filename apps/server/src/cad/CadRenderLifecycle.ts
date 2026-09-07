import { isCadThreadRunActive, type ThreadId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { CadRenderBroker } from "./CadRenderBroker.ts";

export const releaseCompletedCadRuns = Effect.fn("releaseCompletedCadRuns")(function* (
  threadId: ThreadId,
) {
  const broker = yield* CadRenderBroker;
  const query = yield* ProjectionSnapshotQuery;
  // Snapshot candidates before the async read so a newer run is never swept by it.
  const runs = yield* broker.runsForThread(threadId);
  if (runs.length === 0) return;
  const thread = yield* query.getThreadShellById(threadId);
  if (Option.isSome(thread) && isCadThreadRunActive(thread.value)) return;
  for (const runId of runs) yield* broker.endRun(runId);
});

/** Native descendants share a run circuit until the owning thread is fully quiescent. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const subscription = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.session-set" ||
            event.type === "thread.turn-lifecycle-settled" ||
            event.type === "thread.turn-start-settled" ||
            event.type === "thread.deleted" ||
            (event.type === "thread.activity-appended" &&
              event.payload.activity.kind.startsWith("task.")),
        ),
        Stream.runForEach((event) =>
          releaseCompletedCadRuns(event.aggregateId as ThreadId).pipe(
            Effect.catch(() => Effect.logWarning("CAD renderer release remains pending")),
          ),
        ),
      ),
    );
  }),
);
