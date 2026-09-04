import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface OnshapeSigningInput {
  readonly accessKeyId: string;
  readonly secretKey: string;
  readonly method: "GET";
  readonly nonce: string;
  readonly date: string;
  readonly contentType: string;
  readonly path: string;
  readonly query: string;
}

export interface OnshapeSignedHeaders {
  readonly Authorization: string;
  readonly Date: string;
  readonly "On-Nonce": string;
  readonly "Content-Type": string;
}

/**
 * Onshape signs the lowercase form of the seven newline-delimited request
 * components, including the final newline.
 */
export function signOnshapeRequest(input: OnshapeSigningInput): OnshapeSignedHeaders {
  const canonicalRequest = [
    input.method,
    input.nonce,
    input.date,
    input.contentType,
    input.path,
    input.query,
    "",
  ]
    .join("\n")
    .toLowerCase();
  const signature = NodeCrypto.createHmac("sha256", input.secretKey)
    .update(canonicalRequest, "utf8")
    .digest("base64");

  return {
    Authorization: `On ${input.accessKeyId}:HmacSHA256:${signature}`,
    Date: input.date,
    "On-Nonce": input.nonce,
    "Content-Type": input.contentType,
  };
}

export class OnshapeRequestSigner extends Context.Service<
  OnshapeRequestSigner,
  {
    readonly sign: (input: OnshapeSigningInput) => Effect.Effect<OnshapeSignedHeaders>;
  }
>()("@cadsense/server/onshape/OnshapeRequestSigner") {}

export const layer = Layer.succeed(
  OnshapeRequestSigner,
  OnshapeRequestSigner.of({
    sign: Effect.fn("OnshapeRequestSigner.sign")(function* (input) {
      return yield* Effect.sync(() => signOnshapeRequest(input));
    }),
  }),
);
