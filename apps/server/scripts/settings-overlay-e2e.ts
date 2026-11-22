// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check that settings opens as an overlay and leaves the page behind it alone. Starts
 * the dev server and web app on a fresh data directory, opens a local CAD project's draft with its
 * CAD panel showing and text in the composer, then opens and closes settings every way a user can.
 * Each time, the composer, the CAD panel, and its canvas must be the same DOM nodes as before (a
 * remount would replace them) and the draft text must still be there. Evidence goes under --out:
 *
 *   NN-*.png       a screenshot after each step
 *   dev.log        dev runner, server, and web output
 *   summary.json   step timings, what each step observed, and whether the page had errors
 *
 *   node apps/server/scripts/settings-overlay-e2e.ts --out .cadsense/settings-overlay-e2e/run
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache and renders with
 * SwiftShader.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Page } from "playwright-core";
import { parseE2eArgs, repo, runE2e } from "./e2e-harness.ts";

const { out } = parseE2eArgs("--out <dir>", {});
const stepName = "exports/dm1-id-214.stp";
const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports"), { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);

await runE2e(out, async (run) => {
  const { url } = await run.startDevApp({ home: NodePath.join(out, "home") });
  const page = await (
    await run.launchChromium()
  ).newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const step = run.screenshotSteps(page);

  const DRAFT_TEXT = "Keep this draft while settings is open.";
  const panel = page.getByRole("region", { name: "CAD panel" });
  const composer = page
    .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
    .first();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  // The page behind settings, as nodes. Each gets a marker property that only this exact node
  // carries, so a remount (a new node) reads back as unmarked.
  const BEHIND = {
    composer: '[data-chat-composer-form="true"]',
    cadPanel: 'section[aria-label="CAD panel"]',
    canvas: '[aria-label="CAD panel"] canvas',
  } as const;
  // The server's tsconfig has no DOM types, so the page code below names the little it touches.
  type MarkedNode = { __settingsE2e?: string; readonly isConnected: boolean };
  type BrowserGlobal = { document: { querySelector(selector: string): MarkedNode | null } };
  const markPageBehind = (page: Page) =>
    page.evaluate((selectors) => {
      for (const [name, selector] of Object.entries(selectors)) {
        const node = (globalThis as unknown as BrowserGlobal).document.querySelector(selector);
        if (!node) throw new Error(`Nothing to mark for ${name}`);
        node.__settingsE2e = name;
      }
    }, BEHIND);
  /** Throws unless every marked node is still in the page and the draft text is unchanged. */
  const expectPageBehindKept = async (page: Page) => {
    const kept = await page.evaluate(
      (selectors) =>
        Object.fromEntries(
          Object.entries(selectors).map(([name, selector]) => {
            const node = (globalThis as unknown as BrowserGlobal).document.querySelector(selector);
            return [name, node?.__settingsE2e === name && node.isConnected];
          }),
        ),
      BEHIND,
    );
    const lost = Object.entries(kept).filter(([, same]) => !same);
    if (lost.length > 0)
      throw new Error(`Remounted or removed: ${lost.map(([name]) => name).join(", ")}`);
    const text = (await composer.innerText()).trim();
    if (text !== DRAFT_TEXT) throw new Error(`The draft text changed to ${JSON.stringify(text)}`);
    return kept;
  };
  const settingsParam = (page: Page) => new URL(page.url()).searchParams.get("settings");
  let draftPath = "";
  const expectClosed = async (page: Page) => {
    await settingsDialog.waitFor({ state: "detached", timeout: 10_000 });
    const location = new URL(page.url());
    if (location.pathname !== draftPath || location.search !== "")
      throw new Error(`Closing settings left ${location.pathname}${location.search}`);
    return { url: page.url(), kept: await expectPageBehindKept(page) };
  };
  const openFromSidebar = async (page: Page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await settingsDialog.waitFor({ timeout: 10_000 });
    if (settingsParam(page) !== "general") throw new Error(`Opened at ${page.url()}`);
    if (new URL(page.url()).pathname !== draftPath)
      throw new Error("Opening settings left the page");
  };

  await step("project-created", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "CAD file" }).click();
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await page
      .getByRole("dialog", { name: /^(Add project|New (CAD|Onshape) project)$/ })
      .waitFor({ state: "detached" });
    return { url: page.url() };
  });
  await step("draft-with-cad", async (page) => {
    // The draft's right panel shows the project's CAD. It can start closed while the draft loads.
    for (let attempt = 0; !(await panel.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never showed its CAD");
      const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
      await panel.waitFor({ timeout: 1_000 }).catch(() => {});
    }
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await composer.click();
    await page.keyboard.type(DRAFT_TEXT);
    draftPath = new URL(page.url()).pathname;
    await markPageBehind(page);
    return { url: page.url() };
  });
  await step("settings-open-over-draft", async (page) => {
    await openFromSidebar(page);
    // Typing goes to settings, not the composer behind it.
    await page.keyboard.type("x");
    return { url: page.url(), kept: await expectPageBehindKept(page) };
  });
  await step("settings-tab-switched", async (page) => {
    await settingsDialog.getByRole("link", { name: "Providers" }).click();
    await page.waitForURL((next) => next.searchParams.get("settings") === "providers");
    return { url: page.url(), kept: await expectPageBehindKept(page) };
  });
  await step("closed-with-escape", async (page) => {
    await page.keyboard.press("Escape");
    return expectClosed(page);
  });
  await step("closed-with-button", async (page) => {
    await openFromSidebar(page);
    await settingsDialog.getByRole("button", { name: "Close settings" }).click();
    return expectClosed(page);
  });
  await step("closed-with-backdrop", async (page) => {
    await openFromSidebar(page);
    await page.mouse.click(10, 450);
    return expectClosed(page);
  });
  await step("closed-with-browser-back", async (page) => {
    await openFromSidebar(page);
    await page.goBack();
    return expectClosed(page);
  });
  // A settings link loaded fresh has no history entry to go back to, so closing drops the
  // param in place.
  await step("deep-link-closed", async (page) => {
    await page.goto(`${url.replace(/\/$/, "")}${draftPath}?settings=appearance`, {
      waitUntil: "networkidle",
    });
    await settingsDialog.waitFor({ timeout: 10_000 });
    await panel.waitFor({ timeout: 30_000 });
    await settingsDialog.getByRole("button", { name: "Close settings" }).click();
    await settingsDialog.waitFor({ state: "detached", timeout: 10_000 });
    const location = new URL(page.url());
    if (location.pathname !== draftPath || location.search !== "")
      throw new Error(`Closing a deep link left ${location.pathname}${location.search}`);
    return { url: page.url(), cadPanelVisible: await panel.isVisible() };
  });
  // `/` forwards to a draft. Settings opened there (as removing the active project does) must
  // stay open over that draft.
  await step("root-link-forwarded", async (page) => {
    await page.goto(`${url}?settings=archived#cad-storage`, { waitUntil: "networkidle" });
    await page.waitForURL((next) => next.pathname.startsWith("/draft/"), { timeout: 30_000 });
    await settingsDialog.waitFor({ timeout: 10_000 });
    if (settingsParam(page) !== "archived") throw new Error(`Forwarded to ${page.url()}`);
    return { url: page.url() };
  });
  run.check("the page had no errors", pageErrors.length === 0, { pageErrors });
});
