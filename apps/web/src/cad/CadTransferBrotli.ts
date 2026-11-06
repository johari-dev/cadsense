import { CAD_TRANSFER_BROTLI_CONTENT_TYPE } from "@cadsense/shared/cadTransfer";

let decoder: Promise<typeof import("brotli-dec-wasm/web")> | undefined;
// Fetched on the first Brotli range, so HTTPS and localhost pages never download it.
const loadDecoder = () =>
  (decoder ??= (async () => {
    const [module, { default: wasm }] = await Promise.all([
      import("brotli-dec-wasm/web"),
      import("brotli-dec-wasm/web/bg.wasm?url"),
    ]);
    await module.default({ module_or_path: wasm });
    return module;
  })().catch((error: unknown) => {
    decoder = undefined;
    throw error;
  }));

/**
 * Decode a transfer range the server sent still Brotli-compressed (see
 * `CAD_TRANSFER_BROTLI_CONTENT_TYPE`) into exactly `byteLength` bytes. Other responses, including
 * ranges the browser already decoded from `Content-Encoding: br`, pass through unchanged.
 * Call it before the range cache so the cache only ever holds decoded bytes.
 */
export async function decodeCadTransferResponse(
  response: Response,
  byteLength: number,
): Promise<Response> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (type !== CAD_TRANSFER_BROTLI_CONTENT_TYPE) return response;
  const [{ BrotliDecStream, BrotliStreamResultCode }, encoded] = await Promise.all([
    loadDecoder(),
    response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);
  const stream = new BrotliDecStream();
  try {
    // One byte of headroom exposes a body that decodes past the range instead of cutting it off.
    const result = stream.dec(encoded, byteLength + 1);
    try {
      const decoded = result.buf;
      if (
        result.code !== BrotliStreamResultCode.ResultSuccess ||
        result.input_offset !== encoded.byteLength ||
        decoded.byteLength !== byteLength
      )
        throw new Error("Invalid CAD transfer range encoding");
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/vnd.cadsense.geometry-bundle");
      // The binding types its output as possibly shared memory; a copy is a plain ArrayBuffer.
      return new Response(decoded.slice(), { status: response.status, headers });
    } finally {
      result.free();
    }
  } finally {
    stream.free();
  }
}
