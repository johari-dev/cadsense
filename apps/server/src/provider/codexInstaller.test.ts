// @effect-diagnostics nodeBuiltinImport:off
/**
 * Ways `installCodex` can fail, each covered below:
 *
 * 1. The download returns an error status. Nothing is installed.
 * 2. The download is larger than the pinned size. It stops early and nothing is installed.
 * 3. The download is the wrong size or fails the SHA-256 check. Nothing is installed.
 * 4. The archive holds an entry that escapes the install folder or is a link. Nothing is installed.
 * 5. The package manifest is missing or names a different version, target, or entrypoint.
 * 6. The extracted executable reports a different version.
 * 7. A completed install already exists. It is reused without a download.
 * 8. An incomplete folder from an earlier attempt exists. A fresh install replaces it.
 * 9. A good install reports progress up to the full size and returns a path inside the install folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { installCodex, type CodexRelease } from "./codexInstaller.ts";

const VERSION = "9.9.9";
const TARGET = "x86_64-unknown-linux-musl";

interface FakePackage {
  readonly manifest?: Record<string, unknown> | null;
  readonly reportedVersion?: string;
  readonly extraTarArgs?: ReadonlyArray<string>;
  readonly prepare?: (root: string) => void;
}

/** Builds a small Codex-shaped `.tar.gz` whose `bin/codex` prints a version. */
function buildPackage(input: FakePackage = {}): Buffer {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-pkg-"));
  NodeFS.mkdirSync(NodePath.join(root, "bin"));
  NodeFS.writeFileSync(
    NodePath.join(root, "bin", "codex"),
    `#!/bin/sh\necho "codex-cli ${input.reportedVersion ?? VERSION}"\n`,
    { mode: 0o755 },
  );
  if (input.manifest !== null) {
    NodeFS.writeFileSync(
      NodePath.join(root, "codex-package.json"),
      JSON.stringify(
        input.manifest ?? {
          layoutVersion: 1,
          version: VERSION,
          target: TARGET,
          entrypoint: "bin/codex",
        },
      ),
    );
  }
  input.prepare?.(root);
  const archive = NodePath.join(root, "..", `${NodePath.basename(root)}.tar.gz`);
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    archive,
    ...(input.extraTarArgs ?? []),
    "-C",
    root,
    ".",
  ]);
  const bytes = NodeFS.readFileSync(archive);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(archive, { force: true });
  return bytes;
}

const releaseFor = (bytes: Buffer, overrides: Partial<CodexRelease> = {}): CodexRelease => ({
  version: VERSION,
  target: TARGET,
  url: "https://example.test/codex.tar.gz",
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.byteLength,
  ...overrides,
});

const serve = (respond: () => Response) => {
  let requests = 0;
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests += 1;
        return HttpClientResponse.fromWeb(request, respond());
      }),
    ),
  );
  return { layer, requests: () => requests };
};

const makeToolsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-tools-"));

const run = (input: {
  readonly toolsDir: string;
  readonly release: CodexRelease;
  readonly http: Layer.Layer<HttpClient.HttpClient>;
  readonly progress?: Array<number>;
}) =>
  installCodex({
    toolsDir: input.toolsDir,
    release: input.release,
    platform: "linux",
    onProgress: (progress) =>
      Effect.sync(() => {
        input.progress?.push(progress.completedBytes);
      }),
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, input.http)));

const installedVersions = (toolsDir: string) => {
  const codexDir = NodePath.join(toolsDir, "codex");
  return NodeFS.existsSync(codexDir)
    ? NodeFS.readdirSync(codexDir).filter((entry) => !entry.startsWith("."))
    : [];
};

describe("installCodex", () => {
  it.live("installs a verified package and reports progress up to the full size", () =>
    Effect.gen(function* () {
      const bytes = buildPackage();
      const toolsDir = makeToolsDir();
      const progress: Array<number> = [];
      const executablePath = yield* run({
        toolsDir,
        release: releaseFor(bytes),
        http: serve(() => new Response(bytes)).layer,
        progress,
      });

      assert.strictEqual(executablePath, NodePath.join(toolsDir, "codex", VERSION, "bin", "codex"));
      assert.strictEqual(
        NodeChildProcess.execFileSync(executablePath).toString().trim(),
        `codex-cli ${VERSION}`,
      );
      assert.strictEqual(progress.at(-1), bytes.byteLength);
      assert.deepStrictEqual(
        progress,
        [...progress].sort((a, b) => a - b),
      );
    }),
  );

  it.live("reuses a completed install without downloading again", () =>
    Effect.gen(function* () {
      const bytes = buildPackage();
      const toolsDir = makeToolsDir();
      const release = releaseFor(bytes);
      yield* run({ toolsDir, release, http: serve(() => new Response(bytes)).layer });

      const second = serve(() => new Response(bytes));
      const executablePath = yield* run({ toolsDir, release, http: second.layer });
      assert.strictEqual(second.requests(), 0);
      assert.isTrue(NodeFS.existsSync(executablePath));
    }),
  );

  it.live("replaces an incomplete folder left by an earlier attempt", () =>
    Effect.gen(function* () {
      const bytes = buildPackage();
      const toolsDir = makeToolsDir();
      const leftover = NodePath.join(toolsDir, "codex", VERSION);
      NodeFS.mkdirSync(NodePath.join(leftover, "bin"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(leftover, "bin", "codex"), "partial");

      const http = serve(() => new Response(bytes));
      const executablePath = yield* run({ toolsDir, release: releaseFor(bytes), http: http.layer });
      assert.strictEqual(http.requests(), 1);
      assert.strictEqual(
        NodeChildProcess.execFileSync(executablePath).toString().trim(),
        `codex-cli ${VERSION}`,
      );
    }),
  );

  const expectNothingInstalled = (input: {
    readonly name: string;
    readonly bytes: Buffer;
    readonly release?: (bytes: Buffer) => CodexRelease;
    readonly respond?: (bytes: Buffer) => Response;
    readonly errorIncludes: string;
  }) =>
    it.live(input.name, () =>
      Effect.gen(function* () {
        const toolsDir = makeToolsDir();
        const error = yield* run({
          toolsDir,
          release: (input.release ?? releaseFor)(input.bytes),
          http: serve(() => (input.respond ?? ((bytes) => new Response(bytes)))(input.bytes)).layer,
        }).pipe(Effect.flip);
        assert.include(error.message, input.errorIncludes);
        assert.deepStrictEqual(installedVersions(toolsDir), []);
      }),
    );

  expectNothingInstalled({
    name: "fails on an error status",
    bytes: buildPackage(),
    respond: () => new Response("not found", { status: 404 }),
    errorIncludes: "download",
  });

  expectNothingInstalled({
    name: "stops when the download is larger than the pinned size",
    bytes: buildPackage(),
    release: (bytes) => releaseFor(bytes, { bytes: bytes.byteLength - 1 }),
    errorIncludes: "larger",
  });

  expectNothingInstalled({
    name: "fails the checksum check",
    bytes: buildPackage(),
    release: (bytes) => releaseFor(bytes, { sha256: "0".repeat(64) }),
    errorIncludes: "check",
  });

  expectNothingInstalled({
    name: "fails when the download is shorter than the pinned size",
    bytes: buildPackage(),
    release: (bytes) => releaseFor(bytes, { bytes: bytes.byteLength + 1 }),
    errorIncludes: "check",
  });

  expectNothingInstalled({
    name: "refuses an archive with a symbolic link",
    bytes: buildPackage({
      prepare: (root) => NodeFS.symlinkSync("/etc/passwd", NodePath.join(root, "bin", "link")),
    }),
    errorIncludes: "unsafe",
  });

  expectNothingInstalled({
    name: "refuses an archive with an entry outside the install folder",
    bytes: buildPackage({ extraTarArgs: ["--transform", "s,^\\./bin/codex$,../escape,"] }),
    errorIncludes: "unsafe",
  });

  expectNothingInstalled({
    name: "fails when the package manifest is missing",
    bytes: buildPackage({ manifest: null }),
    errorIncludes: "package",
  });

  expectNothingInstalled({
    name: "fails when the package manifest names another version",
    bytes: buildPackage({
      manifest: { layoutVersion: 1, version: "1.0.0", target: TARGET, entrypoint: "bin/codex" },
    }),
    errorIncludes: "package",
  });

  expectNothingInstalled({
    name: "fails when the executable reports another version",
    bytes: buildPackage({ reportedVersion: "1.0.0" }),
    errorIncludes: "version",
  });
});
