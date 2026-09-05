import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CadRendererError } from "./CadSceneModel";
import {
  createCadRendererPool,
  type CadRenderJob,
  type CadRenderResult,
  type CadRenderWorker,
} from "./CadRendererPool";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: "1".repeat(64),
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: "https://cad.onshape.com",
    documentId: "1".repeat(24),
    elementId: "2".repeat(24),
    kind: "part-studio",
    originalRevision: { kind: "m", id: "3".repeat(24) },
    microversionId: "3".repeat(24),
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [],
  parts: [],
  assets: [],
  dependencies: [],
});
const state: CadViewState = {
  rootId: snapshot.rootId,
  snapshotId: snapshot.snapshotId,
  revision: 0,
  camera: { kind: "preset", preset: "isometric", fit: [] },
  visibility: {},
  isolatedOccurrenceIds: [],
  explosion: 0,
};
const job = (id: string, sessionId = id, runId = "run"): CadRenderJob => ({
  jobId: id,
  sessionId,
  runId,
  manifest: snapshot,
  state,
  width: 960,
  height: 720,
});
const result = (job: CadRenderJob): CadRenderResult => ({
  jobId: job.jobId,
  snapshotId: job.state.snapshotId,
  revision: job.state.revision,
  pose: {
    position: [1, -1, 1],
    target: [0, 0, 0],
    up: [0, 0, 1],
    projection: "perspective",
    zoom: 1,
  },
  png: new Blob(["png"], { type: "image/png" }),
});
const harness = (mode: CadRenderWorker["mode"] = "offscreen") => {
  const workers: { disposed: boolean }[] = [];
  const starts = new Map<string, ReturnType<typeof deferred<CadRenderJob>>>();
  const completions = new Map<string, ReturnType<typeof deferred<CadRenderResult>>>();
  const counts = new Map<string, number>();
  const timers = new Set<() => void>();
  let current = true;
  const started = (id: string, attempt = 0) => {
    const key = `${id}:${attempt}`;
    let receipt = starts.get(key);
    if (!receipt) {
      receipt = deferred<CadRenderJob>();
      starts.set(key, receipt);
    }
    return receipt;
  };
  const pool = createCadRendererPool({
    isCurrent: () => current,
    clock: {
      now: () => 0,
      schedule: (callback, ms) => {
        expect(ms).toBe(15_000);
        timers.add(callback);
        return () => {
          timers.delete(callback);
        };
      },
    },
    createWorker: async () => {
      const record = { disposed: false };
      workers.push(record);
      return {
        mode,
        dispose: () => {
          record.disposed = true;
        },
        capture: (job) => {
          const attempt = counts.get(job.jobId) ?? 0;
          counts.set(job.jobId, attempt + 1);
          const completion = deferred<CadRenderResult>();
          completions.set(`${job.jobId}:${attempt}`, completion);
          started(job.jobId, attempt).resolve(job);
          return completion.promise;
        },
      };
    },
  });
  return {
    pool,
    workers,
    counts,
    started: (id: string, attempt = 0) => started(id, attempt).promise,
    finish: async (id: string, attempt = 0) => {
      const input = await started(id, attempt).promise;
      completions.get(`${id}:${attempt}`)!.resolve(result(input));
    },
    fail: async (id: string, attempt = 0) => {
      await started(id, attempt).promise;
      completions.get(`${id}:${attempt}`)!.reject(new CadRendererError("capture-failed"));
    },
    expire: () => {
      const pending = [...timers];
      timers.clear();
      pending.forEach((callback) => callback());
    },
    makeStale: () => {
      current = false;
    },
  };
};

describe("CAD background renderer pool", () => {
  it("is lazy, limits concurrent distinct sessions to two, and retains per-session FIFO", async () => {
    const h = harness();
    expect(h.workers).toHaveLength(0);
    const a = h.pool.capture(job("a", "same"));
    await h.started("a");
    const a2 = h.pool.capture(job("a2", "same"));
    expect(h.workers).toHaveLength(1);
    const b = h.pool.capture(job("b"));
    await h.started("b");
    const c = h.pool.capture(job("c"));
    expect(h.workers).toHaveLength(2);
    await h.finish("a");
    await a;
    await h.started("c");
    expect(h.counts.has("a2")).toBe(false);
    await h.finish("b");
    await b;
    await h.started("a2");
    await h.finish("a2");
    await a2;
    await h.finish("c");
    await c;
    expect(h.workers).toHaveLength(2);
    h.pool.dispose();
  });
  it("serialized fallback is fair across sessions and expires warm workers after 15 seconds", async () => {
    const h = harness("main-thread");
    const a = h.pool.capture(job("a", "A"));
    await h.started("a");
    const a2 = h.pool.capture(job("a2", "A"));
    const b = h.pool.capture(job("b", "B"));
    await h.finish("a");
    await a;
    await h.started("b");
    expect(h.counts.has("a2")).toBe(false);
    await h.finish("b");
    await b;
    await h.finish("a2");
    await a2;
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.disposed).toBe(false);
    h.expire();
    expect(h.workers[0]!.disposed).toBe(true);
    h.pool.dispose();
  });
  it("retries once cold at the exact immutable state then opens a run-scoped circuit", async () => {
    const h = harness();
    const capture = h.pool.capture(job("a"));
    const rejected = expect(capture).rejects.toMatchObject({ reason: "renderer-unavailable" });
    const first = await h.started("a");
    await h.fail("a");
    const second = await h.started("a", 1);
    expect(second).toEqual(first);
    expect(h.workers[0]!.disposed).toBe(true);
    await h.fail("a", 1);
    await rejected;
    await expect(h.pool.capture(job("b"))).rejects.toMatchObject({
      reason: "renderer-unavailable",
    });
    expect(h.workers).toHaveLength(2);
    h.pool.endRun("run");
    const next = h.pool.capture(job("c"));
    await h.finish("c");
    await next;
    h.pool.dispose();
  });
  it("clones semantic input and discards obsolete results without cold retry", async () => {
    const h = harness();
    const visibility: Record<string, boolean> = {};
    const mutable = { ...structuredClone(state), visibility };
    const capture = h.pool.capture({ ...job("a"), state: mutable });
    const rejected = expect(capture).rejects.toMatchObject({ reason: "superseded" });
    mutable.visibility["2".repeat(64)] = false;
    const received = await h.started("a");
    expect(received.state.visibility).toEqual({});
    h.makeStale();
    await h.finish("a");
    await rejected;
    expect(h.workers).toHaveLength(1);
    h.pool.dispose();
  });
  it("aborts active jobs and rejects late completion without disturbing the replacement", async () => {
    const h = harness();
    const controller = new AbortController();
    const capture = h.pool.capture(job("a", "same"), controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ reason: "superseded" });
    await h.started("a");
    controller.abort();
    await rejected;
    const replacement = h.pool.capture(job("b", "same"));
    await h.started("b");
    await h.finish("a");
    await h.finish("b");
    await replacement;
    h.pool.dispose();
  });
  it("backgrounding drains and evicts without preventing agents from capturing", async () => {
    const h = harness();
    const a = h.pool.capture(job("a"));
    await h.started("a");
    h.pool.setPolicy({ backgrounded: true, memoryPressure: false });
    const b = h.pool.capture(job("b"));
    await h.finish("a");
    await a;
    expect(h.workers[0]!.disposed).toBe(true);
    await h.finish("b");
    await b;
    expect(h.workers.every((worker) => worker.disposed)).toBe(true);
    h.pool.dispose();
  });
  it("bounds each session queue and releases capacity when queued work is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    const captures = Array.from({ length: 8 }, (_, index) =>
      h.pool.capture(job(`bounded-${index}`, "same"), controller.signal),
    );
    const settled = Promise.allSettled(captures);
    await h.started("bounded-0");
    await expect(h.pool.capture(job("overflow", "same"))).rejects.toMatchObject({
      reason: "renderer-busy",
    });
    controller.abort();
    await settled;
    const replacement = h.pool.capture(job("replacement", "same"));
    await h.finish("replacement");
    await replacement;
    h.pool.dispose();
  });
  it("pressure drains existing jobs safely and prevents a second worker", async () => {
    const h = harness();
    h.pool.setPolicy({ backgrounded: false, memoryPressure: true });
    const a = h.pool.capture(job("a"));
    await h.started("a");
    const b = h.pool.capture(job("b"));
    expect(h.workers).toHaveLength(1);
    await h.finish("a");
    await a;
    await h.finish("b");
    await b;
    expect(h.workers.every((worker) => worker.disposed)).toBe(true);
    h.pool.dispose();
  });
});
