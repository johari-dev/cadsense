const DATABASE_NAME = "cadsense:cad-bundle-ranges";
const DATABASE_VERSION = 1;
const RANGE_STORE = "ranges";
const METADATA_STORE = "metadata";
const CACHE_KEY_ORIGIN = "https://cad-range-cache.invalid";
const RANGE_HEADER = "x-cad-bundle-range";

export const DEFAULT_CAD_ASSET_RANGE_CACHE_BYTES = 512 * 1024 ** 2;
export const DEFAULT_CAD_ASSET_RANGE_CACHE_WRITES = 4;
// Four concurrent 4 MiB reads can exceed 250 ms while the full scene is parsing.
// Allow disk reuse without letting unavailable storage block loading indefinitely.
export const DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS = 2_000;
export const DEFAULT_CAD_ASSET_RANGE_CACHE_WRITE_WAIT_MS = 2_000;

export interface CadAssetRangeCacheNamespace {
  /** The connection's HTTP base URL. Authentication data must never be included. */
  readonly baseUrl: string;
  readonly environmentId: string;
  /** A manifest-verified immutable snapshot identifier. */
  readonly snapshotId: string;
  /** Absent for the original GLB bundle; derived formats include codec and content identity. */
  readonly representation?: string;
}

export interface CadAssetRangeCacheEntry {
  readonly bytes: ArrayBuffer;
  readonly range: string;
  readonly byteLength: number;
  readonly lastAccessed: number;
}

export interface CadAssetRangeCacheRecord {
  readonly key: string;
  readonly byteLength: number;
  readonly lastAccessed: number;
}

/** Injectable to keep range-cache behavior testable without a browser CacheStorage shim. */
export interface CadAssetRangeCacheBackend {
  get(key: string): Promise<CadAssetRangeCacheEntry | null>;
  list(): Promise<readonly CadAssetRangeCacheRecord[]>;
  set(key: string, entry: CadAssetRangeCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  touch?(key: string, lastAccessed: number): Promise<void>;
}

export interface CachedCadAssetRangeRequestOptions {
  readonly namespace: CadAssetRangeCacheNamespace;
  /** Manifest-ordered, SHA-deduplicated decoded byte total. */
  readonly expectedTotalBytes: number;
  readonly request: (start: number, end: number) => Promise<Response>;
  /**
   * The load-session signal. A cache hit is discarded after cancellation.
   * The caller must acquire and await the current server lease before using this wrapper.
   */
  readonly signal?: AbortSignal;
  readonly backend?: CadAssetRangeCacheBackend;
  readonly maxBytes?: number;
  readonly maxConcurrentWrites?: number;
  readonly maxPendingWrites?: number;
  readonly cacheReadTimeoutMs?: number;
  readonly cacheWriteWaitMs?: number;
  /** Integrity recovery bypasses stale reads while repopulating the same bounded cache. */
  readonly skipCacheRead?: boolean;
  readonly now?: () => number;
}

interface ParsedRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

const mutationQueues = new WeakMap<CadAssetRangeCacheBackend, Promise<void>>();
let sharedIndexedDbBackend: CadAssetRangeCacheBackend | null = null;

function canonicalBaseUrl(value: string): string {
  const url = new URL(value, globalThis.location?.href);
  if (url.username || url.password)
    throw new Error("CAD cache base URL cannot contain credentials");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function createCadAssetRangeCacheKey(
  namespace: CadAssetRangeCacheNamespace,
  start: number,
  end: number,
): string {
  const parts = [
    canonicalBaseUrl(namespace.baseUrl),
    namespace.environmentId,
    namespace.snapshotId,
    ...(namespace.representation ? [namespace.representation] : []),
    `${start}-${end}`,
  ];
  return `${CACHE_KEY_ORIGIN}/v1/${parts.map(encodeURIComponent).join("/")}`;
}

/** Prefer an already complete original bundle when upgrading the app's delivery format. */
export async function hasCachedCadAssetRanges(
  namespace: CadAssetRangeCacheNamespace,
  total: number,
  backend: CadAssetRangeCacheBackend = getSharedIndexedDbBackend(),
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      backend.list(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS);
      }),
    ]);
    if (!records) return false;
    const lengths = new Map(records.map((record) => [record.key, record.byteLength]));
    for (let start = 0; start < total; start += 4 * 1024 ** 2) {
      const end = Math.min(total - 1, start + 4 * 1024 ** 2 - 1);
      if (lengths.get(createCadAssetRangeCacheKey(namespace, start, end)) !== end - start + 1)
        return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A failed integrity check invalidates only this derived representation, never other models. */
export async function invalidateCadAssetRanges(
  namespace: CadAssetRangeCacheNamespace,
  backend: CadAssetRangeCacheBackend = getSharedIndexedDbBackend(),
) {
  const sample = createCadAssetRangeCacheKey(namespace, 0, 0);
  const prefix = sample.slice(0, sample.lastIndexOf("/") + 1);
  await queueMutation(backend, async () => {
    for (const record of await backend.list())
      if (record.key.startsWith(prefix)) await backend.delete(record.key);
  }).catch(() => {});
}

function parseRange(value: string | null): ParsedRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  )
    return null;
  return { start, end, total };
}

function validEntry(
  entry: CadAssetRangeCacheEntry,
  start: number,
  end: number,
  expectedTotalBytes: number,
): ParsedRange | null {
  const parsed = parseRange(entry.range);
  const expectedLength = end - start + 1;
  return parsed &&
    parsed.start === start &&
    parsed.end === end &&
    parsed.total === expectedTotalBytes &&
    entry.byteLength === expectedLength &&
    entry.bytes.byteLength === expectedLength
    ? parsed
    : null;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("CAD scene load cancelled", "AbortError");
}

async function readBeforeTimeout(
  backend: CadAssetRangeCacheBackend,
  key: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CadAssetRangeCacheEntry | null> {
  if (signal?.aborted) throw abortError(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeoutResult = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  const abortResult = signal
    ? new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      })
    : null;
  try {
    return await Promise.race([
      backend.get(key),
      timeoutResult,
      ...(abortResult ? [abortResult] : []),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

function queueMutation(backend: CadAssetRangeCacheBackend, operation: () => Promise<void>) {
  const previous = mutationQueues.get(backend) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  mutationQueues.set(backend, next);
  void next
    .finally(() => {
      if (mutationQueues.get(backend) === next) mutationQueues.delete(backend);
    })
    .catch(() => {});
  return next;
}

function createWritePermits(
  limit: number,
  pendingLimit: number,
  waitMs: number,
  signal?: AbortSignal,
) {
  let active = 0;
  const pending: Array<{
    resolve: (release: (() => void) | null) => void;
    reject: (error: unknown) => void;
    removeAbortListener?: () => void;
    timeout?: ReturnType<typeof setTimeout>;
  }> = [];
  const release = () => {
    const next = pending.shift();
    if (next) {
      if (next.timeout !== undefined) clearTimeout(next.timeout);
      next.removeAbortListener?.();
      next.resolve(release);
    } else {
      active--;
    }
  };
  return () => {
    if (limit === 0) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (active < limit) {
      active++;
      return Promise.resolve(release);
    }
    if (pending.length >= pendingLimit) return Promise.resolve(null);
    return new Promise<(() => void) | null>((resolve, reject) => {
      const waiter: (typeof pending)[number] = { resolve, reject };
      if (signal) {
        const onAbort = () => {
          const index = pending.indexOf(waiter);
          if (index >= 0) pending.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      pending.push(waiter);
      waiter.timeout = setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index < 0) return;
        pending.splice(index, 1);
        waiter.removeAbortListener?.();
        resolve(null);
      }, waitMs);
    });
  };
}

async function storeWithinBudget(
  backend: CadAssetRangeCacheBackend,
  key: string,
  entry: CadAssetRangeCacheEntry,
  maxBytes: number,
) {
  if (entry.byteLength > maxBytes) return;
  const records = await backend.list();
  const existing = records.find((record) => record.key === key);
  let storedBytes = records.reduce((sum, record) => sum + record.byteLength, 0);
  if (existing) storedBytes -= existing.byteLength;

  const oldestFirst = records
    .filter((record) => record.key !== key)
    .toSorted((left, right) => left.lastAccessed - right.lastAccessed);
  for (const record of oldestFirst) {
    if (storedBytes + entry.byteLength <= maxBytes) break;
    await backend.delete(record.key);
    storedBytes -= record.byteLength;
  }
  if (storedBytes + entry.byteLength <= maxBytes) await backend.set(key, entry);
}

/**
 * Adds a bounded persistent cache in front of immutable CAD bundle range requests.
 * Cache failures are deliberately best-effort: the live lease-backed request remains authoritative.
 */
export function createCachedCadAssetRangeRequest({
  namespace,
  expectedTotalBytes,
  request,
  signal,
  backend = getSharedIndexedDbBackend(),
  maxBytes = DEFAULT_CAD_ASSET_RANGE_CACHE_BYTES,
  maxConcurrentWrites = DEFAULT_CAD_ASSET_RANGE_CACHE_WRITES,
  maxPendingWrites = DEFAULT_CAD_ASSET_RANGE_CACHE_WRITES,
  cacheReadTimeoutMs = DEFAULT_CAD_ASSET_RANGE_CACHE_READ_TIMEOUT_MS,
  cacheWriteWaitMs = DEFAULT_CAD_ASSET_RANGE_CACHE_WRITE_WAIT_MS,
  skipCacheRead = false,
  now = Date.now,
}: CachedCadAssetRangeRequestOptions): (start: number, end: number) => Promise<Response> {
  if (!Number.isSafeInteger(expectedTotalBytes) || expectedTotalBytes < 0)
    throw new Error("Invalid CAD bundle total byte length");
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error("Invalid CAD cache byte budget");
  if (!Number.isInteger(maxConcurrentWrites) || maxConcurrentWrites < 0)
    throw new Error("Invalid CAD cache write limit");
  if (!Number.isInteger(maxPendingWrites) || maxPendingWrites < 0)
    throw new Error("Invalid CAD cache pending write limit");
  if (!Number.isFinite(cacheReadTimeoutMs) || cacheReadTimeoutMs < 0)
    throw new Error("Invalid CAD cache read timeout");
  if (!Number.isFinite(cacheWriteWaitMs) || cacheWriteWaitMs < 0)
    throw new Error("Invalid CAD cache write wait");

  const acquireWritePermit = createWritePermits(
    maxConcurrentWrites,
    maxPendingWrites,
    cacheWriteWaitMs,
    signal,
  );

  return async (start, end) => {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= expectedTotalBytes
    )
      throw new Error("Invalid CAD bundle cache range");
    if (signal?.aborted) throw abortError(signal);
    const key = createCadAssetRangeCacheKey(namespace, start, end);

    let cached: CadAssetRangeCacheEntry | null = null;
    try {
      if (!skipCacheRead)
        cached = await readBeforeTimeout(backend, key, cacheReadTimeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (signal?.aborted) throw abortError(signal);
    if (cached) {
      if (validEntry(cached, start, end, expectedTotalBytes)) {
        if (backend.touch) void backend.touch(key, now()).catch(() => {});
        return new Response(cached.bytes, {
          status: 200,
          headers: { [RANGE_HEADER]: cached.range, "content-type": "application/octet-stream" },
        });
      }
      void queueMutation(backend, () => backend.delete(key)).catch(() => {});
    }

    const releaseWritePermit = await acquireWritePermit();
    let response: Response;
    try {
      response = await request(start, end);
    } catch (error) {
      releaseWritePermit?.();
      throw error;
    }
    if (signal?.aborted) {
      releaseWritePermit?.();
      return response;
    }
    const parsed = parseRange(response.headers.get(RANGE_HEADER));
    if (
      !releaseWritePermit ||
      !response.ok ||
      !response.body ||
      parsed?.start !== start ||
      parsed.end !== end ||
      parsed.total !== expectedTotalBytes
    ) {
      releaseWritePermit?.();
      return response;
    }

    let copy: Response;
    try {
      copy = response.clone();
    } catch {
      releaseWritePermit();
      return response;
    }
    void copy
      .arrayBuffer()
      .then((bytes) => {
        if (signal?.aborted || bytes.byteLength !== end - start + 1) return;
        return queueMutation(backend, () =>
          storeWithinBudget(
            backend,
            key,
            {
              bytes,
              range: response.headers.get(RANGE_HEADER)!,
              byteLength: bytes.byteLength,
              lastAccessed: now(),
            },
            maxBytes,
          ),
        );
      })
      .catch(() => {})
      .finally(releaseWritePermit);
    return response;
  };
}

interface StoredRange {
  readonly key: string;
  readonly bytes: ArrayBuffer;
  readonly range: string;
  readonly byteLength: number;
}

interface StoredMetadata extends CadAssetRangeCacheRecord {}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

/**
 * IndexedDB keeps range bodies separate from small LRU records, so cache hits can be
 * promoted without rewriting another 4 MB body.
 */
export function createIndexedDbCadAssetRangeBackend(
  factory: IDBFactory = globalThis.indexedDB,
): CadAssetRangeCacheBackend {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(RANGE_STORE))
          request.result.createObjectStore(RANGE_STORE, { keyPath: "key" });
        if (!request.result.objectStoreNames.contains(METADATA_STORE))
          request.result.createObjectStore(METADATA_STORE, { keyPath: "key" });
      });
      request.addEventListener("success", () => {
        request.result.addEventListener("versionchange", () => {
          request.result.close();
          databasePromise = null;
        });
        resolve(request.result);
      });
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () => reject(new Error("CAD range cache is blocked")));
    });
    void databasePromise.catch(() => (databasePromise = null));
    return databasePromise;
  };
  return {
    async get(key) {
      const database = await open();
      const transaction = database.transaction([RANGE_STORE, METADATA_STORE], "readonly");
      const rangeRequest = transaction.objectStore(RANGE_STORE).get(key) as IDBRequest<
        StoredRange | undefined
      >;
      const metadataRequest = transaction.objectStore(METADATA_STORE).get(key) as IDBRequest<
        StoredMetadata | undefined
      >;
      const [range, metadata] = await Promise.all([
        requestResult(rangeRequest),
        requestResult(metadataRequest),
        transactionDone(transaction),
      ]);
      return range && metadata
        ? {
            bytes: range.bytes,
            range: range.range,
            byteLength: range.byteLength,
            lastAccessed: metadata.lastAccessed,
          }
        : null;
    },
    async list() {
      const database = await open();
      const transaction = database.transaction(METADATA_STORE, "readonly");
      const done = transactionDone(transaction);
      const [records] = await Promise.all([
        requestResult(
          transaction.objectStore(METADATA_STORE).getAll() as IDBRequest<StoredMetadata[]>,
        ),
        done,
      ]);
      return records;
    },
    async set(key, entry) {
      const database = await open();
      const transaction = database.transaction([RANGE_STORE, METADATA_STORE], "readwrite");
      transaction.objectStore(RANGE_STORE).put({
        key,
        bytes: entry.bytes,
        range: entry.range,
        byteLength: entry.byteLength,
      } satisfies StoredRange);
      transaction.objectStore(METADATA_STORE).put({
        key,
        byteLength: entry.byteLength,
        lastAccessed: entry.lastAccessed,
      } satisfies StoredMetadata);
      await transactionDone(transaction);
    },
    async delete(key) {
      const database = await open();
      const transaction = database.transaction([RANGE_STORE, METADATA_STORE], "readwrite");
      transaction.objectStore(RANGE_STORE).delete(key);
      transaction.objectStore(METADATA_STORE).delete(key);
      await transactionDone(transaction);
    },
    async touch(key, lastAccessed) {
      const database = await open();
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const done = transactionDone(transaction);
      void done.catch(() => {});
      const store = transaction.objectStore(METADATA_STORE);
      const metadata = await requestResult(
        store.get(key) as IDBRequest<StoredMetadata | undefined>,
      );
      if (metadata) store.put({ ...metadata, lastAccessed } satisfies StoredMetadata);
      await done;
    },
  };
}

function getSharedIndexedDbBackend() {
  return (sharedIndexedDbBackend ??= createIndexedDbCadAssetRangeBackend());
}
