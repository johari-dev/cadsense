import {
  MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH,
  MAX_ONSHAPE_CONNECTION_HOST_LENGTH,
  MAX_ONSHAPE_CONNECTION_NAME_LENGTH,
  MAX_ONSHAPE_SECRET_KEY_LENGTH,
} from "@cadsense/contracts";
import * as Predicate from "effect/Predicate";

export const DEFAULT_ONSHAPE_HOST = "cad.onshape.com";

function comparableOnshapeHost(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export function onshapeHostsDiffer(currentHost: string, candidateHost: string): boolean {
  return comparableOnshapeHost(currentHost) !== comparableOnshapeHost(candidateHost);
}

export interface OnshapeCredentialDraft {
  readonly host: string;
  readonly accessKeyId: string;
  readonly secretKey: string;
}

export interface OnshapeConnectionDraft extends OnshapeCredentialDraft {
  readonly name: string;
}

export type OnshapeConnectionDraftField = keyof OnshapeConnectionDraft;
export type OnshapeConnectionDraftErrors = Partial<Record<OnshapeConnectionDraftField, string>>;

export type ValidatedDraft<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly errors: OnshapeConnectionDraftErrors };

function fieldError(value: string, label: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${label} is required.`;
  return trimmed.length > maxLength ? `${label} must be ${maxLength} characters or fewer.` : null;
}

export function validateOnshapeConnectionDraft(
  draft: OnshapeConnectionDraft,
): ValidatedDraft<OnshapeConnectionDraft> {
  const errors: OnshapeConnectionDraftErrors = {};
  const nameError = fieldError(draft.name, "Name", MAX_ONSHAPE_CONNECTION_NAME_LENGTH);
  const hostError = fieldError(draft.host, "Stack host", MAX_ONSHAPE_CONNECTION_HOST_LENGTH);
  const accessKeyIdError = fieldError(
    draft.accessKeyId,
    "Access key ID",
    MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH,
  );
  const secretKeyError = fieldError(draft.secretKey, "Secret key", MAX_ONSHAPE_SECRET_KEY_LENGTH);

  if (nameError) errors.name = nameError;
  if (hostError) errors.host = hostError;
  if (accessKeyIdError) errors.accessKeyId = accessKeyIdError;
  if (secretKeyError) errors.secretKey = secretKeyError;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: draft.name.trim(),
      host: draft.host.trim(),
      accessKeyId: draft.accessKeyId.trim(),
      secretKey: draft.secretKey.trim(),
    },
  };
}

export function validateOnshapeCredentialDraft(
  draft: OnshapeCredentialDraft,
): ValidatedDraft<OnshapeCredentialDraft> {
  const errors: OnshapeConnectionDraftErrors = {};
  const hostError = fieldError(draft.host, "Stack host", MAX_ONSHAPE_CONNECTION_HOST_LENGTH);
  const accessKeyIdError = fieldError(
    draft.accessKeyId,
    "Access key ID",
    MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH,
  );
  const secretKeyError = fieldError(draft.secretKey, "Secret key", MAX_ONSHAPE_SECRET_KEY_LENGTH);

  if (hostError) errors.host = hostError;
  if (accessKeyIdError) errors.accessKeyId = accessKeyIdError;
  if (secretKeyError) errors.secretKey = secretKeyError;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      host: draft.host.trim(),
      accessKeyId: draft.accessKeyId.trim(),
      secretKey: draft.secretKey.trim(),
    },
  };
}

export function validateOnshapeConnectionName(
  name: string,
): ValidatedDraft<{ readonly name: string }> {
  const nameError = fieldError(name, "Name", MAX_ONSHAPE_CONNECTION_NAME_LENGTH);
  return nameError
    ? { ok: false, errors: { name: nameError } }
    : { ok: true, value: { name: name.trim() } };
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Maps the typed server failures to copy safe to put beside credential fields.
 * Unknown errors stay deliberately generic: transport errors can include the
 * request payload and must never echo an access key or secret back into the UI.
 */
export function safeOnshapeConnectionErrorMessage(error: unknown): string {
  if (Predicate.isTagged(error, "OnshapeInvalidCredentialsError")) {
    return "Onshape rejected this access key ID and secret key. Check them and try again.";
  }
  if (Predicate.isTagged(error, "OnshapeInsufficientPermissionsError")) {
    return "This API key cannot read Onshape documents. Grant it document read access in Onshape before saving again.";
  }
  if (Predicate.isTagged(error, "OnshapeAnnualQuotaExceededError")) {
    return "This Onshape account's annual API quota has been used up. Try another connection or wait for the quota to renew.";
  }
  if (
    Predicate.isTagged(error, "OnshapeRateLimitError") ||
    Predicate.isTagged(error, "OnshapeVerificationThrottledError")
  ) {
    const retryAfterSeconds = Predicate.hasProperty(error, "retryAfterSeconds")
      ? error.retryAfterSeconds
      : undefined;
    const subject = Predicate.isTagged(error, "OnshapeVerificationThrottledError")
      ? "Too many connection verification attempts."
      : "Onshape is rate limiting requests.";
    return Predicate.isNumber(retryAfterSeconds) && Number.isFinite(retryAfterSeconds)
      ? `${subject} Try again in ${formatRetryAfter(Math.max(0, Math.ceil(retryAfterSeconds)))}.`
      : `${subject} Try again later.`;
  }
  if (Predicate.isTagged(error, "OnshapeRedirectError")) {
    return "Onshape redirected the verification request. Confirm the exact stack host where this key was created before saving again.";
  }
  if (Predicate.isTagged(error, "OnshapeNetworkError")) {
    return "cadsense could not reach Onshape. Check the stack host and your connection, then try again.";
  }
  if (Predicate.isTagged(error, "OnshapeInvalidHostError")) {
    return "Enter a valid Onshape stack host, such as cad.onshape.com.";
  }
  if (Predicate.isTagged(error, "OnshapeConnectionNotFoundError")) {
    return "This Onshape connection no longer exists. Refresh the list and try again.";
  }
  if (Predicate.isTagged(error, "OnshapeConnectionConflictError")) {
    return "A connection with that name already exists. Choose a different name.";
  }
  if (Predicate.isTagged(error, "OnshapeConnectionPersistenceError")) {
    return "cadsense could not save this connection change. Try again.";
  }
  return "cadsense could not complete this connection change. Try again.";
}

export type ExclusiveOperationResult<A> =
  | { readonly _tag: "Completed"; readonly value: A }
  | { readonly _tag: "AlreadyRunning" };

/** A same-tick-safe lock for destructive or quota-consuming UI actions. */
export function createExclusiveOperationRunner() {
  let running = false;
  return {
    async run<A>(operation: () => Promise<A>): Promise<ExclusiveOperationResult<A>> {
      if (running) return { _tag: "AlreadyRunning" };
      running = true;
      try {
        return { _tag: "Completed", value: await operation() };
      } finally {
        running = false;
      }
    },
  };
}

/** Keeps a credential editor or mutation attached to the device that owns it. */
export function resolveOnshapeEnvironmentSelection<EnvironmentId extends string>(
  currentEnvironmentId: EnvironmentId | null,
  requestedEnvironmentId: EnvironmentId,
  interactionsDisabled: boolean,
): EnvironmentId | null {
  return interactionsDisabled && currentEnvironmentId !== requestedEnvironmentId
    ? currentEnvironmentId
    : requestedEnvironmentId;
}
