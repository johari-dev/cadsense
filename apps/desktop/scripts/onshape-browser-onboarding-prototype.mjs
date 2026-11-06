// Throwaway, isolated host for onboarding and first sync without an Onshape API key.
// Electron owns browser acquisition. The frontend still uses the real local CAD importer.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import { _electron } from "playwright-core";
import electronExecutable from "electron";

// oxlint-disable-next-line cadsense/no-global-process-runtime -- This standalone prototype owns its processes.
const hostPlatform = NodeOS.platform();

const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    "home-dir": { type: "string" },
    port: { type: "string", default: "8800" },
    "skip-build": { type: "boolean" },
  },
});
await NodeFSP.mkdir(NodePath.join(root, ".cadsense"), { recursive: true });
const output = values["home-dir"]
  ? NodePath.resolve(values["home-dir"])
  : await NodeFSP.mkdtemp(NodePath.join(root, ".cadsense/onshape-browser-onboarding-"));
await NodeFSP.mkdir(output, { recursive: true });
const port = Number(values.port);
NodeAssert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const previous = await NodeFSP.readFile(NodePath.join(output, "server.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);
const access = previous?.access ?? NodeCrypto.randomBytes(24).toString("hex");
const cookieName = "cadsense_browser_onboarding";
const prefix = "/__prototype/onshape-browser/";
const cadCapabilityPath =
  /^\/api\/cad-panel\/[0-9a-f-]{36}(?:\/(?:[0-9a-f]{64}|bundle|transfer|transfer-index))?$/;
const sourcesFile = NodePath.join(output, "sources.json");
const sources = new Map(
  Object.entries(
    await NodeFSP.readFile(sourcesFile, "utf8")
      .then(JSON.parse)
      .catch(() => ({})),
  ),
);
const jobs = new Map();
let acquiring = false;
let application;
let web;
let server;
let closing = false;
const connections = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (step, detail = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }));
const until = async (read, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out after ${timeout}ms`);
};
async function cleanup() {
  if (closing) return;
  closing = true;
  for (const socket of connections) socket.destroy();
  server?.close();
  await application?.close().catch(() => {});
  if (web?.pid) {
    if (hostPlatform === "win32")
      NodeChildProcess.spawnSync("taskkill", ["/PID", String(web.pid), "/T", "/F"]);
    else {
      try {
        process.kill(-web.pid, "SIGTERM");
      } catch {}
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup());

/** One real website export. It does not need a pre-existing project or CAD snapshot. */
async function acquire(job, input) {
  let windowId;
  let browser;
  const update = (message) => {
    job.message = message;
    note(message, { jobId: job.id });
  };
  const existing =
    typeof input.workspaceRoot === "string" ? sources.get(input.workspaceRoot) : null;
  const sourceUrl = existing?.url ?? input.url;
  try {
    const url = new URL(sourceUrl);
    if (
      url.origin !== "https://cad.onshape.com" ||
      !url.pathname.startsWith("/documents/") ||
      url.username ||
      url.password
    )
      throw new Error("Use a public cad.onshape.com document link for this prototype.");
    if (input.workspaceRoot && !existing)
      throw new Error("This project has no browser connection.");
    if (
      !existing &&
      (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)
    )
      throw new Error("Give your robot a name.");
    const workspaceRoot = existing
      ? input.workspaceRoot
      : NodePath.join(output, "robots", NodeCrypto.randomUUID());
    const filePath = existing?.filePath ?? "onshape-browser-model.step";
    await NodeFSP.mkdir(workspaceRoot, { recursive: true });
    const stage = NodePath.join(workspaceRoot, `.incoming-${job.id}.step`);
    update("Opening your Onshape document…");
    const nextWindow = application.waitForEvent("window");
    windowId = await application.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Cadsense Onshape browser",
        autoHideMenuBar: true,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      void window.loadURL(url).catch(() => {});
      return window.id;
    }, url.toString());
    browser = await nextWindow;
    browser.setDefaultTimeout(60000);
    await browser.waitForLoadState("domcontentloaded", { timeout: 180000 });
    await browser.locator('[command-id="exportTab"]:visible').first().waitFor({ timeout: 180000 });
    await until(
      () => browser.evaluate(() => !document.body.innerText.includes("Loading studio data")),
      180000,
    );
    update("Exporting the first CAD model through Onshape…");
    await application.evaluate(
      ({ BrowserWindow }, { windowId, stage, jobId }) => {
        const window = BrowserWindow.fromId(windowId);
        globalThis.__onboardingDownloads ??= {};
        globalThis.__onboardingDownloads[jobId] = null;
        const handler = (_event, item) => {
          const record = { state: "started", receivedBytes: 0 };
          globalThis.__onboardingDownloads[jobId] = record;
          item.setSavePath(stage);
          item.once("done", (_event, state) => {
            record.state = state;
            record.receivedBytes = item.getReceivedBytes();
          });
        };
        globalThis.__onboardingDownloadHandler = handler;
        window.webContents.session.once("will-download", handler);
      },
      { windowId, stage, jobId: job.id },
    );
    // Onshape's own UI submits the export and polls its job. No direct Onshape HTTP calls.
    await browser
      .locator('[command-id="exportTab"]:visible')
      .first()
      .evaluate((element) => element.click());
    const dialog = browser.locator(".export-dialog.show");
    await dialog.locator("#export-filename-input").fill("cadsense-browser-model");
    await dialog.locator("#export-format-dropdown").selectOption({ label: "STEP" });
    await browser.screenshot({ path: NodePath.join(output, `${job.id}-export.png`) });
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    update("Waiting for the STEP download…");
    const download = await until(
      () =>
        application.evaluate((_electron, jobId) => {
          const record = globalThis.__onboardingDownloads[jobId];
          if (record && ["cancelled", "interrupted"].includes(record.state))
            throw new Error("Onshape's download did not finish. Try again.");
          return record?.state === "completed" ? record : null;
        }, job.id),
      180000,
    );
    const bytes = await NodeFSP.readFile(stage);
    NodeAssert.ok(
      bytes.subarray(0, 100).toString().includes("ISO-10303-21;"),
      "Onshape did not download a STEP file.",
    );
    NodeAssert.ok(
      bytes.subarray(-100).toString().includes("END-ISO-10303-21;"),
      "The STEP download is incomplete.",
    );
    NodeAssert.equal(bytes.length, download.receivedBytes);
    await NodeFSP.rename(stage, NodePath.join(workspaceRoot, filePath));
    sources.set(workspaceRoot, { url: url.toString(), filePath });
    await NodeFSP.writeFile(sourcesFile, JSON.stringify(Object.fromEntries(sources), null, 2));
    job.download = { workspaceRoot, filePath };
    job.bytes = bytes.length;
    job.sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    job.state = "completed";
    note("Validated browser STEP ready for local import", {
      jobId: job.id,
      bytes: job.bytes,
      sha256: job.sha256,
    });
  } catch (error) {
    job.state = "failed";
    job.message = error instanceof Error ? error.message : String(error);
    if (/Timeout|Timed out/.test(job.message))
      job.message =
        "The browser export did not finish in time. Use a public document that allows export, or open a STEP file instead.";
    note("Browser acquisition failed", {
      jobId: job.id,
      reason: job.message,
      error: String(error),
    });
    await browser
      ?.screenshot({ path: NodePath.join(output, `${job.id}-failure.png`), timeout: 10000 })
      .catch(() => {});
  } finally {
    if (windowId)
      await application
        .evaluate(({ BrowserWindow }, id) => {
          const window = BrowserWindow.fromId(id);
          if (window && !window.isDestroyed()) {
            if (globalThis.__onboardingDownloadHandler)
              window.webContents.session.removeListener(
                "will-download",
                globalThis.__onboardingDownloadHandler,
              );
            window.destroy();
          }
        }, windowId)
        .catch(() => {});
    await NodeFSP.writeFile(
      NodePath.join(output, `${job.id}-report.json`),
      JSON.stringify(job, null, 2),
    );
  }
}

try {
  if (!values["skip-build"]) {
    for (const [command, args, cwd] of [
      ["vp", ["run", "--filter", "@cadsense/server", "build:desktop-dev"], root],
      [process.execPath, ["apps/desktop/scripts/build-preview-annotation-css.mjs"], root],
      ["vp", ["pack"], NodePath.join(root, "apps/desktop")],
    ]) {
      const result = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
      NodeAssert.equal(result.status, 0, "Desktop build failed");
    }
  }
  const probe = NodeNet.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const backendPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const webLogPath = NodePath.join(output, "web.log");
  const webLog = NodeFS.createWriteStream(webLogPath);
  web = NodeChildProcess.spawn(
    "vp",
    ["run", "dev:web", "--home-dir", NodePath.join(output, "state"), "--port", String(backendPort)],
    {
      cwd: root,
      detached: hostPlatform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CADSENSE_DEV_INSTANCE: `onshape-onboarding-${NodePath.basename(output)}`,
      },
    },
  );
  web.stdout.pipe(webLog);
  web.stderr.pipe(webLog);
  const webPort = await until(async () =>
    Number(
      (await NodeFSP.readFile(webLogPath, "utf8").catch(() => "")).match(
        /\[dev-runner\].*webPort=(\d+)/,
      )?.[1],
    ),
  );
  const rendererUrl = `http://127.0.0.1:${webPort}/`;
  await until(() =>
    fetch(rendererUrl)
      .then((response) => response.ok)
      .catch(() => false),
  );
  const env = {
    ...process.env,
    CADSENSE_HOME: NodePath.join(output, "state"),
    CADSENSE_PORT: String(backendPort),
    CADSENSE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    VITE_DEV_SERVER_URL: rendererUrl,
    XDG_CONFIG_HOME: NodePath.join(output, "electron-config"),
    APPDATA: NodePath.join(output, "electron-config"),
    LOCALAPPDATA: NodePath.join(output, "electron-local"),
    CADSENSE_DISABLE_AUTO_UPDATE: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (hostPlatform === "linux" && !env.DISPLAY) env.DISPLAY = ":0";
  application = await _electron.launch({
    executablePath: electronExecutable,
    cwd: NodePath.join(root, "apps/desktop"),
    env,
    args: [
      NodePath.join(root, "apps/desktop/dist-electron/main.cjs"),
      ...(hostPlatform === "linux"
        ? ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]
        : []),
    ],
    timeout: 60000,
  });
  const desktopLog = NodeFS.createWriteStream(NodePath.join(output, "desktop.log"));
  application.process().stdout.pipe(desktopLog);
  application.process().stderr.pipe(desktopLog);
  await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.closeDevTools();
  });
  const mainPage = await until(() =>
    application.windows().find((page) => !page.url().startsWith("devtools:")),
  );
  const credential = await mainPage.evaluate(() =>
    window.desktopBridge.getLocalEnvironmentBearerToken(),
  );
  const backendPath = (pathname) =>
    ["/api", "/oauth", "/.well-known", "/ws"].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
  const authenticated = (req) =>
    (req.headers.cookie ?? "")
      .split(";")
      .some((value) => value.trim() === `${cookieName}=${access}`);
  const sameOrigin = (req) =>
    !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
  const headersFor = (req, backend) => {
    const headers = { ...req.headers, host: `127.0.0.1:${backend ? backendPort : webPort}` };
    delete headers.cookie;
    delete headers.authorization;
    if (backend && !cadCapabilityPath.test(new URL(req.url, "http://prototype").pathname))
      headers.authorization = `Bearer ${credential}`;
    else delete headers["accept-encoding"];
    if (headers.origin) headers.origin = `http://${headers.host}`;
    return headers;
  };
  server = NodeHttp.createServer(async (req, res) => {
    const url = new URL(req.url, "http://prototype");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/" && url.searchParams.get("access") === access) {
      res
        .writeHead(302, {
          "Set-Cookie": `${cookieName}=${access}; Path=/; HttpOnly; SameSite=Strict`,
          Location: "/prototype/onshape-browser",
        })
        .end();
      return;
    }
    // CAD requests deliberately omit cookies and carry their own server-validated scene ticket.
    const cadCapability =
      req.method === "GET" &&
      cadCapabilityPath.test(url.pathname) &&
      typeof req.headers["x-cad-panel-token"] === "string";
    if ((!authenticated(req) && !cadCapability) || !sameOrigin(req)) {
      res.writeHead(403).end("Open the prototype access link.");
      return;
    }
    try {
      if (url.pathname.startsWith(prefix)) {
        res.setHeader("Content-Type", "application/json");
        const operation = url.pathname.slice(prefix.length);
        if (req.method === "GET" && operation === "source") {
          res.end(
            JSON.stringify({
              url: sources.get(url.searchParams.get("workspaceRoot"))?.url ?? null,
            }),
          );
          return;
        }
        if (req.method === "GET" && operation.startsWith("jobs/")) {
          const job = jobs.get(operation.slice(5));
          if (!job) {
            res.writeHead(404).end();
            return;
          }
          res.end(JSON.stringify(job));
          return;
        }
        if (req.method === "POST" && operation === "acquire") {
          if (!req.headers["content-type"]?.startsWith("application/json")) {
            res.writeHead(415).end();
            return;
          }
          if (acquiring) {
            res.writeHead(409).end("A browser export is already running. Wait for it to finish.");
            return;
          }
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 8192) throw new Error("The Onshape link is too long.");
          }
          const input = JSON.parse(body);
          if (!input || typeof input !== "object")
            throw new Error("Enter an Onshape link and robot name.");
          const job = {
            id: NodeCrypto.randomUUID(),
            state: "running",
            message: "Opening your Onshape document…",
            startedAt: new Date().toISOString(),
          };
          acquiring = true;
          jobs.set(job.id, job);
          res.writeHead(202).end(JSON.stringify({ jobId: job.id }));
          void acquire(job, input).finally(() => {
            acquiring = false;
          });
          return;
        }
        res.writeHead(404).end();
        return;
      }
      const backend = backendPath(url.pathname);
      const upstream = NodeHttp.request(
        {
          hostname: "127.0.0.1",
          port: backend ? backendPort : webPort,
          path: req.url,
          method: req.method,
          headers: headersFor(req, backend),
        },
        (response) => {
          if (!backend && response.headers["content-type"]?.includes("text/html")) {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const html = Buffer.concat(chunks)
                .toString()
                .replace(
                  "<head>",
                  "<head><script>window.__cadsenseOnshapeBrowserPrototype=true</script>",
                );
              const headers = { ...response.headers };
              delete headers["content-length"];
              delete headers.etag;
              res.writeHead(response.statusCode, headers).end(html);
            });
          } else {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("The prototype backend is unavailable.");
      });
      req.on("aborted", () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) {
      res.writeHead(400).end(error instanceof Error ? error.message : "Invalid request");
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.on("upgrade", async (req, client, head) => {
    if (!authenticated(req) || !sameOrigin(req)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const url = new URL(req.url, "http://prototype");
      const backend = url.pathname === "/ws";
      if (backend) {
        const response = await fetch(`http://127.0.0.1:${backendPort}/api/auth/websocket-ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}` },
        });
        if (!response.ok) throw new Error("WebSocket authentication failed");
        url.searchParams.set("wsTicket", (await response.json()).ticket);
      }
      const upstream = NodeHttp.request({
        hostname: "127.0.0.1",
        port: backend ? backendPort : webPort,
        path: url.pathname + url.search,
        headers: headersFor(req, backend),
      });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        client.write(
          `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((text, value, index, all) => (index % 2 === 0 ? `${text}${value}: ${all[index + 1]}\r\n` : text), "")}\r\n`,
        );
        if (remoteHead.length) client.write(remoteHead);
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
        client.on("error", () => remote.destroy());
        remote.on("error", () => client.destroy());
        client.on("close", () => remote.destroy());
        remote.on("close", () => client.destroy());
      });
      upstream.on("response", (response) => {
        client.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
        response.resume();
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.end();
    } catch {
      client.destroy();
    }
  });
  server.on("error", (error) => {
    note("Preview server failed", { error: error.message });
    void cleanup();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const info = {
    pid: process.pid,
    electronPid: application.process().pid,
    webPid: web.pid,
    backendPort,
    webPort,
    port,
    output,
    access,
    url: `http://100.83.64.92:${port}/?access=${access}`,
  };
  await NodeFSP.writeFile(NodePath.join(output, "server.json"), JSON.stringify(info, null, 2), {
    mode: 0o600,
  });
  note("Onboarding preview ready", { url: info.url, output });
} catch (error) {
  note("Prototype failed", { error: String(error) });
  process.exitCode = 1;
  await cleanup();
}
