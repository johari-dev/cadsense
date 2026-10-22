// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
/**
 * Installs the official Codex CLI into the app's data folder, so people
 * without Node, npm, or a terminal can use Codex. The release is pinned per
 * platform with its size and SHA-256, so a changed or truncated download is
 * rejected before anything runs.
 *
 * @module provider/codexInstaller
 */
import * as NodeCrypto from "node:crypto";

import { resolveSpawnCommand } from "@cadsense/shared/shell";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export interface CodexRelease {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

const PINNED_VERSION = "0.163.0";
const pinned = (target: string, sha256: string, bytes: number): CodexRelease => ({
  version: PINNED_VERSION,
  target,
  url: `https://github.com/openai/codex/releases/download/rust-v${PINNED_VERSION}/codex-package-${target}.tar.gz`,
  sha256,
  bytes,
});

// Sizes and digests come from the GitHub release's asset metadata.
const CODEX_RELEASES: Partial<Record<string, CodexRelease>> = {
  "darwin-arm64": pinned(
    "aarch64-apple-darwin",
    "b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34",
    133_412_281,
  ),
  "darwin-x64": pinned(
    "x86_64-apple-darwin",
    "0c182d6194da7003943678dc87866b54b3dee719edaf8d092f304affbc6b57d1",
    144_982_749,
  ),
  "linux-arm64": pinned(
    "aarch64-unknown-linux-musl",
    "9d8ecf2d19d3e184877983902d6c85de48b3888dcb72c382a8a0c975845927fb",
    149_800_043,
  ),
  "linux-x64": pinned(
    "x86_64-unknown-linux-musl",
    "582646c6bf0561eb0de540f7fc85b9121b0091a826bc6e96830b7f1722122182",
    159_424_486,
  ),
  "win32-arm64": pinned(
    "aarch64-pc-windows-msvc",
    "6bbada389cd1ce26783e837fd9ba4711fb4542f432044f7955139e27e27acfde",
    150_223_371,
  ),
  "win32-x64": pinned(
    "x86_64-pc-windows-msvc",
    "901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522",
    162_230_206,
  ),
};

/** The pinned release for this computer, or null when OpenAI publishes none. */
export const codexReleaseFor = (platform: NodeJS.Platform, arch: string): CodexRelease | null =>
  CODEX_RELEASES[`${platform}-${arch}`] ?? null;

export class CodexInstallError extends Data.TaggedError("CodexInstallError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PackageManifest = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  version: Schema.String,
  target: Schema.String,
  entrypoint: Schema.String,
});
const InstallRecord = Schema.Struct({ sha256: Schema.String });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstallRecord));

const COMPLETE_MARKER = ".install-complete.json";
const MAX_ARCHIVE_ENTRIES = 10_000;
const COMMAND_OUTPUT_MAX_BYTES = 2_000_000;

/**
 * True when an archive member stays inside the extraction folder. GNU tar
 * lists members of a `-C dir .` archive with a leading `./`; that one prefix
 * is allowed.
 */
function isSafeArchiveEntry(entry: string): boolean {
  const name = entry.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (name === "" || name === ".") return entry === "./" || entry === ".";
  if (name.startsWith("/") || name.includes("\\")) return false;
  return name
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
}

/**
 * Bare `tar` on Windows can resolve to Git's MSYS tar, which reads `C:\...`
 * as a remote host, so the system copy is named by absolute path.
 */
function tarCommand(platform: NodeJS.Platform): string {
  if (platform !== "win32") return "tar";
  const systemRoot = process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

/**
 * Installs `release` into `<toolsDir>/codex/<version>` and returns the
 * executable path. A completed install of the same release is reused without
 * a download. Work happens in a hidden staging folder that is removed on any
 * failure, so a failed install leaves nothing behind.
 */
export const installCodex = Effect.fn("installCodex")(
  function* (input: {
    readonly toolsDir: string;
    readonly release: CodexRelease;
    readonly platform: NodeJS.Platform;
    readonly onProgress: (progress: {
      readonly completedBytes: number;
      readonly totalBytes: number;
    }) => Effect.Effect<void>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { release } = input;
    const executableName = input.platform === "win32" ? "codex.exe" : "codex";
    const codexDir = path.join(input.toolsDir, "codex");
    const destination = path.join(codexDir, release.version);
    const entrypoint = `bin/${executableName}`;
    const fail = (message: string) => Effect.fail(new CodexInstallError({ message }));

    const runCommand = Effect.fn("installCodex.runCommand")(function* (
      command: string,
      args: ReadonlyArray<string>,
    ) {
      const resolved = yield* resolveSpawnCommand(command, args);
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: COMMAND_OUTPUT_MAX_BYTES }),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.text, exitCode: Number(exitCode) };
    }, Effect.scoped);

    const completed = yield* fs
      .readFileString(path.join(destination, COMPLETE_MARKER))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);
    if (Option.isSome(completed) && completed.value.sha256 === release.sha256) {
      return path.join(destination, entrypoint);
    }

    yield* fs.makeDirectory(codexDir, { recursive: true });
    const staging = yield* fs.makeTempDirectoryScoped({ directory: codexDir, prefix: ".install-" });
    const archivePath = path.join(staging, "codex.tar.gz");
    const packageDir = path.join(staging, "package");

    const response = yield* http.execute(HttpClientRequest.get(release.url));
    if (response.status !== 200) {
      return yield* fail(`Could not download Codex (HTTP ${response.status}).`);
    }
    const hash = NodeCrypto.createHash("sha256");
    let completedBytes = 0;
    let reportedPercent = -1;
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          completedBytes += chunk.byteLength;
          if (completedBytes > release.bytes) {
            return yield* fail("The Codex download was larger than expected.");
          }
          hash.update(chunk);
          // One update per percent keeps snapshot pushes to about a hundred.
          const percent = Math.floor((completedBytes / release.bytes) * 100);
          if (percent !== reportedPercent) {
            reportedPercent = percent;
            yield* input.onProgress({ completedBytes, totalBytes: release.bytes });
          }
        }),
      ),
      Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
      Effect.timeout("30 minutes"),
    );
    if (completedBytes !== release.bytes || hash.digest("hex") !== release.sha256) {
      return yield* fail("The Codex download failed its size or checksum check.");
    }

    const tar = tarCommand(input.platform);
    const names = yield* runCommand(tar, ["-tzf", archivePath]);
    const details = yield* runCommand(tar, ["-tvzf", archivePath]);
    const entries = names.stdout.trim().split(/\r?\n/u);
    const types = details.stdout.trim().split(/\r?\n/u);
    if (
      names.exitCode !== 0 ||
      details.exitCode !== 0 ||
      entries.length > MAX_ARCHIVE_ENTRIES ||
      entries.length !== types.length ||
      types.some((line) => line[0] !== "-" && line[0] !== "d") ||
      !entries.every(isSafeArchiveEntry)
    ) {
      return yield* fail("The Codex archive contains unsafe entries.");
    }
    yield* fs.makeDirectory(packageDir);
    const extract = yield* runCommand(tar, ["-xzf", archivePath, "-C", packageDir]);
    if (extract.exitCode !== 0) {
      return yield* fail("Could not unpack the Codex download.");
    }

    const manifest = yield* fs
      .readFileString(path.join(packageDir, "codex-package.json"))
      .pipe(Effect.flatMap(decodeManifest), Effect.option);
    if (
      Option.isNone(manifest) ||
      manifest.value.version !== release.version ||
      manifest.value.target !== release.target ||
      manifest.value.entrypoint !== entrypoint
    ) {
      return yield* fail("The downloaded Codex package does not match the expected release.");
    }

    const version = yield* runCommand(path.join(packageDir, entrypoint), ["--version"]).pipe(
      Effect.timeout("90 seconds"),
    );
    if (version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${release.version}`) {
      return yield* fail("The downloaded Codex reports the wrong version.");
    }

    yield* fs.writeFileString(
      path.join(packageDir, COMPLETE_MARKER),
      yield* encodeRecord({ sha256: release.sha256 }),
      { flag: "wx", mode: 0o600 },
    );
    yield* fs.remove(destination, { recursive: true, force: true });
    // On Windows, Defender can briefly hold the just-run codex.exe open.
    yield* fs
      .rename(packageDir, destination)
      .pipe(
        input.platform === "win32"
          ? Effect.retry({ times: 10, schedule: Schedule.spaced("100 millis") })
          : (effect) => effect,
      );
    return path.join(destination, entrypoint);
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause instanceof CodexInstallError
      ? cause
      : new CodexInstallError({
          message: "Could not install Codex. Check your connection and disk space, then try again.",
          cause,
        }),
  ),
);
