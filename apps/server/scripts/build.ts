#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import {
  ServerBuildCommandExitError,
  ServerBuildDevelopmentIconSourceMissingError,
  ServerBuildDevelopmentIconTargetMissingError,
} from "./buildErrors.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("serverBuild.runCommand")(function* (
  command: ChildProcess.StandardCommand,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerBuildCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("serverBuild.applyDevelopmentIconOverrides")(
  function* (repoRoot: string, serverDir: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    for (const override of DEVELOPMENT_ICON_OVERRIDES) {
      const sourcePath = path.join(repoRoot, override.sourceRelativePath);
      const targetPath = path.join(serverDir, override.targetRelativePath);

      if (!(yield* fs.exists(sourcePath))) {
        return yield* new ServerBuildDevelopmentIconSourceMissingError({ sourcePath });
      }
      if (!(yield* fs.exists(targetPath))) {
        return yield* new ServerBuildDevelopmentIconTargetMissingError({ targetPath });
      }

      yield* fs.copyFile(sourcePath, targetPath);
    }

    yield* Effect.log("Applied development icon overrides to dist/client");
  },
);

const build = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (!(yield* fs.exists(webDist))) {
        yield* Effect.logWarning("Web dist not found; skipping the renderer bundle.");
        return;
      }

      yield* fs.copy(webDist, clientTarget);
      yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
      yield* Effect.log("Bundled the web renderer into dist/client");
    }),
).pipe(Command.withDescription("Build the desktop backend and bundle the web renderer."));

Command.run(Command.make("server-build").pipe(Command.withSubcommands([build])), {
  version: "0.0.0",
}).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
