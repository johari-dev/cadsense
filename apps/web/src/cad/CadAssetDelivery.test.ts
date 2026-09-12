import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadCadAssetDelivery } from "./CadAssetDelivery";
import { createCadAssetRangeCacheKey } from "./CadAssetRangeCache";

const cache = vi.hoisted(() => {
  const entries = new Map<
    string,
    { bytes: ArrayBuffer; range: string; byteLength: number; lastAccessed: number }
  >();
  const backend = {
    entries,
    async get(key: string) {
      const entry = entries.get(key);
      return entry ? { ...entry, bytes: entry.bytes.slice(0) } : null;
    },
    async list() {
      return [...entries].map(([key, entry]) => ({
        key,
        byteLength: entry.byteLength,
        lastAccessed: entry.lastAccessed,
      }));
    },
    async set(
      key: string,
      entry: { bytes: ArrayBuffer; range: string; byteLength: number; lastAccessed: number },
    ) {
      entries.set(key, { ...entry, bytes: entry.bytes.slice(0) });
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
  return {
    backend,
    complete: vi.fn(async () => false),
    invalidate: vi.fn(),
    corruptOriginal: false,
    useBackend: false,
  };
});
vi.mock("./CadAssetRangeCache", async (original) => {
  const actual = await original<typeof import("./CadAssetRangeCache")>();
  return {
    ...actual,
    hasCachedCadAssetRanges: cache.complete,
    invalidateCadAssetRanges: (
      namespace: Parameters<typeof actual.invalidateCadAssetRanges>[0],
    ) => {
      cache.invalidate(namespace);
      return cache.useBackend
        ? actual.invalidateCadAssetRanges(namespace, cache.backend)
        : Promise.resolve();
    },
    createCachedCadAssetRangeRequest: (
      options: Parameters<typeof actual.createCachedCadAssetRangeRequest>[0],
    ) => {
      if (cache.useBackend)
        return actual.createCachedCadAssetRangeRequest({ ...options, backend: cache.backend });
      if (cache.corruptOriginal && !options.namespace.representation && !options.skipCacheRead)
        return async (start: number, end: number) => new Response(new Uint8Array(end - start + 1));
      return actual.createCachedCadAssetRangeRequest(options);
    },
  };
});
afterEach(() => {
  vi.clearAllMocks();
  cache.complete.mockResolvedValue(false);
  cache.corruptOriginal = false;
  cache.useBackend = false;
  cache.backend.entries.clear();
});
const namespace = {
  baseUrl: "https://cad.test",
  environmentId: "environment",
  snapshotId: "snapshot",
};
const body = new TextEncoder().encode("prefix-bin");

it("rejects same-length corrupt original cache bytes and retries through the live bundle", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  cache.corruptOriginal = true;
  const published: Uint8Array[] = [];
  const request = vi.fn(async () => new Response(body));
  await loadCadAssetDelivery({
    assets,
    namespace,
    signal: new AbortController().signal,
    request,
    load: async (reader) => {
      try {
        published.push(new Uint8Array(await reader(hash)));
      } catch (error) {
        // The production renderer wraps read failures as invalid-snapshot errors.
        throw new Error("invalid-snapshot", { cause: error });
      }
    },
    onProgress: () => {},
  });
  expect(published).toEqual([body]);
  expect(request).toHaveBeenCalledExactlyOnceWith("bundle?start=0&end=9", expect.any(AbortSignal));
  expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith(namespace);
});

it("does not publish corrupt original geometry when the live retry also fails integrity", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  cache.corruptOriginal = true;
  const published = vi.fn();
  const request = vi.fn(async () => new Response(new Uint8Array(body.length)));
  await expect(
    loadCadAssetDelivery({
      assets,
      namespace,
      signal: new AbortController().signal,
      request,
      load: async (reader) => {
        published(await reader(hash));
      },
      onProgress: () => {},
    }),
  ).rejects.toThrow(/hash mismatch/);
  expect(published).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it("removes write-through recovery bytes when the live retry also fails integrity", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  cache.useBackend = true;
  const key = createCadAssetRangeCacheKey(namespace, 0, body.length - 1);
  cache.backend.entries.set(key, {
    bytes: new Uint8Array(body.length).buffer,
    range: `bytes 0-${body.length - 1}/${body.length}`,
    byteLength: body.length,
    lastAccessed: 0,
  });
  const request = vi.fn(
    async () =>
      new Response(new Uint8Array(body.length), {
        headers: { "x-cad-bundle-range": `bytes 0-${body.length - 1}/${body.length}` },
      }),
  );
  await expect(
    loadCadAssetDelivery({
      assets,
      namespace,
      signal: new AbortController().signal,
      request,
      load: async (reader) => {
        await reader(hash);
      },
      onProgress: () => {},
    }),
  ).rejects.toThrow(/hash mismatch/);
  await vi.waitFor(() => expect(cache.backend.entries.size).toBe(0));
  expect(cache.invalidate).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not retry or discard the original cache for a renderer failure", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  const request = vi.fn(async () => new Response(body));
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
  expect(request).toHaveBeenCalledTimes(1);
  expect(cache.invalidate).not.toHaveBeenCalled();
});

it("does not retry corrupt original geometry after cancellation", async () => {
  const { hash, assets } = await fixture();
  cache.complete.mockResolvedValue(true);
  cache.corruptOriginal = true;
  const controller = new AbortController();
  const request = vi.fn(async () => new Response(body));
  await expect(
    loadCadAssetDelivery({
      assets,
      namespace,
      signal: controller.signal,
      request,
      load: async (reader) => {
        try {
          await reader(hash);
        } catch (error) {
          controller.abort();
          throw error;
        }
      },
      onProgress: () => {},
    }),
  ).rejects.toThrow(/hash mismatch/);
  expect(request).not.toHaveBeenCalled();
  expect(cache.invalidate).not.toHaveBeenCalled();
});
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
