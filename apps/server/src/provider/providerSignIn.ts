/**
 * One browser sign-in at a time for a provider instance.
 *
 * Drivers call `makeProviderSignIn` inside their `create` scope and expose
 * the result as `ProviderInstance.signIn`. Each attempt runs in a fiber owned
 * by the instance, so it outlives the RPC that started it and ends when the
 * instance is rebuilt or removed.
 *
 * @module provider/providerSignIn
 */
import { ServerProviderSignInError, type ProviderInstanceId } from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const BEGIN_TIMEOUT = "30 seconds";
const SIGN_IN_TIMEOUT = "15 minutes";

export interface ProviderSignInStart<E> {
  /** URL for the client to open, or null when the CLI opens the browser itself. */
  readonly authUrl: string | null;
  /** Waits until the login finishes. Fails when the provider reports a failed login. */
  readonly finished: Effect.Effect<void, E>;
}

/**
 * `begin` starts the provider's login inside the attempt's scope, so any
 * child process it spawns lives until the login finishes. A new attempt
 * cancels the previous one. After a successful login, `refresh` re-probes the
 * instance so its snapshot shows the new auth status.
 */
export const makeProviderSignIn = Effect.fn("makeProviderSignIn")(function* <E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly begin: Effect.Effect<ProviderSignInStart<E>, E, Scope.Scope>;
  readonly refresh: Effect.Effect<unknown>;
}) {
  const instanceScope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const currentAttempt = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);

  return gate.withPermit(
    Effect.gen(function* () {
      const previous = yield* Ref.get(currentAttempt);
      if (previous !== undefined) yield* Fiber.interrupt(previous);

      const started = yield* Deferred.make<string | null, ServerProviderSignInError>();
      const attempt = yield* Effect.gen(function* () {
        const start = yield* input.begin.pipe(Effect.timeout(BEGIN_TIMEOUT));
        yield* Deferred.succeed(started, start.authUrl);
        yield* start.finished.pipe(Effect.timeout(SIGN_IN_TIMEOUT));
        yield* input.refresh;
      }).pipe(
        Effect.scoped,
        // Settle `started` on every failure, including interruption by a
        // rebuild, so the RPC waiting on it never hangs. Failing an
        // already-settled Deferred is a no-op.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Deferred.fail(
                started,
                new ServerProviderSignInError({
                  instanceId: input.instanceId,
                  reason: `Could not start ${input.providerLabel} sign-in.`,
                  cause: Cause.squash(exit.cause),
                }),
              ).pipe(
                Effect.andThen(
                  Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.void
                    : Effect.logWarning("Provider sign-in failed", {
                        instanceId: input.instanceId,
                        cause: Cause.pretty(exit.cause),
                      }),
                ),
              ),
        ),
        Effect.ignoreCause,
        Effect.forkIn(instanceScope),
      );
      yield* Ref.set(currentAttempt, attempt);
      return { authUrl: yield* Deferred.await(started) };
    }),
  );
});
