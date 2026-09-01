import type { EnvironmentId } from "@cadsense/contracts";

import type { EnvironmentRequestError } from "../rpc/http.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `Connected environment ${input.actual} does not match ${input.expected}.`,
  });
}

export function mapEnvironmentRequestError(error: EnvironmentRequestError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "The local environment credential is invalid.",
        traceId: error.traceId,
      });
    case "EnvironmentScopeRequiredError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: "The local environment credential does not grant the required access.",
        traceId: error.traceId,
      });
    case "EnvironmentRequestInvalidError":
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "The local environment endpoint rejected the request.",
        traceId: error.traceId,
      });
    case "EnvironmentRequestTimeoutError":
      return new ConnectionTransientError({ reason: "timeout", detail: error.message });
    case "EnvironmentRequestFetchError":
      return new ConnectionTransientError({ reason: "network", detail: error.message });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: "The local environment could not authorize the connection.",
        traceId: error.traceId,
      });
    case "EnvironmentResponseInvalidError":
    case "EnvironmentResponseStatusError":
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: error.message,
      });
  }
}
