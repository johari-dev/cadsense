import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export interface OnshapeTransportRequest<E = never, R = never> {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly responseType?: "json" | "binary";
  readonly beforeChunk?: (receivedBytes: number) => Effect.Effect<void, E, R>;
}

export interface OnshapeTransportResponse {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body?: unknown;
  readonly bytes?: Uint8Array;
  readonly contentType?: string | null;
  readonly location?: string | null;
}

export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_BINARY_BODY_BYTES = 128 * 1024 * 1024;
/** Scoped to one sync, including separately signed redirect hops. */
export const OnshapeRequestMetrics = Context.Reference<{ requests: number } | undefined>(
  "@cadsense/server/onshape/OnshapeRequestMetrics",
  { defaultValue: () => undefined },
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const responseContentType = (header: string | undefined): string | null => {
  const mediaType = header?.split(";")[0]?.trim().toLowerCase();
  return mediaType &&
    mediaType.length <= 127 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null;
};

/** Deliberately contains no underlying exception or request data. */
export class OnshapeTransportFailure extends Schema.TaggedErrorClass<OnshapeTransportFailure>()(
  "OnshapeTransportFailure",
  {},
) {}

export class OnshapeTransport extends Context.Service<
  OnshapeTransport,
  {
    readonly execute: <E = never, R = never>(
      request: OnshapeTransportRequest<E, R>,
    ) => Effect.Effect<OnshapeTransportResponse, OnshapeTransportFailure | E, R>;
  }
>()("@cadsense/server/onshape/OnshapeTransport") {}

/** One fetch, redirects disabled, and no retry policy. */
export const layer = Layer.effect(
  OnshapeTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const execute: OnshapeTransport["Service"]["execute"] = Effect.fn("OnshapeTransport.execute")(
      function* <E = never, R = never>(request: OnshapeTransportRequest<E, R>) {
        let guardFailure: Option.Option<E> = Option.none();
        const metrics = yield* OnshapeRequestMetrics;
        return yield* HttpClientRequest.make(request.method)(request.url).pipe(
          (req) =>
            request.body === undefined
              ? req
              : HttpClientRequest.bodyText(req, request.body, "application/json"),
          HttpClientRequest.setHeaders(request.headers),
          (request) =>
            Effect.sync(() => {
              if (metrics) metrics.requests++;
            }).pipe(Effect.andThen(client.execute(request))),
          Effect.flatMap(
            Effect.fn(function* (response) {
              const result = {
                status: response.status,
                retryAfter: response.headers["retry-after"] ?? null,
                ...(request.responseType === "binary"
                  ? {
                      location: response.headers.location ?? null,
                      contentType: responseContentType(response.headers["content-type"]),
                    }
                  : {}),
              };
              if (
                request.responseType === undefined ||
                response.status < 200 ||
                response.status >= 300
              ) {
                return result;
              }
              let bytes = 0;
              const maxBytes =
                request.responseType === "binary" ? MAX_BINARY_BODY_BYTES : MAX_JSON_BODY_BYTES;
              const chunks: Uint8Array[] = [];
              yield* response.stream.pipe(
                Stream.runForEach((chunk) => {
                  bytes += chunk.byteLength;
                  if (bytes > maxBytes) return Effect.fail(new OnshapeTransportFailure());
                  return (request.beforeChunk?.(bytes) ?? Effect.void).pipe(
                    Effect.mapError((error) => {
                      guardFailure = Option.some(error);
                      return new OnshapeTransportFailure();
                    }),
                    Effect.andThen(
                      Effect.sync(() => {
                        chunks.push(chunk);
                      }),
                    ),
                  );
                }),
              );
              const body = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
              }
              if (request.responseType === "binary") return { ...result, bytes: body };
              const text = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
                catch: () => new OnshapeTransportFailure(),
              });
              return { ...result, body: yield* decodeJson(text) };
            }),
          ),
          Effect.scoped,
          // Translation jobs are polled separately. Large export bodies need time to download.
          Effect.timeout(request.responseType === "binary" ? "3 minutes" : "15 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() =>
            Option.isSome(guardFailure) ? guardFailure.value : new OnshapeTransportFailure(),
          ),
        );
      },
    );
    return OnshapeTransport.of({ execute });
  }),
);
