import {
  AuthAccessTokenType,
  type AuthClientPresentationMetadata,
  AuthEnvironmentBootstrapTokenType,
  type AuthEnvironmentScope,
  AuthTokenExchangeGrantType,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";

const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 10_000;

function clientMetadataFields(metadata: AuthClientPresentationMetadata | undefined) {
  return {
    ...(metadata?.label ? { client_label: metadata.label } : {}),
    ...(metadata?.deviceType ? { client_device_type: metadata.deviceType } : {}),
    ...(metadata?.os && metadata.os !== "unknown" && metadata.os !== "other"
      ? { client_os: metadata.os }
      : {}),
  };
}

export function appendLocalClientParams(
  url: URL,
  metadata: AuthClientPresentationMetadata | undefined,
): void {
  if (metadata?.surface) url.searchParams.set("clientSurface", metadata.surface);
  if (metadata?.appVersion) url.searchParams.set("clientAppVersion", metadata.appVersion);
  if (metadata?.deviceType) url.searchParams.set("clientDeviceType", metadata.deviceType);
  if (metadata?.os) url.searchParams.set("clientOs", metadata.os);
}

export const bootstrapLocalBearerSession = Effect.fn(
  "clientRuntime.authorization.bootstrapLocalBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
    client.auth.token({
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        ...(input.scopes ? { scope: input.scopes.join(" ") } : {}),
        ...clientMetadataFields(input.clientMetadata),
      },
    }),
  );
});

export const resolveLocalWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.authorization.resolveLocalWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  const issued = yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
    client.auth.webSocketTicket({
      headers: { authorization: `Bearer ${input.bearerToken}` },
    }),
  );
  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  url.searchParams.set("wsTicket", issued.ticket);
  appendLocalClientParams(url, input.clientMetadata);
  return url.toString();
});
