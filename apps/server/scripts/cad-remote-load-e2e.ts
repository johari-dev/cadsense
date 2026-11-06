// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * Measures CAD loading the way a remote device sees it: a page opened at a plain-http, non-localhost
 * address (like a tailnet IP) over a slower link. Starts the dev app on a fresh data directory,
 * imports a local STEP file through a localhost page, then opens the same chat from a fresh browser
 * profile through a throttled forwarder on this machine's LAN address. It loads the model cold,
 * then keeps that page open through two syncs from the local page: a re-export with the same
 * geometry, and an edit that moves one vertex of one part. Last, it reloads the remote page.
 *
 *   node apps/server/scripts/cad-remote-load-e2e.ts --out .cadsense/cad-remote-load/run \
 *     [--step path/to/assembly.step] [--mbps 40]
 *
 * Evidence under --out:
 *
 *   NN-*.png      a screenshot after each step
 *   dev.log       dev runner, server, and web output
 *   summary.json  per load: every /api/cad-panel response (path, content type, bytes on the wire),
 *                 the browser's Accept-Encoding, whether the page was a secure context, the
 *                 snapshot shown, and the time until the scene replaced its loading bar, both
 *                 from navigation (readyMs) and from the first CAD request (cadMs)
 *
 * --mbps caps the forwarder's server-to-browser bandwidth for every connection together.
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: { out: { type: "string" }, step: { type: "string" }, mbps: { type: "string" } },
});
if (!values.out) throw new Error("Usage: --out <dir> [--step <file.step>] [--mbps <n>]");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const mbps = Number(values.mbps ?? 40);
if (!(mbps > 0)) throw new Error("--mbps must be positive");
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const step = NodePath.resolve(
  values.step ?? NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
);
const stepName = NodePath.basename(step);
const folder = NodePath.join(out, "remote-rig");
NodeFS.mkdirSync(folder, { recursive: true });
NodeFS.copyFileSync(step, NodePath.join(folder, stepName));

const summary: {
  link: { mbps: number; origin?: string };
  steps: { name: string; ms: number; observed?: unknown }[];
  ok: boolean;
} = { link: { mbps }, steps: [], ok: false };
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

// Opening a chat sends one message. Codex gets its own home whose only provider is a closed local
// port, so the turn fails at once without reaching any model or spending tokens, while the session
// still starts and stops cleanly, which Sync waits for.
const codexHome = NodePath.join(out, "codex-home");
NodeFS.mkdirSync(codexHome);
NodeFS.writeFileSync(
  NodePath.join(codexHome, "config.toml"),
  [
    'model_provider = "offline"',
    "[model_providers.offline]",
    'name = "offline"',
    'base_url = "http://127.0.0.1:9/v1"',
    'env_key = "CADSENSE_E2E_OFFLINE_KEY"',
    'wire_api = "responses"',
    "stream_max_retries = 0",
    "request_max_retries = 0",
    "",
  ].join("\n"),
);
const log = NodeFS.openSync(NodePath.join(out, "dev.log"), "a");
const dev = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", NodePath.join(out, "home")],
  {
    cwd: repo,
    stdio: ["ignore", log, log],
    detached: true,
    env: { ...process.env, CODEX_HOME: codexHome, CADSENSE_E2E_OFFLINE_KEY: "offline" },
  },
);
process.on("exit", () => {
  if (dev.pid)
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
});

const waitFor = async <T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
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
  if (!NodeFS.readFileSync(NodePath.join(out, "dev.log"), "utf8").includes("Listening on"))
    return undefined;
  return fetch(url).then(
    (response) => (response.ok ? true : undefined),
    () => undefined,
  );
});

// A plain TCP forwarder on the LAN address, like the tailnet forwarder. Every connection shares
// one server-to-browser budget of `mbps`, so parallel range requests cannot exceed the link.
// Prefers a private LAN range; WSL's mirrored tailnet address is not reachable from WSL itself.
const lanAddresses = Object.values(NodeOS.networkInterfaces())
  .flat()
  .filter((entry) => entry?.family === "IPv4" && !entry.internal)
  .map((entry) => entry!.address);
const lanAddress =
  lanAddresses.find((address) => /^(192\.168|10)\./.test(address)) ?? lanAddresses[0];
if (!lanAddress) throw new Error("No non-loopback IPv4 address to serve the remote page from");
const bytesPerMs = (mbps * 1_000_000) / 8 / 1000;
let linkFreeAt = 0;
const forwarder = NodeNet.createServer((client) => {
  const upstream = NodeNet.connect(Number(webPort), "127.0.0.1");
  client.pipe(upstream);
  upstream.on("data", (chunk: Buffer) => {
    const now = performance.now();
    linkFreeAt = Math.max(now, linkFreeAt) + chunk.byteLength / bytesPerMs;
    upstream.pause();
    setTimeout(() => {
      if (!client.destroyed) client.write(chunk);
      upstream.resume();
    }, linkFreeAt - now);
  });
  upstream.on("end", () =>
    setTimeout(() => client.end(), Math.max(0, linkFreeAt - performance.now())),
  );
  for (const socket of [client, upstream])
    socket.on("error", () => (client.destroy(), upstream.destroy()));
});
await new Promise<void>((resolve) => forwarder.listen(0, lanAddress, resolve));
const remoteOrigin = `http://${lanAddress}:${(forwarder.address() as NodeNet.AddressInfo).port}`;
summary.link.origin = remoteOrigin;

const browser = await chromium.launch({
  ...(process.env.CADSENSE_CHROMIUM_PATH
    ? { executablePath: process.env.CADSENSE_CHROMIUM_PATH }
    : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const local = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let shots = 0;
const run = async (name: string, page: Page, action: () => Promise<unknown>) => {
  const started = Date.now();
  const observed = await action().catch(async (error: unknown) => {
    await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
    throw error;
  });
  const index = String(++shots).padStart(2, "0");
  await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
  summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
  writeSummary();
  console.log(`${index} ${name}`, JSON.stringify(observed ?? ""));
};
const panelOf = (page: Page) => page.getByRole("region", { name: "CAD panel" });
const openRightPanel = async (page: Page) => {
  const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
  await toggle.waitFor({ timeout: 60_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
};
// The scene is ready once its canvas shows and the loading bar has gone.
const sceneReady = async (page: Page) => {
  const panel = panelOf(page);
  await panel
    .locator("canvas")
    .first()
    .waitFor({ timeout: 10 * 60_000 });
  await panel.getByRole("progressbar").waitFor({ state: "detached", timeout: 10 * 60_000 });
  await panel.getByText("Preparing CAD…").waitFor({ state: "detached", timeout: 10 * 60_000 });
};
// A new project opens on a draft; sending a message makes it a chat with a CAD panel. The turn is
// stopped as soon as it starts, as in local-cad-project-e2e.ts.
const startThread = async (page: Page) => {
  const placeholder = page.getByText("Start a thread to open its CAD view.");
  const composer = page
    .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
    .first();
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    for (let attempt = 0; !(await placeholder.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never asked for a thread");
      await openRightPanel(page);
      await placeholder.waitFor({ timeout: 1_000 }).catch(() => {});
    }
    if (!(await composer.innerText()).trim()) {
      await composer.click();
      await page.keyboard.type("Open the CAD view.");
    }
    await page
      .getByRole("button", { name: "Send message" })
      .click({ timeout: Math.max(1_000, deadline - Date.now()) });
    const started = await placeholder.waitFor({ state: "detached", timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (started) break;
    if (Date.now() > deadline) throw new Error("Sending never started a thread");
  }
  const stop = page.getByRole("button", { name: "Stop generation" });
  await stop.click({ timeout: 15_000 }).catch(() => {});
  await stop.waitFor({ state: "detached", timeout: 60_000 });
};
const manifestDir = NodePath.join(out, "home/userdata/cad/manifests");
const manifests = () =>
  NodeFS.existsSync(manifestDir)
    ? NodeFS.readdirSync(manifestDir).filter((name) => name.endsWith(".json"))
    : [];

interface CadResponse {
  readonly path: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly wireBytes: number;
  readonly acceptEncoding: string | null;
  /** On scene manifests: the snapshot the panel is about to show. */
  readonly snapshotId?: string;
  readonly finishedAt: number;
}
/**
 * Records every /api/cad-panel request `context` makes for the whole run, so traffic from an open
 * page that follows a sync on its own is counted too. `phase` reports what happened during `step`.
 */
const recordCadTraffic = (context: BrowserContext) => {
  const requestTimes: number[] = [];
  const pending: Promise<CadResponse>[] = [];
  const settled: CadResponse[] = [];
  const isCad = (url: string) => new URL(url).pathname.startsWith("/api/cad-panel/");
  context.on("request", (request) => {
    if (isCad(request.url())) requestTimes.push(Date.now());
  });
  context.on("response", (response) => {
    if (!isCad(response.url())) return;
    const target = new URL(response.url());
    const result = (async (): Promise<CadResponse> => {
      await response.finished();
      const headers = await response.allHeaders();
      return {
        path: `${target.pathname.split("/").slice(4).join("/")}${target.search}`,
        status: response.status(),
        contentType: headers["content-type"] ?? null,
        contentEncoding: headers["content-encoding"] ?? null,
        wireBytes: (await response.request().sizes()).responseBodySize,
        acceptEncoding: (await response.request().allHeaders())["accept-encoding"] ?? null,
        ...(target.searchParams.has("delivery")
          ? { snapshotId: ((await response.json()) as { snapshotId: string }).snapshotId }
          : {}),
        finishedAt: Date.now(),
      };
    })();
    pending.push(result);
    void result.then((response) => settled.push(response));
  });
  const phase = async (page: Page, step: () => Promise<void>) => {
    const fromRequest = requestTimes.length;
    const fromResponse = pending.length;
    const started = Date.now();
    await step();
    const finished = Date.now();
    const responses = await Promise.all(pending.slice(fromResponse));
    const geometry = responses.filter((response) => /^(transfer\?|bundle)/.test(response.path));
    return {
      snapshotIds: responses.flatMap((response) => response.snapshotId ?? []),
      secureContext: await page.evaluate<boolean>("isSecureContext"),
      // Page boot through the throttled link is not CAD loading, so time CAD from its first request.
      cadMs: finished - (requestTimes[fromRequest] ?? started),
      geometryRequests: geometry.length,
      geometryWireBytes: geometry.reduce((sum, response) => sum + response.wireBytes, 0),
      cachedKeys: await cachedKeys(page),
      responses,
    };
  };
  const manifestFor = (snapshotId: string) =>
    waitFor(
      `the remote page to request snapshot ${snapshotId}`,
      () => settled.find((response) => response.snapshotId === snapshotId),
      10 * 60_000,
    );
  return { phase, manifestFor };
};
// What the browser's CAD cache holds, by key without its origin prefix. The script runs in the
// page; it is a string because this package does not type-check against the DOM.
const cachedKeys = (page: Page) =>
  page.evaluate<string[]>(`(async () => {
    const keys = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith("cadsense:cad-")) continue;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (database.objectStoreNames.contains("metadata"))
        keys.push(...(await new Promise((resolve, reject) => {
          const request = database.transaction("metadata").objectStore("metadata").getAllKeys();
          request.onsuccess = () => resolve(request.result.map(String));
          request.onerror = () => reject(request.error);
        })));
      database.close();
    }
    return keys.map((key) => decodeURIComponent(key.replace(/^https:\\/\\/[^/]+\\//, "")));
  })()`);
// The loading bar can be absent for a moment before a new snapshot starts loading, so the scene
// counts as settled once the bar has stayed away for a second.
const sceneSettled = async (page: Page) => {
  const bar = panelOf(page).getByRole("progressbar");
  const deadline = Date.now() + 10 * 60_000;
  for (let quiet = 0; quiet < 4; ) {
    if (Date.now() > deadline)
      throw new Error(`The scene never settled: ${await panelOf(page).innerText()}`);
    quiet = (await bar.isVisible()) ? 0 : quiet + 1;
    await page.waitForTimeout(250);
  }
};

try {
  let threadPath = "/";
  await run("local-project-imported", local, async () => {
    await local.goto(url, { waitUntil: "networkidle" });
    await local
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await local.getByRole("button", { name: "Add project" }).first().click();
    await local.getByRole("button", { name: "Local CAD file" }).click();
    await local.getByLabel("Folder").fill(folder);
    await local.getByRole("button", { name: "Scan" }).click();
    const dialog = local.getByRole("dialog", { name: "Add project" });
    await dialog.getByText(stepName, { exact: true }).click({ timeout: 60_000 });
    await local.getByRole("button", { name: "Create project" }).click();
    await dialog.waitFor({ state: "detached" });
    await startThread(local);
    await sceneReady(local);
    threadPath = new URL(local.url()).pathname;
    return { threadPath, snapshots: manifests().length };
  });

  const remoteContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const remote = await remoteContext.newPage();
  const traffic = recordCadTraffic(remoteContext);
  await run("remote-cold-load", remote, () =>
    traffic.phase(remote, async () => {
      await remote.goto(`${remoteOrigin}${threadPath}`, { waitUntil: "domcontentloaded" });
      await openRightPanel(remote);
      await sceneReady(remote);
    }),
  );

  /** Rewrites the STEP file, syncs from the local page, and waits for the open remote page to
   * load the new snapshot. Retries Sync while the server still refuses it. */
  const syncAndFollow = (edit: (text: string) => string) =>
    traffic.phase(remote, async () => {
      const file = NodePath.join(folder, stepName);
      const text = NodeFS.readFileSync(file, "utf8");
      const edited = edit(text);
      // An unchanged file re-syncs to the same snapshot, which would leave nothing to follow.
      if (edited === text) throw new Error("The edit left the STEP file unchanged");
      NodeFS.writeFileSync(file, edited);
      const before = new Set(manifests());
      // The server refuses a sync while the chat's stopped turn is still winding down, so press
      // Sync again until an import starts, as a user would.
      const sync = local.getByRole("button", { name: "Sync", exact: true });
      const created = await waitFor(
        "the re-imported snapshot",
        async () => {
          const found = manifests().find((name) => !before.has(name));
          if (found) return found;
          await sync.click({ timeout: 1_000 }).catch(() => {});
          await local.waitForTimeout(5_000);
          return manifests().find((name) => !before.has(name));
        },
        10 * 60_000,
      );
      await traffic.manifestFor(NodePath.basename(created, ".json"));
      await sceneSettled(remote);
    });
  const assetChanges = () => {
    const [previous, latest] = manifests()
      .map((name) => NodePath.join(manifestDir, name))
      .toSorted((a, b) => NodeFS.statSync(a).mtimeMs - NodeFS.statSync(b).mtimeMs)
      .slice(-2)
      .map(
        (path) =>
          new Set(
            (
              JSON.parse(NodeFS.readFileSync(path, "utf8")) as { assets: { sha256: string }[] }
            ).assets.map((asset) => asset.sha256),
          ),
      );
    return {
      assets: latest!.size,
      changed: [...latest!].filter((sha256) => !previous!.has(sha256)).length,
    };
  };

  // The remote page stays open while the local page syncs, so it follows each new snapshot.
  // First a re-export: new file bytes, the same geometry.
  await run("remote-follows-re-export", remote, async () => ({
    ...(await syncAndFollow((text) =>
      text.replace(/^ISO-10303-21;/, "ISO-10303-21;\n/* re-exported */"),
    )),
    ...assetChanges(),
  }));
  // Then an edit to one part: one B-rep vertex moves by a hair, so that part's mesh changes.
  await run("remote-follows-part-edit", remote, async () => ({
    ...(await syncAndFollow((text) => {
      const vertex = /VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/.exec(text);
      if (!vertex) throw new Error("The STEP file has no vertex to move");
      const point = new RegExp(
        `(#${vertex[1]}\\s*=\\s*CARTESIAN_POINT\\s*\\(\\s*'[^']*'\\s*,\\s*\\(\\s*)([-0-9.Ee+]+)`,
      );
      if (!point.test(text)) throw new Error(`No point #${vertex[1]}`);
      return text.replace(point, (_, head: string, x: string) => `${head}${Number(x) + 1e-4}`);
    })),
    ...assetChanges(),
  }));

  await run("remote-reload", remote, () =>
    traffic.phase(remote, async () => {
      await remote.reload({ waitUntil: "domcontentloaded" });
      await openRightPanel(remote);
      await sceneReady(remote);
    }),
  );
  summary.ok = true;
  writeSummary();
} finally {
  await browser.close().catch(() => {});
  forwarder.close();
  if (dev.pid)
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
}
