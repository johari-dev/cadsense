export class CadAssetIntegrityError extends Error {
  constructor() {
    super("CAD asset hash mismatch");
  }
}

/** Verify persistent and transferred bytes against the authorized manifest before parsing. */
export async function verifyCadAssetBytes(bytes: ArrayBuffer, hash: string): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== hash) throw new CadAssetIntegrityError();
}
