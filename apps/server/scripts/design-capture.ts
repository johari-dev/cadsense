// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
/**
 * Screenshots for the design hillclimb (see .agents/skills/design-council). It drives a running dev
 * app, so a CSS edit only needs a reload and a new `shoot`.
 *
 *   # once: start a dev app on a fixture home, then fill it with a project and real chats
 *   vp run dev --home-dir .cadsense/hillclimb/home
 *   node apps/server/scripts/design-capture.ts seed --url http://localhost:<webPort>/ \
 *     --fixture .cadsense/hillclimb [--provider Claude --model "Sonnet 5.5"]
 *
 *   # every round: the same screens, in the same states, into a new folder
 *   node apps/server/scripts/design-capture.ts shoot --url http://localhost:<webPort>/ \
 *     --fixture .cadsense/hillclimb --out .cadsense/hillclimb/rounds/r01
 *
 * `seed` sends real agent turns, so it needs a signed-in provider and costs tokens. It writes
 * fixture.json with the chat URLs that `shoot` opens. `shoot` writes NN-<screen>.png at 1440x900
 * and a manifest.json that says what each screen shows, for the reviewers' brief.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache and renders with
 * SwiftShader, like local-cad-project-e2e.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    fixture: { type: "string" },
    out: { type: "string" },
    provider: { type: "string", default: "Claude" },
    model: { type: "string", default: "Sonnet 5.5" },
  },
});
const command = positionals[0];
if ((command !== "seed" && command !== "shoot") || !values.url || !values.fixture)
  throw new Error(
    "Usage: design-capture.ts seed --url <app> --fixture <dir> [--model <name>]\n" +
      "       design-capture.ts shoot --url <app> --fixture <dir> --out <dir>",
  );
const url = values.url;
const fixtureDir = NodePath.resolve(values.fixture);
const fixtureFile = NodePath.join(fixtureDir, "fixture.json");
const repo = NodePath.resolve(import.meta.dirname, "../../..");

/** What `seed` leaves behind for `shoot`. */
interface Fixture {
  readonly projectName: string;
  /** The chat that has the long CAD review answer and the imported model. */
  readonly reviewThreadUrl: string;
  readonly otherThreadUrls: ReadonlyArray<string>;
}

const browser = await chromium.launch({
  ...(process.env.CADSENSE_CHROMIUM_PATH
    ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH }
    : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Opening files and folders would launch apps on this machine, so those requests never leave.
await page.routeWebSocket(/./, (ws) => {
  const server = ws.connectToServer();
  ws.onMessage((message) => {
    if (typeof message === "string" && message.includes('"shell.openInFileManager"')) return;
    server.send(message);
  });
});
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const panel = page.getByRole("region", { name: "CAD panel" });
const rightPanelToggle = page.getByRole("button", { name: /^Toggle right panel/ });
const setRightPanel = async (open: boolean) => {
  const pressed = (await rightPanelToggle.getAttribute("aria-pressed")) === "true";
  if (pressed !== open) await rightPanelToggle.click();
};
const dismissToasts = () =>
  page
    .getByRole("button", { name: "Dismiss notification" })
    .click({ timeout: 1500 })
    .catch(() => {});

/** Picks `model` in the composer, sends `prompt`, and waits for the turn to finish. */
const ask = async (prompt: string) => {
  await page.getByRole("button", { name: "Change model and reasoning" }).click();
  await page.getByRole("tab", { name: values.provider!, exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: values.model! }).first().click();
  await page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first().click();
  await page.keyboard.type(prompt);
  // Send stays disabled while the project's first import runs, so this waits for it.
  await page.getByRole("button", { name: "Send message" }).click({ timeout: 20 * 60_000 });
  const stop = page.getByRole("button", { name: "Stop generation" });
  await stop.waitFor({ timeout: 60_000 });
  await stop.waitFor({ state: "detached", timeout: 20 * 60_000 });
  await page.waitForTimeout(2000);
  return page.url();
};

/**
 * Renames the chat at `threadUrl` from the sidebar, like a user double-clicking its row. Seeds
 * use this for the short titles the server generates, since title generation can fail on a
 * test machine and leave the raw prompt as the title.
 */
const setTitle = async (threadUrl: string, title: string) => {
  const threadId = threadUrl.split("/").at(-1)!;
  await page.getByTestId(`thread-title-${threadId}`).dblclick();
  const input = page.locator(`[data-testid="thread-row-${threadId}"] input`);
  await input.fill(title);
  await input.press("Enter");
  await page.getByTestId(`thread-title-${threadId}`).getByText(title).waitFor();
};

const newThread = async () => {
  await page
    .getByRole("button", { name: /^New chat in / })
    .first()
    .click({ force: true });
  await page.locator('[data-chat-composer-form="true"]').waitFor();
};

const seed = async () => {
  if (NodeFS.existsSync(fixtureFile)) throw new Error(`${fixtureFile} exists. Seed once per home.`);
  // A project folder that reads like a real robot subsystem, holding the CAx-IF dm1 assembly.
  const projectName = "intake-bracket";
  const folder = NodePath.join(fixtureDir, projectName);
  const stepName = "exports/bracket-assembly.step";
  NodeFS.mkdirSync(NodePath.join(folder, "exports"), { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
    NodePath.join(folder, stepName),
  );

  await page.goto(url, { waitUntil: "networkidle" });
  await dismissToasts();
  // A seed that failed after creating the project resumes from the project's new chat.
  const existing = page.locator('[data-sidebar="menu-button"]').filter({ hasText: projectName });
  if (
    await existing
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false)
  ) {
    await newThread();
  } else {
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Local CAD file" }).click();
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    await dialog.getByText(stepName, { exact: true }).click({ timeout: 60_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await dialog.waitFor({ state: "detached" });
  }

  const reviewThreadUrl = await ask(
    "Review this bracket assembly for manufacturability. List each fastener with its size, " +
      "check the hole clearances against the bolts, and end with a short table of risks.",
  );
  await setTitle(reviewThreadUrl, "Bracket manufacturability review");
  console.log("review chat", reviewThreadUrl);
  const otherThreadUrls: string[] = [];
  for (const [prompt, title] of [
    [
      "What material and thickness would you pick for this bracket if it holds a 2 kg intake?",
      "Bracket material and thickness",
    ],
    [
      "Write a short checklist for torquing the three bolts on this bracket.",
      "Bolt torque checklist",
    ],
  ] as const) {
    await newThread();
    const threadUrl = await ask(prompt);
    await setTitle(threadUrl, title);
    otherThreadUrls.push(threadUrl);
    console.log("chat", threadUrl);
  }
  const fixture: Fixture = { projectName, reviewThreadUrl, otherThreadUrls };
  NodeFS.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Seeded. Fixture in ${fixtureFile}`);
};

/** Scrolls the chat timeline's nearest scrolling ancestor to the top. Runs in the page. */
const SCROLL_TIMELINE_TO_TOP = `(() => {
  let element = document.querySelector('[data-timeline-root="true"]');
  while (element && !(element.scrollHeight > element.clientHeight + 1 &&
    /auto|scroll/.test(getComputedStyle(element).overflowY))) element = element.parentElement;
  element?.scrollTo({ top: 0 });
})()`;

const shoot = async () => {
  if (!values.out) throw new Error("shoot needs --out <dir>");
  const out = NodePath.resolve(values.out);
  if (NodeFS.existsSync(out)) throw new Error(`${out} exists. Use a fresh --out per round.`);
  NodeFS.mkdirSync(out, { recursive: true });
  const fixture = JSON.parse(NodeFS.readFileSync(fixtureFile, "utf8")) as Fixture;
  const manifest: { file: string; shows: string }[] = [];
  let index = 0;
  const screen = async (name: string, shows: string, arrange: (page: Page) => Promise<void>) => {
    await arrange(page);
    // Let fonts, transitions, and the CAD scene settle so rounds compare like for like.
    // Page scripts are strings: this package type-checks without the DOM library.
    await page.evaluate("document.fonts.ready.then(() => true)");
    await page.mouse.move(0, 899);
    await page.waitForTimeout(1200);
    const file = `${String(++index).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: NodePath.join(out, file) });
    manifest.push({ file, shows });
    console.log(file);
  };
  const openThread = async (threadUrl: string) => {
    await page.goto(threadUrl, { waitUntil: "networkidle" });
    await dismissToasts();
    await page.locator('[data-chat-composer-form="true"]').waitFor();
  };

  await screen(
    "chat",
    "A finished chat: the user's request, the agent's tool work, and a long markdown answer with a table. The sidebar lists the project and its chats.",
    async () => {
      await openThread(fixture.reviewThreadUrl);
      await setRightPanel(false);
    },
  );
  await screen(
    "chat-with-cad",
    "The same chat with the right panel open on the imported CAD assembly (an L-bracket with three bolts and nuts).",
    async () => {
      await setRightPanel(true);
      await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
      // The agent's tools leave the view isolated or zoomed. Every round shows the whole model.
      const showAll = page.getByRole("button", { name: "Show every part" });
      if (!(await showAll.isVisible())) {
        const changes = page.getByRole("button", { name: /^View changes: / });
        if (await changes.isVisible()) await changes.click();
      }
      if (await showAll.isVisible()) await showAll.click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Reset view to isometric" }).click();
      await page.getByRole("button", { name: "Fit to view" }).click();
      await page.waitForTimeout(4000);
    },
  );
  await screen(
    "chat-scrolled-top",
    "The top of the same chat, CAD panel open: the user's message and the start of the agent's work.",
    async () => {
      // The timeline is virtualized, so scroll its scroller to the top a few times as rows mount.
      for (let pass = 0; pass < 4; pass++) {
        await page.evaluate(SCROLL_TIMELINE_TO_TOP);
        await page.waitForTimeout(400);
      }
    },
  );
  await screen(
    "new-chat",
    "A new chat in the project: the empty state and the composer with its model and mode controls.",
    async () => {
      await openThread(fixture.otherThreadUrls[0]!);
      await setRightPanel(false);
      await newThread();
    },
  );
  await screen(
    "model-picker",
    "The composer's model picker, open on the Claude models.",
    async () => {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await page.getByRole("tab", { name: "Claude", exact: true }).click();
      await page.getByRole("menuitem").first().waitFor();
    },
  );
  await screen("file-picker", "The project file picker over a chat (Ctrl+P).", async () => {
    await page.keyboard.press("Escape");
    await openThread(fixture.otherThreadUrls[0]!);
    await page.keyboard.press("Control+p");
    await page.locator('[data-command-palette="true"]').waitFor();
  });
  await screen("add-project", "The Add project dialog.", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("dialog", { name: "Add project" }).waitFor();
  });
  await screen("settings", "Settings, General page.", async () => {
    await page.goto(new URL("settings/general", url).href, { waitUntil: "networkidle" });
  });
  await screen("settings-providers", "Settings, Providers page.", async () => {
    await page.goto(new URL("settings/providers", url).href, { waitUntil: "networkidle" });
  });
  await screen(
    "settings-drawings",
    "Settings, CAD > Drawings page: drawing units and tap depth.",
    async () => {
      await page.goto(new URL("settings/drawings", url).href, { waitUntil: "networkidle" });
    },
  );

  NodeFS.writeFileSync(
    NodePath.join(out, "manifest.json"),
    `${JSON.stringify({ url, viewport: "1440x900", screens: manifest, pageErrors }, null, 2)}\n`,
  );
  console.log(`Shot ${index} screens into ${out}`);
};

try {
  await (command === "seed" ? seed() : shoot());
} finally {
  await browser.close();
}
