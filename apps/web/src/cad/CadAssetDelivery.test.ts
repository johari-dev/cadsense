import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadCadAssetDelivery } from "./CadAssetDelivery";

const cache = vi.hoisted(() => ({
  complete: vi.fn(async () => false),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("./CadAssetRangeCache", async (original) => ({
  ...(await original<typeof import("./CadAssetRangeCache")>()),
  hasCachedCadAssetRanges: cache.complete,
  invalidateCadAssetRanges: cache.invalidate,
}));
afterEach(() => {
  vi.clearAllMocks();
  cache.complete.mockResolvedValue(false);
});
const namespace = {
  baseUrl: "https://cad.test",
  environmentId: "environment",
  snapshotId: "snapshot",
};
const body = new TextEncoder().encode("prefix-bin");
async function fixture() {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const assets = [{ sha256: hash, byteLength: body.length }];
  const envelope = {
    identity: "a".repeat(64),
    index: {
      version: "meshopt-bin-v1",
      byteLength: body.length,
      assets: [{ ...assets[0], prefix: { offset: 0, byteLength: 7 }, bin: 0 }],
      bins: [
        {
          byteLength: 3,
          segments: [
            { offset: 7, byteLength: 3, decodedByteLength: 3, mode: "raw", count: 0, stride: 0 },
          ],
        },
      ],
    },
  };
  return { hash, assets, envelope };
}

it("uses the optimized representation and verifies reconstructed bytes", async () => {
  const { hash, assets, envelope } = await fixture();
  const request = vi.fn(async (path: string) =>
    path === "transfer-index" ? Response.json(envelope) : new Response(body),
  );
  const read = vi.fn(async (reader: (hash: string) => Promise<ArrayBuffer>) => {
    expect(new Uint8Array(await reader(hash))).toEqual(body);
  });
  await loadCadAssetDelivery({
    assets,
    namespace,
    signal: new AbortController().signal,
    request,
    load: read,
    onProgress: () => {},
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "transfer-index",
    `transfer?identity=${"a".repeat(64)}&start=0&end=9`,
  ]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("falls back to the original bundle and invalidates corrupt optimized bytes", async () => {
  const { hash, assets, envelope } = await fixture();
  const broken = body.slice();
  broken[9] = 0;
  const request = vi.fn(async (path: string) =>
    path === "transfer-index"
      ? Response.json(envelope)
      : new Response(path.startsWith("transfer?") ? broken : body),
  );
  const read = vi.fn(async (reader: (hash: string) => Promise<ArrayBuffer>) => {
    await reader(hash);
  });
  await loadCadAssetDelivery({
    assets,
    namespace,
    signal: new AbortController().signal,
    request,
    load: read,
    onProgress: () => {},
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.at(-1)?.[0]).toBe("bundle?start=0&end=9");
  expect(cache.invalidate).toHaveBeenCalledTimes(1);
});

it("reuses an existing complete original cache without preparing another format", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  const request = vi.fn(async () => new Response(body));
  await loadCadAssetDelivery({
    assets,
    namespace,
    signal: new AbortController().signal,
    request,
    load: async (reader) => {
      await reader(hash);
    },
    onProgress: () => {},
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual(["bundle?start=0&end=9", expect.any(AbortSignal)]);
});

it("does not restart through fallback when the scene is cancelled", async () => {
  const { assets } = await fixture();
  const controller = new AbortController();
  const request = vi.fn(async () => {
    controller.abort();
    throw new Error("cancelled");
  });
  const load = vi.fn();
  await expect(
    loadCadAssetDelivery({
      assets,
      namespace,
      signal: controller.signal,
      request,
      load,
      onProgress: () => {},
    }),
  ).rejects.toThrow("cancelled");
  expect(load).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it("bounds index response bytes and falls back without decoding oversized metadata", async () => {
  const { hash, assets } = await fixture();
  const request = vi.fn(
    async (path: string) =>
      new Response(path === "transfer-index" ? new Uint8Array(4 * 1024 ** 2 + 1) : body),
  );
  await loadCadAssetDelivery({
    assets,
    namespace,
    signal: new AbortController().signal,
    request,
    load: async (reader) => {
      expect(new Uint8Array(await reader(hash))).toEqual(body);
    },
    onProgress: () => {},
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "transfer-index",
    "bundle?start=0&end=9",
  ]);
});

it("does not discard valid cached geometry or redownload after an unrelated renderer failure", async () => {
  const { hash, assets, envelope } = await fixture();
  const request = vi.fn(async (path: string) =>
    path === "transfer-index" ? Response.json(envelope) : new Response(body),
  );
  await expect(
    loadCadAssetDelivery({
      assets,
      namespace,
      signal: new AbortController().signal,
      request,
      load: async (reader) => {
        await reader(hash);
        throw new Error("graphics context unavailable");
      },
      onProgress: () => {},
    }),
  ).rejects.toThrow("graphics context unavailable");
  expect(request).toHaveBeenCalledTimes(2);
  expect(cache.invalidate).not.toHaveBeenCalled();
});
