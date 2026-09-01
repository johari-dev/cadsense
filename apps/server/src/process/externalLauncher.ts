import {
  FileManagerSpawnError,
  type FileManagerError,
  type FileManagerRevealKind,
  type OpenInFileManagerInput,
} from "@cadsense/contracts";
import { HostProcessPlatform } from "@cadsense/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@cadsense/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

interface FileManagerLaunch {
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const LaunchEnvironment = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.string("WSL_INTEROP").pipe(Config.option),
}).pipe(
  Config.map(
    (input): NodeJS.ProcessEnv =>
      Object.fromEntries(
        Object.entries(input).flatMap(([key, value]) =>
          Option.match(value, {
            onNone: () => [],
            onSome: (resolved) => [[key, resolved]],
          }),
        ),
      ),
  ),
);

const readLaunchEnvironment = LaunchEnvironment.pipe(Effect.orElseSucceed(() => ({})));

function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return (
    platform === "linux" && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined)
  );
}

function windowsExplorerPath(env: NodeJS.ProcessEnv): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\explorer.exe`;
}

function wslExplorerTarget(target: string, distroName: string | undefined): string {
  if (!distroName?.trim()) return target;
  const relative = target.replace(/^\/+/, "").replaceAll("/", "\\");
  return `\\\\wsl.localhost\\${distroName}${relative.length > 0 ? `\\${relative}` : ""}`;
}

export function buildFileManagerLaunch(
  input: OpenInFileManagerInput,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): FileManagerLaunch {
  if (platform === "darwin") {
    return {
      target: input.cwd,
      command: "open",
      args: input.reveal === true ? ["-R", input.cwd] : [input.cwd],
    };
  }

  if (platform === "win32") {
    return {
      target: input.cwd,
      command: windowsExplorerPath(env),
      args: input.reveal === true ? ["/select,", input.cwd] : [input.cwd],
    };
  }

  if (isWsl(platform, env)) {
    const target = wslExplorerTarget(input.cwd, env.WSL_DISTRO_NAME);
    return {
      target,
      command: "explorer.exe",
      args: input.reveal === true ? ["/select,", target] : [target],
    };
  }

  return {
    target: input.cwd,
    command: "xdg-open",
    args: [input.cwd],
  };
}

function fileManagerRevealKind(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): FileManagerRevealKind {
  if (platform === "darwin") return "finder";
  if (platform === "win32" || isWsl(platform, env)) return "file-explorer";
  return "files";
}

export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveFileManagerRevealKind: () => Effect.Effect<FileManagerRevealKind | undefined>;
    readonly openInFileManager: (
      input: OpenInFileManagerInput,
    ) => Effect.Effect<void, FileManagerError>;
  }
>()("@cadsense/server/process/externalLauncher") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const withCommandServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const resolveFileManagerRevealKind = Effect.gen(function* () {
    const env = yield* readLaunchEnvironment;
    const launch = buildFileManagerLaunch({ cwd: "." }, platform, env);
    const available = yield* withCommandServices(isCommandAvailable(launch.command, { env }));
    return available ? fileManagerRevealKind(platform, env) : undefined;
  });

  const openInFileManager = Effect.fn("externalLauncher.openInFileManager")(function* (
    input: OpenInFileManagerInput,
  ) {
    const env = yield* readLaunchEnvironment;
    const launch = buildFileManagerLaunch(input, platform, env);
    const resolved = yield* withCommandServices(
      resolveSpawnCommand(launch.command, launch.args, { env }),
    );
    const command = ChildProcess.make(resolved.command, resolved.args, {
      detached: true,
      shell: resolved.shell,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    yield* spawner.spawn(command).pipe(
      Effect.flatMap((handle) => handle.unref),
      Effect.asVoid,
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new FileManagerSpawnError({
            target: launch.target,
            command: resolved.command,
            args: resolved.args,
            cause,
          }),
      ),
    );
  });

  return ExternalLauncher.of({
    resolveFileManagerRevealKind: () => resolveFileManagerRevealKind,
    openInFileManager,
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
