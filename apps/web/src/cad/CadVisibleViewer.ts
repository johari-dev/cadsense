import { createCadSceneRenderer, type CadSceneRendererOptions } from "./CadSceneRenderer";
import { cadDiagnostics } from "./CadDiagnostics";
import { isCadMemoryConstrained } from "./CadMemoryPolicy";

const IDLE_MS = 60_000;
type Callbacks = Pick<CadSceneRendererOptions, "onInteractionEnd" | "onUnavailable">;

/** One reserved visible canvas; scenes are bounded inside its renderer, never one GPU per thread. */
export function createCadVisibleViewer() {
  let resident: {
    environmentId: string;
    canvas: HTMLCanvasElement;
    renderer: ReturnType<typeof createCadSceneRenderer>;
    diagnostics: ReturnType<typeof cadDiagnostics.register>;
    callbacks: Callbacks | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  const clear = () => {
    if (!resident) return;
    if (resident.timer !== null) clearTimeout(resident.timer);
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
          resident = { environmentId, canvas, renderer, diagnostics, callbacks: null, timer: null };
          diagnostics.record({ type: "worker-count", workers: 1 });
        } catch (error) {
          canvas.remove();
          diagnostics.dispose();
          throw error;
        }
      }
      const current = resident;
      current.callbacks = callbacks;
      return {
        canvas: current.canvas,
        renderer: current.renderer,
        diagnostics: current.diagnostics,
        release() {
          if (resident !== current || current.callbacks !== callbacks) return;
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
