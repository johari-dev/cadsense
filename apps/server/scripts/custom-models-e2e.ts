// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of the custom models dialog in Settings > Providers. Claude Code is pointed at
 * a local gateway (Ollama) through a proxy that answers GET /v1/models with 404, like a gateway
 * that serves models it does not list. The picker then keeps the bundled Claude models, so the
 * only way to reach one of the gateway's models is to add it by name. Starts the dev server and web app on a fresh data directory with a brand-new
 * Claude config directory, drives headless Chromium, and keeps the evidence under --out:
 *
 *   NN-*.png              a screenshot after each step
 *   dev.log               dev runner, server, and web output
 *   gateway-requests.log  every request Claude Code sent the gateway: method, path, model, status
 *   settings.json         the server settings file after the run
 *   summary.json          each check with pass/fail and the values it compared
 *
 *   node apps/server/scripts/custom-models-e2e.ts --out .cadsense/custom-models-e2e/run \
 *     [--gateway http://127.0.0.1:11434] [--model qwen3:0.6b]
 *
 * --gateway is an Ollama-compatible endpoint serving Anthropic's /v1/messages (default: Ollama on
 * its usual port), and --model a model it serves (default: the first it lists). Claude Code reaches
 * it through a logging proxy, set up the way Ollama's guide does: ANTHROPIC_BASE_URL in the new
 * config directory's settings.json and ANTHROPIC_AUTH_TOKEN=ollama in the environment.
 *
 * Checks: "⋯" > "Custom models…" on the Claude row opens the dialog; a name is added and saved in
 * providerInstances.claudeAgent.config.customModels; a name the picker already lists is refused;
 * the model then shows in the Claude tab of the composer's picker and a turn on it reaches the
 * gateway; removing it takes it out of the picker again; two removals clicked in the same tick,
 * before the first save comes back, both stick.
 *
 * Every CLAUDE_*, ANTHROPIC_*, CODEX_* and OPENAI_* variable is removed from the environment, and
 * Codex gets an empty CODEX_HOME, so this machine's real accounts and config are never read. The
 * real Claude settings and credentials are hashed before and after to prove it.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache. `claude` must be on
 * PATH and the gateway must already have at least one model.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: { out: { type: "string" }, gateway: { type: "string" }, model: { type: "string" } },
});
if (!values.out) throw new Error("Usage: --out <dir> [--gateway <url>] [--model <id>]");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });
const gateway = new URL(values.gateway ?? "http://127.0.0.1:11434");
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodePath.join(out, "home");
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

// The real Claude files, hashed before and after so the run can prove it left them alone.
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
const realFiles = ["settings.json", ".credentials.json"].map((name) =>
  NodePath.join(realClaudeDir, name),
);
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
const customModel = values.model ?? gatewayModels[0];
if (!customModel) throw new Error(`${gateway.href} lists no models. Pull one first.`);

/**
 * Forwards everything to the gateway, except the model list, and logs each request's model and
 * response status.
 */
const proxy = NodeHttp.createServer((request, response) => {
  if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
    NodeFS.appendFileSync(requestLog, `GET ${request.url} model=- status=404 (hidden)\n`);
    response.writeHead(404).end();
    return;
  }
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
NodeFS.mkdirSync(codexHome, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(claudeConfig, "settings.json"),
  `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl } }, null, 2)}\n`,
);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)),
);
Object.assign(env, {
  CLAUDE_CONFIG_DIR: claudeConfig,
  CODEX_HOME: codexHome,
  ANTHROPIC_AUTH_TOKEN: "ollama",
});

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}
const summary: {
  gateway: string;
  customModel: string;
  checks: Check[];
  steps: { name: string; observed?: unknown }[];
  ok: boolean;
} = { gateway: gateway.href, customModel, checks: [], steps: [], ok: false };
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

/** The server's settings file, wherever the dev runner put it under the fresh home. */
const settingsFile = () => {
  const stack = [home];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === "settings.json") return path;
    }
  }
  return undefined;
};
const savedCustomModels = (): unknown => {
  const file = settingsFile();
  if (!file) return undefined;
  const settings = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    providerInstances?: Record<string, { config?: { customModels?: unknown } }>;
  };
  return settings.providerInstances?.claudeAgent?.config?.customModels;
};

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
const customModelsDialog = page.getByRole("dialog", { name: "Claude custom models" });
const modelInput = customModelsDialog.getByRole("textbox", { name: "Model name" });
const composer = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first();
const pickerRows = page.locator("[data-model-picker-row]");

/** Open Settings > Providers and the Claude row's custom models dialog. */
const openCustomModels = async (page: Page) => {
  await page.goto(`${url}?settings=providers`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "More Claude settings" }).click({ timeout: 60_000 });
  await page.getByRole("menuitem", { name: "Custom models…" }).click();
  await customModelsDialog.waitFor();
};
/** Model names in the Claude tab of the composer's picker. */
const claudePickerModels = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page
    .locator('[data-chat-composer-form="true"] button')
    .filter({ hasText: /\S/ })
    .first()
    .click();
  await page
    .getByRole("tablist", { name: "Model sources" })
    .getByRole("tab", { name: "Claude", exact: true })
    .click();
  await pickerRows.first().waitFor({ timeout: 10_000 });
  // A row reads "<model name>" then its shortcut hint, one per line.
  return (await pickerRows.allInnerTexts()).map((text) => text.trim().split("\n")[0]!);
};
const requests = () =>
  NodeFS.existsSync(requestLog) ? NodeFS.readFileSync(requestLog, "utf8") : "";

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
  const projectUrl = page.url();

  let before: string[] = [];
  await run("picker-before", async (page) => {
    // Wait for Claude's check: until then the tab may be missing or unavailable.
    before = await waitFor(
      "the Claude tab",
      () => claudePickerModels(page).catch(() => undefined),
      180_000,
    );
    return { rows: before };
  });
  check(
    `the picker does not list ${customModel} before it is added`,
    !before.includes(customModel),
    {
      rows: before,
    },
  );

  await run("provider-menu", async (page) => {
    await page.goto(`${url}?settings=providers`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More Claude settings" }).click({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Custom models…" }).waitFor();
  });
  await run("custom-models-dialog", async () => {
    await page.getByRole("menuitem", { name: "Custom models…" }).click();
    await customModelsDialog.waitFor();
    return { text: await customModelsDialog.innerText() };
  });

  await run("custom-model-added", async () => {
    await modelInput.fill(customModel);
    await modelInput.press("Enter");
    await customModelsDialog.getByRole("button", { name: `Remove ${customModel}` }).waitFor();
    return { saved: await waitFor("the setting to save", () => savedCustomModels() ?? undefined) };
  });
  check(
    "the added model is saved in providerInstances.claudeAgent.config.customModels",
    JSON.stringify(savedCustomModels()) === JSON.stringify([customModel]),
    { saved: savedCustomModels() },
  );

  // A Claude slug the picker already lists: the first one in the bundled model manifest.
  const listedModel = /"slug":\s*"(claude-[^"]+)"/.exec(
    NodeFS.readFileSync(
      NodePath.join(repo, "apps/server/src/provider/model-manifest.json"),
      "utf8",
    ),
  )?.[1];
  if (!listedModel) throw new Error("No Claude model in the bundled manifest");
  await run("listed-model-refused", async () => {
    await modelInput.fill(listedModel);
    await modelInput.press("Enter");
    return { alert: await customModelsDialog.getByRole("alert").innerText() };
  });
  check(
    `a model the picker already lists (${listedModel}) is refused`,
    JSON.stringify(savedCustomModels()) === JSON.stringify([customModel]),
    { saved: savedCustomModels() },
  );

  let after: string[] = [];
  await run("picker-after-add", async (page) => {
    await customModelsDialog.getByRole("button", { name: "Done" }).click();
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    after = await waitFor(
      "the custom model in the picker",
      async () => {
        const rows = await claudePickerModels(page).catch(() => undefined);
        return rows?.includes(customModel) ? rows : undefined;
      },
      60_000,
    );
    return { rows: after };
  });
  check(`the Claude tab lists ${customModel} after it is added`, after.includes(customModel), {
    rows: after,
  });

  await run("turn-on-custom-model", async (page) => {
    await pickerRows.filter({ hasText: customModel }).first().click();
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
    return { requests: requests().trim().split("\n") };
  });
  check(
    `the turn reached the gateway asking for ${customModel}`,
    requests()
      .split("\n")
      .some(
        (line) =>
          line.startsWith("POST /v1/messages") && line.includes(`model=${customModel} status=200`),
      ),
    { requests: requests().trim().split("\n") },
  );

  let afterRemove: string[] = [];
  await run("custom-model-removed", async (page) => {
    await openCustomModels(page);
    await customModelsDialog.getByRole("button", { name: `Remove ${customModel}` }).click();
    await customModelsDialog.getByText("No custom models yet.").waitFor();
    await customModelsDialog.getByRole("button", { name: "Done" }).click();
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    afterRemove = await waitFor(
      "the custom model to leave the picker",
      async () => {
        const rows = await claudePickerModels(page).catch(() => undefined);
        return rows && !rows.includes(customModel) ? rows : undefined;
      },
      60_000,
    );
    return { rows: afterRemove, saved: savedCustomModels() };
  });
  check(
    `removing ${customModel} takes it out of the saved settings and the picker`,
    JSON.stringify(savedCustomModels()) === "[]" && !afterRemove.includes(customModel),
    { saved: savedCustomModels(), rows: afterRemove },
  );
  await run("rapid-removals", async (page) => {
    await openCustomModels(page);
    for (const slug of ["rapid-a", "rapid-b"]) {
      await modelInput.fill(slug);
      await modelInput.press("Enter");
      await customModelsDialog.getByRole("button", { name: `Remove ${slug}` }).waitFor();
    }
    await waitFor("both names to save", () =>
      JSON.stringify(savedCustomModels()) === '["rapid-a","rapid-b"]' ? true : undefined,
    );
    // Both clicks run before either save is acknowledged, like a fast double removal.
    await customModelsDialog.evaluate((dialog) => {
      for (const button of dialog.querySelectorAll('button[aria-label^="Remove "]')) {
        button.click();
      }
    });
    await page.waitForTimeout(3_000);
    return { saved: savedCustomModels(), dialog: await customModelsDialog.innerText() };
  });
  check(
    "two removals clicked before the first save is acknowledged both stick",
    JSON.stringify(savedCustomModels()) === "[]",
    { saved: savedCustomModels() },
  );
  check("the page had no errors", pageErrors.length === 0, { pageErrors });
} finally {
  await browser.close();
  stopDev();
  proxy.close();
  const file = settingsFile();
  if (file) NodeFS.copyFileSync(file, NodePath.join(out, "settings.json"));
  const realAfter = fingerprint();
  check(
    "the real Claude settings and credentials did not change",
    realAfter.every((hash, index) => hash === realBefore[index]),
    { files: realFiles, before: realBefore, after: realAfter },
  );
  summary.ok = summary.checks.length > 0 && summary.checks.every((entry) => entry.pass);
  writeSummary();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
