import type { AuthClientPresentationMetadata } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { appendLocalClientParams } from "../authorization/local.ts";
import * as EnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "./model.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@cadsense/client-runtime/connection/resolver/ConnectionResolver") {}

function primarySocketUrl(
  wsBaseUrl: string,
  metadata: AuthClientPresentationMetadata | undefined,
): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  appendLocalClientParams(url, metadata);
  return url.toString();
}

export const make = Effect.gen(function* () {
  const primaryAuth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const authorization = yield* EnvironmentAuthorization.EnvironmentAuthorization;

  const prepare = Effect.fn("clientRuntime.connection.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    switch (target._tag) {
      case "PrimaryConnectionTarget": {
        const bearerToken = yield* primaryAuth.bearerToken;
        if (Option.isNone(bearerToken)) {
          return {
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: primarySocketUrl(target.wsBaseUrl, presentation.metadata),
            httpAuthorization: null,
            target,
          } satisfies PreparedConnection;
        }
        const authorized = yield* authorization.authorizeBearer({
          expectedEnvironmentId: target.environmentId,
          httpBaseUrl: target.httpBaseUrl,
          wsBaseUrl: target.wsBaseUrl,
          bearerToken: bearerToken.value,
        });
        return { ...authorized, target } satisfies PreparedConnection;
      }
      case "BearerConnectionTarget": {
        const profile = yield* Option.match(entry.profile, {
          onNone: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "configuration",
                detail: `Local backend ${target.connectionId} has no endpoint configuration.`,
              }),
            ),
          onSome: Effect.succeed,
        });
        const credential = yield* Option.match(entry.credential ?? Option.none(), {
          onNone: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "authentication",
                detail: `Local backend ${target.connectionId} has no bearer credential.`,
              }),
            ),
          onSome: Effect.succeed,
        });
        const authorized = yield* authorization.authorizeBearer({
          expectedEnvironmentId: target.environmentId,
          httpBaseUrl: profile.httpBaseUrl,
          wsBaseUrl: profile.wsBaseUrl,
          bearerToken: credential.token,
        });
        return { ...authorized, target } satisfies PreparedConnection;
      }
    }
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
