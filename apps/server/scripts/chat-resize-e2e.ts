// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
/**
 * End-to-end check that the chat holds still while its width changes. Seeds a long chat into a
 * fresh data directory, starts the dev server and web app on it, and drives headless Chromium
 * through three width changes: a window resize in steps, the sidebar closing and opening, and the
 * right panel opening and closing. Each runs twice:
 *
 *   - following the end: the last row must stay where it sits above the composer, every frame
 *   - reading history: the line being read (mid-paragraph) must move at most a line, every frame
 *
 * A fourth scenario switches to another chat and back, which must land at the end without a jump.
 * The last checks the scroll length is right as soon as the chat opens and as soon as a resize
 * settles, before the rows off screen have been scrolled past.
 *
 * A sampler in the page records the scroll geometry after every painted frame, so a one-frame
 * jump or a blank frame shows up in the numbers even when the end state looks right.
 *
 *   node apps/server/scripts/chat-resize-e2e.ts --out .cadsense/chat-resize/run \
 *     [--only window-resize-following] [--repeat 5] [--record --label "After"]
 *
 * --record captures every painted frame of each scenario through Chrome's screencast and draws
 * guides into the page: reading scenarios highlight the read words and box the line where they
 * started; following scenarios outline the last message and mark the composer's top in red.
 * `--label` names the run in a badge on every frame.
 *
 * No provider account is used. Evidence under --out:
 *
 *   NN-*.png        a screenshot after each scenario
 *   frames/*.json   every sampled frame of each scenario
 *   video/*.webm    a recording of the whole run (without --record)
 *   screencast/<scenario>/*.jpg, frames.json   every painted frame and its time (--record)
 *   screencast/<scenario>.mp4                   those frames at 1/8 speed (--record, needs ffmpeg)
 *   dev.log         dev runner, server, and web output
 *   summary.json    each scenario's worst frame and settled position, and the checks
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@cadsense/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { parseE2eArgs, runE2e } from "./e2e-harness.ts";

const { out, values: flags } = parseE2eArgs(
  "--out <dir> [--only <scenario>] [--repeat <n>] [--record] [--label <text>]",
  {
    only: { type: "string" },
    repeat: { type: "string" },
    record: { type: "boolean" },
    label: { type: "string" },
    "cpu-slowdown": { type: "string" },
  },
);
/** How much slower than real time the --record videos play. */
const SLOW_MOTION = 8;
/** How much --record slows the page's CPU, so the screencast captures every painted frame. */
const CPU_SLOWDOWN = Number(flags["cpu-slowdown"] ?? 4);
/** Runs of each scenario, to catch a jump that shows up only on some runs. */
const REPEAT = Math.max(1, Number(flags.repeat ?? 1));
const home = NodePath.join(out, "home");
const THREAD_TITLE = "Resize fixture";
/** A second, shorter chat the thread-switch scenario moves to and back from. */
const OTHER_THREAD_TITLE = "Switch fixture";
const TURNS = 14;
/** The turn whose long paragraph the reading scenarios keep in view. */
const READ_TURN = 7;

/** A long assistant reply: paragraphs that re-wrap at every width, a list, and a code block. */
const assistantText = (turn: number) =>
  [
    `Turn ${turn} answer. ${"The bracket holds the shaft with two bolts, and the slot leaves room for the belt to tension. ".repeat(6)}`,
    `Reading paragraph ${turn}. ${"This sentence keeps going so the paragraph spans many lines at any chat width, which is what a width change re-wraps. ".repeat(8)}`,
    ["- Check the bolt spacing", "- Check the slot length", "- Check the belt clearance"].join(
      "\n",
    ),
    "```ts\nconst clearance = slotLength - beltWidth;\nconsole.log(clearance);\n```",
    `Closing note ${turn}. ${"Wall thickness stays above the minimum everywhere. ".repeat(4)}`,
  ].join("\n\n");

/**
 * Writes one project and two finished chats into the state database the dev server opens, through
 * the orchestration engine, so the server projects them like any other chat when it starts.
 */
const seedChat = async () => {
  // The sidebar lists only projects with CAD, so the chat lives in a local CAD project. Its file
  // is never imported: the chat is all this script needs.
  const workspace = NodePath.join(out, "bracket-rig");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.copyFileSync(
    repoRelative("apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
    NodePath.join(workspace, "bracket.step"),
  );
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    // The dev runner's --home-dir is an explicit base dir, whose state lives under userdata/.
    Layer.provide(makeSqlitePersistenceLive(NodePath.join(home, "userdata", "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(repoRelative("."), { prefix: "chat-resize-seed-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  let clock = Date.parse("2026-11-01T12:00:00.000Z");
  const at = () => new Date((clock += 1000)).toISOString();
  let commands = 0;
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  const commandId = () => CommandId.make(`seed-${++commands}`);
  const projectId = ProjectId.make("resize-project");
  const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku" };

  await dispatch({
    type: "project.local-cad.create",
    commandId: commandId(),
    projectId,
    title: "Resize project",
    workspaceRoot: workspace,
    defaultModelSelection: modelSelection,
    localCadSource: { filePath: "bracket.step" },
    createdAt: at(),
  });
  /** Message, turn, and thread ids start with `prefix`, so two chats never share one. */
  const seedThread = async (prefix: string, title: string, turns: number) => {
    const threadId = ThreadId.make(`${prefix}thread`);
    await dispatch({
      type: "thread.create",
      commandId: commandId(),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: at(),
    });
    for (let turn = 1; turn <= turns; turn++) {
      const userMessageId = MessageId.make(`${prefix}user-${turn}`);
      const assistantMessageId = MessageId.make(`${prefix}assistant-${turn}`);
      const turnId = TurnId.make(`${prefix}turn-${turn}`);
      await dispatch({
        type: "thread.turn.start",
        commandId: commandId(),
        threadId,
        message: {
          messageId: userMessageId,
          role: "user",
          text: `Question ${turn}: does the bracket still fit after the change?`,
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: at(),
      });
      await dispatch({
        type: "thread.turn.start.settle",
        commandId: commandId(),
        threadId,
        messageId: userMessageId,
        turnId,
      });
      await dispatch({
        type: "thread.message.assistant.delta",
        commandId: commandId(),
        threadId,
        messageId: assistantMessageId,
        delta: assistantText(turn),
        turnId,
        createdAt: at(),
      });
      await dispatch({
        type: "thread.message.assistant.complete",
        commandId: commandId(),
        threadId,
        messageId: assistantMessageId,
        turnId,
        createdAt: at(),
      });
      await dispatch({
        type: "thread.turn.lifecycle.settle",
        commandId: commandId(),
        threadId,
        turnId,
      });
    }
  };
  await seedThread("other-", OTHER_THREAD_TITLE, 6);
  await seedThread("", THREAD_TITLE, TURNS);
  await runtime.dispose();
};

function repoRelative(path: string) {
  return NodePath.resolve(import.meta.dirname, "../../..", path);
}

/**
 * Installs `window.__chatResize` in the page. `start(mode)` records a frame on every animation
 * frame until `stop()` returns them. A frame holds:
 *
 *   endGap      last row's bottom minus the composer's top (following-end mode)
 *   anchorTop   the read point's top minus the scroller's top (reading mode)
 *   visibleRows rows painted between the scroller's top and the composer
 *
 * The page script is plain text because this package has no DOM types.
 */
const SAMPLER = String.raw`
(() => {
  // The app keeps the text 24px below the top in place (preserveReadingPosition), so the read
  // line starts above that point and covers it.
  const READ_LINE_TOP = 16;
  const scrollerOf = (row) => {
    for (let node = row.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  };
  const rows = () => Array.from(document.querySelectorAll("[data-timeline-row-id]"));
  const composer = () => document.querySelector('[data-chat-composer-form="true"]');
  let frames = [];
  let running = false;
  let anchor = null;
  const readPoint = () => {
    const body = Array.from(document.querySelectorAll('[data-message-id="assistant-${READ_TURN}"]'))[0];
    if (!body) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent || "").startsWith("Reading paragraph")) {
        const range = document.createRange();
        // Mid-paragraph: native scroll anchoring keeps the paragraph's start, not this line.
        range.setStart(node, Math.floor((node.textContent || "").length * 0.6));
        range.collapse(true);
        return range;
      }
    }
    return null;
  };
  const sample = () => {
    const all = rows();
    const last = all[all.length - 1];
    const scroller = last ? scrollerOf(last) : null;
    const form = composer();
    if (!scroller || !form) return { missing: true };
    const box = scroller.getBoundingClientRect();
    const composerTop = form.getBoundingClientRect().top;
    const visibleRows = all.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < composerTop && rect.height > 0;
    }).length;
    // The lowest rendered row: at the end of a chat, its last one.
    const lastRow = all.reduce(
      (lowest, row) =>
        !lowest || row.getBoundingClientRect().bottom > lowest.getBoundingClientRect().bottom ? row : lowest,
      null,
    );
    const frame = {
      t: Math.round(performance.now()),
      width: Math.round(box.width),
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      visibleRows,
      endGap: lastRow ? Math.round(lastRow.getBoundingClientRect().bottom - composerTop) : null,
      path: location.pathname,
      anchorTop: null,
    };
    if (anchor && anchor.startContainer.isConnected) {
      frame.anchorTop = Math.round(anchor.getBoundingClientRect().top - box.top);
    }
    return frame;
  };
  // Animation frame callbacks run before the frame's layout and resize observers, so a read there
  // can see rows re-wrapped but not yet repositioned, which is never painted. A task posted from
  // one runs after that frame paints, and reads what the user saw.
  const afterPaint = new MessageChannel();
  afterPaint.port1.onmessage = () => {
    if (!running) return;
    frames.push(sample());
    requestAnimationFrame(tick);
  };
  const tick = () => {
    if (running) afterPaint.port2.postMessage(null);
  };
  window.__chatResize = {
    scroller: () => scrollerOf(rows()[rows().length - 1]),
    readPoint,
    sample,
    /**
     * Scrolls so the read point sits on the first full line in view, the line a reader resumes
     * from. Lines further down move apart as the text between them re-wraps, at any width.
     */
    placeReadPoint: () => {
      const range = readPoint();
      const scroller = scrollerOf(rows()[rows().length - 1]);
      if (!range || !scroller) return null;
      scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - READ_LINE_TOP;
      return Math.round(range.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    },
    start: (mode) => {
      frames = [];
      anchor = mode === "reading" ? readPoint() : null;
      running = true;
      requestAnimationFrame(tick);
    },
    stop: () => {
      running = false;
      return frames;
    },
    /** Draws the --record guides. They are fixed or paint-only, so they never change layout. */
    showGuides: (mode, label) => {
      const layer = document.createElement("div");
      layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      const badge = document.createElement("div");
      badge.textContent = label;
      badge.style.cssText =
        "position:absolute;right:16px;bottom:16px;padding:6px 14px;border-radius:6px;background:#000;color:#fff;font:600 20px system-ui,sans-serif;border:2px solid #fff";
      layer.append(badge);
      const style = document.createElement("style");
      if (mode === "reading" && anchor) {
        const node = anchor.startContainer;
        const offset = anchor.startOffset;
        const words = document.createRange();
        words.setStart(node, Math.max(0, offset - 30));
        words.setEnd(node, Math.min(node.length, offset + 30));
        CSS.highlights.set("chat-resize-read", new Highlight(words));
        style.textContent = "::highlight(chat-resize-read){background-color:#facc15;color:#000}";
        const lineHeight = parseFloat(getComputedStyle(node.parentElement).lineHeight) || 21;
        const band = document.createElement("div");
        band.style.cssText =
          "position:absolute;left:0;right:0;top:" + (anchor.getBoundingClientRect().top - 3) +
          "px;height:" + (lineHeight + 2) + "px;border-top:2px solid #ef4444;border-bottom:2px solid #ef4444";
        layer.append(band);
      } else {
        style.textContent =
          '[data-message-id="assistant-${TURNS}"]{outline:2px solid #22d3ee;outline-offset:-2px}' +
          '[data-chat-composer-form="true"]{box-shadow:0 -3px 0 #ef4444 !important}';
      }
      document.head.append(style);
      document.body.append(layer);
      window.__chatResizeGuides = () => {
        CSS.highlights.delete("chat-resize-read");
        style.remove();
        layer.remove();
      };
    },
    hideGuides: () => window.__chatResizeGuides?.(),
  };
})();
`;

type Mode = "following" | "reading";
interface Frame {
  readonly t: number;
  readonly width: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly visibleRows: number;
  readonly endGap: number | null;
  readonly anchorTop: number | null;
  readonly missing?: true;
}

const frames = (page: Page, count = 1) =>
  page.evaluate(
    `new Promise((resolve) => { let left = ${count}; const next = () => (--left <= 0 ? resolve(null) : requestAnimationFrame(next)); requestAnimationFrame(next); })`,
  );
const sample = (page: Page) => page.evaluate("window.__chatResize.sample()") as Promise<Frame>;

/**
 * Starts capturing every frame Chrome paints into <out>/screencast/<name>/. The returned function
 * stops, writes frames.json (file and paint time of each), and renders <name>.mp4 at 1/8 speed
 * with each frame held for its real duration, so a one-frame jump stays on screen long enough
 * to see.
 */
const startScreencast = async (context: BrowserContext, page: Page, name: string) => {
  const dir = NodePath.join(out, "screencast", name);
  NodeFS.mkdirSync(dir, { recursive: true });
  const cdp = await context.newCDPSession(page);
  const shots: { readonly file: string; readonly timestamp: number }[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    // Ack first: Chrome holds the next frame until the last one is acked.
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    const file = `${String(shots.length).padStart(5, "0")}.jpg`;
    shots.push({ file, timestamp: frame.metadata.timestamp ?? 0 });
    NodeFS.writeFileSync(NodePath.join(dir, file), Buffer.from(frame.data, "base64"));
  });
  // Chrome's screencast delivers about 20 frames a second here, fewer than the page paints. A
  // slower renderer paints fewer frames through the same layout, resize observer, and paint
  // steps, so the screencast can keep every one.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
    NodeFS.writeFileSync(NodePath.join(dir, "frames.json"), `${JSON.stringify(shots, null, 1)}\n`);
    const list = shots.flatMap((shot, index) => {
      const next = shots[index + 1];
      const seconds = next ? (next.timestamp - shot.timestamp) * SLOW_MOTION : 1;
      return [`file '${NodePath.join(dir, shot.file)}'`, `duration ${seconds.toFixed(4)}`];
    });
    // The concat demuxer drops the last entry's duration unless the file is listed again.
    const last = shots.at(-1);
    if (last) list.push(`file '${NodePath.join(dir, last.file)}'`);
    NodeFS.writeFileSync(NodePath.join(dir, "concat.txt"), `${list.join("\n")}\n`);
    const ffmpeg = NodeChildProcess.spawnSync(
      "ffmpeg",
      [
        ...["-y", "-loglevel", "error", "-f", "concat", "-safe", "0"],
        ...["-i", NodePath.join(dir, "concat.txt")],
        // The window-resize scenario changes the frame size; keep the left edge where it is.
        ...[
          "-vf",
          "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:0:0,fps=30,format=yuv420p",
        ],
        ...["-c:v", "libx264", "-crf", "20", NodePath.join(out, "screencast", `${name}.mp4`)],
      ],
      { encoding: "utf8" },
    );
    if (ffmpeg.error || ffmpeg.status !== 0)
      console.log(`Skipped ${name}.mp4: ${ffmpeg.error?.message ?? ffmpeg.stderr}`);
    return shots.length;
  };
};

await runE2e(out, async (run) => {
  await seedChat();
  const app = await run.startDevApp({ home });
  const browser = await run.launchChromium();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Playwright records through the same screencast --record uses, so only one runs.
    ...(flags.record
      ? {}
      : { recordVideo: { dir: NodePath.join(out, "video"), size: { width: 1440, height: 900 } } }),
  });
  run.defer(() => context.close());
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const step = run.screenshotSteps(page);
  NodeFS.mkdirSync(NodePath.join(out, "frames"), { recursive: true });

  let openedScrollLength = 0;
  await step("opened-chat", async (page) => {
    await page.goto(app.url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2_000 })
      .catch(() => {});
    await page.getByText(THREAD_TITLE, { exact: true }).first().click({ timeout: 30_000 });
    await page.locator(`[data-message-id="assistant-${TURNS}"]`).waitFor({ timeout: 30_000 });
    await page.evaluate(SAMPLER);
    // Long enough for the rows off screen to be measured in idle time.
    await frames(page, 90);
    const opened = await sample(page);
    openedScrollLength = opened.scrollHeight;
    return opened;
  });

  const atEnd = async () => {
    const before = await sample(page);
    if (before.endGap !== null && Math.abs(before.endGap) < 400) return;
    // Scrolling down to the end re-arms following the live end.
    await page.mouse.move(700, 400);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 4000);
    await frames(page, 30);
  };
  const reading = async () => {
    await page.mouse.move(700, 400);
    // Wheeling up releases end-follow, as a reader scrolling back would, and brings the read
    // turn's row into the rendered window.
    for (let attempt = 0; attempt < 30; attempt++) {
      const top = (await page.evaluate(
        `(() => { const row = document.querySelector('[data-message-id="assistant-${READ_TURN}"]'); return row ? row.getBoundingClientRect().top : null; })()`,
      )) as number | null;
      if (top !== null && top > -2000 && top < 400) break;
      await page.mouse.wheel(0, -900);
      await frames(page, 4);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate("window.__chatResize.placeReadPoint()");
      await frames(page, 10);
    }
  };

  // The chat lane stops growing at about 650px, so each driver starts at a window width where
  // its change crosses that and re-wraps the text. Below 768px the sidebar turns into a sheet.
  interface Driver {
    readonly name: string;
    readonly windowWidth: number;
    readonly modes: readonly Mode[];
    readonly drive: () => Promise<void>;
  }
  const drivers: Driver[] = [
    {
      name: "window-resize",
      windowWidth: 1100,
      modes: ["following", "reading"],
      drive: async () => {
        // A window edge dragged in, then out again, one width per frame.
        for (const width of [
          ...Array.from({ length: 16 }, (_, i) => 1100 - i * 20),
          ...Array.from({ length: 16 }, (_, i) => 800 + i * 20),
        ]) {
          await page.setViewportSize({ width, height: 900 });
          await frames(page);
        }
        await page.setViewportSize({ width: 1100, height: 900 });
      },
    },
    {
      name: "sidebar-toggle",
      windowWidth: 820,
      modes: ["following", "reading"],
      drive: async () => {
        const trigger = page.locator('[data-sidebar="trigger"]:visible').first();
        await trigger.click();
        await frames(page, 45);
        await page.locator('[data-sidebar="trigger"]:visible').first().click();
      },
    },
    {
      name: "right-panel-toggle",
      windowWidth: 1440,
      modes: ["following", "reading"],
      drive: async () => {
        const toggle = page.getByRole("button", { name: /^Toggle right panel/ }).first();
        if (await toggle.isDisabled()) throw new Error("The right panel toggle is disabled");
        await toggle.click();
        await frames(page, 45);
        await toggle.click();
      },
    },
    {
      // Not a width change: opening a chat must land at its end, not scroll or jump there.
      name: "thread-switch",
      windowWidth: 1440,
      modes: ["following"],
      drive: async () => {
        await page.getByText(OTHER_THREAD_TITLE, { exact: true }).first().click();
        await frames(page, 60);
        await page.getByText(THREAD_TITLE, { exact: true }).first().click();
      },
    },
  ];

  const results: Record<string, unknown>[] = [];
  for (const driver of drivers) {
    for (const [mode, attempt] of driver.modes.flatMap((mode) =>
      Array.from({ length: REPEAT }, (_, attempt) => [mode, attempt] as const),
    )) {
      const scenario = `${driver.name}-${mode}`;
      if (flags.only !== undefined && flags.only !== scenario) continue;
      const name = REPEAT > 1 ? `${scenario}-${attempt + 1}` : scenario;
      await step(name, async () => {
        await page.setViewportSize({ width: driver.windowWidth, height: 900 });
        await frames(page, 30);
        if (mode === "following") await atEnd();
        else await reading();
        await frames(page, 10);
        await page.evaluate(`window.__chatResize.start(${JSON.stringify(mode)})`);
        if (flags.record)
          await page.evaluate(
            `window.__chatResize.showGuides(${JSON.stringify(mode)}, ${JSON.stringify(`${flags.label ?? "Run"} · ${scenario}`)})`,
          );
        const stopScreencast = flags.record
          ? await startScreencast(context, page, name)
          : undefined;
        await frames(page, 5);
        await driver.drive();
        // Let animations and late row measurements finish.
        await frames(page, 60);
        const recorded = (await page.evaluate("window.__chatResize.stop()")) as Frame[];
        const paintedFrames = await stopScreencast?.();
        if (flags.record) await page.evaluate("window.__chatResize.hideGuides()");
        NodeFS.writeFileSync(
          NodePath.join(out, "frames", `${name}.json`),
          `${JSON.stringify(recorded, null, 1)}\n`,
        );
        const measured = recorded.filter((frame) => !frame.missing);
        const baseline = measured[0];
        const settled = measured.at(-1);
        const key = mode === "following" ? "endGap" : "anchorTop";
        const values = measured.map((frame) => frame[key]);
        const base = baseline?.[key] ?? null;
        const offsets = values.map((value) =>
          value === null || base === null ? Number.POSITIVE_INFINITY : value - base,
        );
        let worstFrameJump = 0;
        for (let i = 1; i < values.length; i++) {
          const previous = values[i - 1];
          const current = values[i];
          if (previous == null || current == null) continue;
          worstFrameJump = Math.max(worstFrameJump, Math.abs(current - previous));
        }
        const result = {
          name,
          frames: recorded.length,
          missingFrames: recorded.length - measured.length,
          baseline: base,
          worstOffset: Math.max(...offsets.map(Math.abs)),
          settledOffset:
            settled?.[key] == null || base === null ? null : (settled[key] ?? 0) - base,
          worstFrameJump,
          blankFrames: measured.filter((frame) => frame.visibleRows === 0).length,
          ...(paintedFrames === undefined ? {} : { paintedFrames }),
        };
        results.push(result);
        return result;
      });
    }
  }

  // The scroll length must be right without scrolling first: as soon as a chat opens and as soon
  // as a resize settles, while most rows are still off screen.
  const scrollLength = async () => (await sample(page)).scrollHeight;
  /** Scrolls from the top to the end in small steps, so the list draws every row once. */
  const scrollThrough = async () => {
    await page.mouse.move(700, 400);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4000);
    await frames(page, 10);
    for (let i = 0; i < 100; i++) {
      await page.mouse.wheel(0, 500);
      await frames(page, 6);
      const frame = await sample(page);
      if (frame.scrollTop + frame.clientHeight >= frame.scrollHeight - 1) break;
    }
    await frames(page, 30);
    return scrollLength();
  };
  if (flags.only === undefined || flags.only === "scroll-length") {
    await step("scroll-length", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await frames(page, 60);
      const drawnAt1440 = await scrollThrough();
      await page.setViewportSize({ width: 820, height: 900 });
      await frames(page, 90);
      const resizedTo820 = await scrollLength();
      const drawnAt820 = await scrollThrough();
      await page.setViewportSize({ width: 1440, height: 900 });
      await frames(page, 30);
      const result = { openedAt1440: openedScrollLength, drawnAt1440, resizedTo820, drawnAt820 };
      run.check(
        "scroll-length: right as soon as a chat opens",
        Math.abs(openedScrollLength - drawnAt1440) <= 2,
        result,
      );
      run.check(
        "scroll-length: right as soon as a resize settles",
        Math.abs(resizedTo820 - drawnAt820) <= 2,
        result,
      );
      return result;
    });
  }

  for (const result of results) {
    const name = String(result.name);
    const following = name.includes("-following");
    const worst = Number(result.worstOffset);
    const settled =
      result.settledOffset === null ? Infinity : Math.abs(Number(result.settledOffset));
    run.check(
      `${name}: no blank frames`,
      result.blankFrames === 0 && result.missingFrames === 0,
      result,
    );
    if (following) {
      run.check(`${name}: the last row stays above the composer every frame`, worst <= 4, result);
      run.check(`${name}: the last row settles where it started`, settled <= 1, result);
    } else {
      // A line is 21px. The keeper holds the read line to within one line as text re-wraps.
      run.check(`${name}: the read line moves at most a line in any frame`, worst <= 30, result);
      run.check(`${name}: the read line settles near where it started`, settled <= 30, result);
    }
  }
  run.check("the page threw no errors", pageErrors.length === 0, { pageErrors });
});
