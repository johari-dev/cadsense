import {
  AuthAccessTokenType,
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthSessionState,
  type AuthWebSocketTicketResult,
  type ServerAuthDescriptor,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";
const WEBSOCKET_TICKET_TTL_MS = 60_000;
const LOCAL_SESSION_ID = AuthSessionId.make("desktop-local");

const descriptor: ServerAuthDescriptor = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["bearer-access-token"],
};

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: "desktop-local";
  readonly method: "bearer-access-token";
  readonly scopes: typeof AuthStandardClientScopes;
}

const authenticatedSession: AuthenticatedSession = {
  sessionId: LOCAL_SESSION_ID,
  subject: "desktop-local",
  method: "bearer-access-token",
  scopes: AuthStandardClientScopes,
};

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedErrorClass<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export const ServerAuthInternalError = Schema.Union([ServerAuthWebSocketTokenIssueError]);
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedErrorClass<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedErrorClass<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);

export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" =>
  error._tag === "ServerAuthMissingCredentialError" ? "missing_credential" : "invalid_credential";

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState>;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
    ) => Effect.Effect<AuthAccessTokenResult, ServerAuthInvalidCredentialError>;
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError>;
    readonly issueWebSocketTicket: () => Effect.Effect<
      AuthWebSocketTicketResult,
      ServerAuthWebSocketTokenIssueError
    >;
  }
>()("@cadsense/server/auth/EnvironmentAuth") {}

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const tickets = yield* Ref.make(new Map<string, number>());
  const credential = config.desktopBootstrapToken;

  const validateCredential = (
    token: string | null,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError> => {
    // The development renderer starts its own loopback-only backend without
    // an Electron bootstrap envelope. That local process has no credential to
    // protect; packaged desktop and WSL instances always provide one.
    if (credential === undefined) {
      return Effect.succeed(authenticatedSession);
    }
    if (token === null) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    if (token !== credential) {
      return Effect.fail(new ServerAuthInvalidCredentialError({}));
    }
    return Effect.succeed(authenticatedSession);
  };

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    validateCredential(parseBearerToken(request)).pipe(
      Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"),
    );

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request) {
      if (credential === undefined) {
        return authenticatedSession;
      }
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isNone(requestUrl)) {
        return yield* new ServerAuthMissingCredentialError({});
      }
      const ticket = requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM)?.trim();
      if (!ticket) {
        return yield* new ServerAuthMissingCredentialError({});
      }
      const now = yield* Clock.currentTimeMillis;
      const accepted = yield* Ref.modify(tickets, (current) => {
        const expiresAt = current.get(ticket);
        const next = new Map(Array.from(current.entries()).filter(([, expiry]) => expiry > now));
        next.delete(ticket);
        return [expiresAt !== undefined && expiresAt > now, next] as const;
      });
      if (!accepted) {
        return yield* new ServerAuthInvalidCredentialError({});
      }
      return authenticatedSession;
    });

  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = Effect.fn(
    "EnvironmentAuth.issueWebSocketTicket",
  )(function* () {
    const ticket = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
    );
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { milliseconds: WEBSOCKET_TICKET_TTL_MS });
    yield* Ref.update(tickets, (current) => {
      const next = new Map(current);
      next.set(ticket, expiresAt.epochMilliseconds);
      return next;
    });
    return {
      ticket,
      expiresAt: DateTime.toUtc(expiresAt),
    } satisfies AuthWebSocketTicketResult;
  });

  return EnvironmentAuth.of({
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: (request) =>
      authenticateHttpRequest(request).pipe(
        Effect.as({
          authenticated: true,
          auth: descriptor,
          scopes: AuthStandardClientScopes,
          sessionMethod: "bearer-access-token",
        } satisfies AuthSessionState),
        Effect.catchIf(isServerAuthCredentialError, () =>
          Effect.succeed({ authenticated: false, auth: descriptor }),
        ),
      ),
    exchangeBootstrapCredentialForAccessToken: (input) =>
      validateCredential(input).pipe(
        Effect.as({
          access_token: input,
          issued_token_type: AuthAccessTokenType,
          token_type: "Bearer",
          expires_in: 86_400,
          scope: AuthStandardClientScopes.join(" "),
        } satisfies AuthAccessTokenResult),
        Effect.mapError(() => new ServerAuthInvalidCredentialError({})),
      ),
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
  });
});

export const layer = Layer.effect(EnvironmentAuth, make);
