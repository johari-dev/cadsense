/**
 * Anonymous installation identity for usage analytics.
 *
 * The identity is a random UUID persisted at `ServerConfig.anonymousIdPath`, created on the first
 * event that is actually sent. Analytics never read provider credentials (Codex or Claude account
 * ids), so the id can't be linked to an account or to another app that hashes the same files.
 *
 * @module Identify
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/**
 * Prefix hashed with the installation UUID. It keeps Cadsense's `distinct_id` from matching any
 * other product that hashes a UUID the same way. Bump the version to start every install fresh.
 */
const IDENTITY_NAMESPACE = "cadsense:v1:";

export class TelemetryIdentityReadError extends Schema.TaggedErrorClass<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read the telemetry installation id at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityGenerationError extends Schema.TaggedErrorClass<TelemetryIdentityGenerationError>()(
  "TelemetryIdentityGenerationError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to generate a telemetry installation id for '${this.filePath}'.`;
  }
}

export class TelemetryIdentityPersistenceError extends Schema.TaggedErrorClass<TelemetryIdentityPersistenceError>()(
  "TelemetryIdentityPersistenceError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to persist or delete the telemetry installation id at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityHashError extends Schema.TaggedErrorClass<TelemetryIdentityHashError>()(
  "TelemetryIdentityHashError",
  { algorithm: Schema.Literal("SHA-256"), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to hash the telemetry installation id with ${this.algorithm}.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryIdentityGenerationError
  | TelemetryIdentityPersistenceError
  | TelemetryIdentityHashError;

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      ...("filePath" in error ? { filePath: error.filePath } : {}),
      causeKind: error.cause instanceof PlatformError.PlatformError ? "platform" : "other",
    }),
  );

const readInstallationId = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.map((contents) => Option.some(contents.trim()).pipe(Option.filter((id) => id !== ""))),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFound(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new TelemetryIdentityReadError({ filePath, cause })),
    }),
  );

const upsertInstallationId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readInstallationId(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) return existing.value;

  const installationId = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(
      (cause) => new TelemetryIdentityGenerationError({ filePath: anonymousIdPath, cause }),
    ),
  );
  yield* fileSystem
    .writeFileString(anonymousIdPath, installationId)
    .pipe(
      Effect.mapError(
        (cause) => new TelemetryIdentityPersistenceError({ filePath: anonymousIdPath, cause }),
      ),
    );
  return installationId;
});

const hashInstallationId = (installationId: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.digest("SHA-256", new TextEncoder().encode(`${IDENTITY_NAMESPACE}${installationId}`)),
    ),
    Effect.map(Encoding.encodeHex),
    Effect.mapError((cause) => new TelemetryIdentityHashError({ algorithm: "SHA-256", cause })),
  );

/**
 * The `distinct_id` for analytics events: SHA-256 of the namespaced installation UUID, creating
 * and persisting the UUID on first use. Returns null (and logs) when the id can't be read or
 * written, so callers skip sending rather than fail.
 */
export const getTelemetryIdentifier = upsertInstallationId.pipe(
  Effect.flatMap(hashInstallationId),
  Effect.tapError(logTelemetryIdentityError),
  Effect.orElseSucceed(() => null),
  Effect.withSpan("TelemetryIdentity.getTelemetryIdentifier"),
);

/**
 * Deletes the persisted installation id, so the next identifier is a new, unlinked one. Used when
 * the user turns usage analytics off. Logs and succeeds if the file can't be removed.
 */
export const forgetTelemetryIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
  yield* fileSystem
    .remove(anonymousIdPath, { force: true })
    .pipe(
      Effect.mapError(
        (cause) => new TelemetryIdentityPersistenceError({ filePath: anonymousIdPath, cause }),
      ),
    );
}).pipe(
  Effect.tapError(logTelemetryIdentityError),
  Effect.ignore,
  Effect.withSpan("TelemetryIdentity.forgetTelemetryIdentity"),
);
