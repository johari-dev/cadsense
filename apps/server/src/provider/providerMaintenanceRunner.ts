import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@cadsense/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@cadsense/shared/hostProcess";
import { resolveSpawnCommand } from "@cadsense/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CodexInstallError, codexReleaseFor, installCodex } from "./codexInstaller.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/** True when `instanceId` names a Codex instance: an explicit Codex entry, or the default slot. */
function isCodexInstanceTarget(settings: ServerSettings, instanceId: ProviderInstanceId): boolean {
  const explicit = settings.providerInstances[instanceId];
  return explicit !== undefined
    ? explicit.driver === CODEX_DRIVER
    : instanceId === defaultInstanceIdForDriver(CODEX_DRIVER);
}
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
  /**
   * Install a missing provider CLI into the app's data folder and point the
   * instance at it. Only Codex is supported. Progress is published on the
   * snapshot's `installState`; the effect finishes once the rebuilt instance
   * reports the CLI as installed, or the install fails.
   */
  readonly installProvider: (target: {
    readonly provider: ProviderDriverKind;
    readonly instanceId?: ProviderInstanceId | undefined;
  }) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("@cadsense/server/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // Resolve the executable for the host platform before spawning. On
        // Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`),
        // which a bare ChildProcess.spawn cannot launch (spawn npm ENOENT);
        // resolveSpawnCommand finds the real `.cmd` and routes it through the
        // shell. On Linux/macOS (incl. the WSL backend) this is a no-op.
        const resolved = yield* resolveSpawnCommand(input.command, input.args);
        const child = yield* input.spawner
          .spawn(ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const runnerScope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const runMaintenanceCommand = (command: string, args: ReadonlyArray<string>) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const instanceIds: Array<ProviderInstanceId> = [];
        for (const candidate of providers) {
          if (candidate.driver === provider && candidate.instanceId === instanceId) {
            instanceIds.push(candidate.instanceId);
          }
        }
        return instanceIds;
      }),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers })));
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: "Updating provider.",
              }),
            );

            const result = yield* runMaintenanceCommand(update.executable, update.args);
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
              );
            }

            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              capabilities,
              instanceId,
            );
            const couldNotVerify = verifiedProviders.length === 0;
            const stillOutdated =
              couldNotVerify ||
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            return yield* finish(
              makeUpdateState({
                status: stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? "Update command completed, but cadsense could not verify the provider version."
                  : stillOutdated
                    ? "Update command completed, but cadsense still detects an outdated provider version."
                    : "Provider updated.",
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
            );
          },
        );

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  const installProvider: ProviderMaintenanceRunnerShape["installProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.installProvider",
  )(function* (target) {
    const provider = target.provider;
    const instanceId = target.instanceId ?? defaultInstanceIdForDriver(provider);
    const fail = (reason: string) => new ServerProviderUpdateError({ provider, reason });
    if (provider !== CODEX_DRIVER) {
      return yield* fail("Cadsense can only install Codex for you.");
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => fail("Could not read Cadsense settings.")),
    );
    if (!isCodexInstanceTarget(settings, instanceId)) {
      return yield* fail("This provider instance is not a Codex instance.");
    }
    const platform = yield* HostProcessPlatform;
    const release = codexReleaseFor(platform, yield* HostProcessArchitecture);
    if (release === null) {
      return yield* fail("OpenAI does not publish Codex for this computer.");
    }

    const setInstallState = (state: ServerProviderUpdateState) =>
      providerRegistry.setProviderMaintenanceActionState({ instanceId, action: "install", state });
    const runInstall = Effect.gen(function* () {
      const startedAt = yield* nowIso;
      const running = (progress: { completedBytes: number; totalBytes: number }) =>
        setInstallState({
          ...makeUpdateState({
            status: "running",
            startedAt,
            finishedAt: null,
            message: "Installing Codex.",
          }),
          progress,
        }).pipe(Effect.asVoid);
      const finish = (status: "succeeded" | "failed", message: string) =>
        Effect.flatMap(nowIso, (finishedAt) =>
          setInstallState(makeUpdateState({ status, startedAt, finishedAt, message })),
        ).pipe(Effect.map((providers) => ({ providers })));

      yield* running({ completedBytes: 0, totalBytes: release.bytes });
      return yield* Effect.gen(function* () {
        const binaryPath = yield* installCodex({
          toolsDir: path.join(serverConfig.baseDir, "tools"),
          release,
          platform,
          onProgress: running,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        if (!(yield* pointInstanceAtBinary(instanceId, binaryPath))) {
          return yield* fail("The Codex instance changed during the install.");
        }
        // The registry rebuilds the instance from settings in the background;
        // the new instance probes the binary on its own.
        yield* providerRegistry.getProviders.pipe(
          Effect.map((providers) =>
            providers.some(
              (candidate) =>
                candidate.instanceId === instanceId &&
                candidate.driver === CODEX_DRIVER &&
                candidate.installed,
            ),
          ),
          Effect.repeat({
            until: (installed) => installed,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () =>
              Effect.fail(fail("Codex was installed, but Cadsense could not start it.")),
          }),
        );
        return yield* finish("succeeded", "Codex installed.");
      }).pipe(
        Effect.catchCause((cause) => {
          const failure = Cause.squash(cause);
          return Effect.logWarning("Provider install failed", {
            provider,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.andThen(
              finish(
                "failed",
                isServerProviderUpdateError(failure)
                  ? failure.reason
                  : failure instanceof CodexInstallError
                    ? failure.message
                    : "Could not install Codex.",
              ),
            ),
          );
        }),
      );
    });

    // Fork into the runner's scope so a closed browser tab does not
    // interrupt a half-finished download.
    const install = yield* commandCoordinator
      .withCommandLock({
        targetKey: `instance:${instanceId}`,
        lockKey: "codex-install",
        run: runInstall,
      })
      .pipe(Effect.forkIn(runnerScope));
    return yield* Fiber.join(install);
  });

  /**
   * Store `binaryPath` on the instance's config. An explicit
   * `providerInstances` entry wins over the legacy `providers.codex` mirror,
   * matching how the instance registry reads them. The patch is built inside
   * the settings write lock, so a concurrent settings edit is not lost.
   * Resolves false when the instance stopped being a Codex instance.
   */
  const pointInstanceAtBinary = (instanceId: ProviderInstanceId, binaryPath: string) => {
    let patched = false;
    return serverSettings
      .updateSettings((settings): ServerSettingsPatch => {
        patched = isCodexInstanceTarget(settings, instanceId);
        if (!patched) return {};
        const explicit = settings.providerInstances[instanceId];
        if (explicit === undefined) return { providers: { codex: { binaryPath } } };
        const config =
          typeof explicit.config === "object" && explicit.config !== null ? explicit.config : {};
        return {
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: { ...explicit, config: { ...config, binaryPath } },
          },
        };
      })
      .pipe(Effect.map(() => patched));
  };

  return ProviderMaintenanceRunner.of({
    updateProvider,
    installProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
