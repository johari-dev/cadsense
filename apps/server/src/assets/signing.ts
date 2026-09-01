// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Encoding.encodeBase64Url(new TextEncoder().encode(input))
    : Encoding.encodeBase64Url(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Encoding.decodeBase64UrlString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return (
    leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}
