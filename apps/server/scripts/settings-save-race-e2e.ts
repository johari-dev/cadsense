// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check that a settings change made before an earlier save is answered builds on that
 * earlier change. Each save sends the whole `providerInstances` map, so a second change built from
 * settings the first has not reached yet silently undoes it.
 *
 * Starts the dev server and web app on a fresh data directory, drives headless Chromium, and holds
 * back the server's WebSocket replies like a slow connection would. With the replies held, it
 * turns Codex off and then Claude off in Settings > Providers. Evidence goes under --out:
 *
 *   NN-*.png        a screenshot after each step
 *   dev.log         dev runner, server, and web output
 *   settings.json   the server settings file after the run
 *   summary.json    each check with pass/fail and the values it compared
 *
 *   node apps/server/scripts/settings-save-race-e2e.ts --out .cadsense/settings-save-race-e2e/run
 *
 * Checks:
 *   - both switches read off right away, before the server has answered either save
 *   - once the replies arrive, the saved settings have both providers off
 *   - both switches still read off, and neither flipped back on while the answers arrived (a save's
 *     answer and the settings stream's update for it arrive in no fixed order)
 *
 * Both CLIs get empty config folders under --out (CODEX_HOME and CLAUDE_CONFIG_DIR), and every
 * CLAUDE_*, ANTHROPIC_*, CODEX_* and OPENAI_* variable is removed from the environment, so this
 * machine's real accounts are never read. No step needs an account or the network.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache. The codex and claude
 * CLIs must be on PATH: a provider's switch is disabled until its CLI is installed.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Usage: --out <dir>");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodePath.join(out, "home");
const settingsFile = NodePath.join(home, "userdata", "settings.json");

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)),
);
for (const [name, folder] of [
  ["CLAUDE_CONFIG_DIR", "claude-config"],
  ["CODEX_HOME", "codex-home"],
] as const) {
  env[name] = NodePath.join(out, folder);
  NodeFS.mkdirSync(env[name], { recursive: true });
}

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}
const summary: { checks: Check[]; steps: { name: string; observed?: unknown }[]; ok: boolean } = {
  checks: [],
  steps: [],
  ok: false,
};
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const check = (name: string, pass: boolean, detail: Record<string, unknown> = {}) => {
  summary.checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};

const log = NodeFS.openSync(NodePath.join(out, "dev.log"), "a");
const dev = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", home],
  { cwd: repo, stdio: ["ignore", log, log], detached: true, env },
);
const stopDev = () => {
  if (dev.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
};
process.on("exit", stopDev);

const waitFor = async <T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
) => {
  for (let attempt = 0; attempt < timeoutMs / 500; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const webPort = await waitFor("the dev runner's ports", () => {
  const match = /webPort=(\d+)/.exec(NodeFS.readFileSync(NodePath.join(out, "dev.log"), "utf8"));
  return match?.[1];
});
const url = `http://localhost:${webPort}/`;
await waitFor("the server and web app", async () => {
  const text = NodeFS.readFileSync(NodePath.join(out, "dev.log"), "utf8");
  if (!text.includes("Listening on")) return undefined;
  return fetch(url).then(
    (response) => (response.ok ? true : undefined),
    () => undefined,
  );
});

const browser = await chromium.launch(
  process.env.CADSENSE_CHROMIUM_PATH ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// Holds the app server's WebSocket replies while `holdServerReplies` is set, so a step can act
// before a save is answered, as on a slow connection.
let holdServerReplies = false;
const heldServerReplies: Array<() => void> = [];
await page.routeWebSocket(/\/ws(\?.*)?$/, (socket) => {
  const server = socket.connectToServer();
  server.onMessage((message) => {
    if (holdServerReplies) heldServerReplies.push(() => socket.send(message));
    else socket.send(message);
  });
});
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let shots = 0;
const run = async (name: string, action: (page: Page) => Promise<unknown>) => {
  const observed = await action(page).catch(async (error: unknown) => {
    await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
    throw error;
  });
  const index = String(++shots).padStart(2, "0");
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};

const providers = ["Codex", "Claude"] as const;
const toggle = (label: (typeof providers)[number]) =>
  page.getByRole("switch", { name: `Enable ${label}` });
const switchesOn = async () =>
  Object.fromEntries(
    await Promise.all(
      providers.map(
        async (label) =>
          [label, (await toggle(label).getAttribute("aria-checked")) === "true"] as const,
      ),
    ),
  );
/** Whether each provider is saved as enabled; a provider with no saved entry is on. */
const savedOn = () => {
  const saved = NodeFS.existsSync(settingsFile)
    ? (JSON.parse(NodeFS.readFileSync(settingsFile, "utf8")) as {
        providerInstances?: Record<string, { enabled?: boolean }>;
      })
    : {};
  return {
    Codex: saved.providerInstances?.codex?.enabled !== false,
    Claude: saved.providerInstances?.claudeAgent?.enabled !== false,
  };
};
const bothOff = (state: Record<string, boolean>) => !state.Codex && !state.Claude;

try {
  await run("both-on", async (page) => {
    await page.goto(`${url}?settings=providers`, { waitUntil: "networkidle" });
    // A switch stays disabled until the provider's first status check reports its CLI installed.
    for (const label of providers) {
      await waitFor(`the ${label} switch`, async () =>
        (await toggle(label)
          .isEnabled()
          .catch(() => false))
          ? true
          : undefined,
      );
    }
    return switchesOn();
  });

  let whileHeld: Record<string, boolean> = {};
  await run("both-turned-off-before-any-answer", async () => {
    holdServerReplies = true;
    await toggle("Codex").click();
    await toggle("Claude").click();
    await page.waitForTimeout(500);
    whileHeld = await switchesOn();
    return { switches: whileHeld, saved: savedOn() };
  });
  check("both switches read off before the server answers", bothOff(whileHeld), {
    switches: whileHeld,
  });

  let afterAnswers: Record<string, boolean> = {};
  let flips: string[] = [];
  await run("answers-arrived", async () => {
    // Record every change of a switch's state from here on. A string, since this package
    // typechecks without DOM types.
    await page.evaluate(`
      globalThis.__switchFlips = [];
      for (const element of document.querySelectorAll('[role="switch"]')) {
        new MutationObserver(() =>
          globalThis.__switchFlips.push(
            element.getAttribute("aria-label") + "=" + element.getAttribute("aria-checked"),
          ),
        ).observe(element, { attributes: true, attributeFilter: ["aria-checked"] });
      }
    `);
    holdServerReplies = false;
    for (const reply of heldServerReplies.splice(0)) reply();
    // The second save is only sent once the first is answered.
    await page.waitForTimeout(4_000);
    afterAnswers = await switchesOn();
    flips = (await page.evaluate("globalThis.__switchFlips")) as string[];
    return { switches: afterAnswers, saved: savedOn(), flips };
  });
  check("the saved settings have both providers off", bothOff(savedOn()), { saved: savedOn() });
  check("both switches still read off after the answers", bothOff(afterAnswers), {
    switches: afterAnswers,
  });
  check("neither switch flipped back on while the answers arrived", flips.length === 0, { flips });
  check("the page had no errors", pageErrors.length === 0, { pageErrors });
} finally {
  await browser.close();
  stopDev();
  if (NodeFS.existsSync(settingsFile)) {
    NodeFS.copyFileSync(settingsFile, NodePath.join(out, "settings.json"));
  }
  summary.ok = summary.checks.length > 0 && summary.checks.every((entry) => entry.pass);
  writeSummary();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
