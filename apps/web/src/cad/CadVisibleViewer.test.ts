import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createCadVisibleViewer } from "./CadVisibleViewer";

const graphics = vi.hoisted(() => ({ created: 0, disposed: 0 }));
vi.mock("./CadSceneRenderer", () => ({
  createCadSceneRenderer: () => {
    graphics.created++;
    return {
      suspend() {},
      resume() {},
      cachedManifest: () => null,
      dispose() {
        graphics.disposed++;
      },
    };
  },
}));

const container = () => {
  vi.stubGlobal("document", { createElement: () => ({ setAttribute() {}, remove() {} }) });
  return { append() {} } as unknown as HTMLElement;
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reserved visible CAD cache", () => {
  it("reuses one viewer across owners, ignores old releases, and expires only when idle", () => {
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
    expect(graphics.disposed - disposed).toBe(1);
    const third = cache.acquire(node, "environment", {});
    expect(third.canvas).not.toBe(first.canvas);
    third.release();
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
});
