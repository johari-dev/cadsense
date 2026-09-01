import {
  EnvironmentCacheStore,
  ConnectionPersistenceError,
} from "@cadsense/client-runtime/platform";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ThreadId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DATABASE_NAME = "cadsense:local-cache";
const DATABASE_VERSION = 1;
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const SERVER_CONFIG_STORE_NAME = "server-config";

const StoredShellSnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    environmentId: EnvironmentId,
    snapshot: OrchestrationShellSnapshot,
  }),
);
const StoredThreadSnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
);
const StoredServerConfigJson = Schema.fromJsonString(
  Schema.Struct({
    environmentId: EnvironmentId,
    config: ServerConfig,
  }),
);

function persistenceError(
  operation: ConnectionPersistenceError["operation"],
  cause: unknown,
): ConnectionPersistenceError {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.localCache.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionPersistenceError>((resume) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const storeName of [SHELL_STORE_NAME, THREAD_STORE_NAME, SERVER_CONFIG_STORE_NAME]) {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      }
    });
    request.addEventListener("error", () => {
      resume(Effect.fail(persistenceError("load-shell", request.error)));
    });
    request.addEventListener("success", () => resume(Effect.succeed(request.result)));
  });
});

function readValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionPersistenceError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", () => {
      resume(Effect.fail(persistenceError("load-shell", request.error)));
    });
    request.addEventListener("success", () => resume(Effect.succeed(request.result)));
  });
}

function writeValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: string,
  operation: ConnectionPersistenceError["operation"],
) {
  return Effect.callback<void, ConnectionPersistenceError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(Effect.fail(persistenceError(operation, transaction.error)));
    });
    transaction.addEventListener("complete", () => resume(Effect.void));
    transaction.objectStore(storeName).put(value, key);
  });
}

function removeValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  operation: ConnectionPersistenceError["operation"],
) {
  return Effect.callback<void, ConnectionPersistenceError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(Effect.fail(persistenceError(operation, transaction.error)));
    });
    transaction.addEventListener("complete", () => resume(Effect.void));
    transaction.objectStore(storeName).delete(key);
  });
}

function removeEnvironmentThreads(database: IDBDatabase, environmentId: EnvironmentId) {
  return Effect.callback<void, ConnectionPersistenceError>((resume) => {
    const transaction = database.transaction(THREAD_STORE_NAME, "readwrite");
    transaction.addEventListener("error", () => {
      resume(Effect.fail(persistenceError("clear-environment", transaction.error)));
    });
    transaction.addEventListener("complete", () => resume(Effect.void));
    const request = transaction
      .objectStore(THREAD_STORE_NAME)
      .openCursor(IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`));
    request.addEventListener("error", () => {
      resume(Effect.fail(persistenceError("clear-environment", request.error)));
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor !== null) {
        cursor.delete();
        cursor.continue();
      }
    });
  });
}

function threadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

function decodeOptional<A, I>(
  raw: unknown,
  schema: Schema.Codec<A, I, never, never>,
  operation: ConnectionPersistenceError["operation"],
) {
  if (typeof raw !== "string") return Effect.succeed(Option.none<A>());
  return Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.map(Option.some),
    Effect.mapError((cause) => persistenceError(operation, cause)),
  );
}

export const connectionStorageLayer = Layer.effect(
  EnvironmentCacheStore,
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(openDatabase(), (value) =>
      Effect.sync(() => value.close()),
    );
    const cache = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => decodeOptional(raw, StoredShellSnapshotJson, "load-shell")),
          Effect.map(Option.filter((stored) => stored.environmentId === environmentId)),
          Effect.map(Option.map((stored) => stored.snapshot)),
        ),
      saveShell: (environmentId, snapshot) =>
        Schema.encodeEffect(StoredShellSnapshotJson)({ environmentId, snapshot }).pipe(
          Effect.mapError((cause) => persistenceError("save-shell", cause)),
          Effect.flatMap((encoded) =>
            writeValue(database, SHELL_STORE_NAME, environmentId, encoded, "save-shell"),
          ),
        ),
      loadThread: (environmentId, threadId) =>
        readValue(database, THREAD_STORE_NAME, threadKey(environmentId, threadId)).pipe(
          Effect.flatMap((raw) => decodeOptional(raw, StoredThreadSnapshotJson, "load-thread")),
          Effect.map(
            Option.filter(
              (stored) => stored.environmentId === environmentId && stored.threadId === threadId,
            ),
          ),
          Effect.map(Option.map((stored) => stored.snapshot)),
        ),
      saveThread: (environmentId, snapshot) =>
        Schema.encodeEffect(StoredThreadSnapshotJson)({
          environmentId,
          threadId: snapshot.thread.id,
          snapshot,
        }).pipe(
          Effect.mapError((cause) => persistenceError("save-thread", cause)),
          Effect.flatMap((encoded) =>
            writeValue(
              database,
              THREAD_STORE_NAME,
              threadKey(environmentId, snapshot.thread.id),
              encoded,
              "save-thread",
            ),
          ),
        ),
      removeThread: (environmentId, threadId) =>
        removeValue(
          database,
          THREAD_STORE_NAME,
          threadKey(environmentId, threadId),
          "remove-thread",
        ),
      loadServerConfig: (environmentId) =>
        readValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) =>
            decodeOptional(raw, StoredServerConfigJson, "load-server-config"),
          ),
          Effect.map(Option.filter((stored) => stored.environmentId === environmentId)),
          Effect.map(Option.map((stored) => stored.config)),
        ),
      saveServerConfig: (environmentId, config) =>
        Schema.encodeEffect(StoredServerConfigJson)({ environmentId, config }).pipe(
          Effect.mapError((cause) => persistenceError("save-server-config", cause)),
          Effect.flatMap((encoded) =>
            writeValue(
              database,
              SERVER_CONFIG_STORE_NAME,
              environmentId,
              encoded,
              "save-server-config",
            ),
          ),
        ),
      clear: (environmentId) =>
        Effect.all(
          [
            removeValue(database, SHELL_STORE_NAME, environmentId, "clear-environment"),
            removeValue(database, SERVER_CONFIG_STORE_NAME, environmentId, "clear-environment"),
            removeEnvironmentThreads(database, environmentId),
          ],
          { discard: true },
        ),
    });
    return cache;
  }),
);
