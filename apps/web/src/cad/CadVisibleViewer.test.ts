import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createCadVisibleViewer } from "./CadVisibleViewer";

const graphics = vi.hoisted(() => ({ created: 0, disposed: 0, cancelled: 0 }));
vi.mock("./CadSceneRenderer", () => ({
  createCadSceneRenderer: () => {
    graphics.created++;
    return {
      suspend() {},
      resume() {},
      cachedManifest: () => null,
      displayedManifest: () => null,
      cancelLoad() {
        graphics.cancelled++;
      },
      dispose() {
        graphics.disposed++;
      },
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const loadedManifest = { snapshotId: "snapshot" } as never;

const container = () => {
  vi.stubGlobal("document", { createElement: () => ({ setAttribute() {}, remove() {} }) });
  return { append() {} } as unknown as HTMLElement;
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reserved visible CAD cache", () => {
  it("reuses one viewer across owners, ignores old releases, and survives a normal review break", () => {
    vi.useFakeTimers();
    const cache = createCadVisibleViewer();
    const node = container();
    const created = graphics.created,
      disposed = graphics.disposed;
    const first = cache.acquire(node, "environment", {});
    first.release();
    vi.advanceTimersByTime(59_000);
    const second = cache.acquire(node, "environment", {});
    expect(second.canvas).toBe(first.canvas);
    first.release();
    vi.advanceTimersByTime(61_000);
    expect(graphics.created - created).toBe(1);
    expect(graphics.disposed - disposed).toBe(0);
    second.release();
    vi.advanceTimersByTime(60_000);
    expect(graphics.disposed - disposed).toBe(0);
    const third = cache.acquire(node, "environment", {});
    expect(third.canvas).toBe(first.canvas);
    third.release();
    vi.advanceTimersByTime(300_000);
    expect(graphics.disposed - disposed).toBe(1);
    const fourth = cache.acquire(node, "environment", {});
    expect(fourth.canvas).not.toBe(first.canvas);
    fourth.release();
    cache.clear();
  });
  it("does not share viewers across environments or simultaneous owners", () => {
    const cache = createCadVisibleViewer(),
      node = container();
    const first = cache.acquire(node, "one", {});
    expect(() => cache.acquire(node, "one", {})).toThrow("already attached");
    first.release();
    const second = cache.acquire(node, "two", {});
    expect(second.canvas).not.toBe(first.canvas);
    second.release();
    cache.clear();
  });
  it("releases immediately on low-memory devices", () => {
    const cache = createCadVisibleViewer(),
      node = container();
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    const first = cache.acquire(node, "one", {});
    first.release();
    expect(cache.hasResident("one")).toBe(false);
    const second = cache.acquire(node, "one", {});
    expect(second.canvas).not.toBe(first.canvas);
    second.release();
    cache.clear();
  });

  it("keeps one load and its ticket alive while detached, then replays progress and readiness", async () => {
    const cache = createCadVisibleViewer();
    const node = container();
    const work = deferred<typeof loadedManifest>();
    const releaseTicket = vi.fn();
    const retainTicket = vi.fn(() => releaseTicket);
    let signal!: AbortSignal;
    let reportProgress!: (received: number, total: number) => void;
    const run = vi.fn(
      (
        _renderer,
        currentSignal: AbortSignal,
        progress: (received: number, total: number) => void,
      ) => {
        signal = currentSignal;
        reportProgress = progress;
        progress(12, 100);
        return work.promise;
      },
    );
    const firstStates: unknown[] = [];
    const first = cache.acquire(node, "environment", {});
    first.watchLoad("snapshot", (state) => firstStates.push(state));
    first.ensureLoad("snapshot", "ticket", retainTicket, run);
    expect(firstStates.at(-1)).toMatchObject({ status: "loading", received: 12, total: 100 });
    first.release();
    expect(signal.aborted).toBe(false);
    expect(releaseTicket).not.toHaveBeenCalled();

    const secondStates: unknown[] = [];
    const second = cache.acquire(node, "environment", {});
    second.watchLoad("snapshot", (state) => secondStates.push(state));
    const releaseReplacementTicket = vi.fn();
    const retainReplacementTicket = vi.fn(() => releaseReplacementTicket);
    second.ensureLoad("snapshot", "replacement-ticket", retainReplacementTicket, vi.fn());
    expect(secondStates.at(-1)).toMatchObject({ status: "loading", received: 12, total: 100 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(retainReplacementTicket).toHaveBeenCalledOnce();
    reportProgress(40, 100);
    expect(secondStates.at(-1)).toMatchObject({ status: "loading", received: 40, total: 100 });
    work.resolve(loadedManifest);
    await vi.waitFor(() =>
      expect(secondStates.at(-1)).toEqual({ status: "ready", manifest: loadedManifest }),
    );
    expect(releaseTicket).toHaveBeenCalledOnce();
    expect(releaseReplacementTicket).toHaveBeenCalledOnce();
    second.release();
    cache.clear();
  });

  it("aborts and invalidates an old load before selecting another snapshot", async () => {
    const cache = createCadVisibleViewer();
    const node = container();
    const oldWork = deferred<typeof loadedManifest>();
    const releaseTicket = vi.fn();
    let oldSignal!: AbortSignal;
    const attachment = cache.acquire(node, "environment", {});
    const oldStates: unknown[] = [];
    attachment.watchLoad("old", (state) => oldStates.push(state));
    attachment.ensureLoad(
      "old",
      "old-ticket",
      () => releaseTicket,
      (_renderer, signal) => {
        oldSignal = signal;
        return oldWork.promise;
      },
    );
    const cancelled = graphics.cancelled;
    const nextStates: unknown[] = [];
    attachment.watchLoad("next", (state) => nextStates.push(state));
    expect(oldSignal.aborted).toBe(true);
    expect(releaseTicket).toHaveBeenCalledOnce();
    expect(graphics.cancelled - cancelled).toBe(1);
    oldWork.resolve({ snapshotId: "old" } as never);
    await Promise.resolve();
    expect(nextStates).toEqual([{ status: "idle" }]);
    expect(oldStates.some((state) => (state as { status?: string }).status === "ready")).toBe(
      false,
    );
    attachment.release();
    cache.clear();
  });

  it("replays failures and retries with a refreshed ticket after an authorization failure", async () => {
    const cache = createCadVisibleViewer();
    const node = container();
    const firstRun = deferred<typeof loadedManifest>();
    const nextRun = deferred<typeof loadedManifest>();
    const states: unknown[] = [];
    const attachment = cache.acquire(node, "environment", {});
    attachment.watchLoad("snapshot", (state) => states.push(state));
    attachment.ensureLoad(
      "snapshot",
      "expired",
      () => vi.fn(),
      () => firstRun.promise,
    );
    attachment.ensureLoad(
      "snapshot",
      "fresh",
      () => vi.fn(),
      () => nextRun.promise,
    );
    firstRun.reject(new Error("unauthorized"));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: "loading" }));
    nextRun.reject(new Error("still unavailable"));
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ status: "failure" }));
    attachment.release();

    const reopenedStates: unknown[] = [];
    const reopened = cache.acquire(node, "environment", {});
    reopened.watchLoad("snapshot", (state) => reopenedStates.push(state));
    expect(reopenedStates).toEqual([{ status: "failure" }]);
    reopened.release();
    cache.clear();
  });

  it("aborts detached work and releases its ticket when the viewer expires", () => {
    vi.useFakeTimers();
    const cache = createCadVisibleViewer();
    const node = container();
    const releaseTicket = vi.fn();
    let signal!: AbortSignal;
    const attachment = cache.acquire(node, "environment", {});
    attachment.watchLoad("snapshot", () => {});
    attachment.ensureLoad(
      "snapshot",
      "ticket",
      () => releaseTicket,
      (_renderer, current) => {
        signal = current;
        return new Promise(() => {});
      },
    );
    attachment.release();
    vi.advanceTimersByTime(300_000);
    expect(signal.aborted).toBe(true);
    expect(releaseTicket).toHaveBeenCalledOnce();
    expect(cache.hasResident("environment")).toBe(false);
  });
});
