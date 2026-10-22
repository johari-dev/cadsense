// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of local CAD projects through the real app. Starts the dev server and web app on
 * a fresh data directory, then drives headless Chromium through the whole flow, ending with removing
 * the project from the sidebar and restoring it from CAD storage, and keeps the evidence under --out:
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
// The panel heading opens the shown CAD file with its default app, which the server would launch
// on this machine. So the app's request for it is kept here and never reaches the server.
const openRequests: string[] = [];
await page.routeWebSocket(/./, (ws) => {
  const server = ws.connectToServer();
  ws.onMessage((message) => {
    if (typeof message === "string" && message.includes('"shell.openInFileManager"'))
      openRequests.push(message);
    else server.send(message);
  });
});
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let shots = 0;
const run = async (name: string, action: (page: Page) => Promise<unknown>) => {
  const started = Date.now();
  const observed = await action(page).catch(async (error: unknown) => {
    // Keep what the page showed when the step failed.
    await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
    throw error;
  });
  const index = String(++shots).padStart(2, "0");
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};
const panel = page.getByRole("region", { name: "CAD panel" });
// The model's name and its Sync button sit in the right panel's header, outside the CAD panel.
// A local file is the only model, so its name is a heading rather than a scene picker, and the
// heading is a button that opens the file.
const syncButton = page.getByRole("button", { name: "Sync", exact: true });
const sceneTitle = page.getByRole("button", { name: stepName, exact: true });
// The right panel opens on the CAD view. Opens it unless it is already open.
const openRightPanel = async (page: Page) => {
  const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
};
// A new project opens on a draft, and the CAD view loads once the draft is a thread. Sending a
// message is how a user gets there; the turn is stopped as soon as it starts. A message can't
// start a turn while the project's first import runs, so like a user, keep sending until it does.
// A failed first send gives the draft a new thread id, and panel state is kept per thread id, so
// the panel closes. The prompt going away only means a thread started if the panel stayed open.
const startThread = async (page: Page) => {
  const placeholder = page.getByText("Start a thread to open its CAD view.");
  const composer = page
    .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
    .first();
  // Opens the draft's panel until it asks for a thread. It can start closed while the draft loads.
  const showPrompt = async () => {
    for (let attempt = 0; !(await placeholder.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never asked for a thread");
      await openRightPanel(page);
      await placeholder.waitFor({ timeout: 1_000 }).catch(() => {});
    }
  };
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    await showPrompt();
    if (!(await composer.innerText()).trim()) {
      await composer.click();
      await page.keyboard.type("Open the CAD view.");
    }
    await page.getByRole("button", { name: "Send message" }).click();
    const promptGone = await placeholder.waitFor({ state: "detached", timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    const panelOpen =
      (await page
        .getByRole("button", { name: /^Toggle right panel/ })
        .getAttribute("aria-pressed")) === "true";
    if (promptGone && panelOpen) break;
    if (Date.now() > deadline) throw new Error("Sending never started a thread");
  }
  // Stops the turn if it is still running. A turn that ends by itself first is just as good.
  await page
    .getByRole("button", { name: "Stop generation" })
    .click({ timeout: 15_000 })
    .catch(() => {});
};
const manifestDir = NodePath.join(out, "home/userdata/cad/manifests");
const manifests = () => NodeFS.readdirSync(manifestDir).filter((name) => name.endsWith(".json"));
// Components in the newest imported snapshot, read from the snapshot store.
const componentCount = () => {
  const newest = manifests()
    .map((name) => NodePath.join(manifestDir, name))
    .toSorted((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  if (!newest) return 0;
  return (JSON.parse(NodeFS.readFileSync(newest, "utf8")) as { nodes: unknown[] }).nodes.length;
};
// The chat whose CAD panel shows the model. Removal and restore come back to it.
let threadUrl = url;
const projectRow = page
  .locator('[data-sidebar="menu-button"]')
  .filter({ hasText: NodePath.basename(folder) })
  .first();
const removalDialog = page.getByRole("alertdialog");
const retainedEntry = page.locator("article").filter({ hasText: NodePath.basename(folder) });
// Every file in the project folder, so removal and restore can show they left it alone.
const folderFiles = () =>
  NodeFS.readdirSync(folder, { recursive: true, encoding: "utf8" }).toSorted();

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
  // The file list belongs to the scanned folder. Editing the folder drops it, and a folder that
  // fails to scan leaves nothing to create from, rather than the previous folder's file.
  await run("other-folder-failed", async (page) => {
    const form = page.getByRole("form", { name: "Create local CAD project" });
    await page.getByLabel("Folder").fill(`${folder}-missing`);
    if (await form.getByText(stepName, { exact: true }).isVisible())
      throw new Error("The previous folder's files are still listed");
    await page.getByRole("button", { name: "Scan" }).click();
    const scanError = (await form.getByRole("alert").innerText()).trim();
    if (await page.getByRole("button", { name: "Create project" }).isEnabled())
      throw new Error("Create still targets the previous folder");
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).waitFor({ timeout: 30_000 });
    return { scanError };
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
    await startThread(page);
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
    threadUrl = page.url();
    return { title: (await sceneTitle.innerText()).trim(), components: componentCount() };
  });
  // Like the Onshape link, the heading opens the CAD file it names, here with its default app.
  await run("open-file", async (page) => {
    await sceneTitle.click();
    const request = await waitFor("the request to open the file", () => openRequests[0]);
    const { payload } = JSON.parse(request) as { payload: { cwd: string; reveal?: boolean } };
    if (payload.cwd !== NodePath.join(folder, stepName) || payload.reveal !== false)
      throw new Error(`Asked to open ${request}`);
    return { payload };
  });
  await run("re-exported-and-synced", async (page) => {
    // A new export of the same model: different bytes, same structure.
    const file = NodePath.join(folder, stepName);
    NodeFS.writeFileSync(
      file,
      NodeFS.readFileSync(file, "utf8").replace("FILE_NAME(", "FILE_NAME( /* re-export */ "),
    );
    const before = new Set(manifests());
    await syncButton.click();
    // The import can finish before "Importing…" renders, so watch the snapshot store instead.
    const created = await waitFor("the re-imported snapshot", () =>
      manifests().find((name) => !before.has(name)),
    );
    await syncButton.waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    const revision = (name: string) =>
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(manifestDir, name), "utf8")) as {
          root: { microversionId: string };
        }
      ).root.microversionId;
    return {
      components: componentCount(),
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
  // Removing the project from the sidebar while its chat is open keeps the chat and, here, the
  // imported CAD, then opens CAD storage. The folder is the user's, so nothing offers to delete it.
  await run("remove-dialog", async (page) => {
    await page.goto(threadUrl, { waitUntil: "networkidle" });
    await openRightPanel(page);
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await projectRow.click({ button: "right" });
    // The browser's context menu is a list of plain buttons, added last.
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    await removalDialog.waitFor();
    const checkbox = removalDialog.getByRole("checkbox");
    if ((await checkbox.count()) !== 1) throw new Error("The dialog offers more than imported CAD");
    await removalDialog.getByText("Delete imported CAD data").click();
    if ((await checkbox.getAttribute("aria-checked")) !== "false")
      throw new Error("Could not choose to keep the imported CAD");
    return { dialog: (await removalDialog.innerText()).split("\n").filter(Boolean) };
  });
  const kept = { manifests: 0, files: [] as string[] };
  await run("removed-opens-cad-storage", async (page) => {
    kept.manifests = manifests().length;
    kept.files = folderFiles();
    await removalDialog.getByRole("button", { name: "Remove project" }).click();
    await page.waitForURL(/\/settings\/cad-storage$/, { timeout: 60_000 });
    await retainedEntry.waitFor({ timeout: 30_000 });
    if (manifests().length !== kept.manifests) throw new Error("Removal deleted the kept CAD");
    if (folderFiles().join() !== kept.files.join()) throw new Error("Removal changed the folder");
    // Deleting the retained data later offers the imported CAD only.
    await retainedEntry.getByRole("button", { name: "Delete retained data" }).click();
    await removalDialog.waitFor();
    const cleanup = (await removalDialog.innerText()).split("\n").filter(Boolean);
    if ((await removalDialog.getByRole("checkbox").count()) !== 1)
      throw new Error("Deleting retained data offers more than imported CAD");
    await removalDialog.getByRole("button", { name: "Cancel" }).click();
    await removalDialog.waitFor({ state: "detached" });
    return {
      url: page.url(),
      entry: (await retainedEntry.innerText()).split("\n").filter(Boolean),
      cleanup,
      manifests: kept.manifests,
    };
  });
  // Settings pages show their own navigation, so the project list is checked from the chat.
  await run("thread-link-while-removed", async (page) => {
    await page.goto(threadUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    if (await projectRow.isVisible()) throw new Error("The removed project is still listed");
    return {
      url: page.url(),
      chat: (await page.locator("main").first().innerText()).slice(0, 200),
    };
  });
  await run("restored", async (page) => {
    await page.goto(new URL("settings/cad-storage", url).href, { waitUntil: "networkidle" });
    await retainedEntry.getByRole("button", { name: "Restore project" }).click();
    await retainedEntry.waitFor({ state: "detached", timeout: 60_000 });
    await page.goto(threadUrl, { waitUntil: "networkidle" });
    await projectRow.waitFor();
    await openRightPanel(page);
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    // The kept snapshot came back with the project, so nothing was imported again.
    if (manifests().length !== kept.manifests) throw new Error("Restore imported the file again");
    if (folderFiles().join() !== kept.files.join()) throw new Error("Restore changed the folder");
    return { url: page.url(), title: (await sceneTitle.innerText()).trim() };
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
