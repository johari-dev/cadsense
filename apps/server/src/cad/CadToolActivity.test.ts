import { ThreadId, TurnId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeCadToolActivity } from "./CadToolActivity.ts";

const thread = ThreadId.make("cad-activity-thread");
const turn = TurnId.make("cad-activity-turn");

it.effect("counts concurrent tools until the last call ends and isolates threads", () =>
  Effect.gen(function* () {
    const activity = yield* makeCadToolActivity;
    const read = () => activity.watch(thread).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* activity
      .track(
        thread,
        turn,
        Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const second = yield* activity
      .track(
        thread,
        turn,
        Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(secondStarted);
    assert.isTrue((yield* read()).agentControlling);
    const other = yield* activity
      .watch(ThreadId.make("other"))
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.deepEqual(other, { agentControlling: false, agentActivityTurnId: null });
    yield* Fiber.interrupt(first);
    assert.isTrue((yield* read()).agentControlling);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(second);
    assert.deepEqual(yield* read(), { agentControlling: false, agentActivityTurnId: turn });
  }),
);

it.effect("publishes fast call edges and retains the last used turn for late subscribers", () =>
  Effect.gen(function* () {
    const activity = yield* makeCadToolActivity;
    const ready = yield* Deferred.make<void>();
    const observed = yield* activity.watch(thread).pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* activity.track(thread, turn, Effect.void);
    assert.deepEqual(yield* Fiber.join(observed), [
      { agentControlling: false, agentActivityTurnId: null },
      { agentControlling: true, agentActivityTurnId: turn },
      { agentControlling: false, agentActivityTurnId: turn },
    ]);
    const last = yield* activity.watch(thread).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.equal(last.agentActivityTurnId, turn);
  }),
);

it.effect("clears activity after tool failures", () =>
  Effect.gen(function* () {
    const activity = yield* makeCadToolActivity;
    yield* activity.track(thread, turn, Effect.fail("failed")).pipe(Effect.flip);
    const last = yield* activity.watch(thread).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.deepEqual(last, { agentControlling: false, agentActivityTurnId: turn });
  }),
);
