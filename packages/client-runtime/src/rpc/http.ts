import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@cadsense/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class EnvironmentRequestFetchError extends Data.TaggedError("EnvironmentRequestFetchError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class EnvironmentResponseInvalidError extends Data.TaggedError(
  "EnvironmentResponseInvalidError",
)<{ readonly message: string; readonly cause: unknown }> {}

export class EnvironmentResponseStatusError extends Data.TaggedError(
  "EnvironmentResponseStatusError",
)<{ readonly message: string; readonly status: number; readonly requestUrl: string }> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Environment endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
    });
  }
}

export class EnvironmentRequestTimeoutError extends Data.TaggedError(
  "EnvironmentRequestTimeoutError",
)<{ readonly message: string; readonly requestUrl: string; readonly timeoutMs: number }> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Environment endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

export type EnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | EnvironmentRequestFetchError
  | EnvironmentResponseInvalidError
  | EnvironmentResponseStatusError
  | EnvironmentRequestTimeoutError;

export const environmentHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

const apiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: apiBaseUrl(httpBaseUrl) });

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, { baseUrl: apiBaseUrl(httpBaseUrl) });

function failRequest(
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, EnvironmentRequestError> {
  if (cause instanceof EnvironmentRequestTimeoutError) return Effect.fail(cause);
  if (isEnvironmentHttpCommonError(cause)) return Effect.fail(cause);
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new EnvironmentResponseInvalidError({
        message: `Environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    if (cause.response.status < 200 || cause.response.status >= 300) {
      return Effect.fail(new EnvironmentResponseStatusError(requestUrl, cause.response.status));
    }
    return Effect.fail(
      new EnvironmentResponseInvalidError({
        message: `Environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new EnvironmentRequestFetchError({
      message: `Failed to fetch environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
}

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, EnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new EnvironmentRequestTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRequest(requestUrl, cause)),
  );
