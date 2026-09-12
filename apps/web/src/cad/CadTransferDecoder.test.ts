import { describe, expect, it } from "vite-plus/test";
import { MeshoptEncoder } from "meshoptimizer";
import { decodeCadTransferBin } from "./CadTransferDecoder";

describe("CAD transfer decoder", () => {
  it("reconstructs float bit patterns, ordered indices, and padding without filters", async () => {
    await MeshoptEncoder.ready;
    const vertices = new Uint8Array(12 * 128);
    new DataView(vertices.buffer).setUint32(0, 0x7fc00001, true);
    new DataView(vertices.buffer).setUint32(4, 0x80000000, true);
    const indices = new Uint8Array(
      new Uint32Array(Array.from({ length: 128 }, (_, i) => 127 - i)).buffer,
    );
    const v = MeshoptEncoder.encodeVertexBufferLevel(vertices, 128, 12, 2, 0);
    const i = MeshoptEncoder.encodeIndexSequence(indices, 128, 4);
    const raw = new Uint8Array([1, 2, 3, 4]);
    const source = new Uint8Array([...v, ...i, ...raw]);
    const output = await decodeCadTransferBin(
      {
        byteLength: vertices.length + indices.length + raw.length,
        segments: [
          {
            offset: 0,
            byteLength: v.length,
            decodedByteLength: vertices.length,
            mode: "vertex",
            count: 128,
            stride: 12,
          },
          {
            offset: v.length,
            byteLength: i.length,
            decodedByteLength: indices.length,
            mode: "index",
            count: 128,
            stride: 4,
          },
          {
            offset: v.length + i.length,
            byteLength: raw.length,
            decodedByteLength: raw.length,
            mode: "raw",
            count: 0,
            stride: 0,
          },
        ],
      },
      async (offset, length) => source.subarray(offset, offset + length),
    );
    expect(output).toEqual(new Uint8Array([...vertices, ...indices, ...raw]));
  });
  it("rejects invalid output allocation before reading bytes", async () => {
    let reads = 0;
    await expect(
      decodeCadTransferBin(
        {
          byteLength: 12,
          segments: [
            {
              offset: 0,
              byteLength: 1,
              decodedByteLength: 12,
              mode: "vertex",
              count: Number.MAX_SAFE_INTEGER,
              stride: 12,
            },
          ],
        },
        async () => {
          reads++;
          return new Uint8Array(1);
        },
      ),
    ).rejects.toThrow("Invalid CAD transfer");
    expect(reads).toBe(0);
  });
  it("rejects truncated segments", async () => {
    await expect(
      decodeCadTransferBin(
        {
          byteLength: 4,
          segments: [
            { offset: 0, byteLength: 4, decodedByteLength: 4, mode: "raw", count: 0, stride: 0 },
          ],
        },
        async () => new Uint8Array(3),
      ),
    ).rejects.toThrow("truncated");
  });
});
