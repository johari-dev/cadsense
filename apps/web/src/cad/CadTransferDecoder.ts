import { validateCadTransferBin, type CadTransferBin } from "@cadsense/shared/cadTransfer";
import { MeshoptDecoder } from "meshoptimizer";

/** No filters, quantization, or triangle reordering: every output byte is the original BIN byte. */
export async function decodeCadTransferBin(
  value: CadTransferBin,
  readSlice: (offset: number, byteLength: number) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const bin = validateCadTransferBin(value);
  await MeshoptDecoder.ready;
  const output = new Uint8Array(bin.byteLength);
  let cursor = 0;
  for (const segment of bin.segments) {
    const encoded = await readSlice(segment.offset, segment.byteLength);
    if (encoded.byteLength !== segment.byteLength)
      throw new Error("CAD transfer segment truncated");
    const target = output.subarray(cursor, cursor + segment.decodedByteLength);
    if (segment.mode === "raw") target.set(encoded);
    else if (segment.mode === "vertex")
      MeshoptDecoder.decodeVertexBuffer(target, segment.count, segment.stride, encoded);
    else MeshoptDecoder.decodeIndexSequence(target, segment.count, segment.stride, encoded);
    cursor += segment.decodedByteLength;
  }
  return output;
}
