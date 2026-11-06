import {
  CACHE_KEY_ORIGIN,
  DEFAULT_CAD_ASSET_RANGE_CACHE_BYTES,
  DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS,
  getSharedIndexedDbBackend,
  queueMutation,
  storeWithinBudget,
  type CadAssetRangeCacheBackend,
} from "./CadAssetRangeCache";
import { CadAssetIntegrityError, verifyCadAssetBytes } from "./CadAssetIntegrity";

// Enough to absorb a burst of downloads while IndexedDB catches up; writes past it are skipped.
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 ** 2;

/** Keys name only the content hash, so every snapshot, chat, and server shares an entry. */
export const cadAssetCacheKey = (sha256: string) => `${CACHE_KEY_ORIGIN}/v1/asset/${sha256}`;

/**
 * Decoded GLB assets kept in the browser by content hash. A re-sync usually changes a few parts,
 * so the next snapshot only needs the assets this cache lacks. Everything is best effort: storage
 * that is missing, slow, or corrupt just means a transfer.
 */
export interface CadAssetCache {
  /** Which of `assets` the cache holds at their manifest size. */
  cached(
    assets: readonly { readonly sha256: string; readonly byteLength: number }[],
  ): Promise<ReadonlySet<string>>;
  /** The verified bytes, or null when the entry is gone or corrupt. Corrupt entries are deleted. */
  read(sha256: string, byteLength: number): Promise<ArrayBuffer | null>;
  /** Stores a copy of verified bytes in the background. */
  write(sha256: string, bytes: ArrayBuffer): void;
}

export function createCadAssetCache({
  backend = getSharedIndexedDbBackend(),
  maxBytes = DEFAULT_CAD_ASSET_RANGE_CACHE_BYTES,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  readTimeoutMs = DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS,
  now = Date.now,
}: {
  readonly backend?: CadAssetRangeCacheBackend;
  readonly maxBytes?: number;
  readonly maxPendingBytes?: number;
  readonly readTimeoutMs?: number;
  readonly now?: () => number;
} = {}): CadAssetCache {
  let pendingBytes = 0;
  const withinTimeout = async <T>(operation: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), readTimeoutMs))),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async cached(assets) {
      const records = await withinTimeout(backend.list());
      const lengths = new Map(records?.map((record) => [record.key, record.byteLength]));
      return new Set(
        assets
          .filter((asset) => lengths.get(cadAssetCacheKey(asset.sha256)) === asset.byteLength)
          .map((asset) => asset.sha256),
      );
    },
    async read(sha256, byteLength) {
      const key = cadAssetCacheKey(sha256);
      const entry = await withinTimeout(backend.get(key));
      if (!entry || entry.byteLength !== byteLength || entry.bytes.byteLength !== byteLength)
        return null;
      try {
        await verifyCadAssetBytes(entry.bytes, sha256);
      } catch (error) {
        if (error instanceof CadAssetIntegrityError)
          void queueMutation(backend, () => backend.delete(key)).catch(() => {});
        return null;
      }
      if (backend.touch) void backend.touch(key, now()).catch(() => {});
      return entry.bytes;
    },
    write(sha256, bytes) {
      if (pendingBytes + bytes.byteLength > maxPendingBytes) return;
      // The renderer may transfer the original to a worker before IndexedDB clones it.
      const copy = bytes.slice(0);
      pendingBytes += copy.byteLength;
      void queueMutation(backend, () =>
        storeWithinBudget(
          backend,
          cadAssetCacheKey(sha256),
          { bytes: copy, range: "asset", byteLength: copy.byteLength, lastAccessed: now() },
          maxBytes,
        ),
      )
        .catch(() => {})
        .finally(() => (pendingBytes -= copy.byteLength));
    },
  };
}

let shared: CadAssetCache | undefined;
export const getSharedCadAssetCache = () => (shared ??= createCadAssetCache());
