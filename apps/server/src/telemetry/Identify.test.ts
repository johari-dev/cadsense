import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

const namespacedSha256 = (installationId: string) =>
  NodeCrypto.createHash("sha256").update(`cadsense:v1:${installationId}`, "utf8").digest("hex");

const testConfig = (prefix: string) => ServerConfig.layerTest(process.cwd(), { prefix });

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("hashes the persisted installation id with the Cadsense namespace", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(config.anonymousIdPath, "persisted-installation-id\n");

      assert.equal(
        yield* Identify.getTelemetryIdentifier,
        namespacedSha256("persisted-installation-id"),
      );
    }).pipe(Effect.provide(testConfig("cadsense-telemetry-identify-persisted-"))),
  );

  it.effect("never derives the id from provider account files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexAuthPath = path.join(config.baseDir, "home", ".codex", "auth.json");
      yield* fileSystem.makeDirectory(path.dirname(codexAuthPath), { recursive: true });
      yield* fileSystem.writeFileString(codexAuthPath, '{"tokens":{"account_id":"acct"}}');

      const identifier = yield* Identify.getTelemetryIdentifier;
      const installationId = yield* fileSystem.readFileString(config.anonymousIdPath);

      assert.equal(identifier, namespacedSha256(installationId));
      assert.notEqual(identifier, namespacedSha256("acct"));
    }).pipe(Effect.provide(testConfig("cadsense-telemetry-identify-providers-"))),
  );

  it.effect("starts a new, unlinked id after the old one is forgotten", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const first = yield* Identify.getTelemetryIdentifier;
      assert.equal(yield* Identify.getTelemetryIdentifier, first);

      yield* Identify.forgetTelemetryIdentity;
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
      // Forgetting an id that is already gone is a no-op, not an error.
      yield* Identify.forgetTelemetryIdentity;

      const second = yield* Identify.getTelemetryIdentifier;
      assert.isNotNull(second);
      assert.notEqual(second, first);
    }).pipe(Effect.provide(testConfig("cadsense-telemetry-identify-forget-"))),
  );
});
