export interface CadDiagnosticEvent {
  readonly type:
    | "worker-count"
    | "capture"
    | "fallback"
    | "circuit-open"
    | "frame"
    | "context-loss";
  readonly workers?: number;
  readonly snapshotIds?: readonly string[];
  readonly milliseconds?: number;
  readonly cold?: boolean;
}

const percentile = (values: readonly number[]) => {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
};

/** Bounded local measurements. No polling, transport, or notification timer while diagnostics are closed. */
export function createCadDiagnostics() {
  const renderers = new Map<symbol, { workers: number; snapshots: readonly string[] }>();
  const frames: number[] = [],
    warm: number[] = [],
    cold: number[] = [];
  const listeners = new Set<() => void>();
  let contextLosses = 0,
    fallbacks = 0,
    circuits = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = () => ({
    renderers: [...renderers.values()].reduce((sum, item) => sum + item.workers, 0),
    snapshotIds: [...new Set([...renderers.values()].flatMap((item) => item.snapshots))],
    frameP95: percentile(frames),
    warmCaptureP95: percentile(warm),
    coldCaptureP95: percentile(cold),
    frameSamples: frames.length,
    warmSamples: warm.length,
    coldSamples: cold.length,
    contextLosses,
    fallbacks,
    circuits,
  });
  let snapshot = read();
  let dirty = false;
  const changed = () => {
    dirty = true;
    if (!listeners.size || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      snapshot = read();
      dirty = false;
      for (const listener of listeners) listener();
    }, 500);
  };
  const sample = (values: number[], value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    values.push(value);
    if (values.length > 128) values.shift();
  };
  return {
    getSnapshot: () => {
      if (dirty && timer === null) {
        snapshot = read();
        dirty = false;
      }
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
    register: () => {
      const id = Symbol();
      let open = true;
      renderers.set(id, { workers: 0, snapshots: [] });
      return {
        record: (event: CadDiagnosticEvent) => {
          if (!open) return;
          const previous = renderers.get(id)!;
          if (event.workers !== undefined || event.snapshotIds !== undefined)
            renderers.set(id, {
              workers: event.workers ?? previous.workers,
              snapshots: event.snapshotIds ?? previous.snapshots,
            });
          if (event.type === "frame") sample(frames, event.milliseconds);
          if (event.type === "capture") sample(event.cold ? cold : warm, event.milliseconds);
          if (event.type === "context-loss") contextLosses++;
          if (event.type === "fallback") fallbacks++;
          if (event.type === "circuit-open") circuits++;
          changed();
        },
        dispose: () => {
          open = false;
          renderers.delete(id);
          changed();
        },
      };
    },
  };
}

export const cadDiagnostics = createCadDiagnostics();
