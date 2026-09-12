import { describe, expect, it, vi } from "vite-plus/test";
import {
  createCachedCadAssetRangeRequest,
  createCadAssetRangeCacheKey,
  DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS,
  type CadAssetRangeCacheBackend,
  type CadAssetRangeCacheEntry,
  type CadAssetRangeCacheRecord,
  type CadAssetRangeCacheNamespace,
} from "./CadAssetRangeCache";

const namespace: CadAssetRangeCacheNamespace = {
  baseUrl: "http://localhost:5733/api/",
  environmentId: "local",
  snapshotId: "snapshot-a",
};

class MemoryBackend implements CadAssetRangeCacheBackend {
  readonly entries = new Map<string, CadAssetRangeCacheEntry>();
  failReads = false;

  async get(key: string) {
    if (this.failReads) throw new Error("cache unavailable");
    const entry = this.entries.get(key);
    return entry ? { ...entry, bytes: entry.bytes.slice(0) } : null;
  }

  async list(): Promise<readonly CadAssetRangeCacheRecord[]> {
    return [...this.entries].map(([key, entry]) => ({
      key,
      byteLength: entry.byteLength,
      lastAccessed: entry.lastAccessed,
    }));
  }

  async set(key: string, entry: CadAssetRangeCacheEntry) {
    this.entries.set(key, { ...entry, bytes: entry.bytes.slice(0) });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }
}

function rangeResponse(start: number, end: number, total: number, value = start + 1) {
  return new Response(new Uint8Array(end - start + 1).fill(value), {
    status: 200,
    headers: { "x-cad-bundle-range": `bytes ${start}-${end}/${total}` },
  });
}

describe("persistent CAD bundle range cache", () => {
  it("still downloads when persistent storage never responds", async () => {
    vi.useFakeTimers();
    try {
      const backend = new MemoryBackend();
      backend.get = () => new Promise(() => {});
      const live = vi.fn(async () => rangeResponse(0, 2, 3));
      const request = createCachedCadAssetRangeRequest({
        namespace,
        expectedTotalBytes: 3,
        backend,
        request: live,
      });
      const response = request(0, 2);
      await vi.advanceTimersByTimeAsync(DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS - 1);
      expect(live).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await response).ok).toBe(true);
      expect(live).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a large cached range when storage takes more than 250 ms", async () => {
    vi.useFakeTimers();
    try {
      const backend = new MemoryBackend();
      backend.entries.set(createCadAssetRangeCacheKey(namespace, 0, 2), {
        bytes: new Uint8Array([7, 7, 7]).buffer,
        range: "bytes 0-2/3",
        byteLength: 3,
        lastAccessed: 0,
      });
      const get = backend.get.bind(backend);
      backend.get = async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return get(key);
      };
      const live = vi.fn(async () => rangeResponse(0, 2, 3));
      const request = createCachedCadAssetRangeRequest({
        namespace,
        expectedTotalBytes: 3,
        backend,
        request: live,
      });
      const response = request(0, 2);
      await vi.advanceTimersByTimeAsync(500);
      expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(
        new Uint8Array([7, 7, 7]),
      );
      expect(live).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows an empty manifest while rejecting impossible range requests", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async () => rangeResponse(0, 0, 1));
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 0,
      request: live,
      backend,
    });

    await expect(request(0, 0)).rejects.toThrow("Invalid CAD bundle cache range");
    expect(live).not.toHaveBeenCalled();
  });

  it("serves an immutable range after a new wrapper is created for an app reload", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async (start: number, end: number) => rangeResponse(start, end, 3, 7));
    const firstLoad = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 3,
      request: live,
      backend,
    });

    expect([...new Uint8Array(await (await firstLoad(0, 2)).arrayBuffer())]).toEqual([7, 7, 7]);
    await vi.waitFor(() => expect(backend.entries.size).toBe(1));

    const afterReload = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 3,
      request: live,
      backend,
    });
    const cached = await afterReload(0, 2);
    expect([...new Uint8Array(await cached.arrayBuffer())]).toEqual([7, 7, 7]);
    expect(cached.headers.get("x-cad-bundle-range")).toBe("bytes 0-2/3");
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("persists every range across the reader's four-request window", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async (start: number, end: number) => rangeResponse(start, end, 49));
    const readAll = async (request: (start: number, end: number) => Promise<Response>) => {
      await Promise.all(
        Array.from({ length: 4 }, async (_, lane) => {
          for (let start = lane; start < 49; start += 4)
            await (await request(start, start)).arrayBuffer();
        }),
      );
    };

    await readAll(
      createCachedCadAssetRangeRequest({
        namespace,
        expectedTotalBytes: 49,
        request: live,
        backend,
      }),
    );
    await vi.waitFor(() => expect(backend.entries.size).toBe(49));

    await readAll(
      createCachedCadAssetRangeRequest({
        namespace,
        expectedTotalBytes: 49,
        request: live,
        backend,
      }),
    );
    expect(live).toHaveBeenCalledTimes(49);
  });

  it("isolates ranges by canonical server, environment, and snapshot identity", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async (start: number, end: number) => rangeResponse(start, end, 2));
    const first = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 2,
      request: live,
      backend,
    });
    await (await first(0, 1)).arrayBuffer();
    await vi.waitFor(() => expect(backend.entries.size).toBe(1));

    const sameCanonicalServer = createCachedCadAssetRangeRequest({
      namespace: { ...namespace, baseUrl: "http://localhost:5733/api" },
      expectedTotalBytes: 2,
      request: live,
      backend,
    });
    await (await sameCanonicalServer(0, 1)).arrayBuffer();
    expect(live).toHaveBeenCalledTimes(1);

    const differentSnapshot = createCachedCadAssetRangeRequest({
      namespace: { ...namespace, snapshotId: "snapshot-b" },
      expectedTotalBytes: 2,
      request: live,
      backend,
    });
    await (await differentSnapshot(0, 1)).arrayBuffer();
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("keeps original, encoded, and newer codec ranges separate across reloads", async () => {
    const backend = new MemoryBackend();
    const representations = [undefined, "meshopt-bin-v1:first", "meshopt-bin-v2:second"];
    const live = vi.fn(async () => rangeResponse(0, 2, 3, live.mock.calls.length));
    const read = async (representation: string | undefined) => {
      const request = createCachedCadAssetRangeRequest({
        namespace: { ...namespace, ...(representation === undefined ? {} : { representation }) },
        expectedTotalBytes: 3,
        request: live,
        backend,
      });
      return [...new Uint8Array(await (await request(0, 2)).arrayBuffer())];
    };
    for (const [i, representation] of representations.entries()) {
      expect(await read(representation)).toEqual([i + 1, i + 1, i + 1]);
      await vi.waitFor(() => expect(backend.entries.size).toBe(i + 1));
    }
    for (const [i, representation] of representations.entries())
      expect(await read(representation)).toEqual([i + 1, i + 1, i + 1]);
    expect(live).toHaveBeenCalledTimes(3);
  });

  it("deletes corrupt entries and falls back to the live lease-backed request", async () => {
    const backend = new MemoryBackend();
    const key = createCadAssetRangeCacheKey(namespace, 0, 2);
    backend.entries.set(key, {
      bytes: Uint8Array.from([9, 9]).buffer,
      range: "bytes 0-2/3",
      byteLength: 3,
      lastAccessed: 1,
    });
    const live = vi.fn(async () => rangeResponse(0, 2, 3, 4));
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 3,
      request: live,
      backend,
    });

    expect([...new Uint8Array(await (await request(0, 2)).arrayBuffer())]).toEqual([4, 4, 4]);
    expect(live).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(backend.entries.get(key)?.bytes.byteLength).toBe(3));
  });

  it("falls back when storage is unavailable and never caches incomplete responses", async () => {
    const backend = new MemoryBackend();
    backend.failReads = true;
    const live = vi.fn(
      async () =>
        new Response(Uint8Array.from([1, 2]), {
          status: 200,
          headers: { "x-cad-bundle-range": "bytes 0-2/3" },
        }),
    );
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 3,
      request: live,
      backend,
    });

    expect([...new Uint8Array(await (await request(0, 2)).arrayBuffer())]).toEqual([1, 2]);
    await vi.waitFor(() => expect(live).toHaveBeenCalledOnce());
    expect(backend.entries.size).toBe(0);
  });

  it("passes a wrong-total response through for the bundle reader to reject without caching it", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async () => rangeResponse(0, 2, 4));
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 3,
      request: live,
      backend,
    });

    const response = await request(0, 2);
    expect(response.headers.get("x-cad-bundle-range")).toBe("bytes 0-2/4");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 1, 1]);
    expect(backend.entries.size).toBe(0);
  });

  it("evicts the least recently used ranges before exceeding its disk budget", async () => {
    const backend = new MemoryBackend();
    let time = 0;
    const live = vi.fn(async (start: number, end: number) => rangeResponse(start, end, 6));
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 6,
      request: live,
      backend,
      maxBytes: 5,
      maxConcurrentWrites: 1,
      now: () => ++time,
    });

    await (await request(0, 2)).arrayBuffer();
    await vi.waitFor(() => expect(backend.entries.size).toBe(1));
    await (await request(3, 5)).arrayBuffer();
    const firstKey = createCadAssetRangeCacheKey(namespace, 0, 2);
    const secondKey = createCadAssetRangeCacheKey(namespace, 3, 5);
    await vi.waitFor(() => expect(backend.entries.has(secondKey)).toBe(true));
    expect(backend.entries.has(firstKey)).toBe(false);
    expect([...backend.entries.values()].reduce((sum, entry) => sum + entry.byteLength, 0)).toBe(3);
  });

  it("honors load-session cancellation before serving disk data or starting a request", async () => {
    const backend = new MemoryBackend();
    const live = vi.fn(async () => rangeResponse(0, 0, 1));
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const request = createCachedCadAssetRangeRequest({
      namespace,
      expectedTotalBytes: 1,
      request: live,
      backend,
      signal: controller.signal,
    });

    await expect(request(0, 0)).rejects.toMatchObject({ name: "AbortError" });
    expect(live).not.toHaveBeenCalled();
  });
});
