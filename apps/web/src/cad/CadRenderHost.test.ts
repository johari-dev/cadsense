import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createCadRenderHost } from "./CadRenderHost";

const pool = vi.hoisted(() => ({
  capture: vi.fn(),
  dispose: vi.fn(),
  setPolicy: vi.fn(),
  endRun: vi.fn(),
}));
vi.mock("./CadBrowserWorkers", () => ({ createCadBrowserPool: () => pool }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const ticket = (index: number) => ({
  jobId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  token: "00000000-0000-4000-8000-000000000099",
});

describe("CAD renderer host lifetime", () => {
  it("limits concurrent manifest loads, skips cancelled queued work, and aborts all loads on disposal", async () => {
    const document = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", document);
    const signals: AbortSignal[] = [];
    const urls: string[] = [];
    let thirdStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      thirdStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL, init: RequestInit) => {
        const signal = init.signal!;
        signals.push(signal);
        urls.push(String(url));
        if (signals.length === 3) thirdStarted();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const host = createCadRenderHost("https://example.test/");
    try {
      for (let index = 1; index <= 4; index++)
        host.accept({ type: "capture", ticket: ticket(index) });
      expect(signals).toHaveLength(2);
      host.accept({ type: "cancel", jobId: ticket(3).jobId });
      host.accept({ type: "cancel", jobId: ticket(1).jobId });
      await started;
      expect(urls[2]).toContain(ticket(4).jobId);
      expect(signals[0]?.aborted).toBe(true);
      document.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(pool.setPolicy).toHaveBeenLastCalledWith({
        backgrounded: true,
        memoryPressure: false,
      });
    } finally {
      host.dispose();
    }
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(pool.dispose).toHaveBeenCalledOnce();
    expect(pool.capture).not.toHaveBeenCalled();
    host.accept({ type: "capture", ticket: ticket(5) });
    expect(signals).toHaveLength(3);
  });
});
