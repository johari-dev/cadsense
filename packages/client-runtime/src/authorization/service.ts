import { EnvironmentId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { environmentMismatchError, mapEnvironmentRequestError } from "../connection/errors.ts";
import type { ConnectionAttemptError, PreparedHttpAuthorization } from "../connection/model.ts";
import { fetchEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { resolveLocalWebSocketConnectionUrl } from "./local.ts";

export interface AuthorizedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class EnvironmentAuthorization extends Context.Service<
  EnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedEnvironment, ConnectionAttemptError>;
  }
>()("@cadsense/client-runtime/authorization/service/EnvironmentAuthorization") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const presentation = yield* ClientCapabilities.ClientPresentation;

  const authorizeBearer = Effect.fn("clientRuntime.authorization.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) {
      const descriptor = yield* fetchEnvironmentDescriptor({ httpBaseUrl: input.httpBaseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(mapEnvironmentRequestError),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const socketUrl = yield* resolveLocalWebSocketConnectionUrl({
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(mapEnvironmentRequestError),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
      } satisfies AuthorizedEnvironment;
    },
  );

  return EnvironmentAuthorization.of({ authorizeBearer });
});

export const layer = Layer.effect(EnvironmentAuthorization, make);
