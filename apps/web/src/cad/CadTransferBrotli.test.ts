// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import { CAD_TRANSFER_BROTLI_CONTENT_TYPE } from "@cadsense/shared/cadTransfer";
import { expect, it, vi } from "vite-plus/test";
import { decodeCadTransferResponse } from "./CadTransferBrotli";

// The browser fetches the decoder by URL; Node instantiates the same module from its bytes.
vi.mock("brotli-dec-wasm/web/bg.wasm?url", async () => ({
  default: (await import("node:fs")).readFileSync(
    new URL("../../node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm", import.meta.url),
  ),
}));

const range = new Uint8Array(64 * 1024).map((_, index) => (index * 31) % 251);
const encoded = (bytes: Uint8Array, contentType = CAD_TRANSFER_BROTLI_CONTENT_TYPE) =>
  new Response(NodeZlib.brotliCompressSync(bytes), {
    headers: {
      "content-type": contentType,
      "x-cad-bundle-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
  });

it("decodes a range the browser could not negotiate into its exact bytes", async () => {
  const response = await decodeCadTransferResponse(encoded(range), range.length);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(range);
  expect(response.headers.get("x-cad-bundle-range")).toBe(
    `bytes 0-${range.length - 1}/${range.length}`,
  );
  expect(response.headers.get("content-type")).not.toBe(CAD_TRANSFER_BROTLI_CONTENT_TYPE);
});

it("leaves ranges the browser already decoded untouched", async () => {
  const plain = new Response(range, { headers: { "content-type": "application/octet-stream" } });
  expect(await decodeCadTransferResponse(plain, range.length)).toBe(plain);
});

it("rejects a body that decodes past the requested range", async () => {
  await expect(decodeCadTransferResponse(encoded(range), range.length - 1)).rejects.toThrow(
    /CAD transfer range/,
  );
});

it("rejects truncated and corrupt Brotli bodies", async () => {
  const bytes = NodeZlib.brotliCompressSync(range);
  for (const body of [bytes.subarray(0, bytes.length - 8), bytes.map((byte) => byte ^ 0x5a)])
    await expect(
      decodeCadTransferResponse(
        new Response(body, { headers: { "content-type": CAD_TRANSFER_BROTLI_CONTENT_TYPE } }),
        range.length,
      ),
    ).rejects.toThrow();
});
