import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MAX_ONSHAPE_CONNECTION_NAME_LENGTH = 120;
export const MAX_ONSHAPE_CONNECTION_HOST_LENGTH = 253;
export const MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH = 256;
export const MAX_ONSHAPE_SECRET_KEY_LENGTH = 512;
export const MAX_ONSHAPE_RETRY_AFTER_SECONDS = 86_400;

/** Server-generated environment-local UUID for one saved Onshape connection. */
export const OnshapeConnectionId = TrimmedNonEmptyString.check(
  Schema.isPattern(UUID_V4_PATTERN),
).pipe(Schema.brand("OnshapeConnectionId"));
export type OnshapeConnectionId = typeof OnshapeConnectionId.Type;

export const OnshapeConnectionName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ONSHAPE_CONNECTION_NAME_LENGTH),
);
export type OnshapeConnectionName = typeof OnshapeConnectionName.Type;

/**
 * The user-selected Onshape stack, normalized by the server after validation.
 *
 * This remains a string on the wire because URL parsing and the allow-list of
 * supported URL parts belong to the server's Onshape boundary.
 */
export const OnshapeConnectionHost = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ONSHAPE_CONNECTION_HOST_LENGTH),
);
export type OnshapeConnectionHost = typeof OnshapeConnectionHost.Type;

export const OnshapeAccessKeyId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH),
);
export type OnshapeAccessKeyId = typeof OnshapeAccessKeyId.Type;

export const OnshapeSecretKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ONSHAPE_SECRET_KEY_LENGTH),
);
export type OnshapeSecretKey = typeof OnshapeSecretKey.Type;

export const OnshapeRetryAfterSeconds = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(MAX_ONSHAPE_RETRY_AFTER_SECONDS),
);
export type OnshapeRetryAfterSeconds = typeof OnshapeRetryAfterSeconds.Type;

/**
 * The only saved connection shape permitted to cross the server boundary.
 * Credentials deliberately exist only on the write inputs below.
 */
export const OnshapeConnectionSummary = Schema.Struct({
  connectionId: OnshapeConnectionId,
  name: OnshapeConnectionName,
  host: OnshapeConnectionHost,
  verifiedAt: IsoDateTime,
});
export type OnshapeConnectionSummary = typeof OnshapeConnectionSummary.Type;

export const OnshapeConnectionListResult = Schema.Struct({
  connections: Schema.Array(OnshapeConnectionSummary),
});
export type OnshapeConnectionListResult = typeof OnshapeConnectionListResult.Type;

/** Creates and verifies a connection in one explicit user action. */
export const OnshapeConnectionCreateInput = Schema.Struct({
  name: OnshapeConnectionName,
  host: OnshapeConnectionHost,
  accessKeyId: OnshapeAccessKeyId,
  secretKey: OnshapeSecretKey,
});
export type OnshapeConnectionCreateInput = typeof OnshapeConnectionCreateInput.Type;

/** Renaming is entirely local and must not cause an Onshape request. */
export const OnshapeConnectionRenameInput = Schema.Struct({
  connectionId: OnshapeConnectionId,
  name: OnshapeConnectionName,
});
export type OnshapeConnectionRenameInput = typeof OnshapeConnectionRenameInput.Type;

/** Replaces the host and credentials after one explicit verification request. */
export const OnshapeConnectionReplaceCredentialsInput = Schema.Struct({
  connectionId: OnshapeConnectionId,
  host: OnshapeConnectionHost,
  accessKeyId: OnshapeAccessKeyId,
  secretKey: OnshapeSecretKey,
});
export type OnshapeConnectionReplaceCredentialsInput =
  typeof OnshapeConnectionReplaceCredentialsInput.Type;

export const OnshapeConnectionRemoveInput = Schema.Struct({
  connectionId: OnshapeConnectionId,
});
export type OnshapeConnectionRemoveInput = typeof OnshapeConnectionRemoveInput.Type;

export const OnshapeConnectionRemoveResult = Schema.Struct({
  connectionId: OnshapeConnectionId,
});
export type OnshapeConnectionRemoveResult = typeof OnshapeConnectionRemoveResult.Type;

export class OnshapeInvalidCredentialsError extends Schema.TaggedErrorClass<OnshapeInvalidCredentialsError>()(
  "OnshapeInvalidCredentialsError",
  {},
) {
  override get message(): string {
    return "Onshape rejected these credentials.";
  }
}

export class OnshapeAnnualQuotaExceededError extends Schema.TaggedErrorClass<OnshapeAnnualQuotaExceededError>()(
  "OnshapeAnnualQuotaExceededError",
  {},
) {
  override get message(): string {
    return "The Onshape API annual quota is exhausted.";
  }
}

export class OnshapeRateLimitError extends Schema.TaggedErrorClass<OnshapeRateLimitError>()(
  "OnshapeRateLimitError",
  {
    retryAfterSeconds: Schema.optionalKey(OnshapeRetryAfterSeconds),
  },
) {
  override get message(): string {
    return this.retryAfterSeconds === undefined
      ? "Onshape is rate limiting requests."
      : `Onshape is rate limiting requests. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

export class OnshapeInsufficientPermissionsError extends Schema.TaggedErrorClass<OnshapeInsufficientPermissionsError>()(
  "OnshapeInsufficientPermissionsError",
  {},
) {
  override get message(): string {
    return "These Onshape credentials do not grant the required read access.";
  }
}

export class OnshapeRedirectError extends Schema.TaggedErrorClass<OnshapeRedirectError>()(
  "OnshapeRedirectError",
  {},
) {
  override get message(): string {
    return "Onshape redirected the verification request unexpectedly.";
  }
}

export class OnshapeVerificationThrottledError extends Schema.TaggedErrorClass<OnshapeVerificationThrottledError>()(
  "OnshapeVerificationThrottledError",
  {
    retryAfterSeconds: Schema.optionalKey(OnshapeRetryAfterSeconds),
  },
) {
  override get message(): string {
    return this.retryAfterSeconds === undefined
      ? "Connection verification is temporarily throttled."
      : `Connection verification is temporarily throttled. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

export class OnshapeNetworkError extends Schema.TaggedErrorClass<OnshapeNetworkError>()(
  "OnshapeNetworkError",
  {},
) {
  override get message(): string {
    return "Could not reach Onshape.";
  }
}

export class OnshapeInvalidHostError extends Schema.TaggedErrorClass<OnshapeInvalidHostError>()(
  "OnshapeInvalidHostError",
  {},
) {
  override get message(): string {
    return "The Onshape host is invalid.";
  }
}

export class OnshapeConnectionNotFoundError extends Schema.TaggedErrorClass<OnshapeConnectionNotFoundError>()(
  "OnshapeConnectionNotFoundError",
  {
    connectionId: OnshapeConnectionId,
  },
) {
  override get message(): string {
    return "The Onshape connection was not found.";
  }
}

export class OnshapeConnectionConflictError extends Schema.TaggedErrorClass<OnshapeConnectionConflictError>()(
  "OnshapeConnectionConflictError",
  {},
) {
  override get message(): string {
    return "An Onshape connection with that name already exists.";
  }
}

export const OnshapeConnectionPersistenceOperation = Schema.Literals([
  "list",
  "create",
  "rename",
  "replace-credentials",
  "remove",
]);
export type OnshapeConnectionPersistenceOperation =
  typeof OnshapeConnectionPersistenceOperation.Type;

export class OnshapeConnectionPersistenceError extends Schema.TaggedErrorClass<OnshapeConnectionPersistenceError>()(
  "OnshapeConnectionPersistenceError",
  {
    operation: OnshapeConnectionPersistenceOperation,
  },
) {
  override get message(): string {
    return "Could not save the Onshape connection change.";
  }
}

export const OnshapeConnectionError = Schema.Union([
  OnshapeInvalidCredentialsError,
  OnshapeInsufficientPermissionsError,
  OnshapeAnnualQuotaExceededError,
  OnshapeRateLimitError,
  OnshapeRedirectError,
  OnshapeVerificationThrottledError,
  OnshapeNetworkError,
  OnshapeInvalidHostError,
  OnshapeConnectionNotFoundError,
  OnshapeConnectionConflictError,
  OnshapeConnectionPersistenceError,
]);
export type OnshapeConnectionError = typeof OnshapeConnectionError.Type;

export const isOnshapeConnectionError = Schema.is(OnshapeConnectionError);
