/** Progress counts decoded bytes, matching the manifest even with HTTP compression. */
export async function readCadAssetResponse(
  response: Response,
  expectedBytes: number,
  onBytes: (count: number) => void,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("CAD asset body unavailable");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > expectedBytes) throw new Error("CAD asset size mismatch");
      bytes.set(next.value, offset);
      offset += next.value.length;
      onBytes(next.value.length);
    }
    if (offset !== expectedBytes) throw new Error("CAD asset size mismatch");
    return bytes.buffer;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
