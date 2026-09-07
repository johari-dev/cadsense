import { describe, expect, it, vi } from "vite-plus/test";
import { readCadAssetResponse } from "./readCadAssetResponse";

describe("CAD download progress", () => {
  it("reports actual decoded bytes while an asset is still downloading", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      {
        headers: { "content-length": "2", "content-encoding": "gzip" },
      },
    );
    const progress = vi.fn();
    const reading = readCadAssetResponse(response, 5, progress);
    controller.enqueue(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(2));
    controller.enqueue(new Uint8Array([3, 4, 5]));
    controller.close();
    expect([...new Uint8Array(await reading)]).toEqual([1, 2, 3, 4, 5]);
    expect(progress.mock.calls.map(([count]) => count)).toEqual([2, 3]);
    expect(response.body!.locked).toBe(false);
  });
  it("rejects truncated and oversized bodies and releases their readers", async () => {
    for (const length of [2, 4]) {
      const response = new Response(new Uint8Array(length));
      await expect(readCadAssetResponse(response, 3, () => {})).rejects.toThrow("size mismatch");
      expect(response.body!.locked).toBe(false);
    }
  });
  it("propagates an interrupted download without reporting completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
    );
    const progress = vi.fn();
    const reading = readCadAssetResponse(response, 5, progress);
    controller.error(new DOMException("Aborted", "AbortError"));
    await expect(reading).rejects.toThrow("Aborted");
    expect(progress).not.toHaveBeenCalled();
    expect(response.body!.locked).toBe(false);
  });
});
