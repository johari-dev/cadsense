import * as NodeModule from "node:module";
import type { CadRenderEvent } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Browser, Page } from "playwright-core";
import { CadRenderBroker } from "../cad/CadRenderBroker.ts";

export class CadMcpRenderHostError extends Schema.TaggedErrorClass<CadMcpRenderHostError>()(
  "CadMcpRenderHostError",
  { message: Schema.String },
) {}

// Chrome 137 stopped falling back to SwiftShader on its own. Without this flag, machines with no
// usable GPU (CI, containers, WSL) get no WebGL context at all. The page only runs Cadsense code on
// the user's own CAD, so SwiftShader's weaker sandboxing for untrusted content does not apply.
const CHROMIUM_ARGS = ["--enable-unsafe-swiftshader"];

interface RenderHostGlobal {
  readonly cadsenseRenderHost: { accept(event: CadRenderEvent): void };
}

const failure = (message: string) => (cause: unknown) =>
  new CadMcpRenderHostError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** Downloads Playwright's headless Chromium build into its shared cache (about 110 MB, once). */
const installChromium = Effect.fn("installChromium")(function* () {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cli = path.join(
    path.dirname(NodeModule.createRequire(import.meta.url).resolve("playwright-core/package.json")),
    "cli.js",
  );
  yield* Effect.logInfo("Downloading headless Chromium for CAD rendering (one time)");
  // stdout carries MCP messages, so the installer's progress output is dropped.
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [cli, "install", "chromium-headless-shell"], {
      stdout: "ignore",
      stderr: "inherit",
      shell: false,
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) return yield* failure("Could not download headless Chromium")(exitCode);
}, Effect.scoped);

const launch = (executablePath?: string) =>
  Effect.tryPromise({
    try: async () =>
      (await import("playwright-core")).chromium.launch({
        args: CHROMIUM_ARGS,
        ...(executablePath ? { executablePath } : {}),
      }),
    catch: failure("Could not start headless Chromium"),
  });

/** Launches `CADSENSE_CHROMIUM_PATH` if set, else Playwright's headless shell, installing it on first use. */
const launchChromium = Effect.gen(function* () {
  const executablePath = process.env.CADSENSE_CHROMIUM_PATH?.trim();
  if (executablePath) return yield* launch(executablePath);
  return yield* launch().pipe(
    // Playwright's wording for a browser build that has not been downloaded yet.
    Effect.catchIf(
      (error) => error.message.includes("Executable doesn't exist"),
      () => installChromium().pipe(Effect.andThen(launch())),
    ),
  );
});

const openRenderPage = async (browser: Browser, origin: string) => {
  const page = await browser.newPage();
  await page.goto(`${origin}/render-host.html`);
  await page.waitForFunction(() => "cadsenseRenderHost" in globalThis);
  // Logged so a slow capture can be traced to software rendering. A string keeps DOM types out of
  // the server build.
  const renderer: unknown = await page.evaluate(`(() => {
    const context = new OffscreenCanvas(1, 1).getContext("webgl2");
    const info = context && context.getExtension("WEBGL_debug_renderer_info");
    return context && info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
  })()`);
  return { page, renderer };
};

const forward = (page: Page, event: CadRenderEvent) =>
  Effect.tryPromise({
    try: () =>
      page.evaluate(
        (next) => (globalThis as unknown as RenderHostGlobal).cadsenseRenderHost.accept(next),
        event,
      ),
    catch: failure("CAD render page stopped"),
  });

/**
 * Headless Chromium running the web app's `render-host.html`, connected as the server's only CAD
 * render host. This process reads the broker's render stream and hands each event to the page;
 * the page fetches jobs and uploads PNGs over the ticketed `/api/cad-render` routes.
 *
 * `ensure` launches it on first use and again after a crash. While it is down, captures fail with
 * the broker's `render-unavailable` error, which tells the agent to retry.
 */
export const makeCadMcpRenderHost = Effect.fn("makeCadMcpRenderHost")(function* (origin: string) {
  const broker = yield* CadRenderBroker;
  const owner = yield* Scope.Scope;
  const services = yield* Effect.context<Path.Path | ChildProcessSpawner.ChildProcessSpawner>();
  const gate = yield* Semaphore.make(1);
  let live: {
    readonly browser: Browser;
    readonly page: Page;
    readonly bridge: Fiber.Fiber<void>;
  } | null = null;
  const stop = Effect.gen(function* () {
    const current = live;
    live = null;
    if (!current) return;
    yield* Fiber.interrupt(current.bridge);
    yield* Effect.promise(() => current.browser.close().catch(() => undefined));
  });
  yield* Scope.addFinalizer(owner, stop);
  const ensure = gate.withPermits(1)(
    Effect.gen(function* () {
      if (
        live &&
        live.browser.isConnected() &&
        !live.page.isClosed() &&
        live.bridge.pollUnsafe() === undefined
      )
        return;
      yield* stop;
      const browser = yield* launchChromium.pipe(Effect.provide(services));
      const { page, renderer } = yield* Effect.tryPromise({
        try: () => openRenderPage(browser, origin),
        catch: failure("Could not load the CAD render page"),
      }).pipe(Effect.tapError(() => Effect.promise(() => browser.close().catch(() => undefined))));
      const bridge = yield* broker.connect().pipe(
        Stream.runForEach((event) => forward(page, event)),
        Effect.catchCause((cause) => Effect.logWarning("CAD render host disconnected", cause)),
        Effect.forkIn(owner),
      );
      live = { browser, page, bridge };
      yield* Effect.logInfo("CAD render host ready", { renderer, browser: browser.version() });
    }),
  );
  return { ensure };
});
export type CadMcpRenderHost = Effect.Success<ReturnType<typeof makeCadMcpRenderHost>>;
