import { describe, expect, it } from "vite-plus/test";
import { CAD_TRANSFER_VERSION, validateCadTransferIndex } from "./cadTransfer.ts";
const assets = [{ sha256: "a".repeat(64), byteLength: 20 }];
const valid = () => ({
  version: CAD_TRANSFER_VERSION,
  byteLength: 12,
  assets: [{ ...assets[0]!, prefix: { offset: 0, byteLength: 4 }, bin: 0 }],
  bins: [
    {
      byteLength: 16,
      segments: [
        { offset: 4, byteLength: 8, decodedByteLength: 16, mode: "vertex", count: 4, stride: 4 },
      ],
    },
  ],
});
describe("CAD transfer index validation", () => {
  it("accepts only a complete contiguous reconstruction of the authoritative assets", () => {
    expect(validateCadTransferIndex(valid(), [...assets, ...assets])).toEqual(valid());
  });
  it.each([
    (index: ReturnType<typeof valid>) => {
      index.assets[0]!.sha256 = "b".repeat(64);
    },
    (index: ReturnType<typeof valid>) => {
      index.assets[0]!.byteLength++;
    },
    (index: ReturnType<typeof valid>) => {
      index.assets[0]!.bin = 99;
    },
    (index: ReturnType<typeof valid>) => {
      index.bins[0]!.byteLength = 2 ** 40;
    },
    (index: ReturnType<typeof valid>) => {
      index.bins[0]!.segments[0]!.stride = 3;
    },
    (index: ReturnType<typeof valid>) => {
      index.bins[0]!.segments[0]!.offset++;
    },
    (index: ReturnType<typeof valid>) => {
      index.bins[0]!.segments[0]!.count = Number.MAX_SAFE_INTEGER;
    },
    (index: ReturnType<typeof valid>) => {
      index.byteLength++;
    },
  ])("rejects malformed or unbounded metadata", (mutate) => {
    const index = valid();
    mutate(index);
    expect(() => validateCadTransferIndex(index, assets)).toThrow("Invalid CAD transfer");
  });
});
