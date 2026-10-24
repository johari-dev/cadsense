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
import * as Option from "effect/Option";
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
 * A started sign-in, as returned to the registry. `finished` settles when the
 * login ends: it succeeds after `afterLogin` and fails when the login fails,
 * times out, or is cancelled by a newer attempt or a rebuild. The registry
 * refreshes the snapshot after success.
 */
export interface ProviderSignInHandle {
  readonly authUrl: string | null;
  readonly finished: Effect.Effect<void, ServerProviderSignInError>;
}

/**
 * `begin` starts the provider's login inside the attempt's scope, so any
 * child process it spawns lives until the login finishes. A new attempt
 * cancels the previous one. `afterLogin` runs after a successful login, for
 * driver cleanup such as dropping a cached auth probe.
 */
export const makeProviderSignIn = Effect.fn("makeProviderSignIn")(function* <E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly begin: Effect.Effect<ProviderSignInStart<E>, E, Scope.Scope>;
  readonly afterLogin: Effect.Effect<void>;
}) {
  const instanceScope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const currentAttempt = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const signInError = (reason: string, cause?: unknown) =>
    new ServerProviderSignInError({
      instanceId: input.instanceId,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  return gate.withPermit(
    Effect.gen(function* () {
      const previous = yield* Ref.get(currentAttempt);
      if (previous !== undefined) yield* Fiber.interrupt(previous);

      const started = yield* Deferred.make<string | null, ServerProviderSignInError>();
      const outcome = yield* Deferred.make<void, ServerProviderSignInError>();
      const attempt = yield* Effect.gen(function* () {
        const start = yield* input.begin.pipe(Effect.timeout(BEGIN_TIMEOUT));
        yield* Deferred.succeed(started, start.authUrl);
        yield* start.finished.pipe(Effect.timeout(SIGN_IN_TIMEOUT));
        yield* input.afterLogin;
      }).pipe(
        Effect.scoped,
        // Failing an already-settled Deferred is a no-op, so `started` keeps
        // its URL when only the later login fails.
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Deferred.succeed(outcome, undefined);
          const interrupted = Cause.hasInterruptsOnly(exit.cause);
          const error = signInError(
            interrupted
              ? `${input.providerLabel} sign-in was cancelled.`
              : `${input.providerLabel} sign-in did not finish.`,
            Cause.squash(exit.cause),
          );
          return Deferred.fail(started, error).pipe(
            Effect.andThen(Deferred.fail(outcome, error)),
            Effect.andThen(
              interrupted
                ? Effect.void
                : Effect.logWarning("Provider sign-in failed", {
                    instanceId: input.instanceId,
                    cause: Cause.pretty(exit.cause),
                  }),
            ),
          );
        }),
        Effect.ignoreCause,
        Effect.forkIn(instanceScope),
      );
      yield* Ref.set(currentAttempt, attempt);

      // A fiber forked into a scope that is already closing (an instance
      // rebuild) is interrupted before `onExit` runs, so each wait also
      // watches the fiber itself instead of trusting the Deferred alone.
      const awaitUnlessStopped = <A>(deferred: Deferred.Deferred<A, ServerProviderSignInError>) =>
        Effect.raceFirst(
          Deferred.await(deferred),
          Fiber.await(attempt).pipe(
            Effect.andThen(Deferred.poll(deferred)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(signInError(`${input.providerLabel} sign-in was cancelled.`)),
                onSome: (settled) => settled,
              }),
            ),
          ),
        );
      return {
        authUrl: yield* awaitUnlessStopped(started),
        finished: awaitUnlessStopped(outcome),
      } satisfies ProviderSignInHandle;
    }),
  );
});
