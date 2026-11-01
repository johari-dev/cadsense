/**
 * One-click provider setup behind onboarding and the providers settings
 * page: install a missing CLI, or run the CLI's own browser sign-in.
 *
 * Each driver supplies the exact commands for its instance through
 * `ServerProviderShape.setupCommands`, so sign-in runs with the same
 * environment (CODEX_HOME, CLAUDE_CONFIG_DIR) the instance reads credentials
 * from. While a command runs, and after it fails, the registry publishes its
 * state on the instance's snapshot. After a command succeeds the runner
 * re-probes the instance and returns the fresh snapshots. Each finished attempt
 * counts toward usage analytics as an ok or failed install or sign-in.
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
import { CommandResolutionCache, resolveSpawnCommand } from "@cadsense/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
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

/**
 * A vendor's standalone install script. Each one downloads a native binary,
 * so installing needs no Node or npm, only the shell the OS already has.
 */
export interface InstallScript {
  /** macOS and Linux: fetched with curl and piped into `shell`. */
  readonly posix: { readonly url: string; readonly shell: "sh" | "bash" };
  /** Windows: run in PowerShell with `irm <url> | iex`. */
  readonly windowsUrl: string;
  /** Full environment for the script. Omit to inherit the server's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** The command that runs a vendor install script on `platform`. */
export function installScriptCommand(
  platform: NodeJS.Platform,
  script: InstallScript,
): ProviderSetupCommand {
  if (platform === "win32") {
    return {
      executable: "powershell",
      // -NonInteractive makes a stray Read-Host fail instead of hanging.
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `irm ${script.windowsUrl} | iex`,
      ],
      env: script.env,
    };
  }
  return {
    executable: "bash",
    // pipefail turns a failed download into a failed install, not an empty
    // script that exits 0. The URL goes in as $1 so it needs no quoting.
    args: [
      "-c",
      `set -o pipefail; curl -fsSL "$1" | ${script.posix.shell}`,
      "bash",
      script.posix.url,
    ],
    env: script.env,
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
  const analytics = yield* AnalyticsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Installers write shared folders such as ~/.local/bin, so run one at a time.
  const installLock = yield* Semaphore.make(1);
  // A new sign-in for an instance interrupts (and kills) the previous one.
  // Codex's login server holds a fixed port, and a user who closed the
  // browser tab should not have to wait out the old attempt.
  const signIns = yield* FiberMap.make<
    ProviderInstanceId,
    ReadonlyArray<ServerProvider>,
    ServerProviderSetupError
  >();
  // A repeat Install for an instance (say, after the page reloaded mid-install)
  // joins the install already running instead of queuing a second one.
  const installs = yield* FiberMap.make<
    ProviderInstanceId,
    ReadonlyArray<ServerProvider>,
    ServerProviderSetupError
  >();

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

  /**
   * Runs one setup action to the end and records its state on the registry.
   * It runs in a fiber the runner owns, so a closed browser tab does not stop
   * a half-finished download or leave the state stuck on "running". An
   * attempt interrupted by a newer one records nothing; the newer one owns
   * the state.
   */
  const perform = (input: ServerProviderSetupInput, commands: ProviderSetupCommands) =>
    Effect.gen(function* () {
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const running = providerRegistry.setSetupState(input.instanceId, {
        action: input.action,
        status: "running",
        startedAt,
      });
      const fail = (reason: string) =>
        analytics
          .count(
            input.action === "install" ? "provider_installs_failed" : "provider_signins_failed",
          )
          .pipe(
            Effect.andThen(
              providerRegistry.setSetupState(input.instanceId, {
                action: input.action,
                status: "failed",
                startedAt,
                reason,
              }),
            ),
            Effect.andThen(
              Effect.fail(
                new ServerProviderSetupError({
                  instanceId: input.instanceId,
                  action: input.action,
                  reason,
                }),
              ),
            ),
          );

      yield* running;
      const label = input.action === "install" ? "Install" : "Sign-in";
      const command = input.action === "install" ? commands.install : commands.signIn;
      const timeout = input.action === "install" ? INSTALL_TIMEOUT : SIGN_IN_TIMEOUT;
      const result = yield* runCommand(command, timeout).pipe(Effect.result);
      const commandFailure =
        result._tag === "Failure"
          ? result.failure
          : result.success === null
            ? input.action === "signIn"
              ? `Sign-in timed out after ${Duration.toMinutes(SIGN_IN_TIMEOUT)} minutes.`
              : `${label} timed out.`
            : result.success.exitCode !== 0
              ? `${label} exited with code ${result.success.exitCode}.${
                  outputTail(result.success.output) ? `\n${outputTail(result.success.output)}` : ""
                }`
              : null;
      if (commandFailure !== null) {
        // A sign-in that ends badly may still have signed the account in,
        // for example when the browser finished but the CLI was stopped.
        // The CLI's own account check decides.
        const signedIn =
          input.action === "signIn" &&
          (yield* providerRegistry.refreshInstance(input.instanceId)).some(
            (provider) =>
              provider.instanceId === input.instanceId && provider.auth.status === "authenticated",
          );
        if (!signedIn) return yield* fail(commandFailure);
      }

      if (input.action === "install") {
        // PATH lookups remember "not found" for 30s. Forget that so the
        // re-probe sees the binary the installer just wrote.
        (yield* CommandResolutionCache).clear();
      }
      const providers = yield* providerRegistry.refreshInstance(input.instanceId);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      if (input.action === "install" && provider?.installed !== true) {
        return yield* fail(
          `Install finished, but cadsense still cannot find ${commands.signIn.executable} on PATH.`,
        );
      }
      if (input.action === "signIn" && provider?.auth.status === "unauthenticated") {
        return yield* fail("Sign-in finished, but the CLI still reports no signed-in account.");
      }
      yield* providerRegistry.setSetupState(input.instanceId, null);
      // A probe that timed out reads "unknown"; only a confirmed account counts as signed in.
      if (input.action === "install") yield* analytics.count("provider_installs_ok");
      else if (provider?.auth.status === "authenticated")
        yield* analytics.count("provider_signins_ok");
      return yield* providerRegistry.getProviders;
    });

  const run: ProviderSetupRunnerShape["run"] = Effect.fn("ProviderSetupRunner.run")(
    function* (input) {
      const commands = yield* providerRegistry.getProviderSetupCommands(input.instanceId);
      if (commands === undefined) {
        return yield* new ServerProviderSetupError({
          instanceId: input.instanceId,
          action: input.action,
          reason: "This provider is not running on the server.",
        });
      }
      const fiber =
        input.action === "install"
          ? yield* Option.match(FiberMap.getUnsafe(installs, input.instanceId), {
              onSome: Effect.succeed,
              onNone: () =>
                FiberMap.run(
                  installs,
                  input.instanceId,
                  installLock.withPermits(1)(perform(input, commands)),
                ),
            })
          : yield* FiberMap.run(signIns, input.instanceId, perform(input, commands));
      return { providers: yield* Fiber.join(fiber) };
    },
  );

  return ProviderSetupRunner.of({ run });
});

export const layer = Layer.effect(ProviderSetupRunner, make());
