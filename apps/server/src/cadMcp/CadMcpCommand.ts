import * as NodeOS from "node:os";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import { baseDirFlag, resolveServerConfig } from "../cli/config.ts";
import * as ServerConfig from "../config.ts";
import type { CadMcpStartupError } from "./CadMcpBackend.ts";
import { serveCadMcpStdio, type CadMcpCall } from "./CadMcpStdio.ts";
import { CAD_MCP_INSTRUCTIONS, cadMcpToolDefinitions } from "./CadMcpTools.ts";

const McpEnv = Config.all({
  home: Config.string("CADSENSE_MCP_HOME").pipe(Config.option),
  accessKeyId: Config.string("ONSHAPE_ACCESS_KEY").pipe(Config.option),
  secretKey: Config.redacted("ONSHAPE_SECRET_KEY").pipe(Config.option),
});

/**
 * `cadsense mcp`: a stdio MCP server that reviews Onshape CAD with no window. It runs the regular
 * backend on a random loopback port with its own data directory (`~/.cadsense-mcp` by default),
 * locked with a per-process credential, and renders captures in headless Chromium.
 *
 * Only light modules load before the stdio server starts. The backend loads next, so `initialize`
 * answers quickly even on a slow machine; Codex drops servers that take over 10 seconds.
 */
const runCadMcp = Effect.fn("runCadMcp")(function* (flags: {
  readonly baseDir: Option.Option<string>;
}) {
  // stdout carries only MCP messages. Loggers and libraries that print go to stderr.
  console.log = console.info = console.debug = console.error;
  const env = yield* McpEnv;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const home = Option.getOrElse(Option.firstSomeOf([flags.baseDir, env.home]), () =>
    path.join(NodeOS.homedir(), ".cadsense-mcp"),
  );
  const resolved = yield* resolveServerConfig(
    {
      port: Option.some(0),
      baseDir: Option.some(home),
      cwd: Option.none(),
      devUrl: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.some(false),
      logWebSocketEvents: Option.none(),
    },
    Option.none(),
  );
  const staticDir = resolved.staticDir ?? (yield* ServerConfig.resolveStaticDir());
  if (!staticDir)
    return yield* Effect.die(
      new Error(
        "The web build is missing, so CAD cannot render. Run `pnpm --filter @cadsense/web build`.",
      ),
    );
  const config: ServerConfig.ServerConfig["Service"] = {
    ...resolved,
    port: 0,
    devUrl: undefined,
    staticDir,
    // Only this process calls the backend, so every HTTP and WebSocket client must authenticate.
    desktopBootstrapToken: yield* crypto.randomUUIDv4,
    autoBootstrapProjectFromCwd: false,
  };
  let clientName = "MCP client";
  const ready = yield* Deferred.make<CadMcpCall, CadMcpStartupError>();
  yield* Effect.logInfo("Cadsense MCP starting", { home });
  // Closing stdin ends the session; interrupting the backend runs every finalizer.
  yield* Effect.raceFirst(
    serveCadMcpStdio({
      version: packageJson.version,
      instructions: CAD_MCP_INSTRUCTIONS,
      tools: cadMcpToolDefinitions,
      ready: Deferred.await(ready),
      onInitialize: (client) => {
        clientName = client.name;
      },
    }).pipe(Effect.scoped),
    Effect.promise(() => import("./CadMcpBackend.ts")).pipe(
      Effect.flatMap(({ runCadMcpBackend }) =>
        runCadMcpBackend({
          config,
          apiKey: Option.all({ accessKeyId: env.accessKeyId, secretKey: env.secretKey }),
          clientName: () => clientName,
          ready,
        }),
      ),
    ),
  );
});

export const cadMcpCommand = Command.make("mcp", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Run a stdio MCP server that reviews Onshape CAD without a window. Reads ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY.",
  ),
  Command.withHandler(runCadMcp),
);
