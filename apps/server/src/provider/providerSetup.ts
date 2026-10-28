/**
 * One-click provider setup behind the providers settings page: install a
 * missing CLI, or run the CLI's own browser sign-in.
 *
 * Each driver supplies the exact commands for its instance through
 * `ServerProviderShape.setupCommands`, so sign-in runs with the same
 * environment (CODEX_HOME, CLAUDE_CONFIG_DIR) the instance reads credentials
 * from. After a command exits the runner re-probes the instance and returns
 * the fresh snapshots.
 *
 * @module providerSetup
 */
import {
  ServerProviderSetupError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSetupInput,
  type ServerProviderUpdatedPayload,
} from "@cadsense/contracts";
import { resolveSpawnCommand } from "@cadsense/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

export interface ProviderSetupCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /** Full environment for the child. Omit to inherit the server's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface ProviderSetupCommands {
  readonly install: ProviderSetupCommand;
  readonly signIn: ProviderSetupCommand;
}

/** Global npm install of a provider CLI package at its latest version. */
export function npmGlobalInstallCommand(packageName: string): ProviderSetupCommand {
  return {
    executable: "npm",
    // npm 12 blocks install scripts by default and still exits 0, so a
    // package whose postinstall finishes the install (claude copies its
    // native binary over a placeholder stub) would be left broken. Allow
    // this one package's scripts. Older npm warns about the flag and
    // continues.
    args: ["install", "-g", `--allow-scripts=${packageName}`, `${packageName}@latest`],
  };
}

const INSTALL_TIMEOUT = Duration.minutes(5);
// Sign-in waits for the user to finish in the browser.
const SIGN_IN_TIMEOUT = Duration.minutes(10);
const OUTPUT_MAX_BYTES = 10_000;
const FAILURE_OUTPUT_MAX_CHARS = 600;

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface ProviderSetupRunnerShape {
  readonly run: (
    input: ServerProviderSetupInput,
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderSetupError>;
}

export class ProviderSetupRunner extends Context.Service<
  ProviderSetupRunner,
  ProviderSetupRunnerShape
>()("@cadsense/server/provider/providerSetup/ProviderSetupRunner") {}

function outputTail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= FAILURE_OUTPUT_MAX_CHARS
    ? trimmed
    : `…${trimmed.slice(-FAILURE_OUTPUT_MAX_CHARS)}`;
}

export const make = Effect.fn("ProviderSetupRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Global npm installs share one prefix, so run them one at a time.
  const installLock = yield* Semaphore.make(1);
  // A new sign-in for an instance interrupts (and kills) the previous one.
  // Codex's login server holds a fixed port, and a user who closed the
  // browser tab should not have to wait out the old attempt.
  const signIns = yield* FiberMap.make<ProviderInstanceId, CommandResult | null, string>();

  /** Run a command to completion. Fails with a user-facing reason; `null` means timed out. */
  const runCommand = (command: ProviderSetupCommand, timeout: Duration.Duration) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(
        command.executable,
        command.args,
        command.env === undefined ? {} : { env: command.env },
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            shell: resolved.shell,
            ...(command.env === undefined ? {} : { env: command.env, extendEnv: false }),
          }),
        )
        .pipe(Effect.mapError((cause) => `Could not run ${command.executable}: ${cause.message}`));
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_MAX_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: OUTPUT_MAX_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => `${command.executable} failed: ${String(cause)}`));
      return {
        exitCode: Number(exitCode),
        output: [stderr.text, stdout.text].filter(Boolean).join("\n"),
      } satisfies CommandResult;
    }).pipe(Effect.scoped, Effect.timeoutOption(timeout), Effect.map(Option.getOrNull));

  const run: ProviderSetupRunnerShape["run"] = Effect.fn("ProviderSetupRunner.run")(
    function* (input) {
      const fail = (reason: string) =>
        new ServerProviderSetupError({
          instanceId: input.instanceId,
          action: input.action,
          reason,
        });
      const commands = yield* providerRegistry.getProviderSetupCommands(input.instanceId);
      if (commands === undefined) {
        return yield* fail("This provider is not running on the server.");
      }

      const result =
        input.action === "install"
          ? yield* installLock
              .withPermits(1)(runCommand(commands.install, INSTALL_TIMEOUT))
              .pipe(Effect.mapError(fail))
          : yield* FiberMap.run(
              signIns,
              input.instanceId,
              runCommand(commands.signIn, SIGN_IN_TIMEOUT),
            ).pipe(Effect.flatMap(Fiber.join), Effect.mapError(fail));
      const label = input.action === "install" ? "Install" : "Sign-in";
      if (result === null) {
        return yield* fail(`${label} timed out.`);
      }
      if (result.exitCode !== 0) {
        const tail = outputTail(result.output);
        return yield* fail(
          `${label} exited with code ${result.exitCode}.${tail ? `\n${tail}` : ""}`,
        );
      }

      const providers = yield* providerRegistry.refreshInstance(input.instanceId);
      const provider: ServerProvider | undefined = providers.find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (input.action === "install" && provider?.installed !== true) {
        return yield* fail(
          `Install finished, but cadsense still cannot find ${commands.signIn.executable} on PATH.`,
        );
      }
      if (input.action === "signIn" && provider?.auth.status === "unauthenticated") {
        return yield* fail("Sign-in finished, but the CLI still reports no signed-in account.");
      }
      return { providers };
    },
  );

  return ProviderSetupRunner.of({ run });
});

export const layer = Layer.effect(ProviderSetupRunner, make());
