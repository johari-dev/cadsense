// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check that Claude Code and Codex pointed at a local gateway (Ollama, LM Studio,
 * LiteLLM...) put the gateway's own models in the picker, and that a turn on one of them reaches
 * the gateway. Starts the dev server and web app on a fresh data directory with brand-new Claude
 * and Codex config directories, drives headless Chromium, and keeps the evidence under --out:
 *
 *   NN-*.png              a screenshot after each step
 *   dev.log               dev runner, server, and web output
 *   gateway-models.json   what the gateway's GET /v1/models returned
 *   gateway-requests.log  every request either CLI sent the gateway: method, path, model, status
 *   summary.json          each check with pass/fail and the values it compared
 *
 *   node apps/server/scripts/gateway-models-e2e.ts --out .cadsense/gateway-e2e/run \
 *     [--gateway http://127.0.0.1:11434] [--model qwen3:0.6b] [--codex-config builtin|custom]
 *
 * --gateway is an Ollama-compatible endpoint serving both Anthropic's /v1/messages and OpenAI's
 * /v1/responses (default: Ollama on its usual port), and --model the one to run turns with
 * (default: the first the gateway lists). Both CLIs reach it through a logging proxy, set up the
 * way Ollama's guides do:
 *
 *   Claude  ANTHROPIC_BASE_URL in the new config directory's settings.json, and
 *           ANTHROPIC_AUTH_TOKEN=ollama in the environment.
 *   Codex   model_provider = "ollama" in config.toml (what `codex --oss` uses), with
 *           CODEX_OSS_PORT pointing at the proxy. --codex-config custom instead declares a
 *           [model_providers.local] entry whose base_url is the proxy.
 *
 * Thread titles are generated with the "Text generation model" setting, which defaults to
 * DEFAULT_TEXT_GENERATION_MODEL on Codex. A fresh install keeps that default, so those requests
 * still ask the gateway for it and fail. They are recorded but not counted against the turns.
 *
 * Every CLAUDE_*, ANTHROPIC_*, CODEX_* and OPENAI_* variable is removed from the environment
 * first, so this machine's real accounts and config are never read. The real Claude and Codex
 * settings and credentials are hashed before and after to prove it.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache. `claude` and `codex`
 * must be on PATH and the gateway must already have at least one model.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { DEFAULT_TEXT_GENERATION_MODEL } from "@cadsense/contracts";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    gateway: { type: "string" },
    model: { type: "string" },
    "codex-config": { type: "string" },
  },
});
if (!values.out) {
  throw new Error(
    "Usage: --out <dir> [--gateway <url>] [--model <id>] [--codex-config builtin|custom]",
  );
}
const codexConfigKind = values["codex-config"] ?? "builtin";
if (codexConfigKind !== "builtin" && codexConfigKind !== "custom") {
  throw new Error("--codex-config must be builtin or custom");
}
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });
const gateway = new URL(values.gateway ?? "http://127.0.0.1:11434");
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const claudeConfig = NodePath.join(out, "claude-config");
const codexHome = NodePath.join(out, "codex-home");
const requestLog = NodePath.join(out, "gateway-requests.log");
const stepName = "exports/dm1-id-214.stp";
const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports"), { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);

// The real config and credential files, hashed before and after so the run can prove it left
// them alone.
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
const realCodexDir = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
const realFiles = [
  NodePath.join(realClaudeDir, "settings.json"),
  NodePath.join(realClaudeDir, ".credentials.json"),
  NodePath.join(realCodexDir, "config.toml"),
  NodePath.join(realCodexDir, "auth.json"),
];
const fingerprint = () =>
  realFiles.map((file) =>
    NodeFS.existsSync(file)
      ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
      : null,
  );
const realBefore = fingerprint();

const gatewayModels = await fetch(new URL("/v1/models", gateway))
  .then((response) => response.json() as Promise<{ data: Array<{ id: string }> }>)
  .then((body) => body.data.map((entry) => entry.id));
NodeFS.writeFileSync(
  NodePath.join(out, "gateway-models.json"),
  `${JSON.stringify(gatewayModels, null, 2)}\n`,
);
const turnModel = values.model ?? gatewayModels[0];
if (!turnModel) throw new Error(`${gateway.href} lists no models. Pull one first.`);

/** Forwards everything to the gateway and logs each request's model and response status. */
const proxy = NodeHttp.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    let model = "-";
    try {
      model = (JSON.parse(body.toString("utf8")) as { model?: string }).model ?? "-";
    } catch {}
    const upstream = NodeHttp.request(
      new URL(request.url ?? "/", gateway),
      { method: request.method, headers: { ...request.headers, host: gateway.host } },
      (upstreamResponse) => {
        NodeFS.appendFileSync(
          requestLog,
          `${request.method} ${request.url} model=${model} status=${upstreamResponse.statusCode}\n`,
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      NodeFS.appendFileSync(
        requestLog,
        `${request.method} ${request.url} error=${error.message}\n`,
      );
      response.destroy();
    });
    upstream.end(body);
  });
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Proxy did not bind");
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

NodeFS.mkdirSync(claudeConfig, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(claudeConfig, "settings.json"),
  `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl } }, null, 2)}\n`,
);
NodeFS.mkdirSync(codexHome, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(codexHome, "config.toml"),
  codexConfigKind === "builtin"
    ? `model_provider = "ollama"\nmodel = "${turnModel}"\n`
    : [
        `model_provider = "local"`,
        `model = "${turnModel}"`,
        ``,
        `[model_providers.local]`,
        `name = "Local gateway"`,
        `base_url = "${proxyUrl}/v1"`,
        ``,
      ].join("\n"),
);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)),
);
Object.assign(env, {
  CLAUDE_CONFIG_DIR: claudeConfig,
  CODEX_HOME: codexHome,
  ANTHROPIC_AUTH_TOKEN: "ollama",
  ...(codexConfigKind === "builtin" ? { CODEX_OSS_PORT: String(proxyAddress.port) } : {}),
});

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}
const summary: {
  gateway: string;
  proxy: string;
  turnModel: string;
  codexConfig: string;
  checks: Check[];
  steps: { name: string; observed?: unknown }[];
  ok: boolean;
} = {
  gateway: gateway.href,
  proxy: proxyUrl,
  turnModel,
  codexConfig: codexConfigKind,
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
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", NodePath.join(out, "home")],
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

const browser = await chromium.launch({
  ...(process.env.CADSENSE_CHROMIUM_PATH
    ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH }
    : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let shots = 0;
const run = async (name: string, action: (page: Page) => Promise<unknown>) => {
  const observed = await action(page).catch(async (error: unknown) => {
    await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
    throw error;
  });
  const index = String(++shots).padStart(2, "0");
  await page.waitForTimeout(400);
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};

const addProjectDialog = page.getByRole("dialog", {
  name: /^(Add project|New (CAD|Onshape) project)$/,
});
const composer = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first();
const pickerRows = page.locator("[data-model-picker-row]");
const requests = () =>
  NodeFS.existsSync(requestLog) ? NodeFS.readFileSync(requestLog, "utf8") : "";

/** Open the composer's model picker on `tab` and return its model names once they settle. */
const pickerModelsOn = (page: Page, tab: "Claude" | "Codex") =>
  waitFor(
    `the ${tab} tab to list the gateway's models`,
    async () => {
      await page.keyboard.press("Escape");
      await page
        .locator('[data-chat-composer-form="true"] button')
        .filter({ hasText: /\S/ })
        .first()
        .click();
      const tabButton = page
        .getByRole("tablist", { name: "Model sources" })
        .getByRole("tab", { name: tab, exact: true });
      if (!(await tabButton.isVisible())) return undefined;
      await tabButton.click();
      await pickerRows.first().waitFor({ timeout: 5_000 });
      // A row reads "<model name>" then its shortcut hint, one per line.
      const rows = (await pickerRows.allInnerTexts()).map((text) => text.trim().split("\n")[0]!);
      // The first snapshot is the built-in list; wait for the probe that asks the gateway.
      return rows.some((row) => gatewayModels.includes(row)) ? rows : undefined;
    },
    180_000,
  );

/** Pick `turnModel` in the open picker and send one short message, waiting for the reply. */
const runTurn = async (page: Page) => {
  await pickerRows.filter({ hasText: turnModel }).first().click();
  const stop = page.getByRole("button", { name: "Stop generation" });
  // A message can't start a turn while the project's first import runs, so keep sending.
  const deadline = Date.now() + 5 * 60_000;
  while (!(await stop.isVisible())) {
    if (Date.now() > deadline) throw new Error("Sending never started a turn");
    if (!(await composer.innerText()).trim()) {
      await composer.click();
      await page.keyboard.type("Reply with the single word: pong");
    }
    await page.getByRole("button", { name: "Send message" }).click();
    await stop.waitFor({ timeout: 5_000 }).catch(() => {});
  }
  await stop.waitFor({ state: "detached", timeout: 5 * 60_000 });
};
const requestsTo = (path: string) =>
  requests()
    .split("\n")
    .filter((line) => line.startsWith(`POST ${path}`));

try {
  await run("project-created", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await addProjectDialog.getByRole("button", { name: "CAD file" }).click();
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await addProjectDialog.waitFor({ state: "detached" });
  });

  for (const tab of ["Claude", "Codex"] as const) {
    let pickerModels: string[] = [];
    await run(`${tab.toLowerCase()}-picker`, async (page) => {
      pickerModels = await pickerModelsOn(page, tab);
      return { rows: pickerModels };
    });
    check(
      `the ${tab} tab lists every model the gateway lists`,
      gatewayModels.every((id) => pickerModels.includes(id)),
      { gatewayModels, pickerModels },
    );
    check(
      `the ${tab} tab lists no built-in models the gateway does not serve`,
      pickerModels.every((row) => gatewayModels.includes(row)),
      { pickerModels },
    );
  }

  await run("claude-turn", async (page) => {
    await pickerModelsOn(page, "Claude");
    await runTurn(page);
    return { requests: requestsTo("/v1/messages") };
  });
  await run("codex-turn", async (page) => {
    await page
      .getByRole("button", { name: /^New thread in / })
      .first()
      .click({ force: true });
    await pickerModelsOn(page, "Codex");
    await runTurn(page);
    return { requests: requestsTo("/v1/responses") };
  });
  for (const [cli, path] of [
    ["Claude", "/v1/messages"],
    ["Codex", "/v1/responses"],
  ] as const) {
    const turnRequests = requestsTo(path);
    check(
      `the ${cli} turn reached the gateway asking for ${turnModel}`,
      turnRequests.some((line) => line.includes(`model=${turnModel} status=200`)),
      { turnRequests },
    );
    const titleModel = `model=${DEFAULT_TEXT_GENERATION_MODEL} `;
    check(
      `no ${cli} request asked the gateway for a built-in model, besides title generation`,
      !turnRequests.some((line) => /model=(claude-|gpt-)/.test(line) && !line.includes(titleModel)),
      {
        turnRequests,
        titleGenerationRequests: turnRequests.filter((line) => line.includes(titleModel)),
      },
    );
  }
  check("the page had no errors", pageErrors.length === 0, { pageErrors });
} finally {
  await browser.close();
  stopDev();
  proxy.close();
  const realAfter = fingerprint();
  check(
    "the real Claude and Codex config and credentials did not change",
    realAfter.every((hash, index) => hash === realBefore[index]),
    { files: realFiles, before: realBefore, after: realAfter },
  );
  summary.ok = summary.checks.length > 0 && summary.checks.every((entry) => entry.pass);
  writeSummary();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
