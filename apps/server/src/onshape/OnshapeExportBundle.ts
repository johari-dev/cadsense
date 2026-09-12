// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CadGeometryError, normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { MAX_EXPORT_BYTES } from "./OnshapeSyncState.ts";

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(ObjectValue));
const isObject = Schema.is(ObjectValue);
const decoder = new TextDecoder("utf-8", { fatal: true });
const invalid = () => new CadGeometryError({ reason: "invalid-geometry" });
const tooLarge = () => new CadGeometryError({ reason: "too-large" });
const external = () => new CadGeometryError({ reason: "external-resource" });
const isGeometryError = Schema.is(CadGeometryError);

/** ZIP entries stay in memory. Central-directory and actual inflated sizes both have limits. */
export function readOnshapeZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw invalid();
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw invalid();
  let count = view.getUint16(end + 10, true);
  if (count !== view.getUint16(end + 8, true)) throw invalid();
  let centralSize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  let centralEnd = end;
  const uint64 = (at: number) => {
    if (at < 0 || at + 8 > bytes.length) throw invalid();
    const value = view.getBigUint64(at, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw tooLarge();
    return Number(value);
  };
  // Onshape 3MF uses ZIP64 even for small archives. Validate its locator and directory,
  // retaining the same inflated-byte and entry-count limits as ordinary ZIP.
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    if (view.getUint32(end - 16, true) !== 0 || view.getUint32(end - 4, true) !== 1)
      throw invalid();
    const record = uint64(end - 12);
    if (
      record + 56 > end - 20 ||
      view.getUint32(record, true) !== 0x06064b50 ||
      record + 12 + uint64(record + 4) !== end - 20 ||
      view.getUint32(record + 16, true) !== 0 ||
      view.getUint32(record + 20, true) !== 0
    )
      throw invalid();
    count = uint64(record + 32);
    if (count !== uint64(record + 24)) throw invalid();
    centralSize = uint64(record + 40);
    offset = uint64(record + 48);
    centralEnd = record;
  }
  if (count > 4096) throw tooLarge();
  if (offset + centralSize !== centralEnd) throw invalid();
  const files = new Map<string, () => Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    let compressed = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    let local = view.getUint32(offset + 42, true);
    const extraEnd = offset + 46 + nameLength + view.getUint16(offset + 30, true);
    if (extraEnd > centralEnd) throw invalid();
    for (let extra = offset + 46 + nameLength; extra < extraEnd; ) {
      if (extra + 4 > extraEnd) throw invalid();
      const tag = view.getUint16(extra, true),
        length = view.getUint16(extra + 2, true);
      if (extra + 4 + length > extraEnd) throw invalid();
      if (tag === 1) {
        let cursor = extra + 4;
        const next64 = () => {
          if (cursor + 8 > extra + 4 + length) throw invalid();
          const value = uint64(cursor);
          cursor += 8;
          return value;
        };
        if (size === 0xffffffff) size = next64();
        if (compressed === 0xffffffff) compressed = next64();
        if (local === 0xffffffff) local = next64();
      }
      extra += 4 + length;
    }
    if (next > end || local + 30 > offset || (flags & 1) !== 0 || (method !== 0 && method !== 8))
      throw invalid();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((segment) => segment === "..") ||
      name.includes("\0")
    )
      throw external();
    const path = NodePath.posix.normalize(name);
    if (files.has(path)) throw invalid();
    total += size;
    if (total > MAX_EXPORT_BYTES || compressed > MAX_EXPORT_BYTES) throw tooLarge();
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method)
      throw invalid();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > offset) throw invalid();
    files.set(path, () => {
      const packed = bytes.subarray(start, start + compressed);
      const data =
        method === 0
          ? packed
          : NodeZlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
      if (data.length !== size || NodeZlib.crc32(data) !== crc) throw invalid();
      return data;
    });
    offset = next;
  }
  if (offset !== centralEnd) throw invalid();
  return files;
}

/** Resolve only files contained in the export, then use the usual self-contained GLB validator. */
export const normalizeOnshapeExport = Effect.fn("normalizeOnshapeExport")(function* (
  bytes: Uint8Array,
) {
  const embedded = yield* Effect.try({
    try: () => {
      if (bytes.length > MAX_EXPORT_BYTES) throw tooLarge();
      if (
        bytes.length < 4 ||
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !==
          0x04034b50
      )
        return bytes;
      const files = readOnshapeZip(bytes);
      const models = [...files.keys()].filter((name) => /\.(gltf|glb)$/i.test(name));
      if (models.length !== 1) throw invalid();
      const name = models[0]!;
      const model = files.get(name)!();
      if (/\.glb$/i.test(name)) return model;
      const document = { ...decodeJson(decoder.decode(model)) };
      const resolve = (uri: string, mimeType: string) => {
        if (uri.startsWith("data:")) return uri;
        if (
          /^[a-z][a-z\d+.-]*:/i.test(uri) ||
          uri.startsWith("/") ||
          /[\\?#]/.test(uri) ||
          uri.includes("\0")
        )
          throw external();
        const path = NodePath.posix.normalize(
          NodePath.posix.join(NodePath.posix.dirname(name), decodeURIComponent(uri)),
        );
        if (path.startsWith("../") || path.startsWith("/") || path.includes("\\")) throw external();
        const file = files.get(path);
        if (!file) throw external();
        return `data:${mimeType};base64,${Buffer.from(file()).toString("base64")}`;
      };
      for (const key of ["buffers", "images"]) {
        const resources = document[key];
        if (resources === undefined) continue;
        if (!Array.isArray(resources)) throw invalid();
        document[key] = resources.map((value: unknown) => {
          if (!isObject(value)) throw invalid();
          if (value.uri === undefined) return value;
          if (typeof value.uri !== "string") throw invalid();
          const mimeType =
            key === "buffers"
              ? "application/octet-stream"
              : typeof value.mimeType === "string"
                ? value.mimeType
                : /\.png$/i.test(value.uri)
                  ? "image/png"
                  : "image/jpeg";
          return { ...value, uri: resolve(value.uri, mimeType) };
        });
      }
      return new TextEncoder().encode(encodeJson(document));
    },
    catch: (error) => (isGeometryError(error) ? error : invalid()),
  });
  return yield* normalizeCadGeometry(embedded, "assembly");
});
