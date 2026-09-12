import type { CadSnapshotManifest } from "@cadsense/contracts";
import {
  createCadSceneRenderer,
  type CadSceneRenderer,
  type CadSceneRendererOptions,
} from "./CadSceneRenderer";
import { cadDiagnostics } from "./CadDiagnostics";
import { isCadMemoryConstrained } from "./CadMemoryPolicy";

// A full robot can take tens of seconds and hundreds of MB to reload. Keep the single bounded
// renderer through ordinary review/navigation breaks; constrained devices still release at once.
const IDLE_MS = 5 * 60_000;
type Callbacks = Pick<CadSceneRendererOptions, "onInteractionEnd" | "onUnavailable">;
export type CadVisibleLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly received: number; readonly total: number | null }
  | { readonly status: "ready"; readonly manifest: CadSnapshotManifest }
  | { readonly status: "failure" };
export type CadVisibleLoadRunner = (
  renderer: CadSceneRenderer,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
) => Promise<CadSnapshotManifest>;
type LoadRequest = {
  readonly sourceKey: string;
  readonly releaseTicket: () => void;
  readonly run: CadVisibleLoadRunner;
};
type LoadSession = {
  readonly snapshotId: string;
  sourceKey: string | null;
  state: CadVisibleLoadState;
  controller: AbortController | null;
  releaseTicket: (() => void) | null;
  retry: LoadRequest | null;
  readonly listeners: Set<(state: CadVisibleLoadState) => void>;
};

/** One reserved visible canvas; scenes are bounded inside its renderer, never one GPU per thread. */
export function createCadVisibleViewer() {
  let resident: {
    environmentId: string;
    canvas: HTMLCanvasElement;
    renderer: ReturnType<typeof createCadSceneRenderer>;
    diagnostics: ReturnType<typeof cadDiagnostics.register>;
    callbacks: Callbacks | null;
    timer: ReturnType<typeof setTimeout> | null;
    load: LoadSession | null;
  } | null = null;
  const notify = (session: LoadSession, state: CadVisibleLoadState) => {
    session.state = state;
    for (const listener of session.listeners) listener(state);
  };
  const finishAttempt = (session: LoadSession, abort: boolean) => {
    const controller = session.controller;
    session.controller = null;
    if (abort) controller?.abort();
    const releaseTicket = session.releaseTicket;
    session.releaseTicket = null;
    releaseTicket?.();
  };
  const cancelSession = (current: NonNullable<typeof resident>, session: LoadSession) => {
    const running = session.controller !== null;
    finishAttempt(session, true);
    session.retry?.releaseTicket();
    session.retry = null;
    if (running) current.renderer.cancelLoad();
  };
  const start = (
    current: NonNullable<typeof resident>,
    session: LoadSession,
    request: LoadRequest,
  ) => {
    const controller = new AbortController();
    session.sourceKey = request.sourceKey;
    session.controller = controller;
    session.retry = null;
    session.releaseTicket = request.releaseTicket;
    notify(session, { status: "loading", received: 0, total: null });
    void (async () => {
      try {
        const manifest = await request.run(
          current.renderer,
          controller.signal,
          (received, total) => {
            if (
              resident === current &&
              current.load === session &&
              session.controller === controller &&
              !controller.signal.aborted
            )
              notify(session, { status: "loading", received, total });
          },
        );
        if (
          resident !== current ||
          current.load !== session ||
          session.controller !== controller ||
          controller.signal.aborted
        )
          return;
        finishAttempt(session, false);
        session.retry?.releaseTicket();
        session.retry = null;
        notify(session, { status: "ready", manifest });
      } catch {
        if (
          resident !== current ||
          current.load !== session ||
          session.controller !== controller ||
          controller.signal.aborted
        )
          return;
        finishAttempt(session, false);
        const retry = session.retry;
        session.retry = null;
        if (retry && retry.sourceKey !== request.sourceKey) start(current, session, retry);
        else notify(session, { status: "failure" });
      }
    })();
  };
  const selectSession = (current: NonNullable<typeof resident>, snapshotId: string) => {
    if (current.load?.snapshotId === snapshotId) return current.load;
    if (current.load) cancelSession(current, current.load);
    const displayed = current.renderer.displayedManifest();
    current.load = {
      snapshotId,
      sourceKey: null,
      state:
        displayed?.snapshotId === snapshotId
          ? { status: "ready", manifest: displayed }
          : { status: "idle" },
      controller: null,
      releaseTicket: null,
      retry: null,
      listeners: new Set(),
    };
    return current.load;
  };
  const clear = () => {
    if (!resident) return;
    if (resident.timer !== null) clearTimeout(resident.timer);
    if (resident.load) cancelSession(resident, resident.load);
    resident.renderer.dispose();
    resident.canvas.remove();
    resident.diagnostics.dispose();
    resident = null;
  };
  return {
    clear,
    hasResident: (environmentId: string) => resident?.environmentId === environmentId,
    peek: (environmentId: string, snapshotId: string) =>
      resident?.environmentId === environmentId
        ? resident.renderer.cachedManifest(snapshotId)
        : null,
    acquire(container: HTMLElement, environmentId: string, callbacks: Callbacks) {
      const constrained = isCadMemoryConstrained(
        Reflect.get(navigator, "deviceMemory"),
        Reflect.get(performance, "memory"),
      );
      if (resident?.callbacks) throw new Error("The visible CAD renderer is already attached");
      if (resident && (resident.environmentId !== environmentId || constrained)) clear();
      if (resident) {
        if (resident.timer !== null) clearTimeout(resident.timer);
        resident.timer = null;
        container.append(resident.canvas);
        try {
          resident.renderer.resume();
        } catch {
          clear();
        }
      }
      if (!resident) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-label", "CAD viewer");
        canvas.className = "h-full w-full touch-none";
        container.append(canvas);
        const diagnostics = cadDiagnostics.register();
        try {
          const renderer = createCadSceneRenderer({
            canvas,
            cacheScenes: !constrained,
            onFrame: (milliseconds) => diagnostics.record({ type: "frame", milliseconds }),
            onContextLost: () => diagnostics.record({ type: "context-loss" }),
            onInteractionEnd: (pose) => resident?.callbacks?.onInteractionEnd?.(pose),
            onUnavailable: (error) => resident?.callbacks?.onUnavailable?.(error),
          });
          resident = {
            environmentId,
            canvas,
            renderer,
            diagnostics,
            callbacks: null,
            timer: null,
            load: null,
          };
          diagnostics.record({ type: "worker-count", workers: 1 });
        } catch (error) {
          canvas.remove();
          diagnostics.dispose();
          throw error;
        }
      }
      const current = resident;
      current.callbacks = callbacks;
      const observers = new Set<() => void>();
      return {
        canvas: current.canvas,
        renderer: current.renderer,
        diagnostics: current.diagnostics,
        watchLoad(snapshotId: string, listener: (state: CadVisibleLoadState) => void) {
          const session = selectSession(current, snapshotId);
          session.listeners.add(listener);
          listener(session.state);
          const stop = () => session.listeners.delete(listener);
          observers.add(stop);
          return () => {
            observers.delete(stop);
            stop();
          };
        },
        ensureLoad(
          snapshotId: string,
          sourceKey: string,
          retain: () => () => void,
          run: CadVisibleLoadRunner,
        ) {
          const session = selectSession(current, snapshotId);
          if (session.state.status === "ready") return;
          if (session.controller && session.sourceKey === sourceKey) return;
          let releaseTicket: () => void;
          try {
            releaseTicket = retain();
          } catch {
            notify(session, { status: "failure" });
            return;
          }
          const request = { sourceKey, releaseTicket, run };
          if (session.controller) {
            session.retry?.releaseTicket();
            session.retry = request;
            return;
          }
          start(current, session, request);
        },
        release() {
          if (resident !== current || current.callbacks !== callbacks) return;
          for (const stop of observers) stop();
          observers.clear();
          current.callbacks = null;
          current.renderer.suspend();
          current.canvas.remove();
          if (constrained) {
            clear();
            return;
          }
          current.timer = setTimeout(clear, IDLE_MS);
        },
      };
    },
  };
}

export const cadVisibleViewer = createCadVisibleViewer();
if (import.meta.hot) import.meta.hot.dispose(() => cadVisibleViewer.clear());
