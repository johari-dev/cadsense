// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of signing out of Codex and Claude, and back in, from Settings > Providers.
 * Starts the dev server and web app on a fresh data directory, drives headless Chromium, and keeps
 * the evidence under --out:
 *
 *   NN-*.png        a screenshot after each step
 *   dev.log         dev runner, server, and web output
 *   opened.log      every URL the CLIs tried to open in a browser
 *   summary.json    each check with pass/fail and the values it compared
 *
 *   node apps/server/scripts/provider-sign-out-e2e.ts --out .cadsense/provider-sign-out-e2e/run
 *
 * Both CLIs get throwaway credentials in their own folders under --out (CODEX_HOME and
 * CLAUDE_CONFIG_DIR), and every CLAUDE_*, ANTHROPIC_*, CODEX_* and OPENAI_* variable is removed
 * from the environment, so the run never signs this machine's real accounts out. Codex gets a fake
 * API key and Claude a fake OAuth token. Both CLIs report these as signed in without checking them
 * against the server, which is how a token the CLI can no longer refresh looks to the app too.
 * (A Claude token that already expired reads as signed out, so that row already offers Sign in.)
 * The server and CLIs get a proxy on a closed port, so Claude cannot reach Anthropic, find the fake
 * token rejected, and clear it before the test signs out. This also makes Claude's sign-out take the
 * slow path a user without network would see. No step needs the network.
 *
 * Browser launches go to a stub on PATH (and $BROWSER) that writes the URL to opened.log, so the
 * sign-in steps open nothing on the desktop. They stop at "waiting on the browser", since finishing
 * needs a real account.
 *
 * Checks:
 *   - each provider row offers Sign out while its CLI reports a signed-in account
 *   - Sign out removes that CLI's credential file, leaves the other provider's alone, and the row
 *     then reads "Not signed in." with a Sign in button
 *   - Sign in then starts the CLI's browser login for the right account
 *   - the real Codex and Claude credential files on this machine did not change
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache. The codex and claude
 * CLIs must be on PATH.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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
const codexHome = NodePath.join(out, "codex-home");
const claudeConfig = NodePath.join(out, "claude-config");
const shims = NodePath.join(out, "browser-stub");
const openedLog = NodePath.join(out, "opened.log");
const codexAuth = NodePath.join(codexHome, "auth.json");
const claudeCredentials = NodePath.join(claudeConfig, ".credentials.json");

// The real credential files, hashed before and after so the run can prove it left them alone.
const realCredentialFiles = [
  NodePath.join(process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"), "auth.json"),
  NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"),
    ".credentials.json",
  ),
];
const fingerprint = () =>
  realCredentialFiles.map((file) =>
    NodeFS.existsSync(file)
      ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
      : null,
  );
const realBefore = fingerprint();

// A clean environment: nothing that points a CLI at a real account or config folder.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)),
);
NodeFS.mkdirSync(shims, { recursive: true });
for (const name of ["xdg-open", "wslview", "sensible-browser", "x-www-browser", "open"]) {
  const stub = NodePath.join(shims, name);
  NodeFS.writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${openedLog}"\n`);
  NodeFS.chmodSync(stub, 0o755);
}
Object.assign(env, {
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeConfig,
  BROWSER: NodePath.join(shims, "xdg-open"),
  PATH: `${shims}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1,::1",
});

NodeFS.mkdirSync(codexHome, { recursive: true });
const codexLogin = NodeChildProcess.spawnSync("codex", ["login", "--with-api-key"], {
  env,
  input: "sk-cadsense-e2e-not-a-real-key\n",
  encoding: "utf8",
});
if (codexLogin.status !== 0 || !NodeFS.existsSync(codexAuth)) {
  throw new Error(`codex login --with-api-key failed: ${codexLogin.stderr}`);
}
NodeFS.mkdirSync(claudeConfig, { recursive: true });
NodeFS.writeFileSync(
  claudeCredentials,
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-cadsense-e2e-not-a-real-token",
      refreshToken: "sk-ant-ort01-cadsense-e2e-not-a-real-token",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
    },
  }),
);

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

/** The settings row for one provider: the deepest element holding its title and its switch. */
const row = (label: "Codex" | "Claude") =>
  page
    .locator("div")
    .filter({ hasText: label })
    .filter({ has: page.getByRole("switch", { name: `Enable ${label}` }) })
    .last();
const rowButton = (label: "Codex" | "Claude", name: string) =>
  row(label).getByRole("button", { name, exact: true });
const opened = () => (NodeFS.existsSync(openedLog) ? NodeFS.readFileSync(openedLog, "utf8") : "");

try {
  await run("signed-in", async (page) => {
    await page.goto(`${url}settings/providers`, { waitUntil: "networkidle" });
    // Probes can take a while on a cold start; wait for both rows to settle.
    await rowButton("Codex", "Sign out").waitFor({ timeout: 90_000 });
    await rowButton("Claude", "Sign out").waitFor({ timeout: 90_000 });
    return {
      codex: await row("Codex").innerText(),
      claude: await row("Claude").innerText(),
    };
  });
  check("Codex offers Sign out while it reports a signed-in account", true);
  check("Claude offers Sign out while it reports a signed-in account", true);

  await run("codex-signed-out", async () => {
    await rowButton("Codex", "Sign out").click();
    await row("Codex").getByText("Not signed in.").waitFor({ timeout: 60_000 });
    await rowButton("Codex", "Sign in").waitFor();
  });
  check("Codex sign-out removes its auth.json", !NodeFS.existsSync(codexAuth));
  check("Codex sign-out leaves Claude's credentials alone", NodeFS.existsSync(claudeCredentials));

  await run("claude-signed-out", async () => {
    await rowButton("Claude", "Sign out").click();
    // With no network, `claude auth logout` retries revoking the token for about 2.5 minutes.
    await row("Claude").getByText("Not signed in.").waitFor({ timeout: 240_000 });
    await rowButton("Claude", "Sign in").waitFor();
  });
  check("Claude sign-out removes its .credentials.json", !NodeFS.existsSync(claudeCredentials));

  await run("codex-sign-in-started", async () => {
    await rowButton("Codex", "Sign in").click();
    await row("Codex").getByText("Finish signing in to Codex in your browser.").waitFor();
    return waitFor("Codex to open its login page", () =>
      opened().includes("https://auth.openai.com/") ? true : undefined,
    );
  });
  check("Sign in after sign-out opens the OpenAI login", opened().includes("auth.openai.com"));

  await run("claude-sign-in-started", async () => {
    await rowButton("Claude", "Sign in").click();
    await row("Claude").getByText("Finish signing in to Claude in your browser.").waitFor();
    return waitFor("Claude to open its login page", () =>
      /https:\/\/claude\.(com|ai)\//.test(opened()) ? true : undefined,
    );
  });
  check("Sign in after sign-out opens the Claude login", /claude\.(com|ai)\//.test(opened()));

  check("the page had no errors", pageErrors.length === 0, { pageErrors });
} finally {
  await browser.close();
  stopDev();
  // Checked after the server stops, so a login it was still running cannot change the result.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const realAfter = fingerprint();
  check(
    "the real Codex and Claude credential files did not change",
    realAfter.every((hash, index) => hash === realBefore[index]),
    { files: realCredentialFiles, before: realBefore, after: realAfter },
  );
  summary.ok = summary.checks.length > 0 && summary.checks.every((entry) => entry.pass);
  writeSummary();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
