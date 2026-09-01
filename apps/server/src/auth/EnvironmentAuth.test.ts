import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const makeConfigLayer = (desktopBootstrapToken: string | undefined) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) =>
      ServerConfig.make({ ...config, desktopBootstrapToken }),
    ),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-local-auth-test-" })),
  );

const makeAuthLayer = (desktopBootstrapToken: string | undefined) =>
  EnvironmentAuth.layer.pipe(Layer.provide(makeConfigLayer(desktopBootstrapToken)));

const makeRequest = (
  authorization?: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    headers: authorization === undefined ? {} : { authorization },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.layer(NodeServices.layer)("EnvironmentAuth", (it) => {
  it.effect("describes the fixed desktop-local authentication policy", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;

      expect(yield* auth.getDescriptor()).toEqual({
        policy: "desktop-managed-local",
        bootstrapMethods: ["desktop-bootstrap"],
        sessionMethods: ["bearer-access-token"],
      });
    }).pipe(Effect.provide(makeAuthLayer("desktop-token"))),
  );

  it.effect("requires the desktop bootstrap token when one is configured", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const missing = yield* auth.authenticateHttpRequest(makeRequest()).pipe(Effect.flip);
      const invalid = yield* auth
        .authenticateHttpRequest(makeRequest("Bearer wrong-token"))
        .pipe(Effect.flip);
      const session = yield* auth.authenticateHttpRequest(makeRequest("Bearer desktop-token"));

      expect(missing._tag).toBe("ServerAuthMissingCredentialError");
      expect(invalid._tag).toBe("ServerAuthInvalidCredentialError");
      expect(session.subject).toBe("desktop-local");
    }).pipe(Effect.provide(makeAuthLayer("desktop-token"))),
  );

  it.effect("exchanges only the configured desktop bootstrap credential", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const invalid = yield* auth
        .exchangeBootstrapCredentialForAccessToken("wrong-token")
        .pipe(Effect.flip);
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken("desktop-token");

      expect(invalid._tag).toBe("ServerAuthInvalidCredentialError");
      expect(token.access_token).toBe("desktop-token");
      expect(token.token_type).toBe("Bearer");
    }).pipe(Effect.provide(makeAuthLayer("desktop-token"))),
  );

  it.effect("allows the loopback development backend without a bootstrap envelope", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(makeRequest());

      expect(session.subject).toBe("desktop-local");
    }).pipe(Effect.provide(makeAuthLayer(undefined))),
  );
});
