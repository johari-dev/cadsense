// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CAD_TRANSFER_VERSION,
  validateCadTransferIndex,
  type CadTransferAsset,
  type CadTransferBin,
  type CadTransferIndex,
  type CadTransferSegment,
} from "@cadsense/shared/cadTransfer";
import { CAD_SCENE_LIMITS } from "@cadsense/shared/cadSceneBudget";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

type Asset = { readonly sha256: string; readonly byteLength: number };
type View = { byteOffset?: number; byteLength: number; byteStride?: number; buffer?: number };
type Accessor = { bufferView?: number; type?: string; componentType?: number };
type Document = { bufferViews?: View[]; accessors?: Accessor[] };
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function split(bytes: Uint8Array): { prefix: Uint8Array; bin: Uint8Array; document: Document } {
  // A valid but unsupported GLB layout remains a raw, exact asset.
  const raw = { prefix: bytes, bin: bytes.subarray(bytes.length), document: {} };
  if (bytes.length < 28) return raw;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    return raw;
  const jsonEnd = 20 + view.getUint32(12, true);
  if (
    jsonEnd + 8 > bytes.length ||
    view.getUint32(jsonEnd + 4, true) !== 0x004e4942 ||
    jsonEnd + 8 + view.getUint32(jsonEnd, true) !== bytes.length
  )
    return raw;
  try {
    const document: Document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, jsonEnd)));
    if (!document || typeof document !== "object") return raw;
    return { prefix: bytes.subarray(0, jsonEnd + 8), bin: bytes.subarray(jsonEnd + 8), document };
  } catch {
    return raw;
  }
}

function viewsFor(document: Document, bin: Uint8Array): (View & { index: number })[] | null {
  if (!Array.isArray(document.bufferViews) || !Array.isArray(document.accessors)) return null;
  const views = document.bufferViews
    .map((view, index) => ({ ...view, index }))
    .sort((a, b) => (a.byteOffset ?? 0) - (b.byteOffset ?? 0));
  let cursor = 0;
  for (const view of views) {
    const offset = view.byteOffset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(view.byteLength) ||
      offset < cursor ||
      view.byteLength < 0 ||
      offset + view.byteLength > bin.length ||
      (view.buffer ?? 0) !== 0
    )
      return null;
    cursor = offset + view.byteLength;
  }
  return views;
}

/** Persist append-only output without retaining a model-sized byte buffer.
 * Pass one writes JSON prefixes and records BIN identities; pass two encodes one representative
 * GLB per BIN. Each append must finish consuming its input before resolving. */
export async function encodeCadTransfer(
  assets: readonly Asset[],
  readAsset: (sha256: string) => Promise<Uint8Array>,
  appendChunk: (bytes: Uint8Array) => Promise<void>,
): Promise<CadTransferIndex> {
  const unique = new Map<string, Asset>();
  let originalBytes = 0;
  for (const asset of assets) {
    if (
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength <= 0 ||
      asset.byteLength > CAD_SCENE_LIMITS.decodedBytes ||
      (unique.has(asset.sha256) && unique.get(asset.sha256)!.byteLength !== asset.byteLength)
    )
      throw new Error("Invalid CAD transfer source");
    if (!unique.has(asset.sha256)) {
      unique.set(asset.sha256, asset);
      originalBytes += asset.byteLength;
    }
  }
  if (originalBytes > CAD_SCENE_LIMITS.decodedBytes || unique.size > 4_000)
    throw new Error("CAD transfer source exceeds scene budget");
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const read = async (asset: Asset) => {
    const bytes = await readAsset(asset.sha256);
    if (bytes.length !== asset.byteLength || sha256(bytes) !== asset.sha256)
      throw new Error("CAD transfer source integrity mismatch");
    return bytes;
  };
  const binIds = new Map<string, number>();
  const representatives: { asset: Asset; hash: string; byteLength: number }[] = [];
  const records: CadTransferAsset[] = [];
  let offset = 0;
  for (const asset of unique.values()) {
    const { prefix, bin } = split(await read(asset));
    const hash = sha256(bin);
    let id = binIds.get(hash);
    if (id === undefined) {
      id = representatives.length;
      binIds.set(hash, id);
      representatives.push({ asset, hash, byteLength: bin.length });
    } else if (representatives[id]!.byteLength !== bin.length)
      throw new Error("CAD BIN identity mismatch");
    records.push({
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      prefix: { offset, byteLength: prefix.length },
      bin: id,
    });
    await appendChunk(prefix);
    offset += prefix.length;
  }
  const bins: CadTransferBin[] = [];
  for (const representative of representatives) {
    const { bin, document } = split(await read(representative.asset));
    if (sha256(bin) !== representative.hash) throw new Error("CAD BIN changed during preparation");
    const segments: CadTransferSegment[] = [];
    const append = async (
      bytes: Uint8Array,
      mode: CadTransferSegment["mode"] = "raw",
      count = 0,
      stride = 0,
    ) => {
      if (bytes.length === 0) return;
      let encoded = bytes;
      if (mode !== "raw") {
        try {
          const candidate =
            mode === "index"
              ? MeshoptEncoder.encodeIndexSequence(bytes, count, stride)
              : MeshoptEncoder.encodeVertexBufferLevel(bytes, count, stride, 2, 0);
          if (candidate.length < bytes.length) {
            const check = new Uint8Array(bytes.length);
            if (mode === "index")
              MeshoptDecoder.decodeIndexSequence(check, count, stride, candidate);
            else MeshoptDecoder.decodeVertexBuffer(check, count, stride, candidate);
            if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(check))
              encoded = candidate;
          }
        } catch {
          /* Unsupported codec input stays raw. */
        }
        if (encoded === bytes) {
          mode = "raw";
          count = 0;
          stride = 0;
        }
      }
      segments.push({
        offset,
        byteLength: encoded.length,
        decodedByteLength: bytes.length,
        mode,
        count,
        stride,
      });
      await appendChunk(encoded);
      offset += encoded.length;
    };
    const views = viewsFor(document, bin);
    if (!views) await append(bin);
    else {
      let cursor = 0;
      for (const view of views) {
        const start = view.byteOffset ?? 0;
        await append(bin.subarray(cursor, start));
        const bytes = bin.subarray(start, start + view.byteLength);
        const accessor = document.accessors!.find(
          (accessor) => accessor?.bufferView === view.index,
        );
        const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[
          accessor?.type ?? ""
        ];
        const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[
          accessor?.componentType ?? 0
        ];
        const stride = view.byteStride ?? (components ?? 0) * (componentBytes ?? 0);
        const index =
          accessor?.type === "SCALAR" &&
          (accessor.componentType === 5123 || accessor.componentType === 5125) &&
          !view.byteStride;
        if (
          Number.isSafeInteger(stride) &&
          stride > 0 &&
          stride <= 256 &&
          bytes.length % stride === 0 &&
          (index || stride % 4 === 0)
        )
          await append(bytes, index ? "index" : "vertex", bytes.length / stride, stride);
        else await append(bytes);
        cursor = start + view.byteLength;
      }
      await append(bin.subarray(cursor));
    }
    bins.push({ byteLength: bin.length, segments });
  }
  return validateCadTransferIndex(
    { version: CAD_TRANSFER_VERSION, byteLength: offset, assets: records, bins },
    assets,
  );
}
