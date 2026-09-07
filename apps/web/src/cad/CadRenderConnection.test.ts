import { CadRenderError } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { connectCadRenderHost } from "./CadRenderConnection";

it.effect("recovers a replacement subscription that arrives before the old host disconnects", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const events: string[] = [];
    const result = yield* connectCadRenderHost(
      () =>
        ++attempts === 1
          ? Stream.fail(new CadRenderError({ reason: "busy" }))
          : Stream.succeed({ type: "ready" as const }),
      () => {
        events.push("create");
        return { accept: () => events.push("ready"), dispose: () => events.push("dispose") };
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust(1000);
    assert.deepEqual(yield* Fiber.join(result), [{ type: "ready" }]);
    assert.equal(attempts, 2);
    assert.deepEqual(events, ["create", "dispose", "create", "ready", "dispose"]);
  }),
);

it.effect("bounds handoff retries and does not retry unavailable or authorization failures", () =>
  Effect.gen(function* () {
    for (const reason of ["busy", "unavailable"] as const) {
      let attempts = 0,
        disposals = 0;
      const result = yield* connectCadRenderHost(
        () => {
          attempts++;
          return Stream.fail(new CadRenderError({ reason }));
        },
        () => ({
          accept: () => {},
          dispose: () => {
            disposals++;
          },
        }),
      ).pipe(Stream.runDrain, Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1000);
      assert.equal((yield* Fiber.join(result))._tag, "Failure");
      assert.equal(attempts, reason === "busy" ? 4 : 1);
      assert.equal(disposals, attempts);
    }
    let attempts = 0;
    yield* connectCadRenderHost(
      () => {
        attempts++;
        return Stream.fail({ _tag: "EnvironmentAuthorizationError" });
      },
      () => ({ accept: () => {}, dispose: () => {} }),
    ).pipe(Stream.runDrain, Effect.result);
    assert.equal(attempts, 1);
  }),
);

it.effect("cancels a delayed retry when its session is disposed", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const attempted = yield* Deferred.make<void>();
    const fiber = yield* connectCadRenderHost(
      () => {
        attempts++;
        return Stream.fromEffect(Deferred.succeed(attempted, undefined)).pipe(
          Stream.flatMap(() => Stream.fail(new CadRenderError({ reason: "busy" }))),
        );
      },
      () => ({ accept: () => {}, dispose: () => {} }),
    ).pipe(Stream.runDrain, Effect.forkChild);
    yield* Deferred.await(attempted);
    assert.equal(attempts, 1);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust(1000);
    assert.equal(attempts, 1);
  }),
);
