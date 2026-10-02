// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of local CAD projects through the real app. Starts the dev server and web app on
 * a fresh data directory, then drives headless Chromium through the whole flow and keeps the
 * evidence under --out:
 *
 *   bracket-rig/         the project folder: the STEP file, an older export, and a corrupt file
 *   NN-*.png             a screenshot after each step
 *   dev.log              dev runner, server, and web output
 *   summary.json         step timings and what each step observed
 *
 *   node apps/server/scripts/local-cad-project-e2e.ts --out .cadsense/local-cad-e2e/run \
 *     [--step path/to/assembly.step] [--ask "How many bolts?" --model "Opus 5.5"]
 *
 * --step defaults to the dm1 fixture in src/localCad/testFixtures. --ask sends one prompt in a new
 * chat with the model the picker's search finds for --model, and keeps the answer in
 * agent-answer.txt. It runs a real agent turn, so it needs that provider signed in and costs tokens.
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache and renders with
 * SwiftShader.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    step: { type: "string" },
    ask: { type: "string" },
    model: { type: "string" },
  },
});
if (!values.out || (values.ask !== undefined && !values.model))
  throw new Error("Usage: --out <dir> [--step <file.step>] [--ask <prompt> --model <name>]");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const step = NodePath.resolve(
  values.step ?? NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
);
const stepName = `exports/${NodePath.basename(step)}`;

const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports/old"), { recursive: true });
NodeFS.copyFileSync(step, NodePath.join(folder, stepName));
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, "exports/old/previous.step"),
);
NodeFS.writeFileSync(NodePath.join(folder, "exports/old/corrupt.step"), "ISO-10303-21;\nbroken\n");
NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "# Not CAD, so not listed\n");

const summary: { steps: { name: string; ms: number; observed?: unknown }[]; ok: boolean } = {
  steps: [],
  ok: false,
};
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const log = NodeFS.openSync(NodePath.join(out, "dev.log"), "a");
const dev = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", NodePath.join(out, "home")],
  { cwd: repo, stdio: ["ignore", log, log], detached: true },
);
const stopDev = () => {
  if (dev.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
};
process.on("exit", stopDev);

const waitFor = async <T>(label: string, read: () => T | undefined | Promise<T | undefined>) => {
  for (let attempt = 0; attempt < 240; attempt++) {
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
  const started = Date.now();
  const observed = await action(page);
  const index = String(++shots).padStart(2, "0");
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};
const panel = page.getByRole("region", { name: "CAD panel" });
const manifestDir = NodePath.join(out, "home/userdata/cad/manifests");
const manifests = () => NodeFS.readdirSync(manifestDir).filter((name) => name.endsWith(".json"));
const componentCount = async () =>
  Number(
    (await panel.getByText("Components").locator("..").innerText()).match(/(\d+)\s*$/)?.[1] ?? 0,
  );

try {
  await run("add-project", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Local CAD file" }).click();
  });
  await run("folder-scanned", async (page) => {
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).waitFor({ timeout: 30_000 });
    const form = page.getByRole("form", { name: "Create local CAD project" });
    return {
      listed: (await form.locator("label").allInnerTexts()).map((text) => text.split("\n")[0]),
    };
  });
  // Start from the corrupt export, so the panel has to recover through its file prompt.
  await run("corrupt-file-chosen", (page) =>
    page.getByText("exports/old/corrupt.step", { exact: true }).click(),
  );
  await run("project-created", async (page) => {
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "detached" });
    return { url: page.url() };
  });
  await run("cad-panel-import-failed", async (page) => {
    await page.getByRole("button", { name: "Toggle right panel" }).click();
    await page.getByText("Review this project's CAD.").click();
    await panel.getByText(/Could not read this CAD file/).waitFor({ timeout: 120_000 });
    return { prompt: (await panel.innerText()).split("\n").filter(Boolean) };
  });
  await run("cad-panel-file-menu", async (page) => {
    // A browser has no native file dialog, so the button lists the folder's CAD files.
    await panel.getByRole("button", { name: "Pick a file" }).click();
    await page.getByRole("menuitem", { name: stepName }).waitFor();
    return { listed: await page.getByRole("menuitem").allInnerTexts() };
  });
  await run("cad-panel-model", async (page) => {
    await page.getByRole("menuitem", { name: stepName }).click();
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    return { title: (await panel.innerText()).split("\n")[0], components: await componentCount() };
  });
  await run("re-exported-and-synced", async (page) => {
    // A new export of the same model: different bytes, same structure.
    const file = NodePath.join(folder, stepName);
    NodeFS.writeFileSync(
      file,
      NodeFS.readFileSync(file, "utf8").replace("FILE_NAME(", "FILE_NAME( /* re-export */ "),
    );
    const before = new Set(manifests());
    await panel.getByRole("button", { name: "Sync" }).click();
    // The import can finish before "Importing…" renders, so watch the snapshot store instead.
    const created = await waitFor("the re-imported snapshot", () =>
      manifests().find((name) => !before.has(name)),
    );
    await panel.getByRole("button", { name: "Sync" }).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    const revision = (name: string) =>
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(manifestDir, name), "utf8")) as {
          root: { microversionId: string };
        }
      ).root.microversionId;
    return {
      components: await componentCount(),
      revisions: [...before].map(revision).concat(revision(created)),
    };
  });
  await run("project-settings", async (page) => {
    // The settings icon sits under the row until the row is hovered.
    const settings = page.getByRole("button", { name: /^Project settings for / }).first();
    await settings.hover({ force: true });
    await settings.click({ force: true });
    await page.getByText("CAD file", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    const section = page.getByText("Rescan folder").locator("xpath=ancestor::section[1]");
    return { text: (await section.innerText()).split("\n").slice(0, 12) };
  });
  const { ask, model } = values;
  if (ask !== undefined && model !== undefined)
    await run("agent-answer", async (page) => {
      await page.goto(url, { waitUntil: "networkidle" });
      await page
        .getByRole("button", { name: /^New thread in / })
        .first()
        .click({ force: true });
      // The model picker is the composer's first button; it has no label of its own.
      await page.locator('[data-chat-composer-form="true"] button').first().click();
      await page.getByPlaceholder("Search models...").fill(model);
      await page.getByRole("option").first().click();
      await page.locator('[contenteditable="true"]').first().click();
      await page.keyboard.type(ask);
      await page.getByRole("button", { name: "Send message" }).click();
      const stop = page.getByRole("button", { name: "Stop generation" });
      await stop.waitFor({ timeout: 60_000 });
      await stop.waitFor({ state: "detached", timeout: 15 * 60_000 });
      await page.waitForTimeout(3000);
      const transcript = await page.locator("main").first().innerText();
      NodeFS.writeFileSync(NodePath.join(out, "agent-answer.txt"), transcript);
      return { worked: /Worked for [^\n]+/.exec(transcript)?.[0] ?? null };
    });
  summary.ok = pageErrors.length === 0;
} finally {
  summary.steps.push({ name: "page-errors", ms: 0, observed: pageErrors });
  writeSummary();
  await browser.close();
  stopDev();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
