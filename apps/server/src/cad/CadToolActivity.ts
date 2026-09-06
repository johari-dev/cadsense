import type { ThreadId, TurnId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface CadToolActivityState {
  readonly agentControlling: boolean;
  readonly agentActivityTurnId: TurnId | null;
}

/** Counts tool calls, not viewer activations, which stay open throughout an agent turn. */
export const makeCadToolActivity = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make(
    new Map<ThreadId, { count: number; turnId: TurnId | null }>(),
  );
  const track = <A, E, R>(
    threadId: ThreadId,
    turnId: TurnId | undefined,
    call: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      SubscriptionRef.update(state, (current) =>
        new Map(current).set(threadId, {
          count: (current.get(threadId)?.count ?? 0) + 1,
          turnId: turnId ?? current.get(threadId)?.turnId ?? null,
        }),
      ),
      () => call,
      () =>
        SubscriptionRef.update(state, (current) => {
          const entry = current.get(threadId);
          return entry
            ? new Map(current).set(threadId, { ...entry, count: entry.count - 1 })
            : current;
        }),
    );
  const watch = (threadId: ThreadId): Stream.Stream<CadToolActivityState> =>
    SubscriptionRef.changes(state).pipe(
      Stream.map((current) => ({
        agentControlling: (current.get(threadId)?.count ?? 0) > 0,
        agentActivityTurnId: current.get(threadId)?.turnId ?? null,
      })),
      Stream.changesWith(
        (left, right) =>
          left.agentControlling === right.agentControlling &&
          left.agentActivityTurnId === right.agentActivityTurnId,
      ),
    );
  return { track, watch };
});
