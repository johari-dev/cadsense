import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export interface OnshapeTransportRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly responseType?: "json";
}

export interface OnshapeTransportResponse {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body?: unknown;
}

export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Deliberately contains no underlying exception or request data. */
export class OnshapeTransportFailure extends Schema.TaggedErrorClass<OnshapeTransportFailure>()(
  "OnshapeTransportFailure",
  {},
) {}

export class OnshapeTransport extends Context.Service<
  OnshapeTransport,
  {
    readonly execute: (
      request: OnshapeTransportRequest,
    ) => Effect.Effect<OnshapeTransportResponse, OnshapeTransportFailure>;
  }
>()("@cadsense/server/onshape/OnshapeTransport") {}

/** One fetch, redirects disabled, and no retry policy. */
export const layer = Layer.effect(
  OnshapeTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const execute: OnshapeTransport["Service"]["execute"] = Effect.fn("OnshapeTransport.execute")(
      function* (request) {
        return yield* HttpClientRequest.get(request.url).pipe(
          HttpClientRequest.setHeaders(request.headers),
          client.execute,
          Effect.flatMap(
            Effect.fn(function* (response) {
              const result = {
                status: response.status,
                retryAfter: response.headers["retry-after"] ?? null,
              };
              if (
                request.responseType !== "json" ||
                response.status < 200 ||
                response.status >= 300
              ) {
                return result;
              }
              let bytes = 0;
              const chunks: Uint8Array[] = [];
              yield* response.stream.pipe(
                Stream.runForEach((chunk) => {
                  bytes += chunk.byteLength;
                  if (bytes > MAX_JSON_BODY_BYTES)
                    return Effect.fail(new OnshapeTransportFailure());
                  chunks.push(chunk);
                  return Effect.void;
                }),
              );
              const body = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
              }
              const text = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
                catch: () => new OnshapeTransportFailure(),
              });
              return { ...result, body: yield* decodeJson(text) };
            }),
          ),
          Effect.scoped,
          Effect.timeout("15 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() => new OnshapeTransportFailure()),
        );
      },
    );
    return OnshapeTransport.of({ execute });
  }),
);
