import { sha256 } from "@noble/hashes/sha2.js";

export class CadAssetIntegrityError extends Error {
  constructor() {
    super("CAD asset hash mismatch");
  }
}

/** Verify persistent and transferred bytes against the authorized manifest before parsing. */
export async function verifyCadAssetBytes(bytes: ArrayBuffer, hash: string): Promise<void> {
  const digest = await sha256Digest(bytes);
  const actual = [...digest].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== hash) throw new CadAssetIntegrityError();
}

// Browsers only expose Web Crypto in secure contexts. Plain-http origins other than
// localhost (for example a tailnet IP) lack it, so hash in JS there instead.
async function sha256Digest(bytes: ArrayBuffer): Promise<Uint8Array> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto.subtle;
  if (subtle) return new Uint8Array(await subtle.digest("SHA-256", bytes));
  return sha256(new Uint8Array(bytes));
}
