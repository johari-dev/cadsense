import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@cadsense/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { sharedServerCommandFlags } from "./cli/config.ts";
import { isEntrypoint } from "./entrypoint.ts";
import { cadMcpCommand } from "./cadMcp/CadMcpCommand.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

export const makeCli = () =>
  Command.make("cadsense", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the local Cadsense desktop backend."),
    // Imported on use so `cadsense mcp` can answer before the server module graph loads.
    Command.withHandler((flags) =>
      Effect.promise(() => import("./cli/server.ts")).pipe(
        Effect.flatMap(({ runServerCommand }) => runServerCommand(flags)),
      ),
    ),
    Command.withSubcommands([cadMcpCommand]),
  );

export const cli = makeCli();

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
