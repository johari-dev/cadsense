import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createCadDiagnostics } from "./CadDiagnostics";

afterEach(() => vi.useRealTimers());

describe("CAD diagnostics", () => {
  it("bounds and separates timing samples without scheduling work when closed", () => {
    vi.useFakeTimers();
    const diagnostics = createCadDiagnostics();
    const renderer = diagnostics.register();
    for (let i = 1; i <= 200; i++) renderer.record({ type: "frame", milliseconds: i });
    renderer.record({ type: "frame", milliseconds: NaN });
    renderer.record({ type: "frame", milliseconds: -1 });
    renderer.record({ type: "capture", milliseconds: 20, cold: true });
    renderer.record({ type: "capture", milliseconds: 5, cold: false });
    expect(diagnostics.getSnapshot()).toMatchObject({
      frameSamples: 128,
      frameP95: 194,
      coldCaptureP95: 20,
      warmCaptureP95: 5,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces notifications and cancels the only timer when diagnostics close", () => {
    vi.useFakeTimers();
    const diagnostics = createCadDiagnostics();
    const renderer = diagnostics.register();
    const notify = vi.fn();
    const unsubscribe = diagnostics.subscribe(notify);
    const before = diagnostics.getSnapshot();
    renderer.record({ type: "worker-count", workers: 2 });
    renderer.record({ type: "fallback" });
    expect(diagnostics.getSnapshot()).toBe(before);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(diagnostics.getSnapshot()).toMatchObject({ renderers: 2, fallbacks: 1 });
    renderer.record({ type: "frame", milliseconds: 1 });
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    expect(diagnostics.getSnapshot().frameSamples).toBe(1);
  });

  it("releases only its own renderer residency and ignores disposed producers", () => {
    const diagnostics = createCadDiagnostics();
    const a = diagnostics.register(),
      b = diagnostics.register();
    a.record({ type: "worker-count", workers: 2, snapshotIds: ["a", "shared"] });
    b.record({ type: "worker-count", workers: 1, snapshotIds: ["shared"] });
    expect(diagnostics.getSnapshot()).toMatchObject({ renderers: 3, snapshotIds: ["a", "shared"] });
    a.dispose();
    a.record({ type: "context-loss" });
    b.record({ type: "context-loss" });
    b.record({ type: "circuit-open" });
    expect(diagnostics.getSnapshot()).toMatchObject({
      renderers: 1,
      snapshotIds: ["shared"],
      contextLosses: 1,
      circuits: 1,
    });
    b.dispose();
    expect(diagnostics.getSnapshot()).toMatchObject({ renderers: 0, snapshotIds: [] });
  });
});
