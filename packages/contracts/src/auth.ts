import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { ClientSurface, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ServerAuthPolicy = Schema.Literal("desktop-managed-local");
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

export const ServerAuthBootstrapMethod = Schema.Literal("desktop-bootstrap");
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

export const ServerAuthSessionMethod = Schema.Literal("bearer-access-token");
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthEnvironmentScope = Schema.Literals([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
]);
export type AuthEnvironmentScope = typeof AuthEnvironmentScope.Type;
export const AuthEnvironmentScopes = Schema.Array(AuthEnvironmentScope);
export type AuthEnvironmentScopes = typeof AuthEnvironmentScopes.Type;

export const AuthStandardClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;
export const AuthAdministrativeScopes = AuthStandardClientScopes;

export const AuthTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const AuthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const AuthEnvironmentBootstrapTokenType =
  "urn:cadsense:params:oauth:token-type:environment-bootstrap" as const;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthClientMetadataDeviceType = Schema.Literals(["desktop", "bot", "unknown"]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  surface: Schema.optionalKey(ClientSurface),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;

export const AuthTokenExchangeRequest = Schema.Struct({
  grant_type: Schema.Literal(AuthTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString,
  subject_token_type: Schema.Literal(AuthEnvironmentBootstrapTokenType),
  requested_token_type: Schema.Literal(AuthAccessTokenType),
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  client_label: Schema.optionalKey(TrimmedNonEmptyString),
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = typeof AuthTokenExchangeRequest.Type;

export const AuthAccessTokenResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: TrimmedNonEmptyString,
});
export type AuthAccessTokenResult = typeof AuthAccessTokenResult.Type;

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
});
export type AuthSessionState = typeof AuthSessionState.Type;

export class EnvironmentAuthorizationError extends Schema.TaggedErrorClass<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    message: Schema.String,
    requiredScope: AuthEnvironmentScope,
  },
) {}
