import type { CadGeometryAsset } from "@cadsense/contracts";

const MAX_REQUESTS = 6;
const MAX_BUFFERED_BYTES = 32 * 1024 ** 2;
type Outcome = { readonly bytes: ArrayBuffer } | { readonly error: unknown };

/** Read ahead in manifest order without retaining every downloaded asset at once.
 * A single large asset may exceed the window; it is then downloaded alone.
 * All rejections are observed even when a scene is superseded or parsing fails.
 */
export function prefetchCadAssets(
  assets: readonly Pick<CadGeometryAsset, "sha256" | "byteLength">[],
  readAsset: (hash: string) => Promise<ArrayBuffer>,
  isActive: () => boolean = () => true,
) {
  const seen = new Set<string>();
  const unique = assets.filter((asset) => {
    if (seen.has(asset.sha256)) return false;
    seen.add(asset.sha256);
    return true;
  });
  const pending = new Map<string, { bytes: number; result: Promise<Outcome> }>();
  let cursor = 0;
  let bufferedBytes = 0;
  let closed = false;
  const fill = () => {
    if (closed || !isActive()) return;
    while (cursor < unique.length && pending.size < MAX_REQUESTS) {
      const asset = unique[cursor]!;
      if (pending.size > 0 && bufferedBytes + asset.byteLength > MAX_BUFFERED_BYTES) break;
      cursor++;
      bufferedBytes += asset.byteLength;
      pending.set(asset.sha256, {
        bytes: asset.byteLength,
        result: (async (): Promise<Outcome> => {
          try {
            return { bytes: await readAsset(asset.sha256) };
          } catch (error) {
            return { error };
          }
        })(),
      });
    }
  };
  return {
    async read(hash: string) {
      fill();
      const entry = pending.get(hash);
      if (!entry || closed) throw new Error("CAD asset prefetch unavailable");
      const result = await entry.result;
      if (closed) throw new Error("CAD asset prefetch closed");
      pending.delete(hash);
      bufferedBytes -= entry.bytes;
      if ("error" in result) throw result.error;
      fill();
      return result.bytes;
    },
    dispose() {
      closed = true;
      pending.clear();
    },
  };
}
