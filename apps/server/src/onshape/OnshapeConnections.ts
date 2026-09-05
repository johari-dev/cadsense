import {
  OnshapeAnnualQuotaExceededError,
  OnshapeConnectionConflictError,
  type OnshapeConnectionCreateInput,
  type OnshapeConnectionError,
  OnshapeConnectionId,
  type OnshapeConnectionListResult,
  OnshapeConnectionNotFoundError,
  OnshapeConnectionPersistenceError,
  type OnshapeConnectionPersistenceOperation,
  type OnshapeConnectionRemoveInput,
  type OnshapeConnectionRemoveResult,
  type OnshapeConnectionRenameInput,
  type OnshapeConnectionReplaceCredentialsInput,
  OnshapeConnectionSummary,
  OnshapeInsufficientPermissionsError,
  OnshapeInvalidCredentialsError,
  OnshapeInvalidHostError,
  OnshapeNetworkError,
  OnshapeRateLimitError,
  OnshapeRedirectError,
  OnshapeVerificationThrottledError,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as OnshapeRequestSigner from "./OnshapeRequestSigner.ts";
import * as OnshapeTransport from "./OnshapeTransport.ts";

const CREDENTIAL_VERSION = 1 as const;
const VERIFY_PATH = "/api/v10/documents";
const VERIFY_QUERY = "limit=1";
const VERIFY_CONTENT_TYPE = "application/json";
const VERIFICATION_WINDOW_MS = 60_000;
const VERIFICATION_LIMIT_PER_WINDOW = 5;

const StoredCredentials = Schema.Struct({
  version: Schema.Literal(CREDENTIAL_VERSION),
  accessKeyId: Schema.String,
  secretKey: Schema.String,
});
type StoredCredentials = typeof StoredCredentials.Type;
const decodeOnshapeConnectionSummary = Schema.decodeUnknownEffect(OnshapeConnectionSummary);
const encodeStoredCredentials = Schema.encodeSync(Schema.fromJsonString(StoredCredentials));

interface ConnectionRow {
  readonly connectionId: string;
  readonly name: string;
  readonly host: string;
  readonly credentialRevision: string;
  readonly verifiedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CredentialBlobRow {
  readonly connectionId: string;
  readonly credentialRevision: string;
}

interface ConnectionCatalogRow {
  readonly updatedAt: string;
}

export interface OnshapeConnectionsShape {
  readonly list: () => Effect.Effect<OnshapeConnectionListResult, OnshapeConnectionError>;
  readonly create: (
    input: OnshapeConnectionCreateInput,
  ) => Effect.Effect<OnshapeConnectionSummary, OnshapeConnectionError>;
  readonly rename: (
    input: OnshapeConnectionRenameInput,
  ) => Effect.Effect<OnshapeConnectionSummary, OnshapeConnectionError>;
  readonly replaceCredentials: (
    input: OnshapeConnectionReplaceCredentialsInput,
  ) => Effect.Effect<OnshapeConnectionSummary, OnshapeConnectionError>;
  readonly remove: (
    input: OnshapeConnectionRemoveInput,
  ) => Effect.Effect<OnshapeConnectionRemoveResult, OnshapeConnectionError>;
}

export class OnshapeConnections extends Context.Service<
  OnshapeConnections,
  OnshapeConnectionsShape
>()("@cadsense/server/onshape/OnshapeConnections") {}

const secretName = (connectionId: string, revision: string) =>
  `onshape-connection-${connectionId}-credentials-${revision}`;

const persistenceError = (operation: OnshapeConnectionPersistenceOperation) =>
  new OnshapeConnectionPersistenceError({ operation });

const encodeCredentials = (credentials: StoredCredentials) =>
  new TextEncoder().encode(encodeStoredCredentials(credentials));

const normalizeHost = Effect.fn("OnshapeConnections.normalizeHost")(function* (host: string) {
  return yield* Effect.try({
    try: () => {
      const candidate = host.includes("://") ? host : `https://${host}`;
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        (hostname !== "onshape.com" && !hostname.endsWith(".onshape.com")) ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw new Error("unsupported host shape");
      }
      return url.origin;
    },
    catch: () => new OnshapeInvalidHostError(),
  });
});

const parseRetryAfterSeconds = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : undefined;
};

const nextUpdatedAt = Effect.fn("OnshapeConnections.nextUpdatedAt")(function* (
  previousUpdatedAt: string | null,
) {
  const now = yield* DateTime.now;
  if (previousUpdatedAt === null) return DateTime.formatIso(now);
  const previous = DateTime.makeUnsafe(previousUpdatedAt);
  return DateTime.formatIso(
    DateTime.isLessThan(previous, now) ? now : DateTime.add(previous, { milliseconds: 1 }),
  );
});

const decodeSummary = Effect.fn("OnshapeConnections.decodeSummary")(function* (
  row: ConnectionRow,
  operation: OnshapeConnectionPersistenceOperation,
) {
  return yield* decodeOnshapeConnectionSummary({
    connectionId: row.connectionId,
    name: row.name,
    host: row.host,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError(() => persistenceError(operation)));
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore;
  const signer = yield* OnshapeRequestSigner.OnshapeRequestSigner;
  const transport = yield* OnshapeTransport.OnshapeTransport;
  const crypto = yield* Crypto.Crypto;
  const mutationLock = yield* Semaphore.make(1);
  const verificationAttempts: Array<number> = [];
  const cleanupRetries = new Map<
    string,
    {
      readonly row: CredentialBlobRow;
      readonly operation: OnshapeConnectionPersistenceOperation;
    }
  >();
  let remoteBlockedUntilMs = 0;

  const cleanupRetryKey = (row: CredentialBlobRow) =>
    `${row.connectionId}:${row.credentialRevision}`;

  const queryRows = Effect.fn("OnshapeConnections.queryRows")(function* (
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    return yield* sql<ConnectionRow>`
      SELECT
        connection_id AS "connectionId",
        name,
        host,
        credential_revision AS "credentialRevision",
        verified_at AS "verifiedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM onshape_connections
      ORDER BY created_at ASC, connection_id ASC
    `.pipe(Effect.mapError(() => persistenceError(operation)));
  });

  const getRow = Effect.fn("OnshapeConnections.getRow")(function* (
    connectionId: OnshapeConnectionId,
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    return yield* sql<ConnectionRow>`
      SELECT
        connection_id AS "connectionId",
        name,
        host,
        credential_revision AS "credentialRevision",
        verified_at AS "verifiedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM onshape_connections
      WHERE connection_id = ${connectionId}
      LIMIT 1
    `.pipe(
      Effect.mapError(() => persistenceError(operation)),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );
  });

  const getCatalogUpdatedAt = Effect.fn("OnshapeConnections.getCatalogUpdatedAt")(function* (
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    const rows = yield* sql<ConnectionCatalogRow>`
      SELECT updated_at AS "updatedAt"
      FROM onshape_connection_catalog_state
      WHERE singleton = 1
    `.pipe(Effect.mapError(() => persistenceError(operation)));
    const row = rows[0];
    if (row === undefined) return yield* persistenceError(operation);
    return row.updatedAt;
  });

  const setCatalogUpdatedAt = Effect.fn("OnshapeConnections.setCatalogUpdatedAt")(function* (
    updatedAt: string,
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    yield* sql`
      UPDATE onshape_connection_catalog_state
      SET updated_at = ${updatedAt}
      WHERE singleton = 1
    `.pipe(Effect.mapError(() => persistenceError(operation)));
  });

  const nameExists = Effect.fn("OnshapeConnections.nameExists")(function* (
    name: string,
    operation: OnshapeConnectionPersistenceOperation,
    excluding?: OnshapeConnectionId,
  ) {
    const rows = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM onshape_connections
      WHERE name = ${name} COLLATE NOCASE
        AND (${excluding ?? null} IS NULL OR connection_id <> ${excluding ?? null})
      LIMIT 1
    `.pipe(Effect.mapError(() => persistenceError(operation)));
    return rows.length > 0;
  });

  const insertConnection = Effect.fn("OnshapeConnections.insertConnection")(function* (
    row: ConnectionRow,
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    yield* sql`
      INSERT INTO onshape_connections (
        connection_id, name, host, credential_revision, verified_at, created_at, updated_at
      ) VALUES (
        ${row.connectionId}, ${row.name}, ${row.host}, ${row.credentialRevision}, ${row.verifiedAt},
        ${row.createdAt}, ${row.updatedAt}
      )
    `.pipe(Effect.mapError(() => persistenceError(operation)));
  });

  const trackCredential = Effect.fn("OnshapeConnections.trackCredential")(function* (
    row: CredentialBlobRow,
    state: "active" | "cleanup_pending",
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO onshape_credential_blobs (
        connection_id, credential_revision, state, created_at
      ) VALUES (
        ${row.connectionId}, ${row.credentialRevision}, ${state}, ${createdAt}
      )
      ON CONFLICT (connection_id, credential_revision) DO UPDATE SET state = excluded.state
    `.pipe(Effect.mapError(() => persistenceError(operation)));
  });

  const untrackCredential = Effect.fn("OnshapeConnections.untrackCredential")(function* (
    row: CredentialBlobRow,
    operation: OnshapeConnectionPersistenceOperation,
  ) {
    yield* sql`
      DELETE FROM onshape_credential_blobs
      WHERE connection_id = ${row.connectionId}
        AND credential_revision = ${row.credentialRevision}
    `.pipe(Effect.mapError(() => persistenceError(operation)));
  });

  const cleanupTrackedCredential = Effect.fn("OnshapeConnections.cleanupTrackedCredential")(
    function* (row: CredentialBlobRow, operation: OnshapeConnectionPersistenceOperation) {
      yield* secretStore
        .remove(secretName(row.connectionId, row.credentialRevision))
        .pipe(Effect.mapError(() => persistenceError(operation)));
      yield* untrackCredential(row, operation);
      cleanupRetries.delete(cleanupRetryKey(row));
    },
  );

  const scheduleCleanupRetry = Effect.fn("OnshapeConnections.scheduleCleanupRetry")(
    (row: CredentialBlobRow, operation: OnshapeConnectionPersistenceOperation) =>
      Effect.sync(() => cleanupRetries.set(cleanupRetryKey(row), { row, operation })).pipe(
        Effect.asVoid,
      ),
  );

  const retryPendingCleanup = Effect.fn("OnshapeConnections.retryPendingCleanup")(function* () {
    yield* Effect.forEach(
      [...cleanupRetries.values()],
      ({ row, operation }) => cleanupTrackedCredential(row, operation).pipe(Effect.ignore),
      { discard: true },
    );
  });

  const sweepPendingCredentials = Effect.fn("OnshapeConnections.sweepPendingCredentials")(
    function* () {
      const rows = yield* sql<CredentialBlobRow>`
        SELECT
          connection_id AS "connectionId",
          credential_revision AS "credentialRevision"
        FROM onshape_credential_blobs
        WHERE state = 'cleanup_pending'
        ORDER BY created_at ASC
      `.pipe(Effect.mapError(() => persistenceError("list")));
      yield* Effect.forEach(
        rows,
        (row) =>
          scheduleCleanupRetry(row, "remove").pipe(
            Effect.andThen(cleanupTrackedCredential(row, "remove")),
            Effect.catch(() =>
              Effect.logWarning("Failed to clean up an unused Onshape credential.", {
                connectionId: row.connectionId,
              }),
            ),
          ),
        { discard: true },
      );
    },
  );

  const verify = Effect.fn("OnshapeConnections.verify")(function* (
    host: string,
    credentials: StoredCredentials,
  ) {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (remoteBlockedUntilMs > nowMs) {
      return yield* new OnshapeRateLimitError({
        retryAfterSeconds: Math.ceil((remoteBlockedUntilMs - nowMs) / 1_000),
      });
    }
    remoteBlockedUntilMs = 0;
    while (
      verificationAttempts.length > 0 &&
      (verificationAttempts[0] ?? nowMs) <= nowMs - VERIFICATION_WINDOW_MS
    ) {
      verificationAttempts.shift();
    }
    if (verificationAttempts.length >= VERIFICATION_LIMIT_PER_WINDOW) {
      const retryAt = (verificationAttempts[0] ?? nowMs) + VERIFICATION_WINDOW_MS;
      return yield* new OnshapeVerificationThrottledError({
        retryAfterSeconds: Math.max(0, Math.ceil((retryAt - nowMs) / 1_000)),
      });
    }
    verificationAttempts.push(nowMs);

    const nonce = yield* crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => uuid.replaceAll("-", "")),
      Effect.mapError(() => new OnshapeNetworkError()),
    );
    const date = DateTime.toDateUtc(now).toUTCString();
    const headers = yield* signer.sign({
      accessKeyId: credentials.accessKeyId,
      secretKey: credentials.secretKey,
      method: "GET",
      nonce,
      date,
      contentType: VERIFY_CONTENT_TYPE,
      path: VERIFY_PATH,
      query: VERIFY_QUERY,
    });
    const response = yield* transport
      .execute({
        method: "GET",
        url: `${host}${VERIFY_PATH}?${VERIFY_QUERY}`,
        headers: { ...headers, Accept: "application/json" },
      })
      .pipe(Effect.mapError(() => new OnshapeNetworkError()));

    if (response.status >= 200 && response.status < 300) {
      return;
    }
    if (response.status === 401) return yield* new OnshapeInvalidCredentialsError();
    if (response.status === 403) return yield* new OnshapeInsufficientPermissionsError();
    if (response.status === 402) return yield* new OnshapeAnnualQuotaExceededError();
    if (response.status >= 300 && response.status < 400) {
      return yield* new OnshapeRedirectError();
    }
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.retryAfter);
      if (retryAfterSeconds !== undefined) {
        remoteBlockedUntilMs =
          DateTime.toEpochMillis(yield* DateTime.now) + retryAfterSeconds * 1_000;
      }
      return yield* new OnshapeRateLimitError(
        retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
      );
    }
    return yield* new OnshapeNetworkError();
  });

  yield* Effect.forever(
    Effect.sleep("30 seconds").pipe(Effect.andThen(retryPendingCleanup())),
  ).pipe(Effect.forkScoped);

  yield* sweepPendingCredentials().pipe(
    Effect.catch(() => Effect.logWarning("Failed to sweep unused Onshape credentials.")),
  );

  const list: OnshapeConnectionsShape["list"] = Effect.fn("OnshapeConnections.list")(function* () {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* queryRows("list");
          const connections = yield* Effect.forEach(rows, (row) => decodeSummary(row, "list"));
          const catalogUpdatedAt = yield* getCatalogUpdatedAt("list");
          return { connections, catalogUpdatedAt };
        }),
      )
      .pipe(Effect.mapError(() => persistenceError("list")));
  });

  const create: OnshapeConnectionsShape["create"] = Effect.fn("OnshapeConnections.create")(
    function* (input) {
      return yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const host = yield* normalizeHost(input.host);
          if (yield* nameExists(input.name, "create")) {
            return yield* new OnshapeConnectionConflictError();
          }
          const credentials: StoredCredentials = {
            version: CREDENTIAL_VERSION,
            accessKeyId: input.accessKeyId,
            secretKey: input.secretKey,
          };
          yield* verify(host, credentials);
          const connectionId = yield* crypto.randomUUIDv4.pipe(
            Effect.map(OnshapeConnectionId.make),
            Effect.mapError(() => persistenceError("create")),
          );
          const credentialRevision = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => uuid.replaceAll("-", "")),
            Effect.mapError(() => persistenceError("create")),
          );
          const verifiedAt = DateTime.formatIso(yield* DateTime.now);
          const updatedAt = yield* nextUpdatedAt(yield* getCatalogUpdatedAt("create"));
          const row: ConnectionRow = {
            connectionId,
            name: input.name,
            host,
            credentialRevision,
            verifiedAt,
            createdAt: verifiedAt,
            updatedAt,
          };
          const blob = { connectionId, credentialRevision };
          let committed = false;
          yield* Effect.gen(function* () {
            yield* trackCredential(blob, "cleanup_pending", "create");
            yield* secretStore
              .create(secretName(connectionId, credentialRevision), encodeCredentials(credentials))
              .pipe(Effect.mapError(() => persistenceError("create")));

            yield* Effect.uninterruptible(
              sql
                .withTransaction(
                  insertConnection(row, "create").pipe(
                    Effect.andThen(trackCredential(blob, "active", "create")),
                    Effect.andThen(setCatalogUpdatedAt(updatedAt, "create")),
                  ),
                )
                .pipe(
                  Effect.mapError(() => persistenceError("create")),
                  Effect.tap(() => Effect.sync(() => (committed = true))),
                ),
            );
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !committed
                ? scheduleCleanupRetry(blob, "create").pipe(
                    Effect.andThen(cleanupTrackedCredential(blob, "create")),
                    Effect.ignore,
                    Effect.uninterruptible,
                  )
                : Effect.void,
            ),
          );
          return yield* decodeSummary(row, "create");
        }),
      );
    },
  );

  const rename: OnshapeConnectionsShape["rename"] = Effect.fn("OnshapeConnections.rename")(
    function* (input) {
      return yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getRow(input.connectionId, "rename");
          if (Option.isNone(existing)) {
            return yield* new OnshapeConnectionNotFoundError({ connectionId: input.connectionId });
          }
          if (yield* nameExists(input.name, "rename", input.connectionId)) {
            return yield* new OnshapeConnectionConflictError();
          }
          const updatedAt = yield* nextUpdatedAt(yield* getCatalogUpdatedAt("rename"));
          yield* sql
            .withTransaction(
              sql`
                UPDATE onshape_connections
                SET name = ${input.name}, updated_at = ${updatedAt}
                WHERE connection_id = ${input.connectionId}
              `.pipe(Effect.andThen(setCatalogUpdatedAt(updatedAt, "rename"))),
            )
            .pipe(Effect.mapError(() => persistenceError("rename")));
          return yield* decodeSummary({ ...existing.value, name: input.name, updatedAt }, "rename");
        }),
      );
    },
  );

  const replaceCredentials: OnshapeConnectionsShape["replaceCredentials"] = Effect.fn(
    "OnshapeConnections.replaceCredentials",
  )(function* (input) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* getRow(input.connectionId, "replace-credentials");
        if (Option.isNone(existing)) {
          return yield* new OnshapeConnectionNotFoundError({ connectionId: input.connectionId });
        }
        const host = yield* normalizeHost(input.host);
        const credentials: StoredCredentials = {
          version: CREDENTIAL_VERSION,
          accessKeyId: input.accessKeyId,
          secretKey: input.secretKey,
        };
        yield* verify(host, credentials);
        const credentialRevision = yield* crypto.randomUUIDv4.pipe(
          Effect.map((uuid) => uuid.replaceAll("-", "")),
          Effect.mapError(() => persistenceError("replace-credentials")),
        );
        const verifiedAt = DateTime.formatIso(yield* DateTime.now);
        const updatedAt = yield* nextUpdatedAt(yield* getCatalogUpdatedAt("replace-credentials"));
        const candidate = { connectionId: input.connectionId, credentialRevision };
        const previous = {
          connectionId: input.connectionId,
          credentialRevision: existing.value.credentialRevision,
        };

        yield* trackCredential(previous, "active", "replace-credentials");
        let committed = false;
        yield* Effect.gen(function* () {
          yield* trackCredential(candidate, "cleanup_pending", "replace-credentials");
          yield* secretStore
            .create(
              secretName(input.connectionId, credentialRevision),
              encodeCredentials(credentials),
            )
            .pipe(Effect.mapError(() => persistenceError("replace-credentials")));

          yield* Effect.uninterruptible(
            sql
              .withTransaction(
                trackCredential(previous, "cleanup_pending", "replace-credentials").pipe(
                  Effect.andThen(trackCredential(candidate, "active", "replace-credentials")),
                  Effect.andThen(
                    sql`
                      UPDATE onshape_connections
                      SET host = ${host}, credential_revision = ${credentialRevision},
                          verified_at = ${verifiedAt}, updated_at = ${updatedAt}
                      WHERE connection_id = ${input.connectionId}
                    `.pipe(
                      Effect.andThen(setCatalogUpdatedAt(updatedAt, "replace-credentials")),
                      Effect.mapError(() => persistenceError("replace-credentials")),
                    ),
                  ),
                ),
              )
              .pipe(
                Effect.mapError(() => persistenceError("replace-credentials")),
                Effect.tap(() => Effect.sync(() => (committed = true))),
                Effect.tap(() => scheduleCleanupRetry(previous, "replace-credentials")),
              ),
          );
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !committed
              ? scheduleCleanupRetry(candidate, "replace-credentials").pipe(
                  Effect.andThen(cleanupTrackedCredential(candidate, "replace-credentials")),
                  Effect.ignore,
                  Effect.uninterruptible,
                )
              : Effect.void,
          ),
        );
        yield* cleanupTrackedCredential(previous, "replace-credentials").pipe(
          Effect.catch(() =>
            Effect.logWarning("Failed to clean up a superseded Onshape credential.", {
              connectionId: input.connectionId,
            }),
          ),
        );
        return yield* decodeSummary(
          { ...existing.value, host, credentialRevision, verifiedAt, updatedAt },
          "replace-credentials",
        );
      }),
    );
  });

  const remove: OnshapeConnectionsShape["remove"] = Effect.fn("OnshapeConnections.remove")(
    function* (input) {
      return yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getRow(input.connectionId, "remove");
          if (Option.isNone(existing)) {
            return yield* new OnshapeConnectionNotFoundError({ connectionId: input.connectionId });
          }
          const updatedAt = yield* nextUpdatedAt(yield* getCatalogUpdatedAt("remove"));
          const active = {
            connectionId: input.connectionId,
            credentialRevision: existing.value.credentialRevision,
          };
          yield* trackCredential(active, "active", "remove");
          const tracked = yield* sql<CredentialBlobRow>`
            SELECT
              connection_id AS "connectionId",
              credential_revision AS "credentialRevision"
            FROM onshape_credential_blobs
            WHERE connection_id = ${input.connectionId}
          `.pipe(Effect.mapError(() => persistenceError("remove")));

          yield* Effect.uninterruptible(
            sql
              .withTransaction(
                sql`
                  UPDATE onshape_credential_blobs
                  SET state = 'cleanup_pending'
                  WHERE connection_id = ${input.connectionId}
                `.pipe(
                  Effect.andThen(sql`
                    DELETE FROM onshape_connections
                    WHERE connection_id = ${input.connectionId}
                  `),
                  Effect.andThen(setCatalogUpdatedAt(updatedAt, "remove")),
                ),
              )
              .pipe(
                Effect.mapError(() => persistenceError("remove")),
                Effect.tap(() =>
                  Effect.forEach(tracked, (blob) => scheduleCleanupRetry(blob, "remove"), {
                    discard: true,
                  }),
                ),
              ),
          );
          yield* Effect.forEach(
            tracked,
            (blob) =>
              cleanupTrackedCredential(blob, "remove").pipe(
                Effect.catch(() =>
                  Effect.logWarning("Failed to clean up a removed Onshape credential.", {
                    connectionId: input.connectionId,
                  }),
                ),
              ),
            { discard: true },
          );
          return { connectionId: input.connectionId, updatedAt };
        }),
      );
    },
  );

  return OnshapeConnections.of({ list, create, rename, replaceCredentials, remove });
});

/** Test seam: callers may provide deterministic signer and transport services. */
export const layer = Layer.effect(OnshapeConnections, make);

export const layerLive = layer.pipe(
  Layer.provide(OnshapeRequestSigner.layer),
  Layer.provide(OnshapeTransport.layer),
);
