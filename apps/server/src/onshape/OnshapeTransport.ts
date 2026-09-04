import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export interface OnshapeTransportRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OnshapeTransportResponse {
  readonly status: number;
  readonly retryAfter: string | null;
}

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
          Effect.map((response) => ({
            status: response.status,
            retryAfter: response.headers["retry-after"] ?? null,
          })),
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
