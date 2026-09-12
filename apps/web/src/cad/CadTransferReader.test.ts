import { expect, it, vi } from "vite-plus/test";
import type { CadTransferIndex } from "@cadsense/shared/cadTransfer";
import { readCadTransferAssets } from "./CadTransferReader";

const bytes = new TextEncoder().encode("AAxyzBB");
async function hash(value: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function fixture() {
  const a = new TextEncoder().encode("AAxyz");
  const b = new TextEncoder().encode("BBxyz");
  const index: CadTransferIndex = {
    version: "meshopt-bin-v1",
    byteLength: bytes.length,
    assets: [
      { sha256: await hash(a), byteLength: 5, prefix: { offset: 0, byteLength: 2 }, bin: 0 },
      { sha256: await hash(b), byteLength: 5, prefix: { offset: 2, byteLength: 2 }, bin: 0 },
    ],
    bins: [
      {
        byteLength: 3,
        segments: [
          { offset: 4, byteLength: 3, decodedByteLength: 3, mode: "raw", count: 0, stride: 0 },
        ],
      },
    ],
  };
  const payload = new TextEncoder().encode("AABBxyz");
  return { index, payload, a, b };
}

it("reconstructs assets sharing a BIN once and retains original hashes", async () => {
  const { index, payload, a, b } = await fixture();
  const request = vi.fn(
    async (start: number, end: number) =>
      new Response(payload.slice(start, end + 1), {
        headers: { "x-cad-bundle-range": `bytes ${start}-${end}/${payload.length}` },
      }),
  );
  const progress = vi.fn();
  const read = readCadTransferAssets(index, request, new AbortController().signal, progress);
  const results = await Promise.all(index.assets.map((asset) => read(asset.sha256)));
  expect(new Uint8Array(results[0]!)).toEqual(a);
  expect(new Uint8Array(results[1]!)).toEqual(b);
  expect(request).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.map(([n]) => n)).toEqual([5, 5]);
});

it("rejects corrupted reconstructed geometry before it reaches the parser", async () => {
  const { index, payload } = await fixture();
  payload[5] = 0;
  const read = readCadTransferAssets(
    index,
    async () => new Response(payload),
    new AbortController().signal,
    () => {},
  );
  await expect(read(index.assets[0]!.sha256)).rejects.toThrow("hash mismatch");
});

it("does not fetch after cancellation", async () => {
  const { index } = await fixture();
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn();
  const read = readCadTransferAssets(index, request, controller.signal, () => {});
  await expect(read(index.assets[0]!.sha256)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
