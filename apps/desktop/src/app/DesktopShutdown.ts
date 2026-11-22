import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Where the app is on its way out.
 *
 * - `running`: normal operation.
 * - `installingUpdate`: the updater is stopping backends and handing off to
 *   `quitAndInstall`. A failed or interrupted install returns to `running`.
 * - `quitting`: a quit, relaunch, signal, or fatal startup error has begun.
 *   Nothing leaves this phase.
 *
 * Callers treat any phase other than `running` as "the app is going away".
 */
export type DesktopShutdownPhase = "running" | "installingUpdate" | "quitting";

export class DesktopShutdown extends Context.Service<
  DesktopShutdown,
  {
    readonly request: Effect.Effect<void>;
    readonly awaitRequest: Effect.Effect<void>;
    readonly markComplete: Effect.Effect<void>;
    readonly awaitComplete: Effect.Effect<void>;
    readonly isComplete: Effect.Effect<boolean>;
    readonly phase: Effect.Effect<DesktopShutdownPhase>;
    /**
     * Moves `running` to `quitting` and returns true. Returns false and leaves
     * the phase alone when a quit or update install already owns the exit.
     * Only the first caller gets true.
     */
    readonly beginQuit: Effect.Effect<boolean>;
    /** Moves `running` to `installingUpdate`. Returns false from any other phase. */
    readonly beginUpdateInstall: Effect.Effect<boolean>;
    /**
     * Returns a failed or interrupted update install to `running`. Does nothing
     * outside `installingUpdate`, so it cannot undo a real quit.
     */
    readonly cancelUpdateInstall: Effect.Effect<void>;
  }
>()("@cadsense/desktop/app/DesktopShutdown") {}

const make = Effect.gen(function* () {
  const requested = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const completedRef = yield* Ref.make(false);
  const phaseRef = yield* Ref.make<DesktopShutdownPhase>("running");

  // Atomically moves `from` to `to`; returns whether the move happened.
  const transition = (from: DesktopShutdownPhase, to: DesktopShutdownPhase) =>
    Ref.modify(phaseRef, (current) => (current === from ? [true, to] : [false, current]));

  return DesktopShutdown.of({
    request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
    markComplete: Ref.set(completedRef, true).pipe(
      Effect.andThen(Deferred.succeed(completed, undefined)),
      Effect.asVoid,
    ),
    awaitComplete: Deferred.await(completed),
    isComplete: Ref.get(completedRef),
    phase: Ref.get(phaseRef),
    beginQuit: transition("running", "quitting"),
    beginUpdateInstall: transition("running", "installingUpdate"),
    cancelUpdateInstall: transition("installingUpdate", "running").pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(DesktopShutdown, make);
