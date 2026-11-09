// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of the app's dialogs and undo toasts. Starts the dev server and web app on a
 * fresh data directory, adds a local CAD project, starts a chat, then opens each dialog the way a
 * user does and checks its title, rows and buttons:
 *
 *   - add project: the kind chooser and its rows
 *   - update restart: the real confirm host showing the real update copy, with 2 running chats
 *   - delete thread: named confirm button, cancelled
 *   - archive: no confirm, an Undo toast, and Undo brings the thread back
 *   - unpin: no confirm, an Undo toast, and Undo pins the thread again
 *   - remove CAD project: kept rows, the CAD data switch, the restore hint, cancelled
 *
 * Evidence goes under --out:
 *
 *   NN-*.png       a screenshot after each step
 *   dev.log        dev runner, server, and web output
 *   summary.json   step timings and what each step observed
 *
 *   node apps/server/scripts/dialogs-e2e.ts --out .cadsense/dialogs-e2e/run
 *
 * Starting the chat sends one short message to the default provider and stops the turn.
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache.
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
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const stepName = "exports/dm1-id-214.stp";
const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports"), { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);

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
  const started = Date.now();
  const observed = await action(page).catch(async (error: unknown) => {
    await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
    throw error;
  });
  const index = String(++shots).padStart(2, "0");
  // Dialogs and toasts animate in over 200ms. Shoot them once they settle.
  await page.waitForTimeout(400);
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};

const addProjectDialog = page.getByRole("dialog", {
  name: /^(Add project|New (CAD|Onshape) project)$/,
});
const alert = page.getByRole("alertdialog");
const composer = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first();
const projectRow = page
  .locator('[data-sidebar="menu-button"]')
  .filter({ hasText: NodePath.basename(folder) })
  .first();
/** The browser's fallback context menu is a list of plain buttons, added last. */
const pickMenuItem = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).last().click();
/** Lines of text in `locator`, for the summary. */
const lines = async (locator: ReturnType<Page["locator"]>) =>
  (await locator.innerText()).split("\n").filter(Boolean);
const expectText = async (locator: ReturnType<Page["locator"]>, expected: string[]) => {
  const text = await locator.innerText();
  const missing = expected.filter((item) => !text.includes(item));
  if (missing.length > 0) throw new Error(`Missing ${JSON.stringify(missing)} in ${text}`);
};
/** The undo toast whose title starts with `prefix`, once it shows. */
const undoToast = async (page: Page, prefix: string) => {
  const toast = page
    .locator("li, [role=status], [role=alert], div")
    .filter({ hasText: prefix })
    .filter({ has: page.getByRole("button", { name: "Undo", exact: true }) })
    .last();
  await toast.waitFor({ timeout: 15_000 });
  return toast;
};
let threadId = "";
const threadRow = () => page.getByTestId(`thread-row-${threadId}`);

try {
  await run("add-project-chooser", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await addProjectDialog.waitFor();
    await expectText(addProjectDialog, ["Add project", "CAD file", "Onshape document", "Folder"]);
    return { dialog: await lines(addProjectDialog) };
  });
  await run("cad-project-form", async (page) => {
    await addProjectDialog.getByRole("button", { name: "CAD file" }).click();
    await expectText(addProjectDialog, ["New CAD project"]);
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).click({ timeout: 30_000 });
    return { dialog: await lines(addProjectDialog) };
  });
  await run("project-created", async (page) => {
    await page.getByRole("button", { name: "Create project" }).click();
    await addProjectDialog.waitFor({ state: "detached" });
    return { url: page.url() };
  });
  // The update dialog needs the desktop updater, so this asks the app's own confirm host to show
  // the app's own update copy. Vite serves each source module once, so these are the same
  // modules the page runs.
  await run("update-restart-confirm", async (page) => {
    await page.evaluate(async () => {
      const host = globalThis as unknown as { __updateAnswer?: Promise<boolean> };
      const confirmModule = "/src/confirmDialog.ts";
      const logicModule = "/src/components/desktopUpdate.logic.ts";
      const { requestConfirmDialog } = await import(/* @vite-ignore */ confirmModule);
      const { getDesktopUpdateInstallConfirmation } = await import(/* @vite-ignore */ logicModule);
      host.__updateAnswer = requestConfirmDialog(
        getDesktopUpdateInstallConfirmation(
          { availableVersion: "0.9.0", downloadedVersion: "0.9.1" },
          2,
        ),
      );
    });
    await alert.waitFor();
    await expectText(alert, [
      "Restart to update",
      "cadsense closes and reopens on 0.9.1.",
      "2 chats are still running. Restarting stops them.",
      "Later",
      "Restart now",
    ]);
    return { dialog: await lines(alert) };
  });
  await run("update-later", async (page) => {
    await alert.getByRole("button", { name: "Later" }).click();
    await alert.waitFor({ state: "detached" });
    const answer = await page.evaluate(
      () => (globalThis as unknown as { __updateAnswer: Promise<boolean> }).__updateAnswer,
    );
    if (answer !== false) throw new Error(`"Later" answered ${String(answer)}`);
    return { answer };
  });
  await run("chat-started", async (page) => {
    await composer.click();
    await page.keyboard.type("Reply with the single word ok.");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForURL((next) => !next.pathname.startsWith("/draft/"), { timeout: 60_000 });
    const stop = page.getByRole("button", { name: "Stop generation" });
    await stop.click({ timeout: 15_000 }).catch(() => {});
    await stop.waitFor({ state: "detached", timeout: 60_000 });
    threadId = new URL(page.url()).pathname.split("/").at(-1)!;
    await threadRow().waitFor({ timeout: 30_000 });
    return { url: page.url(), threadId };
  });
  await run("delete-thread-confirm", async (page) => {
    await threadRow().click({ button: "right" });
    await pickMenuItem(page, "Delete");
    await alert.waitFor();
    await expectText(alert, ['Delete "', "Its history can't be recovered.", "Delete thread"]);
    if (await alert.getByRole("button", { name: "Confirm", exact: true }).count())
      throw new Error("The delete dialog still has a generic Confirm button");
    return { dialog: await lines(alert) };
  });
  await run("delete-thread-cancelled", async (page) => {
    await alert.getByRole("button", { name: "Cancel" }).click();
    await alert.waitFor({ state: "detached" });
    await threadRow().waitFor();
    return { url: page.url() };
  });
  await run("archive-undo-toast", async (page) => {
    await threadRow().hover();
    await page.getByTestId(`thread-archive-${threadId}`).click();
    const toast = await undoToast(page, "Archived");
    if (await alert.count()) throw new Error("Archiving asked for a confirmation");
    await threadRow().waitFor({ state: "detached", timeout: 15_000 });
    return { toast: await lines(toast) };
  });
  await run("archive-undone", async (page) => {
    const toast = await undoToast(page, "Archived");
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await threadRow().waitFor({ timeout: 30_000 });
    return { restored: true };
  });
  await run("unpin-undo-toast", async (page) => {
    await threadRow().click();
    const title = page.getByRole("button", { name: /^Thread actions for / });
    await title.click();
    await pickMenuItem(page, "Pin thread");
    await page.waitForTimeout(1000);
    await title.click();
    await pickMenuItem(page, "Unpin thread");
    const toast = await undoToast(page, "Unpinned");
    if (await alert.count()) throw new Error("Unpinning asked for a confirmation");
    return { toast: await lines(toast) };
  });
  await run("unpin-undone", async (page) => {
    const toast = await undoToast(page, "Unpinned");
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^Thread actions for / }).click();
    const unpin = page.getByRole("button", { name: "Unpin thread", exact: true }).last();
    await unpin.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    return { pinnedAgain: true };
  });
  await run("remove-cad-project", async (page) => {
    await projectRow.click({ button: "right" });
    await pickMenuItem(page, "Remove");
    await alert.waitFor();
    await expectText(alert, [
      `Remove ${NodePath.basename(folder)}`,
      folder,
      "1 thread",
      "Captured images",
      "Files in the folder",
      "Imported CAD data",
      "Restore it from Settings → Archive",
      "Remove project",
    ]);
    const toggle = alert.getByRole("switch");
    if ((await toggle.count()) !== 1) throw new Error("Expected one switch, for imported CAD data");
    await alert.getByText("Imported CAD data").click();
    if ((await toggle.getAttribute("aria-checked")) !== "false")
      throw new Error("Clicking the row label did not turn the switch off");
    return { dialog: await lines(alert) };
  });
  await run("remove-cad-project-cancelled", async (page) => {
    await alert.getByRole("button", { name: "Cancel" }).click();
    await alert.waitFor({ state: "detached" });
    await projectRow.waitFor();
    return { url: page.url() };
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
