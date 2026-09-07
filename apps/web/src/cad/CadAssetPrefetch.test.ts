import { describe, expect, it, vi } from "vitest";
import { prefetchCadAssets } from "./CadAssetPrefetch";

describe("CAD asset prefetch", () => {
  it("bounds buffered bytes and downloads an oversized asset alone", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    const prefetch = prefetchCadAssets(
      [20, 20, 40, 1].map((size, i) => ({ sha256: String(i), byteLength: size * 1024 ** 2 })),
      read,
    );
    const first = prefetch.read("0");
    expect(read.mock.calls).toHaveLength(1);
    await first;
    expect(read.mock.calls).toHaveLength(2);
    await prefetch.read("1");
    expect(read.mock.calls).toHaveLength(3);
    await prefetch.read("2");
    expect(read.mock.calls).toHaveLength(4);
    await prefetch.read("3");
    prefetch.dispose();
  });

  it("deduplicates downloads and stops read-ahead when the scene is inactive", async () => {
    let active = true;
    const read = vi.fn(async () => new ArrayBuffer(0));
    const prefetch = prefetchCadAssets(
      ["0", "0", "1", "2", "3", "4", "5", "6"].map((sha256) => ({ sha256, byteLength: 1 })),
      read,
      () => active,
    );
    const first = prefetch.read("0");
    expect(read.mock.calls).toHaveLength(6);
    active = false;
    await first;
    expect(read.mock.calls).toHaveLength(6);
    prefetch.dispose();
  });

  it("observes prefetched failures and propagates them when consumed", async () => {
    const failure = new Error("asset unavailable");
    const prefetch = prefetchCadAssets(
      ["0", "1"].map((sha256) => ({ sha256, byteLength: 1 })),
      async (hash) => {
        if (hash === "1") throw failure;
        return new ArrayBuffer(0);
      },
    );
    await prefetch.read("0");
    await expect(prefetch.read("1")).rejects.toBe(failure);
    prefetch.dispose();
  });
});
