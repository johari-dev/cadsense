// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * Shared harness for the end-to-end scripts next to this file (`*-e2e.ts`). A script parses its
 * flags with `parseE2eArgs` and hands its body to `runE2e`, which gives it:
 *
 *   - an isolated backend: `startDevApp` (the dev runner's server and web app) or `startServer`
 *     (`src/bin.ts` alone), each on a data directory of the script's choosing and free ports
 *   - Chromium, launched the way every script launches it (`launchChromium`)
 *   - `check` and `screenshotSteps`, recorded in <out>/summary.json as
 *     `{ checks, steps, ok, error? }`
 *
 * Whatever the run started is stopped when the body ends, even when it throws, in the reverse
 * order it was started. The run then writes summary.json and exits 0 only if the body did not
 * throw, every cleanup succeeded, and it recorded at least one check, all passing.
 *
 *   const { values, out } = parseE2eArgs("--out <dir> [--model <name>]", {
 *     model: { type: "string" },
 *   });
 *   await runE2e(out, async (run) => {
 *     const app = await run.startDevApp({ home: NodePath.join(out, "home") });
 *     const page = await (await run.launchChromium()).newPage();
 *     const step = run.screenshotSteps(page);
 *     await step("opened", (page) => page.goto(app.url));
 *     run.check("the page has a title", (await page.title()) !== "");
 *   });
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

/** The repository root. */
export const repo = NodePath.resolve(import.meta.dirname, "../../..");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `read` every `intervalMs` until it returns a value; undefined once `timeoutMs` passes. */
export const poll = async <T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() >= deadline) return value;
    await sleep(intervalMs);
  }
};

/** Like `poll`, but throws "Timed out waiting for <label>" instead of returning undefined. */
export const waitFor = async <T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
): Promise<T> => {
  const value = await poll(read, timeoutMs);
  if (value === undefined) throw new Error(`Timed out waiting for ${label}`);
  return value;
};

/**
 * Parses the command line: `--out <dir>` plus the script's own `options`. Throws `Usage: <usage>`
 * without --out, refuses an --out that already exists, and creates it.
 */
export const parseE2eArgs = <const Options extends NodeUtil.ParseArgsOptionsConfig>(
  usage: string,
  options: Options,
) => {
  const { values } = NodeUtil.parseArgs({ options: { ...options, out: { type: "string" } } });
  // `values` only gets its precise type at the call site, so narrow --out here by hand.
  const outArg = "out" in values ? values.out : undefined;
  if (typeof outArg !== "string" || outArg === "") throw new Error(`Usage: ${usage}`);
  const out = NodePath.resolve(outArg);
  if (NodeFS.existsSync(out))
    throw new Error(`${out} already exists. Use a fresh --out directory.`);
  NodeFS.mkdirSync(out, { recursive: true });
  return { values, out };
};

/**
 * process.env without any CLAUDE_*, ANTHROPIC_*, CODEX_* or OPENAI_* variable, and with Claude
 * Code and Codex pointed at empty config folders under `dir` (`claude-config`, `codex-home`), so
 * nothing the run starts reads this machine's real accounts or config.
 */
export const isolatedCliEnv = (dir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)),
  );
  env.CLAUDE_CONFIG_DIR = NodePath.join(dir, "claude-config");
  env.CODEX_HOME = NodePath.join(dir, "codex-home");
  NodeFS.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  NodeFS.mkdirSync(env.CODEX_HOME, { recursive: true });
  return env;
};

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}
export interface Step {
  readonly name: string;
  readonly ms: number;
  readonly observed?: unknown;
}
interface Summary {
  checks: Check[];
  steps: Step[];
  ok: boolean;
  /** What the body threw and any cleanup that failed, with stacks. */
  error?: string;
}

export interface DevAppOptions {
  /** The app's data directory, passed to the dev runner as --home-dir (its CADSENSE_HOME). */
  readonly home: string;
  /** Where the dev runner, server, and web app write. Default: <out>/dev.log. */
  readonly logPath?: string;
  /** The dev runner's environment. Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
}
export interface DevApp {
  /** The web app, at the port the dev runner picked. */
  readonly url: string;
  /** Stops the dev runner and everything it started. Safe to call more than once. */
  readonly stop: () => Promise<void>;
}

export interface ServerOptions {
  /** The server's data directory, passed as --base-dir. */
  readonly baseDir: string;
  readonly logPath: string;
  /** The server's environment. Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
}
export interface Server {
  readonly port: number;
  /** Stops the server. Safe to call more than once. */
  readonly stop: () => Promise<void>;
}

export interface E2eRun {
  /** Records a check and prints PASS or FAIL. */
  readonly check: (name: string, pass: boolean, detail?: Record<string, unknown>) => void;
  /** Runs `cleanup` when the run ends: after anything started later, before anything earlier. */
  readonly defer: (cleanup: () => unknown) => void;
  /** Starts the dev server and web app, and waits until the web app answers. */
  readonly startDevApp: (options: DevAppOptions) => Promise<DevApp>;
  /** Starts `src/bin.ts` on a free port, and waits until it logs "Listening on". */
  readonly startServer: (options: ServerOptions) => Promise<Server>;
  /** Headless Chromium from CADSENSE_CHROMIUM_PATH or Playwright's cache, rendering with SwiftShader. */
  readonly launchChromium: () => Promise<Browser>;
  /**
   * Returns `step(name, action)`: runs `action` on `page`, then saves NN-<name>.png and records the
   * step with its time and whatever `action` returned. A failing action saves failed-<name>.png
   * and rethrows.
   */
  readonly screenshotSteps: (
    page: Page,
  ) => (name: string, action: (page: Page) => Promise<unknown>) => Promise<void>;
}

const devRunner = NodePath.join(repo, "scripts/dev-runner.ts");
const serverBin = NodePath.join(repo, "apps/server/src/bin.ts");

/** Calls `stop` once, however many times the returned function is called. */
const once = (stop: () => Promise<void>) => {
  let stopping: Promise<void> | undefined;
  return () => (stopping ??= stop());
};

/** A port nothing is listening on; the server CLI rejects --port 0. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

/**
 * The environment a dev runner child gets: `env` without CADSENSE_PORT, which the dev runner
 * would take as a fixed server port and skip its free-port search. A shell inside another dev
 * app has it set.
 */
const devRunnerEnv = ({ CADSENSE_PORT: _port, ...env }: NodeJS.ProcessEnv) => env;

const describe = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

const exited = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

/** Sends SIGTERM to a process group, and SIGKILL if any of it is still running after 15 s. */
const stopProcessGroup = async (pid: number) => {
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) return;
  const gone = await poll(() => (signal(0) ? undefined : true), 15_000, 200);
  if (!gone) signal("SIGKILL");
};

/**
 * Runs one end-to-end script's `body` with the services above, then stops everything it started,
 * writes <out>/summary.json, and exits the process: 0 if every check passed, 1 otherwise.
 */
export const runE2e = async (out: string, body: (run: E2eRun) => Promise<void>): Promise<never> => {
  const summary: Summary = { checks: [], steps: [], ok: false };
  const cleanups: Array<() => unknown> = [];
  const defer = (cleanup: () => unknown) => {
    cleanups.push(cleanup);
  };
  const writeSummary = () =>
    NodeFS.writeFileSync(
      NodePath.join(out, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

  const run: E2eRun = {
    defer,
    check: (name, pass, detail = {}) => {
      summary.checks.push({ name, pass, detail });
      console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    },

    startDevApp: async ({ home, logPath = NodePath.join(out, "dev.log"), env = process.env }) => {
      const fd = NodeFS.openSync(logPath, "a");
      const child = NodeChildProcess.spawn(
        process.execPath,
        [devRunner, "dev", "--home-dir", home],
        // Its own process group, so stopping it also stops the server and web app it starts.
        { cwd: repo, stdio: ["ignore", fd, fd], detached: true, env: devRunnerEnv(env) },
      );
      NodeFS.closeSync(fd);
      const pid = child.pid;
      if (pid === undefined) throw new Error("The dev runner did not start");
      // If the script dies before cleanup runs, still take the dev runner down with it.
      const killOnExit = () => {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {}
      };
      process.on("exit", killOnExit);
      const stop = once(async () => {
        await stopProcessGroup(pid);
        process.off("exit", killOnExit);
      });
      defer(stop);

      const log = () => NodeFS.readFileSync(logPath, "utf8");
      // A dev runner that exits never gets ready, so stop waiting on it at once.
      const running = () => {
        if (exited(child))
          throw new Error(
            `The dev runner exited (${child.exitCode ?? child.signalCode}). See ${logPath}`,
          );
      };
      const webPort = await waitFor("the dev runner's ports", () => {
        running();
        return /webPort=(\d+)/.exec(log())?.[1];
      });
      const url = `http://localhost:${webPort}/`;
      await waitFor("the server and web app", async () => {
        running();
        if (!log().includes("Listening on")) return undefined;
        return fetch(url).then(
          (response) => (response.ok ? true : undefined),
          () => undefined,
        );
      });
      return { url, stop };
    },

    startServer: async ({ baseDir, logPath, env = process.env }) => {
      const port = await freePort();
      const log = NodeFS.createWriteStream(logPath);
      const child = NodeChildProcess.spawn(
        process.execPath,
        [serverBin, "--port", String(port), "--base-dir", baseDir],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const capture = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        log.write(chunk);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const stop = once(async () => {
        if (!exited(child)) {
          child.kill("SIGTERM");
          await Promise.race([childExit, sleep(15_000)]);
          if (!exited(child)) child.kill("SIGKILL");
        }
        await new Promise<void>((resolve) => log.end(resolve));
      });
      defer(stop);
      await waitFor(
        `the server to listen (see ${logPath})`,
        () => {
          if (exited(child))
            throw new Error(`The server exited (${child.exitCode}). See ${logPath}`);
          return output.includes("Listening on") ? true : undefined;
        },
        60_000,
      );
      return { port, stop };
    },

    launchChromium: async () => {
      const browser = await chromium.launch({
        ...(process.env.CADSENSE_CHROMIUM_PATH
          ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH }
          : {}),
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      });
      defer(() => browser.close());
      return browser;
    },

    screenshotSteps: (page) => {
      let shots = 0;
      return async (name, action) => {
        const started = Date.now();
        const observed = await action(page).catch(async (error: unknown) => {
          await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
          throw error;
        });
        const index = String(++shots).padStart(2, "0");
        await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
        summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
        writeSummary();
        console.log(`${index} ${name}`, observed ?? "");
      };
    },
  };

  const errors: string[] = [];
  try {
    await body(run);
  } catch (error) {
    console.error(error);
    errors.push(describe(error));
  }
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      console.error("Cleanup failed:", error);
      errors.push(`Cleanup failed: ${describe(error)}`);
    }
  }
  if (errors.length > 0) summary.error = errors.join("\n\n");
  const passed = summary.checks.filter((entry) => entry.pass).length;
  summary.ok =
    summary.error === undefined && summary.checks.length > 0 && passed === summary.checks.length;
  writeSummary();
  console.log(
    summary.ok
      ? `Passed ${passed}/${summary.checks.length} checks. Evidence in ${out}`
      : `Failed. See ${NodePath.join(out, "summary.json")}`,
  );
  process.exit(summary.ok ? 0 : 1);
};
