// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { MeshoptDecoder } from "meshoptimizer";
import { encodeCadTransfer } from "./CadTransferEncoder.ts";

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
function glb(name: string, unsupported = false) {
  const bin = Buffer.alloc(16 * 128 + 4);
  for (let index = 0; index < 128; index++) {
    bin.writeFloatLE(index / 10, index * 12);
    bin.writeFloatLE(-index, index * 12 + 4);
    bin.writeUInt32LE(index, 12 * 128 + index * 4);
  }
  bin.set([5, 4, 3, 2], bin.length - 4);
  const json = JSON.stringify({
    asset: { version: "2.0" },
    extras: { name },
    bufferViews: [
      { byteLength: 12 * 128 },
      { byteOffset: unsupported ? 4 : 12 * 128, byteLength: 4 * 128 },
    ],
    accessors: [
      { bufferView: 0, type: "VEC3", componentType: 5126 },
      { bufferView: 1, type: "SCALAR", componentType: 5125 },
    ],
  });
  const document = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
  const prefix = Buffer.alloc(document.length + 28);
  prefix.writeUInt32LE(0x46546c67, 0);
  prefix.writeUInt32LE(2, 4);
  prefix.writeUInt32LE(prefix.length + bin.length, 8);
  prefix.writeUInt32LE(document.length, 12);
  prefix.writeUInt32LE(0x4e4f534a, 16);
  document.copy(prefix, 20);
  prefix.writeUInt32LE(bin.length, 20 + document.length);
  prefix.writeUInt32LE(0x004e4942, 24 + document.length);
  return Buffer.concat([prefix, bin]);
}
async function encode(originals: Uint8Array[]) {
  const source = new Map(originals.map((bytes) => [hash(bytes), bytes]));
  const assets = originals.map((bytes) => ({ sha256: hash(bytes), byteLength: bytes.length }));
  const parts: Uint8Array[] = [];
  const index = await encodeCadTransfer(
    assets,
    async (sha) => source.get(sha)!,
    async (part) => {
      parts.push(part.slice());
    },
  );
  return { index, bytes: Buffer.concat(parts), source };
}
describe("lossless CAD transfer encoder", () => {
  it("deduplicates equal BINs while reconstructing different original JSON and hashes", async () => {
    const first = glb("first");
    const second = glb("second");
    const { index, bytes, source } = await encode([first, second, first]);
    expect(index.assets).toHaveLength(2);
    expect(index.bins).toHaveLength(1);
    expect(index.bins[0]!.segments.map((part) => part.mode)).toEqual(["vertex", "index", "raw"]);
    await MeshoptDecoder.ready;
    const bins = index.bins.map((bin) => {
      const out = new Uint8Array(bin.byteLength);
      let cursor = 0;
      for (const segment of bin.segments) {
        const encoded = bytes.subarray(segment.offset, segment.offset + segment.byteLength);
        const target = out.subarray(cursor, cursor + segment.decodedByteLength);
        if (segment.mode === "raw") target.set(encoded);
        else if (segment.mode === "vertex")
          MeshoptDecoder.decodeVertexBuffer(target, segment.count, segment.stride, encoded);
        else MeshoptDecoder.decodeIndexSequence(target, segment.count, segment.stride, encoded);
        cursor += target.length;
      }
      return out;
    });
    for (const asset of index.assets) {
      const reconstructed = Buffer.concat([
        bytes.subarray(asset.prefix.offset, asset.prefix.offset + asset.prefix.byteLength),
        bins[asset.bin]!,
      ]);
      expect(reconstructed).toEqual(source.get(asset.sha256));
      expect(hash(reconstructed)).toBe(asset.sha256);
    }
    expect(index.byteLength).toBe(bytes.length);
    expect(bytes.length).toBeLessThan(first.length + second.length);
  });
  it("keeps unsupported overlapping views as exact raw bytes", async () => {
    const original = glb("overlap", true);
    const { index, bytes } = await encode([original]);
    expect(index.bins[0]!.segments.map((segment) => segment.mode)).toEqual(["raw"]);
    expect(bytes).toEqual(original);
  });
  it("falls back to whole-asset raw storage for unknown GLB layouts", async () => {
    const original = Buffer.from("future GLB layout");
    const { index, bytes } = await encode([original]);
    expect(index.bins[0]!.byteLength).toBe(0);
    expect(bytes).toEqual(original);
  });
  it("rejects changed source bytes before publication", async () => {
    const original = glb("valid");
    await expect(
      encodeCadTransfer(
        [{ sha256: hash(original), byteLength: original.length }],
        async () => new Uint8Array(original.length),
        async () => {},
      ),
    ).rejects.toThrow("integrity mismatch");
  });
});
