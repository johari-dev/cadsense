import { validateCadTransferIndex } from "@cadsense/shared/cadTransfer";
import type { CadGeometryAsset } from "@cadsense/contracts";
import {
  createCachedCadAssetRangeRequest,
  hasCachedCadAssetRanges,
  invalidateCadAssetRanges,
  type CadAssetRangeCacheNamespace,
} from "./CadAssetRangeCache";
import { readCadAssetBundle } from "./CadAssetBundle";
import { readCadTransferAssets } from "./CadTransferReader";

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

/** Both representations reconstruct the same authenticated snapshot before scene publication. */
export async function loadCadAssetDelivery(options: CadAssetDeliveryOptions) {
  const { assets, namespace, signal, request, load, onProgress } = options;
  const total = [...new Map(assets.map((asset) => [asset.sha256, asset])).values()].reduce(
    (sum, asset) => sum + asset.byteLength,
    0,
  );
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
  const original = () => {
    resetProgress();
    return load(
      readCadAssetBundle(
        assets,
        createCachedCadAssetRangeRequest({
          namespace,
          expectedTotalBytes: total,
          signal,
          request: (start, end) => request(`bundle?start=${start}&end=${end}`, signal),
        }),
        onBytes,
      ),
    );
  };
  if (total === 0 || (await hasCachedCadAssetRanges(namespace, total))) {
    if (signal.aborted) throw signal.reason;
    await original();
    return;
  }
  const attempt = new AbortController();
  const onAbort = () => attempt.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let derivedNamespace: CadAssetRangeCacheNamespace | undefined;
  let loading = false;
  let readFailed = false;
  try {
    if (signal.aborted) throw signal.reason;
    const response = await request("transfer-index", attempt.signal);
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
    const index = validateCadTransferIndex(value.index, assets);
    const identity = value.identity;
    derivedNamespace = { ...namespace, representation: `${index.version}:${identity}` };
    const readAsset = readCadTransferAssets(
      index,
      createCachedCadAssetRangeRequest({
        namespace: derivedNamespace,
        expectedTotalBytes: index.byteLength,
        signal: attempt.signal,
        request: (start, end) =>
          request(`transfer?identity=${identity}&start=${start}&end=${end}`, attempt.signal),
      }),
      attempt.signal,
      onBytes,
    );
    resetProgress();
    loading = true;
    await load(async (hash) => {
      try {
        return await readAsset(hash);
      } catch (error) {
        readFailed = true;
        throw error;
      }
    });
  } catch (error) {
    attempt.abort();
    if (signal.aborted) throw error;
    if (loading && !readFailed) throw error;
    if (derivedNamespace && readFailed) void invalidateCadAssetRanges(derivedNamespace);
    await original();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
