import type { CadGeometryAsset } from "@cadsense/contracts";

const RANGE_BYTES = 4 * 1024 ** 2;
const PREFETCH_RANGES = 4;
/** Decode a manifest-ordered bundle with bounded, independently compressed ranges.
 * At most 16 MB of range data is prefetched, in addition to the renderer's asset window. */
export function readCadAssetBundle(
  assets: readonly Pick<CadGeometryAsset, "sha256" | "byteLength">[],
  request: (start: number, end: number) => Promise<Response>,
  onBytes: (count: number) => void,
) {
  const seen = new Set<string>();
  const unique = assets.filter((asset) => !seen.has(asset.sha256) && seen.add(asset.sha256));
  const total = unique.reduce((sum, asset) => sum + asset.byteLength, 0);
  type Outcome = { bytes: Uint8Array } | { error: unknown };
  const pending = new Map<number, Promise<Outcome>>();
  let requested = 0,
    consumed = 0;
  const fill = () => {
    while (pending.size < PREFETCH_RANGES && requested < total) {
      const start = requested,
        length = Math.min(RANGE_BYTES, total - start);
      requested += length;
      pending.set(
        start,
        (async (): Promise<Outcome> => {
          try {
            const response = await request(start, start + length - 1);
            if (
              !response.ok ||
              !response.body ||
              (!response.headers.has("x-cad-bundle-range") &&
                !(start === 0 && length === total && response.status === 200))
            )
              throw new Error("CAD bundle unavailable");
            if (
              response.headers.has("x-cad-bundle-range") &&
              response.headers.get("x-cad-bundle-range") !==
                `bytes ${start}-${start + length - 1}/${total}`
            )
              throw new Error("CAD bundle range mismatch");
            const reader = response.body.getReader(),
              bytes = new Uint8Array(length);
            let offset = 0;
            let complete = false;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (offset + chunk.value.length > length)
                  throw new Error("CAD bundle has trailing bytes");
                bytes.set(chunk.value, offset);
                offset += chunk.value.length;
              }
              if (offset !== length) throw new Error("CAD bundle truncated");
              complete = true;
              return { bytes };
            } finally {
              if (!complete) await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } catch (error) {
            return { error };
          }
        })(),
      );
    }
  };
  let chunk: Uint8Array = new Uint8Array(0),
    offset = 0,
    cursor = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (hash: string): Promise<ArrayBuffer> => {
    const result = queue.then(async () => {
      const asset = unique[cursor++];
      if (!asset || asset.sha256 !== hash) throw new Error("CAD bundle order mismatch");
      const bytes = new Uint8Array(asset.byteLength);
      let written = 0;
      while (written < bytes.length) {
        if (offset === chunk.length) {
          fill();
          const result = await pending.get(consumed);
          pending.delete(consumed);
          if (!result) throw new Error("CAD bundle truncated");
          if ("error" in result) throw result.error;
          chunk = result.bytes;
          consumed += chunk.length;
          offset = 0;
          fill();
        }
        const count = Math.min(bytes.length - written, chunk.length - offset);
        bytes.set(chunk.subarray(offset, offset + count), written);
        written += count;
        offset += count;
        onBytes(count);
      }
      return bytes.buffer;
    });
    queue = result;
    return result;
  };
}
