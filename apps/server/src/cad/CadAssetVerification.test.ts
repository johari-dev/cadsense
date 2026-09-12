import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { verifyCadAssets } from "./CadAssetVerification.ts";

const MiB = 1024 ** 2;

describe("verifyCadAssets", () => {
  it.effect("verifies four small assets concurrently while bounding declared bytes", () =>
    Effect.gen(function* () {
      const input = [1, 1, 1, 1, 128, 128, 20, 20, 8, 8, 8, 8, 8].map((n, id) => ({
        id,
        byteLength: n * MiB,
      }));
      const active = new Map<number, number>();
      const verified: number[] = [];
      let maximum = 0;
      yield* verifyCadAssets(input, (asset) =>
        Effect.gen(function* () {
          active.set(asset.id, asset.byteLength);
          maximum = Math.max(maximum, active.size);
          assert.isAtMost(active.size, 4);
          if (active.size > 1)
            assert.isAtMost(
              [...active.values()].reduce((sum, bytes) => sum + bytes, 0),
              32 * MiB,
            );
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          verified.push(asset.id);
          active.delete(asset.id);
        }),
      );
      assert.strictEqual(maximum, 4);
      assert.deepStrictEqual(
        verified.sort((a, b) => a - b),
        input.map((asset) => asset.id),
      );
      assert.strictEqual(active.size, 0);
    }),
  );

  for (const mode of ["failure", "cancellation"] as const)
    it.effect(`settles in-flight verification before releasing exclusion on ${mode}`, () =>
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const failure = yield* Deferred.make<void>();
        const started: number[] = [];
        const settled: number[] = [];
        let active = 0;
        const job = verifyCadAssets(
          Array.from({ length: 12 }, (_, id) => ({ id, byteLength: 1 })),
          (asset) =>
            Effect.gen(function* () {
              started.push(asset.id);
              active++;
              if (started.length === 4) yield* Deferred.succeed(entered, undefined);
              if (mode === "failure" && asset.id === 0) {
                yield* Deferred.await(failure);
                return yield* Effect.fail("corrupt");
              }
              yield* Deferred.await(release);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--;
                  settled.push(asset.id);
                }),
              ),
            ),
        );
        const fiber = yield* lock.withPermits(1)(job).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        let lockReleased = false;
        const observer = yield* lock
          .withPermits(1)(
            Effect.sync(() => {
              assert.strictEqual(active, 0);
              lockReleased = true;
            }),
          )
          .pipe(Effect.forkChild);
        const interrupt =
          mode === "cancellation"
            ? yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
            : undefined;
        if (mode === "failure") yield* Deferred.succeed(failure, undefined);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isFalse(lockReleased);
        assert.deepStrictEqual(started, [0, 1, 2, 3]);
        yield* Deferred.succeed(release, undefined);
        if (interrupt) yield* Fiber.join(interrupt);
        else yield* Fiber.await(fiber);
        yield* Fiber.join(observer);
        assert.isTrue(lockReleased);
        assert.strictEqual(active, 0);
        assert.deepStrictEqual(
          settled.sort((a, b) => a - b),
          [0, 1, 2, 3],
        );
        assert.deepStrictEqual(started, [0, 1, 2, 3]);
      }),
    );
});
