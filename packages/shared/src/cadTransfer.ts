import { CAD_SCENE_LIMITS } from "./cadSceneBudget.ts";

export const CAD_TRANSFER_VERSION = "meshopt-bin-v1" as const;
/** A transfer range body that is still Brotli-compressed, for the client to decode itself.
 * Browsers only advertise `br` over HTTPS or localhost, so a page opened at a plain-http
 * address (a tailnet or LAN IP) opts in with `decode=br` instead. */
export const CAD_TRANSFER_BROTLI_CONTENT_TYPE =
  "application/vnd.cadsense.geometry-bundle+br" as const;
export interface CadTransferSlice {
  readonly offset: number;
  readonly byteLength: number;
}
export interface CadTransferSegment extends CadTransferSlice {
  readonly decodedByteLength: number;
  readonly mode: "raw" | "vertex" | "index";
  readonly count: number;
  readonly stride: number;
}
export interface CadTransferBin {
  readonly byteLength: number;
  readonly segments: readonly CadTransferSegment[];
}
export interface CadTransferAsset {
  readonly sha256: string;
  readonly byteLength: number;
  readonly prefix: CadTransferSlice;
  readonly bin: number;
}
export interface CadTransferIndex {
  readonly version: typeof CAD_TRANSFER_VERSION;
  readonly byteLength: number;
  readonly assets: readonly CadTransferAsset[];
  readonly bins: readonly CadTransferBin[];
}
type CadTransferSource = { readonly sha256: string };
const distinct = <T extends CadTransferSource>(assets: readonly T[]): T[] => {
  const seen = new Set<string>();
  return assets.filter((asset) => !seen.has(asset.sha256) && seen.add(asset.sha256));
};
/**
 * Names a subset of a manifest's distinct assets (first-seen order) as a hex bitmap, one bit per
 * asset, least significant bit first. A browser sends it as `assets=` so the server prepares a
 * transfer of only the geometry the browser does not already hold.
 */
export function encodeCadTransferSelection(
  assets: readonly CadTransferSource[],
  selected: ReadonlySet<string>,
): string {
  const unique = distinct(assets);
  const bits = new Uint8Array(Math.ceil(unique.length / 8));
  unique.forEach((asset, index) => {
    if (selected.has(asset.sha256)) bits[index >> 3]! |= 1 << (index & 7);
  });
  return [...bits].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** The manifest's distinct assets a selection names, in manifest order. Throws unless the
 * selection was made for this manifest and names at least one asset. */
export function selectCadTransferAssets<T extends CadTransferSource>(
  assets: readonly T[],
  selection: string,
): T[] {
  const unique = distinct(assets);
  const invalid = () => new Error("Invalid CAD transfer selection");
  if (selection.length !== Math.ceil(unique.length / 8) * 2 || !/^[0-9a-f]*$/.test(selection))
    throw invalid();
  const bits = Uint8Array.from(selection.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const tail = unique.length % 8;
  if (tail !== 0 && bits[bits.length - 1]! >> tail !== 0) throw invalid();
  const chosen = unique.filter((_, index) => (bits[index >> 3]! >> (index & 7)) & 1);
  if (chosen.length === 0) throw invalid();
  return chosen;
}

const invalid = () => new Error("Invalid CAD transfer index");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const integer = (value: unknown, max = CAD_SCENE_LIMITS.decodedBytes): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw invalid();
  return value;
};
const array = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
};
const slice = (value: unknown): CadTransferSlice => {
  const record = object(value);
  return { offset: integer(record.offset), byteLength: integer(record.byteLength) };
};

/** Validate allocation sizes before invoking the WASM decoder, including standalone BIN reads. */
export function validateCadTransferBin(value: unknown): CadTransferBin {
  const record = object(value);
  const byteLength = integer(record.byteLength);
  let decoded = 0;
  let encodedEnd: number | undefined;
  const segments = array(record.segments, 65_536).map((value): CadTransferSegment => {
    const record = object(value);
    const part = slice(record);
    const decodedByteLength = integer(record.decodedByteLength);
    const count = integer(record.count);
    const stride = integer(record.stride, 256);
    const mode = record.mode;
    if (part.byteLength === 0 || decodedByteLength === 0) throw invalid();
    if (encodedEnd !== undefined && encodedEnd !== part.offset) throw invalid();
    encodedEnd = integer(part.offset + part.byteLength);
    if (mode === "raw") {
      if (count !== 0 || stride !== 0 || part.byteLength !== decodedByteLength) throw invalid();
    } else if (mode === "vertex" || mode === "index") {
      if (
        count === 0 ||
        stride === 0 ||
        count * stride !== decodedByteLength ||
        (mode === "vertex" && stride % 4 !== 0) ||
        (mode === "index" && stride !== 2 && stride !== 4) ||
        part.byteLength > decodedByteLength
      )
        throw invalid();
    } else throw invalid();
    decoded = integer(decoded + decodedByteLength);
    return { ...part, decodedByteLength, count, stride, mode };
  });
  if (decoded !== byteLength) throw invalid();
  return { byteLength, segments };
}

/** The authenticated manifest is authoritative; the derived transfer cannot expand or omit assets. */
export function validateCadTransferIndex(
  value: unknown,
  assets: readonly { readonly sha256: string; readonly byteLength: number }[],
): CadTransferIndex {
  const record = object(value);
  if (record.version !== CAD_TRANSFER_VERSION) throw invalid();
  const byteLength = integer(record.byteLength);
  const unique = new Map<string, number>();
  let total = 0;
  for (const asset of assets) {
    const length = integer(asset.byteLength);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || length === 0) throw invalid();
    const previous = unique.get(asset.sha256);
    if (previous !== undefined && previous !== length) throw invalid();
    if (previous === undefined) {
      unique.set(asset.sha256, length);
      total = integer(total + length);
    }
  }
  if (byteLength > total) throw invalid();
  const bins = array(record.bins, 4_000).map(validateCadTransferBin);
  let cursor = 0;
  const expected = [...unique];
  const records = array(record.assets, 4_000);
  if (records.length !== expected.length) throw invalid();
  const usedBins = new Set<number>();
  const decodedAssets = records.map((value, index): CadTransferAsset => {
    const record = object(value);
    const prefix = slice(record.prefix);
    const bin = integer(record.bin, bins.length - 1);
    const original = expected[index]!;
    if (
      record.sha256 !== original[0] ||
      record.byteLength !== original[1] ||
      prefix.offset !== cursor ||
      prefix.byteLength + bins[bin]!.byteLength !== original[1]
    )
      throw invalid();
    cursor = integer(cursor + prefix.byteLength);
    if (!usedBins.has(bin) && bin !== usedBins.size) throw invalid();
    usedBins.add(bin);
    return { sha256: original[0], byteLength: original[1], prefix, bin };
  });
  if (usedBins.size !== bins.length) throw invalid();
  for (const bin of bins)
    for (const segment of bin.segments) {
      if (segment.offset !== cursor) throw invalid();
      cursor = integer(cursor + segment.byteLength);
    }
  if (cursor !== byteLength) throw invalid();
  return { version: CAD_TRANSFER_VERSION, byteLength, assets: decodedAssets, bins };
}
