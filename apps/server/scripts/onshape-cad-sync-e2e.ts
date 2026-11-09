// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of the first CAD download for a new Onshape project, through the real app.
 * Starts the dev server and web app on a fresh data directory, then drives headless Chromium the
 * way a user does: add an Onshape connection, create a project from --url, open a chat, and look at
 * the CAD panel. Then, by --flow:
 *
 *   sync      press the panel's Sync button and wait for the model to show (the default), then
 *             turn on "Show Onshape API calls per sync" and sync again, unchanged
 *   refresh   refresh the CAD catalog in project settings and look at the panel again, as a user
 *             had to before the panel could sync a project that was never refreshed
 *
 * It keeps the evidence under --out:
 *
 *   flow.webm         a video of the whole run
 *   NN-*.png          a screenshot after each step
 *   dev.log           dev runner, server, and web output
 *   cad-state.json    the project's CAD state from the dev database after each step
 *   summary.json      step timings, what each step observed, and the Onshape requests used
 *   toasts.json       each sync's toasts as they changed, with the time since the click
 *   NN-*-toast-*.png  the sync toast at each new step it showed
 *
 *   ONSHAPE_CREDENTIAL_FILE=key.json node apps/server/scripts/onshape-cad-sync-e2e.ts \
 *     --url <onshape document or element url> --out .cadsense/onshape-sync-e2e/run [--flow refresh]
 *
 * The credential file is JSON with `accessKeyId` and `secretKey`. Verifying the connection uses 1
 * Onshape request and the catalog 2; a sync then downloads the model. The saved key is deleted from
 * --out when the run ends. Opening the chat starts an agent turn that is stopped as soon as it starts.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    url: { type: "string" },
    flow: { type: "string", default: "sync" },
  },
});
const credentialFile = process.env.ONSHAPE_CREDENTIAL_FILE;
if (
  !values.out ||
  !values.url ||
  !credentialFile ||
  (values.flow !== "sync" && values.flow !== "refresh")
)
  throw new Error(
    "Usage: ONSHAPE_CREDENTIAL_FILE=key.json --url <onshape url> --out <dir> [--flow sync|refresh]",
  );
const credentials = JSON.parse(NodeFS.readFileSync(credentialFile, "utf8")) as {
  accessKeyId: string;
  secretKey: string;
};

const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodePath.join(out, "home");

const summary: {
  flow: string;
  steps: { name: string; ms: number; observed?: unknown }[];
  onshapeRequests?: number | null;
  // The connection's yearly API call count the app saved, which should equal onshapeRequests.
  connectionApiCalls?: { year: number; used: number; limit: number } | null;
  failures: string[];
  ok: boolean;
} = { flow: values.flow, steps: [], failures: [], ok: false };
/** Records a failed expectation; the run then ends not ok, with every failure listed. */
const expect = (condition: boolean, failure: string) => {
  if (!condition) summary.failures.push(failure);
};
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const log = NodeFS.openSync(NodePath.join(out, "dev.log"), "a");
const dev = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", home],
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
  timeoutMs = 180_000,
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

/** Every file under `dir` whose name matches `pattern`. */
const findFiles = (dir: string, pattern: RegExp): string[] =>
  NodeFS.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => pattern.test(NodePath.basename(name)))
    .map((name) => NodePath.join(dir, name));
/** The CAD state of every project, read from the dev database. */
const cadStates: Record<string, unknown> = {};
const readCadState = (step: string) => {
  const states = findFiles(home, /^state\.sqlite$/).flatMap((file) => {
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      return db
        .prepare("SELECT title, cad_json FROM projection_projects WHERE deleted_at IS NULL")
        .all()
        .map((row) => ({
          title: row.title,
          cad: typeof row.cad_json === "string" ? JSON.parse(row.cad_json) : null,
        }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  });
  cadStates[step] = states;
  NodeFS.writeFileSync(
    NodePath.join(out, "cad-state.json"),
    `${JSON.stringify(cadStates, null, 2)}\n`,
  );
};
/** The yearly API usage the app saved for the run's one connection. */
const connectionApiCalls = () => {
  for (const file of findFiles(home, /^state\.sqlite$/)) {
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          'SELECT api_calls_year AS year, api_calls_used AS used, api_call_limit AS "limit" FROM onshape_connections',
        )
        .get() as { year: number; used: number; limit: number } | undefined;
      if (row) return { year: row.year, used: row.used, limit: row.limit };
    } catch {
    } finally {
      db.close();
    }
  }
  return null;
};
/** HTTP requests the server sent to Onshape, counted from its trace spans. Null with no traces. */
const onshapeRequests = () => {
  const lines = findFiles(home, /trace\.ndjson/).flatMap((file) =>
    NodeFS.readFileSync(file, "utf8").split("\n"),
  );
  if (!lines.some((line) => line.includes('"effect-span"'))) return null;
  return lines.filter((line) => line.includes('"name":"OnshapeTransport.execute"')).length;
};

const browser = await chromium.launch({
  ...(process.env.CADSENSE_CHROMIUM_PATH
    ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH }
    : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: NodePath.join(out, "video"), size: viewport },
});
const page = await context.newPage();
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
  readCadState(name);
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};
const panel = page.getByRole("region", { name: "CAD panel" });
const syncButton = page.getByRole("button", { name: /^(Sync|Syncing…)$/ });
const openRightPanel = async (page: Page) => {
  const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
};
/** What the CAD panel and its header show: the panel's text and whether Sync is there. */
const panelView = async (page: Page) => {
  await openRightPanel(page);
  await panel.waitFor({ timeout: 60_000 });
  // The panel loads the thread's CAD state before it settles on a message.
  await panel.getByText(/Loading|Preparing/).waitFor({ state: "detached", timeout: 30_000 });
  // Long enough for a viewer of the video to read the panel.
  await page.waitForTimeout(3000);
  return {
    panel: (await panel.innerText()).trim(),
    syncButtons: await syncButton.count(),
  };
};
// A new project opens on a draft whose right panel already shows the project's CAD. Sending a
// message turns the draft into a chat, and the app moves from the draft's URL to the chat's. The
// turn is stopped as soon as it starts.
const startThread = async (page: Page) => {
  const composer = page
    .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
    .first();
  for (let attempt = 0; !(await panel.isVisible()); attempt++) {
    if (attempt === 30) throw new Error("The draft's right panel never showed its CAD");
    await openRightPanel(page);
    await panel.waitFor({ timeout: 1_000 }).catch(() => {});
  }
  await composer.click();
  await page.keyboard.type("Open the CAD view.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL((next) => !next.pathname.startsWith("/draft/"), { timeout: 30_000 });
  await page
    .getByRole("button", { name: "Stop generation" })
    .click({ timeout: 15_000 })
    .catch(() => {});
  // Waits for the turn to end, as the server refuses CAD operations while it runs.
  await page
    .getByRole("button", { name: "Stop generation" })
    .waitFor({ state: "detached", timeout: 60_000 });
};

let threadUrl = url;
try {
  await run("add-connection", async (page) => {
    await page.goto(`${url}settings/integrations`, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add connection" }).first().click();
    const form = page.getByRole("form", { name: "Add Onshape connection" });
    await form.getByLabel("Name").fill("E2E Onshape");
    await form.getByLabel("Access key ID").fill(credentials.accessKeyId);
    await form.getByLabel("Secret key").fill(credentials.secretKey);
    await form.getByRole("button", { name: "Save and verify" }).click();
    await form.waitFor({ state: "detached", timeout: 60_000 });
    await page.getByText("E2E Onshape").first().waitFor();
  });
  await run("create-project", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Onshape document" }).click();
    const form = page.getByRole("form", { name: "Create Onshape project" });
    const connection = form.getByLabel("Connection");
    await waitFor("the connection list", async () =>
      (await connection.locator("option").count()) > 1 ? true : undefined,
    );
    await connection.selectOption({ index: 1 });
    await form.getByLabel("Project name").fill("Telescope");
    await form.getByLabel("Onshape URL").fill(values.url!);
    await page.waitForTimeout(1000);
    await form.getByRole("button", { name: "Create project" }).click();
    await page
      .getByRole("dialog", { name: /^(Add project|New (CAD|Onshape) project)$/ })
      .waitFor({ state: "detached" });
  });
  await run("panel-new-project", async (page) => {
    await startThread(page);
    threadUrl = page.url();
    return panelView(page);
  });
  if (values.flow === "sync") {
    const toastTimeline: Record<string, { ms: number; title: string; description: string }[]> = {};
    /**
     * Clicks Sync and records the sync's toast until it stops loading: every text it showed, and
     * a screenshot at each new step. Returns the toast's final title and description.
     */
    const syncWithToast = async (page: Page, name: string) => {
      const timeline: { ms: number; title: string; description: string }[] = [];
      toastTimeline[name] = timeline;
      const toast = page.locator('[data-slot="toast-title"]', { hasText: /Sync|sync|up to date/ });
      const started = Date.now();
      await syncButton.click();
      let steps = 0;
      for (;;) {
        const root = toast.first().locator("xpath=ancestor::*[@data-type][1]");
        const visible = await root.isVisible().catch(() => false);
        if (visible) {
          const type = await root.getAttribute("data-type");
          const title = (await toast.first().innerText()).trim();
          const description = (
            await root
              .locator('[data-slot="toast-description"]')
              .innerText()
              .catch(() => "")
          ).trim();
          const last = timeline.at(-1);
          if (!last || last.title !== title || last.description !== description) {
            timeline.push({ ms: Date.now() - started, title, description });
            // The step's sentence, not its counters, decides a new screenshot.
            const sentence = description.split(/[.\d]/)[0];
            if (!last || last.description.split(/[.\d]/)[0] !== sentence || type !== "loading")
              await page.screenshot({
                path: NodePath.join(
                  out,
                  `${String(shots + 1).padStart(2, "0")}-${name}-toast-${++steps}.png`,
                ),
              });
          }
          if (type !== "loading") return { title, description, timeline };
        }
        if (Date.now() - started > 10 * 60_000) throw new Error(`${name} never finished`);
        await page.waitForTimeout(250);
      }
    };
    await run("sync", async (page) => {
      await syncButton.hover();
      await page.waitForTimeout(1500);
      const result = await syncWithToast(page, "sync");
      await panel
        .locator("canvas")
        .first()
        .waitFor({ timeout: 10 * 60_000 });
      await page.waitForTimeout(5000);
      const loadingTexts = result.timeline.slice(0, -1).map((entry) => entry.description);
      expect(
        result.timeline.some((entry) => entry.title.startsWith("Syncing ")),
        "The sync never showed a loading toast",
      );
      expect(
        new Set(loadingTexts.map((text) => text.split(/[.\d]/)[0])).size >= 3,
        `The loading toast showed fewer than 3 steps: ${JSON.stringify(loadingTexts)}`,
      );
      expect(result.title.endsWith(" synced"), `The sync ended with "${result.title}"`);
      expect(
        /remaining this year/.test(result.description),
        "The finished sync does not say how many calls remain",
      );
      expect(
        !/API call/.test(result.timeline.map((entry) => entry.description).join(" ")),
        "The sync showed its call count with the setting off",
      );
      return { panel: (await panel.innerText()).trim(), toast: result };
    });
    await run("turn-on-api-calls", async (page) => {
      await page.goto(`${url}settings/appearance`, { waitUntil: "networkidle" });
      const toggle = page.getByRole("switch", { name: "Show Onshape API calls per sync" });
      await toggle.click();
      await waitFor("the setting to save", async () =>
        (await toggle.getAttribute("aria-checked")) === "true" ? true : undefined,
      );
      await page.goto(threadUrl, { waitUntil: "networkidle" });
      return panelView(page);
    });
    await run("sync-unchanged", async (page) => {
      const before = connectionApiCalls();
      const result = await syncWithToast(page, "sync-unchanged");
      await page.waitForTimeout(3000);
      const after = connectionApiCalls();
      const used =
        /Used (\d+) API call/.exec(result.timeline.at(-1)!.description) ??
        /^(\d+) API call/m.exec(result.description);
      const remaining = /([\d,]+) remaining this year/.exec(result.description);
      expect(
        result.title.endsWith("already up to date"),
        `The unchanged sync said "${result.title}"`,
      );
      expect(
        used !== null,
        `The toast does not show the calls the sync used: ${result.description}`,
      );
      expect(
        before !== null &&
          after !== null &&
          used !== null &&
          after.used - before.used === Number(used[1]),
        `The toast says ${used?.[1]} calls, but the saved count went from ${before?.used} to ${after?.used}`,
      );
      expect(
        after !== null &&
          remaining !== null &&
          Number(remaining[1]!.replaceAll(",", "")) === after.limit - after.used,
        `The toast says ${remaining?.[1]} remain, but ${after?.limit} - ${after?.used} do`,
      );
      return { toast: result, before, after };
    });
    await run("connection-usage", async (page) => {
      await page.goto(`${url}settings/integrations`, { waitUntil: "networkidle" });
      const usage = page.getByText(/API calls used by cadsense in \d{4}/).first();
      await usage.waitFor({ timeout: 30_000 });
      await usage.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      const text = (await usage.innerText()).trim();
      const saved = connectionApiCalls();
      expect(
        saved !== null && text.startsWith(`${saved.used.toLocaleString("en-US")} of 2,500`),
        `The connection card says "${text}", but the app saved ${JSON.stringify(saved)}`,
      );
      return { card: text };
    });
    NodeFS.writeFileSync(
      NodePath.join(out, "toasts.json"),
      `${JSON.stringify(toastTimeline, null, 2)}\n`,
    );
  } else {
    await run("refresh-catalog", async (page) => {
      const settings = page.getByRole("button", { name: /^Project settings for / }).first();
      await settings.hover({ force: true });
      await settings.click({ force: true });
      const refresh = page.getByRole("button", { name: "Refresh CAD catalog" });
      await refresh.scrollIntoViewIfNeeded();
      const section = refresh.locator("xpath=ancestor::section[1]");
      await page.waitForTimeout(1500);
      await refresh.click();
      await section.getByText("CAD catalog refreshed.").waitFor({ timeout: 90_000 });
      // A user who expects a download presses Refresh again; it only lists the same CAD.
      await page.waitForTimeout(2000);
      await refresh.click();
      await page.waitForTimeout(4000);
      return { settings: (await section.innerText()).split("\n") };
    });
    await run("panel-after-refresh", async (page) => {
      await page.goto(threadUrl, { waitUntil: "networkidle" });
      return panelView(page);
    });
  }
  summary.ok = pageErrors.length === 0;
} finally {
  summary.onshapeRequests = onshapeRequests();
  summary.connectionApiCalls = connectionApiCalls();
  // Every request in a clean run succeeds, and Onshape bills each one, so the counts must agree.
  if (summary.onshapeRequests !== null && summary.connectionApiCalls !== null)
    expect(
      summary.onshapeRequests === summary.connectionApiCalls.used,
      `The traces show ${summary.onshapeRequests} Onshape requests, but the app counted ${summary.connectionApiCalls.used}`,
    );
  summary.ok &&= summary.failures.length === 0;
  summary.steps.push({ name: "page-errors", ms: 0, observed: pageErrors });
  writeSummary();
  const video = page.video();
  await context.close();
  await video?.saveAs(NodePath.join(out, "flow.webm"));
  NodeFS.rmSync(NodePath.join(out, "video"), { recursive: true, force: true });
  await browser.close();
  stopDev();
  // The run's data directory keeps the connection's key; it is not evidence.
  NodeFS.rmSync(NodePath.join(home, "userdata/secrets"), { recursive: true, force: true });
}
console.log(summary.ok ? `Done. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
