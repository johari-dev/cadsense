import type { CadTransferIndex } from "@cadsense/shared/cadTransfer";
import { readCadAssetBundle } from "./CadAssetBundle";
import { decodeCadTransferBin } from "./CadTransferDecoder";

const MAX_PREFIX_BYTES = 32 * 1024 ** 2;
const MAX_SHARED_BIN_BYTES = 64 * 1024 ** 2;

/** Consume the encoded stream in manifest order, retaining only BINs with future references.
 * Range prefetch remains four 4 MiB ranges; the renderer separately bounds reconstructed assets.
 */
export function readCadTransferAssets(
  index: CadTransferIndex,
  request: (start: number, end: number) => Promise<Response>,
  signal: AbortSignal,
  onBytes: (count: number) => void,
): (hash: string) => Promise<ArrayBuffer> {
  const prefixBytes = index.assets.reduce((sum, asset) => sum + asset.prefix.byteLength, 0);
  const remaining = index.bins.map(() => 0);
  for (const asset of index.assets) remaining[asset.bin]!++;
  const sharedBytes = index.bins.reduce(
    (sum, bin, i) => sum + (remaining[i]! > 1 ? bin.byteLength : 0),
    0,
  );
  if (prefixBytes > MAX_PREFIX_BYTES || sharedBytes > MAX_SHARED_BIN_BYTES)
    throw new Error("CAD transfer exceeds reconstruction cache budget");
  const parts = [
    ...(prefixBytes ? [{ sha256: "prefixes", byteLength: prefixBytes }] : []),
    ...index.bins.map((bin, i) => ({
      sha256: `bin:${i}`,
      byteLength: bin.segments.reduce((sum, segment) => sum + segment.byteLength, 0),
    })),
  ];
  const readPart = readCadAssetBundle(parts, request, () => {});
  const bins = new Map<number, Uint8Array>();
  let prefixes: Uint8Array | null = null;
  let cursor = 0;
  let nextBin = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const assertActive = () => {
    if (signal.aborted) throw signal.reason ?? new Error("CAD transfer cancelled");
  };
  return (hash) => {
    const result = queue.then(async () => {
      assertActive();
      const asset = index.assets[cursor++];
      if (!asset || asset.sha256 !== hash) throw new Error("CAD transfer asset order mismatch");
      prefixes ??= prefixBytes ? new Uint8Array(await readPart("prefixes")) : new Uint8Array(0);
      assertActive();
      let bin = bins.get(asset.bin);
      if (!bin) {
        if (asset.bin !== nextBin++) throw new Error("CAD transfer BIN order mismatch");
        const descriptor = index.bins[asset.bin]!;
        const encoded = new Uint8Array(await readPart(`bin:${asset.bin}`));
        assertActive();
        const start = descriptor.segments[0]?.offset ?? 0;
        bin = await decodeCadTransferBin(descriptor, async (offset, length) => {
          assertActive();
          return encoded.subarray(offset - start, offset - start + length);
        });
        if (remaining[asset.bin]! > 1) bins.set(asset.bin, bin);
      }
      assertActive();
      const bytes = new Uint8Array(asset.byteLength);
      bytes.set(
        prefixes.subarray(asset.prefix.offset, asset.prefix.offset + asset.prefix.byteLength),
      );
      bytes.set(bin, asset.prefix.byteLength);
      if (--remaining[asset.bin]! === 0) bins.delete(asset.bin);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      assertActive();
      if (actual !== hash) throw new Error("CAD transfer asset hash mismatch");
      onBytes(bytes.byteLength);
      return bytes.buffer;
    });
    queue = result;
    return result;
  };
}
