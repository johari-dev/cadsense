// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of the new thread view's backdrop through the real app. Starts the dev server
 * and web app on a fresh data directory, adds a local CAD project, and drives headless Chromium.
 * The ways the feature can fail, each of which a step below looks for:
 *
 *   - the hero is not near the pane's bottom
 *   - a CAD project with no saved backdrop shows nothing in the model's place
 *   - with the live model beside the chat, the dim copy stays, or the hero does not rise
 *   - the CAD panel never saves a backdrop, or saves one with an opaque background
 *   - the backdrop is captured at the panel's size and looks soft when drawn large
 *   - the dim copy lingers and slides while the CAD panel opens
 *   - the saved backdrop never shows once the panel closes
 *   - a short pane still draws art above the hero
 *   - a project with CAD turned off shows no dot grid, or the dots ignore the pointer
 *   - switching project swaps one model for the other with no cross-fade
 *   - switching to a project whose CAD panel is open snaps the panel while the hero slides
 *   - sending a message drops the hero text at once, or the composer jumps to the bottom
 *
 *   node apps/server/scripts/new-thread-backdrop-e2e.ts --out .cadsense/new-thread-backdrop/run \
 *     [--send [--model "Haiku"]]
 *
 * --send ends the run by sending one short message, to check the settle into a chat. It is a
 * real agent turn with --model (or the app's default model), so that provider must be signed in,
 * and it costs a few tokens.
 *
 * Evidence under --out:
 *
 *   NN-*.png        a screenshot after each step
 *   backdrop.webp   the backdrop the CAD panel saved, as the server keeps it
 *   dev.log         dev runner, server, and web output
 *   summary.json    what each step observed
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
  options: { out: { type: "string" }, send: { type: "boolean" }, model: { type: "string" } },
});
if (!values.out) throw new Error("Usage: --out <dir> [--send [--model <name>]]");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodePath.join(out, "home");
const folder = NodePath.join(out, "bracket-rig");
const stepName = "bracket.step";
NodeFS.mkdirSync(folder, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, stepName),
);
// A second project, for switching between two models.
const plateFolder = NodePath.join(out, "bolt-plate");
const plateName = "plate.step";
NodeFS.mkdirSync(plateFolder, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repo, "packages/featurescript/corpus/bolt-circle/plate.step"),
  NodePath.join(plateFolder, plateName),
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
// Records every slide the right panel starts, and how long the composer's dock runs. Both use
// the Web Animations API, so a wrapped `animate` sees each one. It runs in the page, and this
// package has no DOM types, so it is plain script text.
type Slide = { from: string; to: string };
await page.addInitScript(`
  window.__panelSlides = [];
  window.__heroDocks = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const animation = animate.call(this, keyframes, options);
    if (this instanceof HTMLElement && this.dataset.previewPanelMode && Array.isArray(keyframes))
      window.__panelSlides.push({ from: String(keyframes[0]?.width), to: String(keyframes[1]?.width) });
    if (Array.isArray(keyframes) && String(keyframes[0]?.transform).startsWith("translate3d"))
      window.__heroDocks.push(options?.duration);
    return animation;
  };
`);
const slides = () => page.evaluate<Slide[]>("window.__panelSlides");
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

/**
 * What the new thread view shows, measured in the page. This package has no DOM types, so the
 * probe is plain script text. `heroGap` is the space between the hero and the pane's bottom,
 * and `heroBelowCenter` is how far the hero's middle sits below the pane's, both in rem.
 */
type Probe = {
  backdrop: boolean;
  dots: boolean;
  dotsVisible: boolean;
  outlineVisible: boolean;
  image: null | { loaded: boolean; opacity: number; visible: boolean; width: number };
  heroGap: number;
  heroBelowCenter: number;
};
const probe = () =>
  page.evaluate<Probe>(`(() => {
    const pane = document.querySelector('[data-chat-workspace-drop-target="true"]').getBoundingClientRect();
    const hero = document.querySelector('[data-chat-composer-overlay="true"] > div').getBoundingClientRect();
    const backdrop = document.querySelector("[data-draft-hero-backdrop]");
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const rem = (pixels) => Math.round((pixels / rootFontSize) * 100) / 100;
    // Drawn at all: neither the node nor anything around it inside the backdrop is display: none.
    const shown = (node) => {
      for (let at = node; at && at !== backdrop.parentElement; at = at.parentElement)
        if (getComputedStyle(at).display === "none") return false;
      return !!node;
    };
    const image = backdrop?.querySelector("img") ?? null;
    const outline = backdrop?.querySelector("svg") ?? null;
    const dots = backdrop?.querySelector(".draft-hero-dots") ?? null;
    return {
      backdrop: !!backdrop,
      dots: !!dots,
      dotsVisible: shown(dots),
      outlineVisible: shown(outline),
      image: image && {
        loaded: image.complete && image.naturalWidth > 0,
        opacity: Number(getComputedStyle(image.parentElement).opacity),
        visible: shown(image),
        width: image.naturalWidth,
      },
      heroGap: rem(pane.bottom - hero.bottom),
      heroBelowCenter: rem(hero.top + hero.height / 2 - (pane.top + pane.height / 2)),
    };
  })()`);
/** Whether the saved backdrop's corner is transparent and its middle is not, read from the page. */
const probeAlpha = () =>
  page.evaluate<{ corner: number; solid: number }>(`(async () => {
    const image = document.querySelector("[data-draft-hero-backdrop] img");
    const bitmap = await createImageBitmap(await (await fetch(image.src)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let solid = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] === 255) solid++;
    return { corner: data[3], solid: Math.round((solid / (data.length / 4)) * 100) };
  })()`);
/** The hero sits 3.25rem above the pane's bottom, or 7rem below its middle once it has risen. */
const HERO_BOTTOM_GAP = 3.25;
const HERO_CENTERED_OFFSET = 7;
const near = (value: number, target: number) => Math.abs(value - target) <= 0.15;

const panel = page.getByRole("region", { name: "CAD panel" });
const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
const backdropFiles = () => {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (NodePath.basename(directory) === "backdrops") found.push(path);
    }
  };
  walk(home);
  return found;
};

try {
  await run("cad-project-outline", async (page) => {
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
    await page.waitForURL((next) => next.pathname.startsWith("/draft/"), { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const view = await probe();
    expect(!view.dots, "A CAD project showed the dot grid");
    expect(view.outlineVisible, `No outline before a backdrop exists: ${JSON.stringify(view)}`);
    expect(near(view.heroGap, HERO_BOTTOM_GAP), `Hero not at the bottom: gap ${view.heroGap}`);
    return view;
  });

  await run("panel-open-hero-centered", async (page) => {
    for (let attempt = 0; !(await panel.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never showed its CAD");
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
      await panel.waitFor({ timeout: 1_000 }).catch(() => {});
    }
    await panel.locator("canvas").first().waitFor({ timeout: 240_000 });
    // The panel captures the backdrop from the loaded scene and saves it to the server.
    const file = await waitFor("the saved backdrop", () => backdropFiles()[0], 240_000);
    NodeFS.copyFileSync(file, NodePath.join(out, "backdrop.webp"));
    await page.locator("[data-draft-hero-backdrop] img").waitFor({ state: "attached" });
    await page.waitForTimeout(600);
    const view = await probe();
    expect(
      view.image !== null && view.image.opacity === 0,
      `The dim copy stayed beside the live model: ${JSON.stringify(view.image)}`,
    );
    expect(
      near(view.heroBelowCenter, HERO_CENTERED_OFFSET),
      `Hero did not rise to the centered spot: ${view.heroBelowCenter}rem below the middle`,
    );
    return { ...view, bytes: NodeFS.statSync(file).size };
  });

  await run("panel-closed-backdrop", async (page) => {
    await toggle.click();
    await panel.waitFor({ state: "detached", timeout: 5_000 });
    await waitFor("the backdrop image to load", async () =>
      (await probe()).image?.loaded ? true : undefined,
    );
    await page.waitForTimeout(600);
    const view = await probe();
    const alpha = await probeAlpha();
    expect(
      view.image !== null && view.image.opacity === 1 && view.image.visible,
      `The saved backdrop is not showing: ${JSON.stringify(view.image)}`,
    );
    expect(!view.outlineVisible, "The outline stayed after the backdrop loaded");
    expect(alpha.corner === 0, `The backdrop's corner is not transparent: alpha ${alpha.corner}`);
    expect(alpha.solid > 5, `The backdrop has almost no solid model pixels: ${alpha.solid}%`);
    expect(
      view.image !== null && view.image.width >= 1400,
      `The backdrop is too small to stay sharp: ${view.image?.width}px wide`,
    );
    expect(near(view.heroGap, HERO_BOTTOM_GAP), `Hero not back at the bottom: gap ${view.heroGap}`);
    return { ...view, alpha };
  });

  await run("panel-reopen-fast-fade", async (page) => {
    /** The model's opacity on every frame after `act`, as [milliseconds, opacity] pairs. */
    const fade = async (act: () => Promise<unknown>) => {
      await page.evaluate(`(() => {
        const art = document.querySelector("[data-draft-hero-backdrop] img").parentElement;
        const record = { samples: [], start: performance.now(), stop: false };
        window.__backdropFade = record;
        const tick = () => {
          record.samples.push([
            Math.round(performance.now() - record.start),
            Number(getComputedStyle(art).opacity),
          ]);
          if (!record.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await act();
      await page.waitForTimeout(700);
      return page.evaluate<[number, number][]>(
        `(window.__backdropFade.stop = true, window.__backdropFade.samples)`,
      );
    };
    const opening = await fade(() => toggle.click());
    await panel.waitFor({ timeout: 10_000 });
    const closing = await fade(() => toggle.click());
    await panel.waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(400);
    // The sampler starts before the click lands, so time the fade from its first drop.
    const dropped = opening.find(([, opacity]) => opacity < 1)?.[0];
    const gone = opening.find(([, opacity]) => opacity <= 0.05)?.[0];
    expect(
      dropped !== undefined && gone !== undefined && gone - dropped <= 130,
      `The model lingered while the panel opened: ${JSON.stringify(opening.slice(0, 30))}`,
    );
    return {
      fadeOutMs: dropped !== undefined && gone !== undefined ? gone - dropped : null,
      opening: opening.filter((_, index) => index % 3 === 0).slice(0, 20),
      closing: closing.filter((_, index) => index % 3 === 0).slice(0, 20),
    };
  });

  await run("short-pane-no-art", async (page) => {
    await page.setViewportSize({ width: 1440, height: 560 });
    await page.waitForTimeout(400);
    const view = await probe();
    expect(
      view.image !== null && !view.image.visible,
      `A short pane still drew the model: ${JSON.stringify(view.image)}`,
    );
    expect(near(view.heroGap, HERO_BOTTOM_GAP), `Hero moved in a short pane: gap ${view.heroGap}`);
    return view;
  });

  /** Adds a local CAD project from a folder holding one CAD file, and lands on its new thread. */
  const addProject = async (projectFolder: string, file: string) => {
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "CAD file" }).click();
    await page.getByLabel("Folder").fill(projectFolder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(file, { exact: true }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await page
      .getByRole("dialog", { name: /^(Add project|New (CAD|Onshape) project)$/ })
      .waitFor({ state: "detached" });
    await page.waitForURL((next) => next.pathname.startsWith("/draft/"), { timeout: 30_000 });
  };
  /** Opens the draft's CAD panel and waits for its model. */
  const openPanel = async () => {
    for (let attempt = 0; !(await panel.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never showed its CAD");
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
      await panel.waitFor({ timeout: 1_000 }).catch(() => {});
    }
    await panel.locator("canvas").first().waitFor({ timeout: 240_000 });
  };
  /** Switches the new thread view to another project through the headline's menu. */
  const switchProject = async (title: string) => {
    await page.getByRole("button", { name: "Change project" }).click();
    await page.getByRole("menuitemradio", { name: title }).click();
  };
  /**
   * The most backdrop layers on screen at once during `act`, sampled on every frame. Two means
   * the outgoing art was still there while the incoming art arrived: a cross-fade.
   */
  const layersDuring = async (act: () => Promise<unknown>) => {
    await page.evaluate(`(() => {
      const record = { most: 0, stop: false };
      window.__backdropLayers = record;
      const tick = () => {
        record.most = Math.max(record.most, document.querySelectorAll("[data-draft-hero-layer]").length);
        if (!record.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await act();
    await page.waitForTimeout(900);
    return page.evaluate<number>(
      `(window.__backdropLayers.stop = true, window.__backdropLayers.most)`,
    );
  };

  await run("second-project", async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await addProject(plateFolder, plateName);
    const before = backdropFiles().length;
    await openPanel();
    await waitFor("the second backdrop", () =>
      backdropFiles().length > before ? true : undefined,
    );
    return { backdrops: backdropFiles().length };
  });

  await run("switch-from-open-panel", async (page) => {
    // The plate's new thread has its CAD panel open. The bracket's has it closed.
    const before = (await slides()).length;
    const most = await layersDuring(() => switchProject("bracket-rig"));
    await panel.waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(600);
    const closing = (await slides()).slice(before);
    const view = await probe();
    expect(
      closing.some((slide) => slide.to === "0px"),
      `The panel did not slide shut on the switch: ${JSON.stringify(closing)}`,
    );
    expect(near(view.heroGap, HERO_BOTTOM_GAP), `Hero not at the bottom: gap ${view.heroGap}`);
    expect(
      view.image !== null && view.image.opacity === 1,
      `The bracket's model is not showing: ${JSON.stringify(view.image)}`,
    );
    return { closing, mostLayers: most, ...view };
  });

  await run("switch-to-open-panel", async (page) => {
    const before = (await slides()).length;
    const most = await layersDuring(() => switchProject("bolt-plate"));
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(600);
    const opening = (await slides()).slice(before);
    const view = await probe();
    expect(
      opening.some((slide) => slide.from === "0px"),
      `The panel did not slide open on the switch: ${JSON.stringify(opening)}`,
    );
    expect(
      near(view.heroBelowCenter, HERO_CENTERED_OFFSET),
      `Hero did not rise with the panel: ${view.heroBelowCenter}rem below the middle`,
    );
    expect(most === 2, `The old model did not stay for a cross-fade: ${most} layer at most`);
    return { opening, mostLayers: most, ...view };
  });

  await run("switch-cross-fade", async (page) => {
    // Both panels closed, so only the model changes.
    await toggle.click();
    await panel.waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(600);
    const before = (await slides()).length;
    const most = await layersDuring(() => switchProject("bracket-rig"));
    const moved = (await slides()).slice(before);
    const view = await probe();
    expect(most === 2, `The models did not cross-fade: ${most} layer at most`);
    expect(moved.length === 0, `The panel moved with both closed: ${JSON.stringify(moved)}`);
    expect(
      view.image !== null && view.image.opacity === 1,
      `The bracket's model is not showing: ${JSON.stringify(view.image)}`,
    );
    return { mostLayers: most, ...view };
  });

  if (values.send)
    await run("send-settles", async (page) => {
      if (values.model) {
        await page.getByRole("button", { name: "Change model and reasoning" }).click();
        await page.getByLabel("Search models").fill(values.model);
        await page.locator("[data-model-picker-row]:not([data-disabled])").first().click();
      }
      await page
        .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
        .first()
        .click();
      await page.keyboard.type("Reply with the single word ok. Do not use any tools.");
      // On every frame after the send: is the hero text still mounted, and are the messages fading in?
      await page.evaluate(`(() => {
        const record = { textFrames: 0, settleFrames: 0, stop: false };
        window.__settle = record;
        const tick = () => {
          if (document.querySelector("[inert] h1")) record.textFrames++;
          if (document.querySelector(".draft-hero-settle-in")) record.settleFrames++;
          if (!record.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForURL((next) => !next.pathname.startsWith("/draft/"), { timeout: 30_000 });
      await page.waitForTimeout(800);
      const settle = await page.evaluate<{ textFrames: number; settleFrames: number }>(
        `(window.__settle.stop = true, window.__settle)`,
      );
      const docks = await page.evaluate<number[]>("window.__heroDocks");
      expect(settle.textFrames > 0, "The hero text was dropped at once on send");
      expect(settle.settleFrames > 0, "The messages did not fade in on send");
      expect(docks.at(-1) === 300, `The composer's dock ran ${docks.at(-1)}ms, not 300`);
      expect((await probe()).backdrop === false, "The backdrop stayed after the send");
      return { ...settle, docks };
    });

  await run("cad-off-dots", async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // The settings icon sits under the row until the row is hovered.
    const settings = page.getByRole("button", { name: "Project settings for bolt-plate" }).first();
    await settings.hover({ force: true });
    await settings.click({ force: true });
    await page.getByRole("button", { name: "Turn off CAD" }).click();
    await page.getByRole("button", { name: "Turn on CAD" }).waitFor({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "New thread in bolt-plate" })
      .first()
      .click({ force: true });
    await page.waitForURL((next) => next.pathname.startsWith("/draft/"), { timeout: 30_000 });
    // Let the one-time ripple finish, then cross the pane with the pointer.
    await page.waitForTimeout(1800);
    await page.mouse.move(700, 250);
    await page.mouse.move(760, 280, { steps: 4 });
    const view = await probe();
    const pointer = await page.evaluate<string>(
      `document.querySelector(".draft-hero-dots-light")?.style.getPropertyValue("--draft-hero-pointer-x") ?? ""`,
    );
    expect(view.dots && view.dotsVisible, `No dot grid with CAD off: ${JSON.stringify(view)}`);
    expect(view.image === null, "A project with CAD off drew a model");
    expect(pointer.endsWith("px"), `The dots did not follow the pointer: "${pointer}"`);
    expect(near(view.heroGap, HERO_BOTTOM_GAP), `Hero not at the bottom: gap ${view.heroGap}`);
    return { ...view, pointer };
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
