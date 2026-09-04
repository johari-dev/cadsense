import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as OnshapeConnections from "./OnshapeConnections.ts";
import * as OnshapeRequestSigner from "./OnshapeRequestSigner.ts";
import * as OnshapeTransport from "./OnshapeTransport.ts";

const OLD_ACCESS_KEY = "old-access-key";
const OLD_SECRET_KEY = "old-secret-key";
const NEW_ACCESS_KEY = "new-access-key";
const NEW_SECRET_KEY = "new-secret-key";

interface HarnessState {
  readonly requests: Array<OnshapeTransport.OnshapeTransportRequest>;
  readonly secrets: Map<string, Uint8Array>;
  status: number;
  retryAfter: string | null;
  failTransport: boolean;
  verificationStarted: Deferred.Deferred<void> | null;
  verificationRelease: Deferred.Deferred<void> | null;
  failCreateAfterWrite: boolean;
  blockCreateAfterWrite: boolean;
  createWritten: Deferred.Deferred<void> | null;
  failRemove: boolean;
  blockRemove: boolean;
  removeStarted: Deferred.Deferred<void> | null;
}

const makeHarness = <E, R>(
  persistence: Layer.Layer<SqlClient.SqlClient, E, R>,
  sharedState?: HarnessState,
) => {
  const state: HarnessState = sharedState ?? {
    requests: [],
    secrets: new Map(),
    status: 200,
    retryAfter: null,
    failTransport: false,
    verificationStarted: null,
    verificationRelease: null,
    failCreateAfterWrite: false,
    blockCreateAfterWrite: false,
    createWritten: null,
    failRemove: false,
    blockRemove: false,
    removeStarted: null,
  };
  const secretFailure = (operation: "persist" | "remove") =>
    operation === "persist"
      ? new ServerSecretStore.SecretStorePersistError({
          resource: "Onshape credential",
          cause: new Error("test persistence failure"),
        })
      : new ServerSecretStore.SecretStoreRemoveError({
          resource: "Onshape credential",
          cause: new Error("test removal failure"),
        });
  const secretStoreLayer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = state.secrets.get(name);
          return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
        }),
      set: (name, value) =>
        Effect.sync(() => {
          state.secrets.set(name, Uint8Array.from(value));
        }),
      create: (name, value) =>
        state.secrets.has(name)
          ? Effect.fail(secretFailure("persist"))
          : Effect.sync(() => state.secrets.set(name, Uint8Array.from(value))).pipe(
              Effect.andThen(
                state.createWritten === null
                  ? Effect.void
                  : Deferred.succeed(state.createWritten, undefined),
              ),
              Effect.andThen(
                state.blockCreateAfterWrite
                  ? Effect.never
                  : state.failCreateAfterWrite
                    ? Effect.fail(secretFailure("persist"))
                    : Effect.void,
              ),
            ),
      getOrCreateRandom: () => Effect.die("not used by Onshape connections"),
      remove: (name) => {
        if (state.blockRemove) {
          return (
            state.removeStarted === null
              ? Effect.void
              : Deferred.succeed(state.removeStarted, undefined)
          ).pipe(Effect.andThen(Effect.never));
        }
        return state.failRemove
          ? Effect.fail(secretFailure("remove"))
          : Effect.sync(() => {
              state.secrets.delete(name);
            });
      },
    }),
  );
  const transportLayer = Layer.succeed(
    OnshapeTransport.OnshapeTransport,
    OnshapeTransport.OnshapeTransport.of({
      execute: (request) =>
        Effect.sync(() => state.requests.push(request)).pipe(
          Effect.andThen(
            state.verificationStarted === null
              ? Effect.void
              : Deferred.succeed(state.verificationStarted, undefined),
          ),
          Effect.andThen(
            state.verificationRelease === null
              ? Effect.void
              : Deferred.await(state.verificationRelease),
          ),
          Effect.andThen(
            state.failTransport
              ? Effect.fail(new OnshapeTransport.OnshapeTransportFailure())
              : Effect.succeed({ status: state.status, retryAfter: state.retryAfter }),
          ),
        ),
    }),
  );
  const dependencies = Layer.mergeAll(
    persistence,
    secretStoreLayer,
    transportLayer,
    OnshapeRequestSigner.layer,
  );
  return {
    state,
    layer: Layer.mergeAll(dependencies, OnshapeConnections.layer.pipe(Layer.provide(dependencies))),
  };
};

const makeMemoryHarness = () => makeHarness(SqlitePersistenceMemory);

const createInput = {
  name: "Team CAD",
  host: "cad.onshape.com",
  accessKeyId: OLD_ACCESS_KEY,
  secretKey: OLD_SECRET_KEY,
} as const;

describe("Onshape request signing", () => {
  it("matches a fixed HMAC-SHA256 vector", () => {
    const headers = OnshapeRequestSigner.signOnshapeRequest({
      accessKeyId: "access-key",
      secretKey: "secret-key",
      method: "GET",
      nonce: "0123456789abcdef0123456789abcdef",
      date: "Thu, 03 Sep 2026 17:00:00 GMT",
      contentType: "application/json",
      path: "/api/v10/documents",
      query: "limit=1",
    });

    assert.equal(
      headers.Authorization,
      "On access-key:HmacSHA256:0rGek66mB4mNL7OiGxORDh+iWidOnhHYc2mCKam3jBE=",
    );
    assert.equal(headers["On-Nonce"], "0123456789abcdef0123456789abcdef");
    assert.equal(headers.Date, "Thu, 03 Sep 2026 17:00:00 GMT");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it.effect("sends once with redirects disabled and no retry", () => {
    let calls = 0;
    let redirect: string | undefined;
    const fetch = ((_input, init) => {
      calls += 1;
      redirect = init?.redirect;
      return Promise.resolve(new Response(undefined, { status: 302 }));
    }) as typeof globalThis.fetch;
    const fetchLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      const response = yield* transport.execute({
        method: "GET",
        url: "https://cad.onshape.com/api/v10/documents?limit=1",
        headers: { Accept: "application/json" },
      });

      assert.equal(response.status, 302);
      assert.equal(calls, 1);
      assert.equal(redirect, "manual");
    }).pipe(Effect.provide(OnshapeTransport.layer.pipe(Layer.provide(fetchLayer))));
  });

  it.effect("times out and aborts one hanging fetch without retrying", () => {
    let calls = 0;
    let aborted = false;
    const fetch = ((_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("fetch did not receive an abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;
    const fetchLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      const failure = yield* transport
        .execute({
          method: "GET",
          url: "https://cad.onshape.com/api/v10/documents?limit=1",
          headers: { Accept: "application/json" },
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(failure);

      assert.equal(error._tag, "OnshapeTransportFailure");
      assert.equal(calls, 1);
      assert.isTrue(aborted);
    }).pipe(Effect.provide(OnshapeTransport.layer.pipe(Layer.provide(fetchLayer))));
  });
});

it.layer(NodeServices.layer)("OnshapeConnections", (it) => {
  it.effect("normalizes a bare Onshape host and verifies with exactly one request", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const saved = yield* connections.create(createInput);

      assert.equal(saved.host, "https://cad.onshape.com");
      assert.equal(harness.state.requests.length, 1);
      assert.equal(
        harness.state.requests[0]?.url,
        "https://cad.onshape.com/api/v10/documents?limit=1",
      );
      assert.equal(harness.state.requests[0]?.method, "GET");
      assert.equal(harness.state.requests[0]?.headers.Accept, "application/json");
      assert.equal(harness.state.requests[0]?.headers["Content-Type"], "application/json");
      assert.match(harness.state.requests[0]?.headers.Authorization ?? "", /^On /);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("publishes a strictly newer revision for every saved connection change", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const saved = yield* connections.create(createInput);
      const renamed = yield* connections.rename({
        connectionId: saved.connectionId,
        name: "Renamed CAD",
      });
      const replaced = yield* connections.replaceCredentials({
        connectionId: saved.connectionId,
        host: "cad.onshape.com",
        accessKeyId: NEW_ACCESS_KEY,
        secretKey: NEW_SECRET_KEY,
      });
      const listed = yield* connections.list();

      assert.isTrue(saved.updatedAt < renamed.updatedAt);
      assert.isTrue(renamed.updatedAt < replaced.updatedAt);
      assert.equal(listed.connections[0]?.updatedAt, replaced.updatedAt);
      assert.equal(listed.catalogUpdatedAt, replaced.updatedAt);
      assert.equal(harness.state.requests.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists a consistent snapshot while connection verification is still pending", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const verificationStarted = yield* Deferred.make<void>();
      const verificationRelease = yield* Deferred.make<void>();
      harness.state.verificationStarted = verificationStarted;
      harness.state.verificationRelease = verificationRelease;
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const before = yield* connections.list();
      const creating = yield* connections.create(createInput).pipe(Effect.forkChild);
      yield* Deferred.await(verificationStarted);

      const whileVerifying = yield* connections.list();
      assert.deepEqual(whileVerifying, before);

      yield* Deferred.succeed(verificationRelease, undefined);
      const saved = yield* Fiber.join(creating);
      const after = yield* connections.list();
      assert.equal(after.connections[0]?.connectionId, saved.connectionId);
      assert.equal(after.catalogUpdatedAt, saved.updatedAt);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects arbitrary, local, and port-qualified hosts without a request", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      for (const host of [
        "https://example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://cad.onshape.com:8443",
        "https://cad.onshape.com/api",
        "https://user:pass@cad.onshape.com",
      ]) {
        const error = yield* Effect.flip(connections.create({ ...createInput, host }));
        assert.equal(error._tag, "OnshapeInvalidHostError");
      }
      assert.equal(harness.state.requests.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps quota responses without exposing either credential", () => {
    const harness = makeMemoryHarness();
    harness.state.status = 429;
    harness.state.retryAfter = "17";
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const error = yield* Effect.flip(connections.create(createInput));
      const serialized = String(error);

      assert.equal(error._tag, "OnshapeRateLimitError");
      if (error._tag === "OnshapeRateLimitError") assert.equal(error.retryAfterSeconds, 17);
      assert.notInclude(serialized, OLD_ACCESS_KEY);
      assert.notInclude(serialized, OLD_SECRET_KEY);
      assert.equal(harness.state.requests.length, 1);
      assert.equal(harness.state.secrets.size, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("honors an upstream Retry-After without sending another request", () => {
    const harness = makeMemoryHarness();
    harness.state.status = 429;
    harness.state.retryAfter = "450";
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const first = yield* Effect.flip(connections.create(createInput));
      harness.state.status = 200;
      const second = yield* Effect.flip(connections.create({ ...createInput, name: "Second CAD" }));

      assert.equal(first._tag, "OnshapeRateLimitError");
      assert.equal(second._tag, "OnshapeRateLimitError");
      if (second._tag === "OnshapeRateLimitError") {
        assert.equal(second.retryAfterSeconds, 450);
      }
      assert.equal(harness.state.requests.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("maps authentication, annual-quota, server, and network failures safely", () =>
    Effect.gen(function* () {
      for (const [status, tag] of [
        [401, "OnshapeInvalidCredentialsError"],
        [403, "OnshapeInsufficientPermissionsError"],
        [402, "OnshapeAnnualQuotaExceededError"],
        [307, "OnshapeRedirectError"],
        [500, "OnshapeNetworkError"],
      ] as const) {
        const harness = makeMemoryHarness();
        harness.state.status = status;
        const error = yield* Effect.gen(function* () {
          const connections = yield* OnshapeConnections.OnshapeConnections;
          return yield* Effect.flip(connections.create(createInput));
        }).pipe(Effect.provide(harness.layer));
        assert.equal(error._tag, tag);
        assert.equal(harness.state.requests.length, 1);
        assert.notInclude(String(error), OLD_ACCESS_KEY);
        assert.notInclude(String(error), OLD_SECRET_KEY);
      }

      const harness = makeMemoryHarness();
      harness.state.failTransport = true;
      const networkError = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        return yield* Effect.flip(connections.create(createInput));
      }).pipe(Effect.provide(harness.layer));
      assert.equal(networkError._tag, "OnshapeNetworkError");
      assert.equal(harness.state.requests.length, 1);
    }),
  );

  it.effect("does not verify a duplicate local name", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      yield* connections.create(createInput);
      const error = yield* Effect.flip(connections.create({ ...createInput, name: "team cad" }));

      assert.equal(error._tag, "OnshapeConnectionConflictError");
      assert.equal(harness.state.requests.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("verifies every admitted save, including identical credentials", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      yield* connections.create(createInput);
      yield* connections.create({ ...createInput, name: "Practice CAD" });

      assert.equal(harness.state.requests.length, 2);
      assert.equal(harness.state.secrets.size, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("throttles verification attempts on the server after five requests per minute", () => {
    const harness = makeMemoryHarness();
    harness.state.status = 401;
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const error = yield* Effect.flip(connections.create(createInput));
        assert.equal(error._tag, "OnshapeInvalidCredentialsError");
      }
      const throttled = yield* Effect.flip(connections.create(createInput));

      assert.equal(throttled._tag, "OnshapeVerificationThrottledError");
      if (throttled._tag === "OnshapeVerificationThrottledError") {
        assert.equal(throttled.retryAfterSeconds, 60);
      }
      assert.equal(harness.state.requests.length, 5);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the previous credential when replacement verification fails", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const saved = yield* connections.create(createInput);
      const oldSecretEntry = Array.from(harness.state.secrets.entries())[0];
      assert.isDefined(oldSecretEntry);
      harness.state.status = 401;

      const error = yield* Effect.flip(
        connections.replaceCredentials({
          connectionId: saved.connectionId,
          host: "cad.onshape.com",
          accessKeyId: NEW_ACCESS_KEY,
          secretKey: NEW_SECRET_KEY,
        }),
      );
      const entries = Array.from(harness.state.secrets.entries());

      assert.equal(error._tag, "OnshapeInvalidCredentialsError");
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.[0], oldSecretEntry?.[0]);
      const stored = new TextDecoder().decode(entries[0]?.[1]);
      assert.include(stored, OLD_ACCESS_KEY);
      assert.include(stored, OLD_SECRET_KEY);
      assert.notInclude(stored, NEW_ACCESS_KEY);
      assert.notInclude(stored, NEW_SECRET_KEY);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("replaces corrupt credentials and removes missing credentials", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const saved = yield* connections.create(createInput);
      const oldSecretName = Array.from(harness.state.secrets.keys())[0];
      assert.isDefined(oldSecretName);
      harness.state.secrets.set(oldSecretName!, new TextEncoder().encode("not-json"));

      yield* connections.replaceCredentials({
        connectionId: saved.connectionId,
        host: "cad.onshape.com",
        accessKeyId: NEW_ACCESS_KEY,
        secretKey: NEW_SECRET_KEY,
      });
      harness.state.secrets.clear();
      yield* connections.remove({ connectionId: saved.connectionId });
      const listed = yield* connections.list();

      assert.equal(listed.connections.length, 0);
      assert.equal(harness.state.requests.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes a failed replacement candidate when the metadata swap fails", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const sql = yield* SqlClient.SqlClient;
      const saved = yield* connections.create(createInput);
      const oldSecretEntry = Array.from(harness.state.secrets.entries())[0];
      yield* sql`
        CREATE TRIGGER reject_onshape_connection_update
        BEFORE UPDATE ON onshape_connections
        BEGIN SELECT RAISE(FAIL, 'test failure'); END
      `;

      const error = yield* Effect.flip(
        connections.replaceCredentials({
          connectionId: saved.connectionId,
          host: "cad.onshape.com",
          accessKeyId: NEW_ACCESS_KEY,
          secretKey: NEW_SECRET_KEY,
        }),
      );
      const entries = Array.from(harness.state.secrets.entries());

      assert.equal(error._tag, "OnshapeConnectionPersistenceError");
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.[0], oldSecretEntry?.[0]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes a newly written secret when metadata creation fails", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TRIGGER reject_onshape_connection_insert
        BEFORE INSERT ON onshape_connections
        BEGIN SELECT RAISE(FAIL, 'test failure'); END
      `;

      const error = yield* Effect.flip(connections.create(createInput));

      assert.equal(error._tag, "OnshapeConnectionPersistenceError");
      assert.equal(harness.state.requests.length, 1);
      assert.equal(harness.state.secrets.size, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cleans up a credential immediately when creation is interrupted", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const written = yield* Deferred.make<void>();
      harness.state.blockCreateAfterWrite = true;
      harness.state.createWritten = written;
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const fiber = yield* connections.create(createInput).pipe(Effect.forkChild);
      yield* Deferred.await(written);
      yield* Fiber.interrupt(fiber);
      const sql = yield* SqlClient.SqlClient;
      const tracked = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM onshape_credential_blobs
      `;

      assert.equal(harness.state.secrets.size, 0);
      assert.equal(tracked[0]?.count, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes metadata and tracks cleanup when secret removal fails", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const saved = yield* connections.create(createInput);
      harness.state.failRemove = true;

      yield* connections.remove({ connectionId: saved.connectionId });
      const listed = yield* connections.list();
      const sql = yield* SqlClient.SqlClient;
      const tracked = yield* sql<{ readonly state: string }>`
        SELECT state FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;

      assert.equal(listed.connections.length, 0);
      assert.equal(harness.state.secrets.size, 1);
      assert.deepEqual(
        tracked.map((row) => row.state),
        ["cleanup_pending"],
      );

      harness.state.failRemove = false;
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const afterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;
      assert.equal(harness.state.secrets.size, 0);
      assert.equal(afterRetry[0]?.count, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps metadata and credentials when the removal transaction fails", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const sql = yield* SqlClient.SqlClient;
      const saved = yield* connections.create(createInput);
      yield* sql`
        CREATE TRIGGER reject_onshape_connection_delete
        BEFORE DELETE ON onshape_connections
        BEGIN SELECT RAISE(FAIL, 'test failure'); END
      `;

      const error = yield* Effect.flip(connections.remove({ connectionId: saved.connectionId }));
      const listed = yield* connections.list();

      assert.equal(error._tag, "OnshapeConnectionPersistenceError");
      assert.equal(listed.connections.length, 1);
      assert.equal(listed.connections[0]?.connectionId, saved.connectionId);
      assert.equal(harness.state.secrets.size, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("retains cleanup work when removal is interrupted after metadata commits", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const removeStarted = yield* Deferred.make<void>();
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const sql = yield* SqlClient.SqlClient;
      const saved = yield* connections.create(createInput);
      harness.state.blockRemove = true;
      harness.state.removeStarted = removeStarted;

      const fiber = yield* connections
        .remove({ connectionId: saved.connectionId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(removeStarted);
      yield* Fiber.interrupt(fiber);
      const listed = yield* connections.list();
      const tracked = yield* sql<{ readonly state: string }>`
        SELECT state FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;

      assert.equal(listed.connections.length, 0);
      assert.equal(harness.state.secrets.size, 1);
      assert.deepEqual(
        tracked.map((row) => row.state),
        ["cleanup_pending"],
      );

      harness.state.blockRemove = false;
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const afterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;
      assert.equal(harness.state.secrets.size, 0);
      assert.equal(afterRetry[0]?.count, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tracks failed superseded cleanup and removal deletes every revision", () => {
    const harness = makeMemoryHarness();
    return Effect.gen(function* () {
      const connections = yield* OnshapeConnections.OnshapeConnections;
      const sql = yield* SqlClient.SqlClient;
      const saved = yield* connections.create(createInput);
      harness.state.failRemove = true;

      yield* connections.replaceCredentials({
        connectionId: saved.connectionId,
        host: "cad.onshape.com",
        accessKeyId: NEW_ACCESS_KEY,
        secretKey: NEW_SECRET_KEY,
      });
      const trackedBefore = yield* sql<{ readonly state: string }>`
        SELECT state FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;
      assert.equal(harness.state.secrets.size, 2);
      assert.deepEqual(trackedBefore.map((row) => row.state).toSorted(), [
        "active",
        "cleanup_pending",
      ]);

      harness.state.failRemove = false;
      yield* connections.remove({ connectionId: saved.connectionId });
      const trackedAfter = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM onshape_credential_blobs
        WHERE connection_id = ${saved.connectionId}
      `;
      assert.equal(harness.state.secrets.size, 0);
      assert.equal(trackedAfter[0]?.count, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sweeps a tracked partial secret creation after restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cadsense-onshape-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const persistence = makeSqlitePersistenceLive(dbPath);
      const first = makeHarness(persistence);
      first.state.failCreateAfterWrite = true;
      first.state.failRemove = true;

      yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        const error = yield* Effect.flip(connections.create(createInput));
        const sql = yield* SqlClient.SqlClient;
        const tracked = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM onshape_credential_blobs
          WHERE state = 'cleanup_pending'
        `;
        assert.equal(error._tag, "OnshapeConnectionPersistenceError");
        assert.equal(first.state.secrets.size, 1);
        assert.equal(tracked[0]?.count, 1);
      }).pipe(Effect.provide(first.layer));

      first.state.failCreateAfterWrite = false;
      first.state.failRemove = false;
      const restarted = makeHarness(persistence, first.state);
      yield* Effect.gen(function* () {
        yield* OnshapeConnections.OnshapeConnections;
        const sql = yield* SqlClient.SqlClient;
        const tracked = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM onshape_credential_blobs
        `;
        assert.equal(first.state.secrets.size, 0);
        assert.equal(tracked[0]?.count, 0);
      }).pipe(Effect.provide(restarted.layer));
    }),
  );

  it.effect("persists non-secret metadata across a database restart", () => {
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cadsense-onshape-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const persistence = makeSqlitePersistenceLive(dbPath);
      const first = makeHarness(persistence);
      const saved = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        return yield* connections.create(createInput);
      }).pipe(Effect.provide(first.layer));

      const second = makeHarness(persistence);
      second.state.secrets.clear();
      for (const [name, bytes] of first.state.secrets) second.state.secrets.set(name, bytes);
      const listed = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        return yield* connections.list();
      }).pipe(Effect.provide(second.layer));

      assert.equal(listed.connections.length, 1);
      assert.equal(listed.connections[0]?.connectionId, saved.connectionId);
      assert.equal(listed.connections[0]?.name, createInput.name);
      assert.equal(listed.catalogUpdatedAt, saved.updatedAt);
      const rawDatabase = new TextDecoder().decode(yield* fileSystem.readFile(dbPath));
      assert.notInclude(rawDatabase, OLD_ACCESS_KEY);
      assert.notInclude(rawDatabase, OLD_SECRET_KEY);
    });
  });

  it.effect("persists an empty catalog's removal revision across restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cadsense-onshape-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const persistence = makeSqlitePersistenceLive(dbPath);
      const first = makeHarness(persistence);
      const removed = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        const saved = yield* connections.create(createInput);
        return yield* connections.remove({ connectionId: saved.connectionId });
      }).pipe(Effect.provide(first.layer));

      const restarted = makeHarness(persistence, first.state);
      const listed = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        return yield* connections.list();
      }).pipe(Effect.provide(restarted.layer));

      assert.deepEqual(listed.connections, []);
      assert.equal(listed.catalogUpdatedAt, removed.updatedAt);
    }),
  );

  it.effect("persists credentials through the real secret store across restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cadsense-onshape-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const persistence = makeSqlitePersistenceLive(dbPath);
      const configLayer = ServerConfig.layerTest(process.cwd(), tempDir);
      const transportLayer = Layer.succeed(
        OnshapeTransport.OnshapeTransport,
        OnshapeTransport.OnshapeTransport.of({
          execute: () => Effect.succeed({ status: 200, retryAfter: null }),
        }),
      );
      const makeLayer = () => {
        const dependencies = Layer.mergeAll(
          persistence,
          ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
          transportLayer,
          OnshapeRequestSigner.layer,
        );
        return Layer.mergeAll(
          dependencies,
          OnshapeConnections.layer.pipe(Layer.provide(dependencies)),
        );
      };

      const saved = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        return yield* connections.create(createInput);
      }).pipe(Effect.provide(makeLayer()));
      const serverConfig = yield* Effect.service(ServerConfig.ServerConfig).pipe(
        Effect.provide(configLayer),
      );
      const secretFiles = yield* fileSystem.readDirectory(serverConfig.secretsDir);
      assert.equal(secretFiles.length, 1);
      const secretFile = secretFiles[0];
      assert.isDefined(secretFile);
      const stored = yield* fileSystem.readFileString(
        path.join(serverConfig.secretsDir, secretFile!),
      );
      assert.include(stored, OLD_ACCESS_KEY);
      assert.include(stored, OLD_SECRET_KEY);

      const listed = yield* Effect.gen(function* () {
        const connections = yield* OnshapeConnections.OnshapeConnections;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const credential = yield* secretStore.get(secretFile!.replace(/\.bin$/, ""));
        assert.isTrue(Option.isSome(credential));
        return yield* connections.list();
      }).pipe(Effect.provide(makeLayer()));
      assert.equal(listed.connections[0]?.connectionId, saved.connectionId);

      for (const databaseFile of [dbPath, `${dbPath}-wal`]) {
        if (!(yield* fileSystem.exists(databaseFile))) continue;
        const raw = new TextDecoder().decode(yield* fileSystem.readFile(databaseFile));
        assert.notInclude(raw, OLD_ACCESS_KEY);
        assert.notInclude(raw, OLD_SECRET_KEY);
      }
    }),
  );
});
