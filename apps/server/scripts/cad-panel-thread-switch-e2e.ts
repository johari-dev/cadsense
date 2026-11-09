// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check that moving between chats keeps the right panel in place. Starts the dev server
 * and web app on a fresh data directory, adds a local CAD project, and drives headless Chromium:
 *
 *   1. While a chat's turn runs, opening a new chat must not replay the panel's slide-in, and the
 *      new chat's CAD view must answer a drag.
 *   2. Moving between two chats that both show CAD must not replay the slide-in.
 *
 *   node apps/server/scripts/cad-panel-thread-switch-e2e.ts --out .cadsense/thread-switch/run \
 *     [--model "Haiku"]
 *
 * The running turn is real: it asks --model (or the app's default model) to run `sleep`, so that
 * provider must be signed in, and the run costs a few tokens. Evidence under --out:
 *
 *   NN-*.png        a screenshot after each step
 *   dev.log         dev runner, server, and web output
 *   summary.json    what each step observed, including every panel slide the page started
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache and renders with
 * SwiftShader.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: { out: { type: "string" }, model: { type: "string" } },
});
if (!values.out) throw new Error("Usage: --out <dir> [--model <name>]");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const folder = NodePath.join(out, "bracket-rig");
const stepName = "bracket.step";
NodeFS.mkdirSync(folder, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);

const summary: { steps: { name: string; ms: number; observed?: unknown }[]; ok: boolean } = {
  steps: [],
  ok: false,
};
const failures: string[] = [];
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
// Records every slide the panel shell starts. The shell animates its own element with the
// Web Animations API, so a wrapped `animate` sees each one. It runs in the page, and this
// package has no DOM types, so it is plain script text.
type Slide = { at: number; path: string; from: string; to: string };
await page.addInitScript(`
  const slides = [];
  window.__panelSlides = slides;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this instanceof HTMLElement && this.dataset.previewPanelMode && Array.isArray(keyframes)) {
      slides.push({
        at: Math.round(performance.now()),
        path: location.pathname,
        from: String(keyframes[0]?.width),
        to: String(keyframes[1]?.width),
      });
    }
    return animate.call(this, keyframes, options);
  };
`);
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
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, JSON.stringify(observed ?? ""));
};
const expect = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};

const panel = page.getByRole("region", { name: "CAD panel" });
const canvas = panel.locator("canvas").first();
const composer = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first();
const stop = page.getByRole("button", { name: "Stop generation" });
const slides = () => page.evaluate<Slide[]>("window.__panelSlides");
/** Slides the page started since `before`, each one a panel opening or closing. */
const slidesSince = async (before: number) => (await slides()).slice(before);
const openRightPanel = async () => {
  const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
};
const openDraftPanel = async () => {
  for (let attempt = 0; !(await panel.isVisible()); attempt++) {
    if (attempt === 30) throw new Error("The draft's right panel never showed its CAD");
    await openRightPanel();
    await panel.waitFor({ timeout: 1_000 }).catch(() => {});
  }
};
const newThread = () =>
  page
    .getByRole("button", { name: /^New thread in / })
    .first()
    .click({ force: true });
const pickModel = async (model: string) => {
  await page.getByRole("button", { name: "Change model and reasoning" }).click();
  // Each provider has its own tab, and search only covers the open one.
  const tabs = page.getByRole("tablist", { name: "Model sources" }).getByRole("tab");
  for (let index = 0; index < (await tabs.count()); index++) {
    await tabs.nth(index).click();
    await page.getByLabel("Search models").fill(model);
    const option = page.locator("[data-model-picker-row]:not([data-disabled])").first();
    if (await option.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await option.click();
      return;
    }
  }
  await page.getByLabel("Search models").fill("");
  await page.waitForTimeout(500);
  const seen = await page
    .locator("[data-model-picker-row]")
    .evaluateAll((nodes) => nodes.map((node) => node.outerHTML.slice(0, 300)));
  throw new Error(`No provider offers a model matching ${model}: ${seen.join("\n")}`);
};
const send = async (text: string) => {
  await composer.click();
  await page.keyboard.type(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL((next) => !next.pathname.startsWith("/draft/"), { timeout: 30_000 });
};
/** What the CAD panel shows about its lock, and whether a drag on the model moves it. */
const probeDrag = async () => {
  await canvas.waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const scene = panel.locator("canvas").first().locator("xpath=..");
  const state = await panel.evaluate((node) => ({
    locked: !!node.querySelector(".cursor-not-allowed"),
    agentControlling: node.getAttribute("data-cad-agent-controlling"),
    status: [...node.querySelectorAll('[role="status"]')].map((item) => item.textContent),
    pending: !!node.querySelector('[aria-label="Updating CAD view"]'),
  }));
  const box = (await canvas.boundingBox())!;
  const before = await scene.screenshot();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + step * 18, y + step * 6);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await scene.screenshot();
  return { ...state, moved: !before.equals(after) };
};

try {
  await run("project-created", async (page) => {
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
    await openDraftPanel();
    await canvas.waitFor({ timeout: 240_000 });
    await page.waitForTimeout(3000);
    return { url: page.url() };
  });
  await run("turn-running", async (page) => {
    if (values.model) await pickModel(values.model);
    await send(
      "First look at the CAD model with one of your CAD tools. Then use your shell tool to run exactly `timeout 90 tail -f /dev/null` in the foreground and wait for it to exit. Then reply with the single word done.",
    );
    await stop.waitFor({ timeout: 60_000 });
    // The agent holds the CAD view while a CAD tool call runs.
    const agentLooked = await page
      .locator('[data-cad-agent-controlling="true"]')
      .waitFor({ timeout: 60_000 })
      .then(
        () => true,
        () => false,
      );
    await page.waitForTimeout(5000);
    return { url: page.url(), agentLooked };
  });
  const runningUrl = page.url();
  /** Moves through history and returns the panel slides the move started. */
  const travel = async (move: () => Promise<unknown>, target: (url: URL) => boolean) => {
    const before = (await slides()).length;
    await move();
    await page.waitForURL(target, { timeout: 10_000 });
    await canvas.waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    return slidesSince(before);
  };
  const isDraft = (next: URL) => next.pathname.startsWith("/draft/");
  await run("new-thread-during-turn", async (page) => {
    if (!(await stop.isVisible())) throw new Error("The first chat's turn ended too early");
    await newThread();
    await page.waitForURL(isDraft, { timeout: 10_000 });
    await page.waitForTimeout(1000);
    const openOnArrival = await panel.isVisible();
    // A brand-new draft starts with its panel closed, so this slide is the user's own.
    await openDraftPanel();
    const drag = await probeDrag();
    expect(drag.moved, `The new chat's CAD did not answer a drag: ${JSON.stringify(drag)}`);
    return { openOnArrival, drag };
  });
  const draftUrl = page.url();
  await run("running-chat-and-back", async (page) => {
    const toRunning = await travel(
      () => page.goBack(),
      (next) => next.href === runningUrl,
    );
    const stillRunning = await stop.isVisible();
    const toDraft = await travel(() => page.goForward(), isDraft);
    const drag = await probeDrag();
    expect(stillRunning, "The first chat's turn ended before the draft was revisited");
    expect(
      toRunning.length === 0,
      `Draft to running chat replayed the slide: ${JSON.stringify(toRunning)}`,
    );
    expect(
      toDraft.length === 0,
      `Running chat to draft replayed the slide: ${JSON.stringify(toDraft)}`,
    );
    expect(
      drag.moved,
      `The draft's CAD did not answer a drag during the turn: ${JSON.stringify(drag)}`,
    );
    return { toRunning, toDraft, stillRunning, drag };
  });
  await run("first-turn-done", async (page) => {
    await page.goBack();
    await page.waitForURL(runningUrl);
    await stop.waitFor({ state: "detached", timeout: 5 * 60_000 });
    return { url: page.url() };
  });
  await run("second-thread", async (page) => {
    await page.goForward();
    await page.waitForURL(draftUrl);
    await send("Reply with the single word ok.");
    await canvas.waitFor({ timeout: 120_000 });
    await stop.waitFor({ state: "detached", timeout: 5 * 60_000 });
    return { url: page.url() };
  });
  const secondUrl = page.url();
  await run("switch-between-chats", async (page) => {
    const toFirst = await travel(
      () => page.goBack(),
      (next) => next.href === runningUrl,
    );
    const toSecond = await travel(
      () => page.goForward(),
      (next) => next.href === secondUrl,
    );
    expect(toFirst.length === 0, `Switching chats replayed the slide: ${JSON.stringify(toFirst)}`);
    expect(
      toSecond.length === 0,
      `Switching chats replayed the slide: ${JSON.stringify(toSecond)}`,
    );
    return { toFirst, toSecond };
  });
  // Closing and opening the panel in one chat still slides both ways.
  await run("toggle-still-slides", async (page) => {
    const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
    const before = (await slides()).length;
    await toggle.click();
    await panel.waitFor({ state: "detached", timeout: 5_000 });
    const closing = await slidesSince(before);
    await toggle.click();
    await canvas.waitFor({ timeout: 120_000 });
    await page.waitForTimeout(500);
    const opening = (await slidesSince(before)).slice(closing.length);
    expect(
      closing.some((slide) => slide.to === "0px"),
      `Closing did not slide: ${JSON.stringify(closing)}`,
    );
    expect(
      opening.some((slide) => slide.from === "0px"),
      `Opening did not slide: ${JSON.stringify(opening)}`,
    );
    return { closing, opening };
  });
  summary.ok = failures.length === 0 && pageErrors.length === 0;
} finally {
  summary.steps.push({ name: "failures", ms: 0, observed: failures });
  summary.steps.push({ name: "page-errors", ms: 0, observed: pageErrors });
  writeSummary();
  await browser.close();
  stopDev();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
