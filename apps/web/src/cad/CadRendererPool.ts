import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import type { ResolvedCadCamera } from "./CadSceneModel";
import { CadRendererError } from "./CadRendererError";

export interface CadRenderJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly manifest: CadSnapshotManifest;
  readonly state: CadViewState;
  readonly width: number;
  readonly height: number;
}
export interface CadRenderResult {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly revision: number;
  readonly pose: ResolvedCadCamera;
  readonly png: Blob;
}
export interface CadRenderWorker {
  readonly mode: "offscreen" | "main-thread";
  capture(job: CadRenderJob): Promise<CadRenderResult>;
  dispose(): void;
}
export interface CadRendererPoolOptions {
  readonly createWorker: () => Promise<CadRenderWorker>;
  readonly isCurrent: (job: CadRenderJob) => boolean;
  readonly onDiagnostic?: (event: {
    type: "worker-count" | "capture" | "fallback" | "circuit-open";
    workers: number;
    snapshotId?: string;
    milliseconds?: number;
    cold?: boolean;
    snapshotIds?: readonly string[];
  }) => void;
  readonly clock?: {
    now(): number;
    schedule(callback: () => void, milliseconds: number): () => void;
  };
}
const defaultClock = {
  now: () => performance.now(),
  schedule: (callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
const MAX_PENDING_JOBS = 64;
const MAX_SESSION_JOBS = 8;
interface Pending {
  job: CadRenderJob;
  resolve(value: CadRenderResult): void;
  reject(error: CadRendererError): void;
  settled: boolean;
  detach(): void;
}
interface Slot {
  worker: CadRenderWorker | null;
  pending: Pending | null;
  snapshotId: string | null;
  runId: string | null;
  cancelIdle: (() => void) | null;
  removed: boolean;
}

/** Bounded round-robin scheduling; the reserved visible renderer is never part of this module. */
export const createCadRendererPool = (options: CadRendererPoolOptions) => {
  const clock = options.clock ?? defaultClock;
  const queues = new Map<string, Pending[]>();
  const ready: string[] = [];
  const active = new Map<string, Pending>();
  const slots = new Set<Slot>();
  const circuits = new Set<string>();
  const jobIds = new Set<string>();
  let disposed = false,
    backgrounded = false,
    pressure = false,
    ceiling = 2;
  const diagnostic = (type: "worker-count" | "fallback" | "circuit-open", snapshotId?: string) =>
    options.onDiagnostic?.({
      type,
      workers: slots.size,
      snapshotIds: [...slots].flatMap((slot) => (slot.snapshotId ? [slot.snapshotId] : [])),
      ...(snapshotId ? { snapshotId } : {}),
    });
  const settle = (pending: Pending, result: CadRenderResult | CadRendererError) => {
    if (pending.settled) return;
    pending.settled = true;
    pending.detach();
    jobIds.delete(pending.job.jobId);
    if (result instanceof CadRendererError) pending.reject(result);
    else pending.resolve(result);
  };
  const remove = (slot: Slot) => {
    if (slot.removed) return;
    slot.removed = true;
    slot.cancelIdle?.();
    slot.worker?.dispose();
    slot.worker = null;
    slots.delete(slot);
    diagnostic("worker-count");
  };
  const capacity = () => (pressure || backgrounded ? 1 : ceiling);
  const next = () => {
    for (let count = ready.length; count > 0; count--) {
      const id = ready.shift()!;
      const queue = queues.get(id)!;
      while (queue[0]?.settled) queue.shift();
      if (queue.length === 0) {
        queues.delete(id);
        continue;
      }
      if (active.has(id)) {
        ready.push(id);
        continue;
      }
      const pending = queue.shift()!;
      if (queue.length > 0) ready.push(id);
      else queues.delete(id);
      return pending;
    }
    return null;
  };
  const execute = async (slot: Slot, pending: Pending) => {
    const { job } = pending;
    const start = clock.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (pending.settled || disposed || slot.removed) return;
        if (circuits.has(job.runId)) throw new CadRendererError("renderer-unavailable");
        if (!options.isCurrent(job)) throw new CadRendererError("superseded");
        let creating = slot.worker === null;
        try {
          if (!slot.worker) {
            const worker = await options.createWorker();
            if (slot.removed || pending.settled || disposed) {
              worker.dispose();
              return;
            }
            slot.worker = worker;
            if (worker.mode === "main-thread") {
              ceiling = 1;
              diagnostic("fallback");
            }
            pump();
          }
          creating = false;
          const cold = slot.snapshotId !== job.state.snapshotId;
          const result = await slot.worker.capture(job);
          if (pending.settled || slot.removed || disposed) return;
          if (
            !options.isCurrent(job) ||
            result.jobId !== job.jobId ||
            result.snapshotId !== job.state.snapshotId ||
            result.revision !== job.state.revision
          )
            throw new CadRendererError("superseded");
          slot.snapshotId = job.state.snapshotId;
          slot.runId = job.runId;
          settle(pending, result);
          options.onDiagnostic?.({
            type: "capture",
            workers: slots.size,
            snapshotId: job.state.snapshotId,
            milliseconds: clock.now() - start,
            cold,
            snapshotIds: [...slots].flatMap((slot) => (slot.snapshotId ? [slot.snapshotId] : [])),
          });
          return;
        } catch (error) {
          if (creating && slots.size > 1 && !pending.settled && !disposed) {
            ceiling = 1;
            remove(slot);
            diagnostic("fallback");
            const queue = queues.get(job.sessionId);
            if (queue) queue.unshift(pending);
            else {
              queues.set(job.sessionId, [pending]);
              ready.push(job.sessionId);
            }
            return;
          }
          slot.worker?.dispose();
          slot.worker = null;
          slot.snapshotId = null;
          diagnostic("worker-count");
          if (pending.settled || disposed || slot.removed) return;
          if (
            error instanceof CadRendererError &&
            (error.reason === "superseded" ||
              error.reason === "invalid-view" ||
              error.reason === "invalid-snapshot")
          )
            throw error;
          if (attempt === 1) {
            circuits.add(job.runId);
            diagnostic("circuit-open", job.state.snapshotId);
            throw new CadRendererError("renderer-unavailable");
          }
        }
      }
    } catch (error) {
      settle(
        pending,
        error instanceof CadRendererError ? error : new CadRendererError("renderer-unavailable"),
      );
    } finally {
      if (active.get(job.sessionId) === pending) active.delete(job.sessionId);
      slot.pending = null;
      const readyIndex = ready.indexOf(job.sessionId);
      if (readyIndex >= 0) {
        ready.splice(readyIndex, 1);
        ready.push(job.sessionId);
      }
      if (!slot.removed) {
        if (disposed || backgrounded || pressure || !slot.worker) remove(slot);
        else
          slot.cancelIdle = clock.schedule(() => {
            remove(slot);
            pump();
          }, 15_000);
      }
      pump();
    }
  };
  const pump = () => {
    if (disposed) return;
    while (true) {
      let slot = [...slots].find((candidate) => candidate.pending === null);
      if (
        !slot &&
        (slots.size >= capacity() ||
          (slots.size > 0 && ![...slots].some((candidate) => candidate.worker !== null)))
      )
        return;
      const pending = next();
      if (!pending) return;
      if (!slot) {
        slot = {
          worker: null,
          pending: null,
          snapshotId: null,
          runId: null,
          cancelIdle: null,
          removed: false,
        };
        slots.add(slot);
        diagnostic("worker-count");
      }
      slot.cancelIdle?.();
      slot.cancelIdle = null;
      slot.pending = pending;
      active.set(pending.job.sessionId, pending);
      void execute(slot, pending);
    }
  };
  const cancelWhere = (matches: (job: CadRenderJob) => boolean) => {
    for (const queue of queues.values())
      for (const pending of queue)
        if (matches(pending.job)) settle(pending, new CadRendererError("superseded"));
    for (const slot of slots)
      if (slot.pending && matches(slot.pending.job)) {
        settle(slot.pending, new CadRendererError("superseded"));
        active.delete(slot.pending.job.sessionId);
        remove(slot);
      }
    pump();
  };
  return {
    capture: (input: CadRenderJob, signal?: AbortSignal): Promise<CadRenderResult> => {
      if (disposed || circuits.has(input.runId))
        return Promise.reject(new CadRendererError("renderer-unavailable"));
      if (
        jobIds.has(input.jobId) ||
        input.state.snapshotId !== input.manifest.snapshotId ||
        input.state.rootId !== input.manifest.rootId
      )
        return Promise.reject(new CadRendererError("invalid-view"));
      if (signal?.aborted) return Promise.reject(new CadRendererError("superseded"));
      const sessionJobs =
        (queues.get(input.sessionId)?.filter((pending) => !pending.settled).length ?? 0) +
        Number(active.has(input.sessionId));
      if (jobIds.size >= MAX_PENDING_JOBS || sessionJobs >= MAX_SESSION_JOBS)
        return Promise.reject(new CadRendererError("renderer-busy"));
      // Semantic state is small and private; the immutable manifest remains shared.
      const job = { ...input, state: structuredClone(input.state) };
      return new Promise((resolve, reject) => {
        const abort = () => cancelWhere((candidate) => candidate.jobId === job.jobId);
        const pending: Pending = {
          job,
          resolve,
          reject,
          settled: false,
          detach: () => signal?.removeEventListener("abort", abort),
        };
        signal?.addEventListener("abort", abort, { once: true });
        jobIds.add(job.jobId);
        const queue = queues.get(job.sessionId);
        if (queue) queue.push(pending);
        else {
          queues.set(job.sessionId, [pending]);
          ready.push(job.sessionId);
        }
        pump();
      });
    },
    setPolicy: (policy: { backgrounded: boolean; memoryPressure: boolean }) => {
      backgrounded = policy.backgrounded;
      pressure = policy.memoryPressure;
      if (backgrounded || pressure) for (const slot of slots) if (!slot.pending) remove(slot);
      pump();
    },
    releaseSnapshot: (snapshotId: string) => {
      cancelWhere((job) => job.state.snapshotId === snapshotId);
      for (const slot of slots) if (slot.snapshotId === snapshotId && !slot.pending) remove(slot);
    },
    endRun: (runId: string) => {
      cancelWhere((job) => job.runId === runId);
      circuits.delete(runId);
      for (const slot of slots) if (slot.runId === runId && !slot.pending) remove(slot);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelWhere(() => true);
      for (const slot of slots) remove(slot);
      queues.clear();
      ready.length = 0;
      circuits.clear();
    },
  };
};
