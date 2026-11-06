import { expect, it, vi } from "vite-plus/test";
import { cadAssetCacheKey, createCadAssetCache } from "./CadAssetCache";
import type { CadAssetRangeCacheBackend, CadAssetRangeCacheEntry } from "./CadAssetRangeCache";

const memoryBackend = () => {
  const entries = new Map<string, CadAssetRangeCacheEntry>();
  const backend = {
    entries,
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    list: vi.fn(async () =>
      [...entries].map(([key, entry]) => ({
        key,
        byteLength: entry.byteLength,
        lastAccessed: entry.lastAccessed,
      })),
    ),
    set: vi.fn(async (key: string, entry: CadAssetRangeCacheEntry) => {
      entries.set(key, entry);
    }),
    delete: vi.fn(async (key: string) => {
      entries.delete(key);
    }),
  } satisfies CadAssetRangeCacheBackend & { entries: unknown };
  return backend;
};
const asset = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  return { sha256, byteLength: bytes.byteLength, bytes };
};
const settle = (backend: ReturnType<typeof memoryBackend>, size: number) =>
  vi.waitFor(() => expect(backend.entries.size).toBe(size));

it("keeps assets by content, so any snapshot or server holding the same geometry reuses them", async () => {
  const backend = memoryBackend();
  const cache = createCadAssetCache({ backend });
  const part = await asset("part geometry");
  cache.write(part.sha256, part.bytes.buffer.slice(0));
  await settle(backend, 1);
  expect([...backend.entries.keys()]).toEqual([cadAssetCacheKey(part.sha256)]);
  const other = createCadAssetCache({ backend });
  expect(await other.cached([part])).toEqual(new Set([part.sha256]));
  expect(new Uint8Array((await other.read(part.sha256, part.byteLength))!)).toEqual(part.bytes);
});

it("deletes and misses an entry whose bytes no longer match its hash", async () => {
  const backend = memoryBackend();
  const cache = createCadAssetCache({ backend });
  const part = await asset("part geometry");
  backend.entries.set(cadAssetCacheKey(part.sha256), {
    bytes: new TextEncoder().encode("PART GEOMETRY").buffer,
    range: "asset",
    byteLength: part.byteLength,
    lastAccessed: 0,
  });
  expect(await cache.read(part.sha256, part.byteLength)).toBeNull();
  await settle(backend, 0);
});

it("does not count an entry whose size differs from the manifest", async () => {
  const backend = memoryBackend();
  const cache = createCadAssetCache({ backend });
  const part = await asset("part geometry");
  cache.write(part.sha256, part.bytes.buffer.slice(0));
  await settle(backend, 1);
  expect(await cache.cached([{ ...part, byteLength: part.byteLength + 1 }])).toEqual(new Set());
  expect(await cache.read(part.sha256, part.byteLength + 1)).toBeNull();
});

it("stores its own copy, so the renderer may transfer the buffer it was given", async () => {
  const backend = memoryBackend();
  const cache = createCadAssetCache({ backend });
  const part = await asset("part geometry");
  const given = part.bytes.buffer.slice(0);
  cache.write(part.sha256, given);
  structuredClone(given, { transfer: [given] });
  expect(given.byteLength).toBe(0);
  await settle(backend, 1);
  expect(new Uint8Array((await cache.read(part.sha256, part.byteLength))!)).toEqual(part.bytes);
});

it("drops writes while too many bytes are already waiting for storage", async () => {
  const backend = memoryBackend();
  let release = () => {};
  backend.set.mockImplementationOnce(async (key, entry) => {
    await new Promise<void>((resolve) => (release = resolve));
    backend.entries.set(key, entry);
  });
  const first = await asset("first part");
  const second = await asset("second part");
  const cache = createCadAssetCache({ backend, maxPendingBytes: first.byteLength });
  cache.write(first.sha256, first.bytes.buffer.slice(0));
  cache.write(second.sha256, second.bytes.buffer.slice(0));
  await vi.waitFor(() => expect(backend.set).toHaveBeenCalledTimes(1));
  release();
  await settle(backend, 1);
  expect([...backend.entries.keys()]).toEqual([cadAssetCacheKey(first.sha256)]);
});

it("evicts the least recently used entries to stay within its byte budget", async () => {
  const backend = memoryBackend();
  let now = 0;
  const parts = await Promise.all(["part a", "part b", "part c"].map(asset));
  const cache = createCadAssetCache({
    backend,
    maxBytes: parts[0]!.byteLength * 2,
    now: () => ++now,
  });
  for (const part of parts) {
    cache.write(part.sha256, part.bytes.buffer.slice(0));
    await vi.waitFor(() => expect(backend.entries.has(cadAssetCacheKey(part.sha256))).toBe(true));
  }
  expect(await cache.cached(parts)).toEqual(new Set([parts[1]!.sha256, parts[2]!.sha256]));
});

it("treats unavailable or stalled storage as an empty cache", async () => {
  const part = await asset("part geometry");
  const failing = memoryBackend();
  failing.list.mockRejectedValue(new Error("blocked"));
  expect(await createCadAssetCache({ backend: failing }).cached([part])).toEqual(new Set());
  const stalled = memoryBackend();
  stalled.list.mockReturnValue(new Promise(() => {}));
  expect(await createCadAssetCache({ backend: stalled, readTimeoutMs: 10 }).cached([part])).toEqual(
    new Set(),
  );
});
