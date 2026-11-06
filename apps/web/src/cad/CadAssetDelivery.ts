import { encodeCadTransferSelection, validateCadTransferIndex } from "@cadsense/shared/cadTransfer";
import type { CadGeometryAsset } from "@cadsense/contracts";
import {
  createCachedCadAssetRangeRequest,
  hasCachedCadAssetRanges,
  invalidateCadAssetRanges,
  type CadAssetRangeCacheNamespace,
} from "./CadAssetRangeCache";
import { readCadAssetBundle } from "./CadAssetBundle";
import { getSharedCadAssetCache } from "./CadAssetCache";
import { readCadTransferAssets } from "./CadTransferReader";
import { decodeCadTransferResponse } from "./CadTransferBrotli";
import { CadAssetIntegrityError, verifyCadAssetBytes } from "./CadAssetIntegrity";

export interface CadAssetDeliveryOptions {
  readonly assets: readonly Pick<CadGeometryAsset, "sha256" | "byteLength">[];
  readonly namespace: CadAssetRangeCacheNamespace;
  readonly signal: AbortSignal;
  readonly request: (path: string, signal: AbortSignal) => Promise<Response>;
  readonly load: (readAsset: (hash: string) => Promise<ArrayBuffer>) => Promise<void>;
  readonly onProgress: (received: number, total: number) => void;
}

async function readTransferIndex(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing CAD transfer index");
  const bytes = new Uint8Array(4 * 1024 ** 2);
  const reader = response.body.getReader();
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength)
        throw new Error("Oversized CAD transfer index");
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    complete = true;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Loads a snapshot's assets for the renderer and verifies each one before scene publication.
 * Assets this browser kept from any earlier snapshot come from its asset cache; the rest arrive
 * as an optimized transfer of just those assets. The original GLB bundle is the fallback.
 */
export async function loadCadAssetDelivery(options: CadAssetDeliveryOptions) {
  const { assets, namespace, signal, request, load, onProgress } = options;
  const distinct = [...new Map(assets.map((asset) => [asset.sha256, asset])).values()];
  const total = distinct.reduce((sum, asset) => sum + asset.byteLength, 0);
  let received = 0;
  let updated = 0;
  const resetProgress = () => {
    received = 0;
    updated = 0;
    onProgress(0, total);
  };
  const onBytes = (count: number) => {
    received += count;
    const now = performance.now();
    if (!signal.aborted && (now - updated >= 100 || received === total)) {
      updated = now;
      onProgress(received, total);
    }
  };
  const original = async () => {
    for (let retry = 0; retry < 2; retry++) {
      const attempt = new AbortController();
      let integrityFailed = false;
      const onAbort = () => attempt.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) throw signal.reason;
        resetProgress();
        const readAsset = readCadAssetBundle(
          assets,
          createCachedCadAssetRangeRequest({
            namespace,
            expectedTotalBytes: total,
            signal: attempt.signal,
            request: (start, end) => request(`bundle?start=${start}&end=${end}`, attempt.signal),
            skipCacheRead: retry > 0,
          }),
          onBytes,
        );
        await load(async (hash) => {
          const bytes = await readAsset(hash);
          try {
            await verifyCadAssetBytes(bytes, hash);
          } catch (error) {
            if (error instanceof CadAssetIntegrityError) integrityFailed = true;
            throw error;
          }
          if (signal.aborted) throw signal.reason;
          return bytes;
        });
        return;
      } catch (error) {
        attempt.abort();
        if (signal.aborted || !integrityFailed) throw error;
        void invalidateCadAssetRanges(namespace);
        if (retry > 0) throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  };
  if (total === 0 || (await hasCachedCadAssetRanges(namespace, total))) {
    if (signal.aborted) throw signal.reason;
    await original();
    return;
  }
  const assetCache = getSharedCadAssetCache();
  const byteLengths = new Map(distinct.map((asset) => [asset.sha256, asset.byteLength]));
  /**
   * Reads the assets in `cached` from this browser and transfers the rest. Resolves "loaded", or
   * which source failed: "cache" when a cached asset was gone or corrupt, "transfer" when the
   * optimized transfer was unavailable or bad. Renderer failures and cancellation throw.
   */
  const transfer = async (cached: ReadonlySet<string>) => {
    const attempt = new AbortController();
    const onAbort = () => attempt.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let loading = false;
    let failed: "cache" | "transfer" | undefined;
    try {
      if (signal.aborted) throw signal.reason;
      const missing = distinct.filter((asset) => !cached.has(asset.sha256));
      // Name the missing assets only when some are cached; the full transfer is shared and reused.
      const selection =
        cached.size > 0 && missing.length > 0
          ? `assets=${encodeCadTransferSelection(assets, new Set(missing.map((asset) => asset.sha256)))}`
          : undefined;
      let readTransfer = (_hash: string): Promise<ArrayBuffer> =>
        Promise.reject(new Error("CAD asset is not in the transfer"));
      if (missing.length > 0) {
        const response = await request(
          selection ? `transfer-index?${selection}` : "transfer-index",
          attempt.signal,
        );
        if (!response.ok) throw new Error("CAD optimized delivery unavailable");
        const value = await readTransferIndex(response);
        if (
          !value ||
          typeof value !== "object" ||
          !("identity" in value) ||
          !("index" in value) ||
          typeof value.identity !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.identity)
        )
          throw new Error("Invalid CAD transfer identity");
        const index = validateCadTransferIndex(value.index, missing);
        const identity = value.identity;
        readTransfer = readCadTransferAssets(
          index,
          // Opt in to prepared Brotli bodies when the browser could not negotiate br itself.
          async (start, end) =>
            decodeCadTransferResponse(
              await request(
                `transfer?identity=${identity}&start=${start}&end=${end}&decode=br${selection ? `&${selection}` : ""}`,
                attempt.signal,
              ),
              end - start + 1,
            ),
          attempt.signal,
          onBytes,
        );
      }
      resetProgress();
      loading = true;
      await load(async (hash) => {
        if (cached.has(hash)) {
          const bytes = await assetCache.read(hash, byteLengths.get(hash)!);
          if (!bytes) {
            failed = "cache";
            throw new Error("Cached CAD asset unavailable");
          }
          if (signal.aborted) throw signal.reason;
          onBytes(bytes.byteLength);
          return bytes;
        }
        try {
          const bytes = await readTransfer(hash);
          assetCache.write(hash, bytes);
          return bytes;
        } catch (error) {
          failed = "transfer";
          throw error;
        }
      });
      return "loaded";
    } catch (error) {
      attempt.abort();
      if (signal.aborted || (loading && failed === undefined)) throw error;
      return failed ?? "transfer";
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const cached = await assetCache.cached(distinct);
  if (signal.aborted) throw signal.reason;
  let outcome = await transfer(cached);
  // A cached asset vanished or went bad partway through: transfer the whole snapshot instead.
  if (outcome === "cache") outcome = await transfer(new Set());
  if (outcome !== "loaded") await original();
}
