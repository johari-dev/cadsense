// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of how a user's feedback reaches usage analytics, through the real app. Starts
 * the dev server and web app on a fresh data directory with a PostHog key pointed at a fake ingest,
 * drives headless Chromium through one real agent turn and a thumbs down with a reason and a note
 * the user chooses to send, and keeps the evidence under --out:
 *
 *   NN-*.png            a screenshot after each step
 *   dev.log             dev runner, server, and web output
 *   requests.jsonl      every request the fake ingest received
 *   analytics-state.json  the server's saved counts after the rating
 *   summary.json        each check with pass/fail and the values it compared
 *
 *   node apps/server/scripts/feedback-e2e.ts --out .cadsense/feedback-e2e/run [--model "Haiku 5.5"]
 *
 * It runs a real agent turn with the model the picker's search finds for --model, so that
 * provider must be signed in on this machine, and the turn costs a few tokens.
 *
 * Checks:
 *   - a signed-in provider reaches the `first_provider_ready` milestone
 *   - the thumbs down counts once in `ratings_down`, although the popover saves the rating twice
 *     (once on click, again with its reason)
 *   - the reason counts once in `ratings_down_too_long`
 *   - the note, with "Send this note to the Cadsense team" ticked, arrives once as `feedback.sent`
 *   - a later note without the box ticked never reaches the ingest
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: { out: { type: "string" }, model: { type: "string" } },
});
if (!values.out) throw new Error('Usage: --out <dir> [--model "Haiku 5.5"]');
const model = values.model ?? "Haiku 5.5";
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodePath.join(out, "home");
const statePath = NodePath.join(home, "userdata/analytics-state.json");
const NOTE = "Cut the preamble and lead with the answer.";
const PRIVATE_NOTE = "This one stays on my machine.";

// A project folder with one small STEP file, so the project needs no Onshape account.
const folder = NodePath.join(out, "bracket-rig");
const stepName = "bracket.step";
NodeFS.mkdirSync(folder, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);

interface CapturedEvent {
  readonly event: string;
  readonly properties: Record<string, unknown>;
}
const events: CapturedEvent[] = [];
const ingest = NodeHttp.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  request.on("end", () => {
    const parsed = JSON.parse(body || "{}") as { batch?: CapturedEvent[] };
    events.push(...(parsed.batch ?? []));
    NodeFS.appendFileSync(NodePath.join(out, "requests.jsonl"), `${body}\n`);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
const ingestAddress = ingest.address();
if (ingestAddress === null || typeof ingestAddress === "string") throw new Error("no ingest port");

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
  {
    cwd: repo,
    stdio: ["ignore", log, log],
    detached: true,
    env: {
      ...process.env,
      CADSENSE_POSTHOG_KEY: "phc_feedback_e2e",
      CADSENSE_POSTHOG_HOST: `http://127.0.0.1:${ingestAddress.port}`,
      CADSENSE_TELEMETRY_ENABLED: "true",
    },
  },
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

interface SavedState {
  readonly counts: Record<string, number>;
  readonly milestones: ReadonlyArray<string>;
}
const readState = (): SavedState | undefined =>
  NodeFS.existsSync(statePath)
    ? (JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as SavedState)
    : undefined;

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
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, observed ?? "");
};

try {
  await run("project-created", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Local CAD file" }).click();
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "detached" });
  });

  await run("agent-answered", async (page) => {
    // The model picker is the composer's only button that shows text: the current model's name.
    await page
      .locator('[data-chat-composer-form="true"] button')
      .filter({ hasText: /\S/ })
      .first()
      .click();
    // The model's provider may not be the open tab, so search under each tab until it lists one.
    const search = page.getByRole("textbox", { name: "Search models" });
    const tabs = page.getByRole("tablist", { name: "Model sources" }).getByRole("tab");
    await search.waitFor();
    for (let index = 1; ; index++) {
      if (index >= (await tabs.count())) throw new Error(`No provider lists ${model}`);
      await tabs.nth(index).click();
      await search.fill(model);
      if (
        await page
          .locator("[data-model-picker-row]")
          .first()
          .waitFor({ timeout: 3_000 })
          .then(
            () => true,
            () => false,
          )
      )
        break;
    }
    await page.locator("[data-model-picker-row]").first().click();
    const composer = page
      .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
      .first();
    const stop = page.getByRole("button", { name: "Stop generation" });
    // A message can't start a turn while the project's first import runs, so keep sending.
    const deadline = Date.now() + 5 * 60_000;
    while (!(await stop.isVisible())) {
      if (Date.now() > deadline) throw new Error("Sending never started a turn");
      if (!(await composer.innerText()).trim()) {
        await composer.click();
        await page.keyboard.type("Reply with the single word OK.");
      }
      await page.getByRole("button", { name: "Send message" }).click();
      await stop.waitFor({ timeout: 5_000 }).catch(() => {});
    }
    await stop.waitFor({ state: "detached", timeout: 5 * 60_000 });
  });

  await run("thumbs-down-reason", async (page) => {
    const thumbsDown = page.getByRole("button", { name: "Bad response" }).last();
    await thumbsDown.hover({ force: true });
    await thumbsDown.click({ force: true });
    await page.getByRole("button", { name: "Too long" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill(NOTE);
    await page.getByText("Send this note to the Cadsense team").click();
    await page.screenshot({ path: NodePath.join(out, "thumbs-down-popover.png") });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("What went wrong?").waitFor({ state: "detached" });
  });

  // Counts are saved every 10 seconds. Wait for the reason, then one more save, so a second
  // thumbs down counted by the reason's save would show up too.
  const state = await waitFor(
    "the reason's count",
    () => {
      const saved = readState();
      return (saved?.counts.ratings_down_too_long ?? 0) > 0 ? saved : undefined;
    },
    60_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  const settled = readState() ?? state;
  NodeFS.writeFileSync(
    NodePath.join(out, "analytics-state.json"),
    `${JSON.stringify(settled, null, 2)}\n`,
  );
  check(
    "the thumbs down counts once, although it was saved twice",
    settled.counts.ratings_down === 1,
    {
      ratings_down: settled.counts.ratings_down,
    },
  );
  check("its reason counts once", settled.counts.ratings_down_too_long === 1, {
    ratings_down_too_long: settled.counts.ratings_down_too_long,
  });
  check(
    "a signed-in provider reaches first_provider_ready",
    settled.milestones.includes("first_provider_ready") &&
      events.some(
        (event) =>
          event.event === "milestone.reached" &&
          event.properties.milestone === "first_provider_ready",
      ),
    { milestones: settled.milestones },
  );
  const notes = events.filter((event) => event.event === "feedback.sent");
  check(
    "the ticked note arrives once as feedback.sent, with its reason",
    notes.length === 1 &&
      notes[0]?.properties.note === NOTE &&
      notes[0]?.properties.reason === "too-long",
    { notes: notes.map((event) => event.properties) },
  );

  // Clear the rating, then rate again with a note the box isn't ticked for.
  await run("thumbs-down-private-note", async (page) => {
    const thumbsDown = page.getByRole("button", { name: "Bad response" }).last();
    await thumbsDown.click({ force: true });
    await page.locator('button[aria-label="Bad response"][aria-pressed="false"]').last().waitFor();
    await thumbsDown.click({ force: true });
    await page.getByRole("textbox", { name: "Note" }).fill(PRIVATE_NOTE);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("What went wrong?").waitFor({ state: "detached" });
  });
  // Notes go out on the server's next one-second tick; give it several.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  check(
    "a note without the box ticked is never sent",
    events.filter((event) => event.event === "feedback.sent").length === 1 &&
      !NodeFS.readFileSync(NodePath.join(out, "requests.jsonl"), "utf8").includes(PRIVATE_NOTE),
  );
  check("the page had no errors", pageErrors.length === 0, { pageErrors });
  summary.ok = summary.checks.every((entry) => entry.pass);
} finally {
  writeSummary();
  await browser.close();
  ingest.close();
  stopDev();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
