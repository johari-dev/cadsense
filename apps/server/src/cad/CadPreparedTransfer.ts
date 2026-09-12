// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

export const CAD_BUNDLE_RANGE_BYTES = 4 * 1024 ** 2;
const DEFAULT_MAX_BYTES = 256 * 1024 ** 2;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_WARM_INPUT_BYTES = 512 * 1024 ** 2;
const DEFAULT_WARM_CONCURRENCY = 2;
const DEFAULT_MAX_CONCURRENT_PREPARATIONS = 4;
const ENCODING_VERSION = "br5-v1";

interface CadTransferAssetInput {
  readonly sha256: string;
  readonly byteLength: number;
}

interface CadTransferManifestInput {
  readonly snapshotId: string;
  readonly assets: ReadonlyArray<CadTransferAssetInput>;
}

interface PlannedAsset extends CadTransferAssetInput {
  readonly offset: number;
}

export interface CadBundleSlice extends CadTransferAssetInput {
  readonly start: number;
  readonly end: number;
}

export interface CadBundleRange {
  readonly start: number;
  readonly end: number;
  readonly slices: ReadonlyArray<CadBundleSlice>;
}

export interface CadBundlePlan {
  readonly snapshotId: string;
  readonly identity: string;
  readonly totalBytes: number;
  readonly assets: ReadonlyArray<PlannedAsset>;
  readonly ranges: ReadonlyArray<CadBundleRange>;
}

const assertPositiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
};

export const createCadBundleRange = (
  plan: CadBundlePlan,
  start: number,
  end: number,
): CadBundleRange => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end >= plan.totalBytes ||
    end - start + 1 > CAD_BUNDLE_RANGE_BYTES
  )
    throw new RangeError("Invalid CAD bundle range");
  const slices: CadBundleSlice[] = [];
  for (const asset of plan.assets) {
    const assetEnd = asset.offset + asset.byteLength;
    if (assetEnd <= start) continue;
    if (asset.offset > end) break;
    slices.push({
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      start: Math.max(0, start - asset.offset),
      end: Math.min(asset.byteLength, end + 1 - asset.offset),
    });
  }
  return { start, end, slices };
};

export const createCadBundlePlan = (
  manifest: CadTransferManifestInput,
  options?: { readonly rangeBytes?: number },
): CadBundlePlan => {
  const rangeBytes = options?.rangeBytes ?? CAD_BUNDLE_RANGE_BYTES;
  assertPositiveInteger(rangeBytes, "rangeBytes");
  if (rangeBytes > CAD_BUNDLE_RANGE_BYTES)
    throw new RangeError("rangeBytes exceeds the HTTP range limit");
  const seen = new Set<string>();
  const assets: PlannedAsset[] = [];
  let totalBytes = 0;
  const fingerprint = NodeCrypto.createHash("sha256").update(manifest.snapshotId).update("\0");
  for (const asset of manifest.assets) {
    if (seen.has(asset.sha256)) continue;
    seen.add(asset.sha256);
    assertPositiveInteger(asset.byteLength, "asset.byteLength");
    assets.push({ ...asset, offset: totalBytes });
    totalBytes += asset.byteLength;
    if (!Number.isSafeInteger(totalBytes)) throw new RangeError("CAD bundle is too large");
    fingerprint.update(asset.sha256).update("\0").update(String(asset.byteLength)).update("\0");
  }
  const partialPlan = {
    snapshotId: manifest.snapshotId,
    identity: fingerprint.digest("hex"),
    totalBytes,
    assets,
  };
  const ranges: CadBundleRange[] = [];
  for (let start = 0; start < totalBytes; start += rangeBytes)
    ranges.push(
      createCadBundleRange(
        { ...partialPlan, ranges },
        start,
        Math.min(totalBytes - 1, start + rangeBytes - 1),
      ),
    );
  return { ...partialPlan, ranges };
};

const acceptMember = /^([a-z0-9!#$%&'*+.^_`|~-]+)(?:;q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/;

export const acceptsPreparedCadEncoding = (header: string | undefined): boolean => {
  if (header === undefined || header.trim() === "") return false;
  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const member = part
      .trim()
      .toLowerCase()
      .replace(/[ \t]*;[ \t]*/g, ";");
    const match = acceptMember.exec(member);
    if (match === null) return false;
    accepted.set(match[1]!, match[2] === undefined ? 1 : Number(match[2]));
  }
  const quality = accepted.get("br") ?? accepted.get("*");
  return quality !== undefined && quality > 0;
};

const brotliEncode = (input: Uint8Array) =>
  new Promise<Uint8Array>((resolve, reject) => {
    NodeZlib.brotliCompress(
      input,
      {
        params: {
          [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
        },
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
  });

type ReadAsset = (sha256: string) => Promise<Uint8Array>;
type Encode = (input: Uint8Array) => Promise<Uint8Array>;

interface PendingEntry {
  readonly state: "pending";
  readonly snapshotId: string;
  readonly identity: string;
  readonly promise: Promise<Uint8Array>;
  lastUsed: number;
}

interface ReadyEntry {
  readonly state: "ready";
  readonly snapshotId: string;
  readonly identity: string;
  readonly promise: Promise<Uint8Array>;
  readonly byteLength: number;
  lastUsed: number;
}

type Entry = PendingEntry | ReadyEntry;

export interface PreparedCadTransferCache {
  readonly retain: (plan: CadBundlePlan, owner: object, whenReleased: () => Promise<void>) => void;
  readonly get: (
    plan: CadBundlePlan,
    range: CadBundleRange,
    readAsset: ReadAsset,
  ) => Promise<Uint8Array>;
  readonly warm: (plan: CadBundlePlan, owner: object, readAsset: ReadAsset) => Promise<void>;
  readonly clear: () => void;
  readonly stats: () => {
    readonly bytes: number;
    readonly pendingEntries: number;
    readonly readyEntries: number;
    readonly retainedIdentities: number;
    readonly warmJobs: number;
  };
}

const readRange = async (range: CadBundleRange, readAsset: ReadAsset) => {
  const bytes = new Uint8Array(range.end - range.start + 1);
  let cursor = 0;
  for (const slice of range.slices) {
    const asset = await readAsset(slice.sha256);
    if (asset.byteLength !== slice.byteLength) throw new Error("CAD asset length changed");
    const chunk = asset.subarray(slice.start, slice.end);
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (cursor !== bytes.byteLength) throw new Error("CAD bundle range was incomplete");
  return bytes;
};

export const makePreparedCadTransferCache = (options?: {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxWarmInputBytes?: number;
  readonly warmConcurrency?: number;
  readonly maxConcurrentPreparations?: number;
  readonly encode?: Encode;
}): PreparedCadTransferCache => {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxWarmInputBytes = options?.maxWarmInputBytes ?? DEFAULT_MAX_WARM_INPUT_BYTES;
  const warmConcurrency = options?.warmConcurrency ?? DEFAULT_WARM_CONCURRENCY;
  const maxConcurrentPreparations =
    options?.maxConcurrentPreparations ?? DEFAULT_MAX_CONCURRENT_PREPARATIONS;
  for (const [value, name] of [
    [maxBytes, "maxBytes"],
    [maxEntries, "maxEntries"],
    [maxWarmInputBytes, "maxWarmInputBytes"],
    [warmConcurrency, "warmConcurrency"],
    [maxConcurrentPreparations, "maxConcurrentPreparations"],
  ] as const)
    assertPositiveInteger(value, name);
  const encode = options?.encode ?? brotliEncode;
  const entries = new Map<string, Entry>();
  interface Retention {
    count: number;
  }
  interface OwnerIdentity {
    retention: Retention | undefined;
  }
  interface WarmJob {
    readonly retention: Retention;
    active: boolean;
    readonly promise: Promise<void>;
  }
  const retentions = new Map<string, Retention>();
  let owners = new WeakMap<object, Map<string, OwnerIdentity>>();
  const warmJobs = new Map<string, Map<object, WarmJob>>();
  let retainedBytes = 0;
  let clock = 0;
  let activePreparations = 0;
  const preparationWaiters: Array<() => void> = [];

  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    if (entry.state === "ready") retainedBytes -= entry.byteLength;
  };
  const evictReady = (requiredBytes: number, requiredEntries: number, except?: Entry) => {
    while (true) {
      if (retainedBytes + requiredBytes <= maxBytes && entries.size + requiredEntries <= maxEntries)
        break;
      let oldestKey: string | undefined;
      let oldest: ReadyEntry | undefined;
      for (const [key, entry] of entries) {
        if (entry === except || entry.state !== "ready") continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (!oldest || oldestKey === undefined) break;
      remove(oldestKey, oldest);
    }
  };
  const activate = (plan: CadBundlePlan) => {
    for (const [key, entry] of entries)
      if (entry.snapshotId === plan.snapshotId && entry.identity !== plan.identity)
        remove(key, entry);
  };
  const retain: PreparedCadTransferCache["retain"] = (plan, owner, whenReleased) => {
    let identities = owners.get(owner);
    if (identities?.has(plan.identity)) return;
    if (!identities) {
      identities = new Map();
      owners.set(owner, identities);
    }
    // Keep this tombstone for the owner's lifetime so a released scene cannot
    // reacquire cache ownership through a late request.
    const ownerIdentity: OwnerIdentity = { retention: undefined };
    identities.set(plan.identity, ownerIdentity);
    activate(plan);
    let retention = retentions.get(plan.identity);
    if (!retention) {
      retention = { count: 0 };
      retentions.set(plan.identity, retention);
    }
    ownerIdentity.retention = retention;
    retention.count++;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      ownerIdentity.retention = undefined;
      const jobs = warmJobs.get(plan.identity);
      const warming = jobs?.get(owner);
      if (warming?.retention === retention) {
        warming.active = false;
        jobs!.delete(owner);
        if (jobs!.size === 0) warmJobs.delete(plan.identity);
      }
      retention.count--;
      if (retention.count !== 0 || retentions.get(plan.identity) !== retention) return;
      retentions.delete(plan.identity);
      for (const [key, entry] of entries) if (entry.identity === plan.identity) remove(key, entry);
    };
    try {
      void whenReleased().then(release, release);
    } catch {
      release();
    }
  };
  const prepare = async (range: CadBundleRange, readAsset: ReadAsset) => {
    if (activePreparations >= maxConcurrentPreparations)
      await new Promise<void>((resolve) => preparationWaiters.push(resolve));
    activePreparations++;
    try {
      return await encode(await readRange(range, readAsset));
    } finally {
      activePreparations--;
      preparationWaiters.shift()?.();
    }
  };
  const getRetained = (
    plan: CadBundlePlan,
    range: CadBundleRange,
    readAsset: ReadAsset,
    retention: Retention,
  ) => {
    activate(plan);
    const key = `${ENCODING_VERSION}:${plan.identity}:${range.start}-${range.end}`;
    const existing = entries.get(key);
    if (existing) {
      existing.lastUsed = ++clock;
      return existing.promise;
    }
    evictReady(0, 1);
    if (entries.size >= maxEntries) return prepare(range, readAsset);
    const entry: PendingEntry = {
      state: "pending",
      snapshotId: plan.snapshotId,
      identity: plan.identity,
      lastUsed: ++clock,
      promise: undefined as never,
    };
    const promise = prepare(range, readAsset).then(
      (result) => {
        if (entries.get(key) !== entry || retentions.get(plan.identity) !== retention)
          return result;
        if (result.byteLength > maxBytes) {
          entries.delete(key);
          return result;
        }
        evictReady(result.byteLength, 0, entry);
        if (retainedBytes + result.byteLength > maxBytes) {
          entries.delete(key);
          return result;
        }
        const ready: ReadyEntry = {
          ...entry,
          state: "ready",
          promise,
          byteLength: result.byteLength,
          lastUsed: ++clock,
        };
        entries.set(key, ready);
        retainedBytes += result.byteLength;
        return result;
      },
      (error) => {
        remove(key, entry);
        throw error;
      },
    );
    Object.assign(entry, { promise });
    entries.set(key, entry);
    return promise;
  };
  const get: PreparedCadTransferCache["get"] = (plan, range, readAsset) => {
    const retention = retentions.get(plan.identity);
    return retention ? getRetained(plan, range, readAsset, retention) : prepare(range, readAsset);
  };
  const warm: PreparedCadTransferCache["warm"] = async (plan, owner, readAsset) => {
    const retention = owners.get(owner)?.get(plan.identity)?.retention;
    if (!retention || retentions.get(plan.identity) !== retention) return;
    let jobs = warmJobs.get(plan.identity);
    const existing = jobs?.get(owner);
    if (existing?.retention === retention) return existing.promise;
    if (plan.totalBytes > maxWarmInputBytes || plan.ranges.length > maxEntries) return;
    const job: WarmJob = {
      retention,
      active: true,
      promise: undefined as never,
    };
    const promise = (async () => {
      let next = 0;
      const worker = async () => {
        while (
          job.active &&
          retentions.get(plan.identity) === retention &&
          next < plan.ranges.length
        ) {
          const range = plan.ranges[next++]!;
          try {
            await getRetained(plan, range, readAsset, retention);
          } catch {
            // A shared pending read can fail when its originating scene releases.
            // Retry once with this still-active owner's reader.
            if (job.active && retentions.get(plan.identity) === retention)
              await getRetained(plan, range, readAsset, retention).catch(() => undefined);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(warmConcurrency, plan.ranges.length) }, () => worker()),
      );
    })().finally(() => {
      const current = warmJobs.get(plan.identity);
      if (current?.get(owner) !== job) return;
      current.delete(owner);
      if (current.size === 0) warmJobs.delete(plan.identity);
    });
    Object.assign(job, { promise });
    if (!jobs) {
      jobs = new Map();
      warmJobs.set(plan.identity, jobs);
    }
    jobs.set(owner, job);
    return promise;
  };
  const clear = () => {
    entries.clear();
    retentions.clear();
    owners = new WeakMap();
    warmJobs.clear();
    retainedBytes = 0;
  };
  const stats = () => {
    let pendingEntries = 0;
    let readyEntries = 0;
    for (const entry of entries.values()) {
      if (entry.state === "pending") pendingEntries++;
      else readyEntries++;
    }
    return {
      bytes: retainedBytes,
      pendingEntries,
      readyEntries,
      retainedIdentities: retentions.size,
      warmJobs: [...warmJobs.values()].reduce((count, jobs) => count + jobs.size, 0),
    };
  };
  return { retain, get, warm, clear, stats };
};

export const preparedCadTransfers = makePreparedCadTransferCache();
