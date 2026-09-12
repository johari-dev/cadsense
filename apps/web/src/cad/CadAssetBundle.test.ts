import { expect, it, vi } from "vite-plus/test";
import { readCadAssetBundle } from "./CadAssetBundle";
const assets = [
  { sha256: "a", byteLength: 3 },
  { sha256: "b", byteLength: 2 },
];
it("uses one request and decodes concurrent queued reads across arbitrary chunk boundaries", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const b of [[1], [2, 3, 4], [5]]) c.enqueue(Uint8Array.from(b));
            c.close();
          },
        }),
      ),
  );
  const progress = vi.fn(),
    read = readCadAssetBundle([...assets, assets[0]!], request, progress);
  const result = await Promise.all([read("a"), read("b")]);
  expect(result.map((b) => [...new Uint8Array(b)])).toEqual([
    [1, 2, 3],
    [4, 5],
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.reduce((s, [n]) => s + n, 0)).toBe(5);
});
it.each([
  [1, 2],
  [1, 2, 3, 4, 5, 6],
])("rejects truncated or trailing data: %s", async (...bytes) => {
  const read = readCadAssetBundle(
    assets,
    async () => new Response(Uint8Array.from(bytes)),
    () => {},
  );
  await expect(Promise.all([read("a"), read("b")])).rejects.toThrow(/truncated|trailing/);
});
it("propagates cancellation to every queued read", async () => {
  const read = readCadAssetBundle(
    assets,
    async () => {
      throw new DOMException("Cancelled", "AbortError");
    },
    () => {},
  );
  const result = await Promise.allSettled([read("a"), read("b")]);
  expect(result.every((r) => r.status === "rejected" && r.reason.name === "AbortError")).toBe(true);
});

it("assembles large assets across parallel bounded ranges and checks range identity", async () => {
  const total = 9 * 1024 ** 2 + 7;
  const requested: number[][] = [];
  const read = readCadAssetBundle(
    [{ sha256: "large", byteLength: total }],
    async (start, end) => {
      requested.push([start, end]);
      const bytes = new Uint8Array(end - start + 1).fill(Math.floor(start / (4 * 1024 ** 2)) + 1);
      return new Response(bytes, {
        status: 200,
        headers: { "x-cad-bundle-range": `bytes ${start}-${end}/${total}` },
      });
    },
    () => {},
  );
  const bytes = new Uint8Array(await read("large"));
  expect(requested).toHaveLength(3);
  expect(requested.every(([a, b]) => b! - a! + 1 <= 4 * 1024 ** 2)).toBe(true);
  expect([bytes[0], bytes[4 * 1024 ** 2], bytes[8 * 1024 ** 2], bytes.at(-1)]).toEqual([
    1, 2, 3, 3,
  ]);
  const invalid = readCadAssetBundle(
    [{ sha256: "large", byteLength: total }],
    async () =>
      new Response(new Uint8Array(1), {
        status: 200,
        headers: { "x-cad-bundle-range": "bytes 0-0/1" },
      }),
    () => {},
  );
  await expect(invalid("large")).rejects.toThrow("range mismatch");
});
