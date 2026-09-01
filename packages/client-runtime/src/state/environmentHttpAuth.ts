import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { PreparedHttpAuthorization } from "../connection/model.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

export const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

export function buildEnvironmentAuthHeaders(
  authorization: PreparedHttpAuthorization | null,
): EnvironmentHttpAuthHeaders {
  return authorization === null ? {} : { authorization: `Bearer ${authorization.token}` };
}
