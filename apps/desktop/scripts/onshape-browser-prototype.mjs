// Throwaway proof: export a real public Onshape document through CADsense's browser,
// capture the download without API keys, and import or sync STEP through the normal UI.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { _electron } from "playwright-core";
import electronExecutable from "electron";

// oxlint-disable-next-line cadsense/no-global-process-runtime -- This standalone prototype owns its processes.
const hostPlatform = NodeOS.platform();
const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    sync: { type: "boolean" },
    "skip-build": { type: "boolean" },
  },
});
const syncPrototype = values.sync === true;
const sourceUrl =
  values.url ??
  "https://cad.onshape.com/documents/e5fd6dd412a8653a52ad3252/w/1cc3344ea68c679223cb7558/e/e46921a75b1bb6cff79888e0";
NodeAssert.equal(new URL(sourceUrl).origin, "https://cad.onshape.com");
await NodeFSP.mkdir(NodePath.join(root, ".cadsense"), { recursive: true });
const output = await NodeFSP.mkdtemp(
  NodePath.join(root, `.cadsense/onshape-browser-${syncPrototype ? "sync" : "export"}-`),
);
const projectFolder = NodePath.join(
  output,
  syncPrototype ? "Onshape browser sync" : "Onshape browser export",
);
await NodeFSP.mkdir(projectFolder);
await NodeFSP.mkdir(NodePath.join(output, "frames"));
const stableCadPath = NodePath.join(projectFolder, "onshape-browser-proof.step");
if (syncPrototype) {
  // An explicit offline baseline proves a geometry update without editing the public document.
  await NodeFSP.copyFile(
    NodePath.join(root, "packages/featurescript/corpus/bolt-circle/plate.step"),
    stableCadPath,
  );
}
const report = {
  sourceUrl,
  output,
  mode: syncPrototype ? "sync" : "import",
  steps: [],
  downloads: [],
  success: false,
};
const note = (step, detail = {}) => {
  const entry = { step, at: new Date().toISOString(), ...detail };
  report.steps.push(entry);
  console.log(JSON.stringify(entry));
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (command, args, cwd = root) => {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
};
// Only poll our own local processes and app state. Onshape's website owns export-job polling.
const until = async (read, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Prototype timed out after ${timeoutMs}ms`);
};
const portProbe = NodeNet.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const backendPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
let application;
let page;
let web;
let runtimeTabId;
let capturing = false;
let captureLoop;
const frames = [];
let browserRecording = false;

try {
  if (!values["skip-build"]) {
    note("build isolated desktop runtime");
    run("vp", ["run", "--filter", "@cadsense/server", "build:desktop-dev"]);
    run(process.execPath, ["apps/desktop/scripts/build-preview-annotation-css.mjs"]);
    run("vp", ["pack"], NodePath.join(root, "apps/desktop"));
  }
  const webLogPath = NodePath.join(output, "web.log");
  const webLog = NodeFS.createWriteStream(webLogPath);
  web = NodeChildProcess.spawn(
    "vp",
    ["run", "dev:web", "--home-dir", NodePath.join(output, "state"), "--port", String(backendPort)],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      // Keep the complete dev-server tree in an owned process group for cleanup.
      detached: hostPlatform !== "win32",
    },
  );
  web.stdout.pipe(webLog);
  web.stderr.pipe(webLog);
  const webPort = await until(async () => {
    const log = await NodeFSP.readFile(webLogPath, "utf8").catch(() => "");
    return Number(log.match(/\[dev-runner\].*webPort=(\d+)/)?.[1]) || null;
  });
  const rendererUrl = `http://127.0.0.1:${webPort}/`;
  await until(async () =>
    fetch(rendererUrl)
      .then((response) => response.ok)
      .catch(() => false),
  );
  const env = {
    ...process.env,
    CADSENSE_HOME: NodePath.join(output, "state"),
    CADSENSE_PORT: String(backendPort),
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
    args: [
      NodePath.join(root, "apps/desktop/dist-electron/main.cjs"),
      ...(hostPlatform === "linux"
        ? ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]
        : []),
    ],
    env,
    timeout: 60_000,
  });
  const desktopLog = NodeFS.createWriteStream(NodePath.join(output, "desktop.log"));
  application.process().stdout.pipe(desktopLog);
  application.process().stderr.pipe(desktopLog);
  note("isolated app started", {
    pid: application.process().pid,
    webPid: web.pid,
    backendPort,
    webPort,
  });
  await application.firstWindow();
  await application.evaluate(({ BrowserWindow, dialog }, folder) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.closeDevTools();
    // Native pickers cannot be controlled with DOM selectors. Supply only this run's folder.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, projectFolder);
  page = await until(() =>
    application.windows().find((window) => !window.url().startsWith("devtools:")),
  );
  page.setDefaultTimeout(30_000);
  await page.getByTestId("sidebar-add-project-trigger").click();
  await page.getByRole("button", { name: "Folder project", exact: true }).click();
  await page.getByRole("button", { name: "Toggle right panel", exact: true }).waitFor();
  capturing = true;
  captureLoop = (async () => {
    // oxlint-disable-next-line no-unmodified-loop-condition -- The main flow stops capture after the import or sync.
    while (capturing) {
      const file = NodePath.join(output, "frames", `${String(frames.length).padStart(6, "0")}.jpg`);
      const at = Date.now();
      try {
        await page.screenshot({ path: file, type: "jpeg", quality: 80 });
        frames.push({ path: file, at });
      } catch (error) {
        note("screenshot skipped during navigation", { error: String(error) });
      }
      await delay(1_000);
    }
  })();
  const readProject = () =>
    page.evaluate(async (folder) => {
      const { appAtomRegistry } = await import("/src/rpc/atomRegistry.ts");
      const { environmentProjects } = await import("/src/state/projects.ts");
      const project = appAtomRegistry
        .get(environmentProjects.projectsAtom)
        .find((project) => project.workspaceRoot === folder);
      if (!project) throw new Error("Prototype project not found");
      return { projectId: project.id, localCadSource: project.localCadSource, cad: project.cad };
    }, projectFolder);
  const waitForSync = (previousOperation) =>
    until(async () => {
      const project = await readProject();
      const outcome = project.cad?.lastOutcome;
      if (!outcome || outcome.operationId === previousOperation || project.cad.operation)
        return null;
      NodeAssert.equal(outcome.status, "succeeded", outcome.reason ?? "CAD sync failed");
      return project;
    }, 300_000);
  await page.evaluate(async () => {
    (await import("/src/components/preview/previewActionBus.ts")).dispatchPreviewAction(
      "toggle-panel",
    );
  });
  await page.locator("webview").waitFor({ state: "attached" });
  // The first open can replace its provisional runtime tab when the server epoch arrives.
  await until(async () => {
    runtimeTabId = await page.locator("webview").getAttribute("data-preview-tab");
    return (
      await page.evaluate(
        (tab) => window.desktopBridge.preview.automation.status(tab),
        runtimeTabId,
      )
    ).available;
  });
  await page.getByRole("button", { name: "Maximize panel", exact: true }).click();
  let baseline;
  if (syncPrototype) {
    await page.getByRole("button", { name: "Back to CAD", exact: true }).click();
    await page.getByRole("button", { name: "Pick a file", exact: true }).waitFor();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, stableCadPath);
    await page.getByRole("button", { name: "Pick a file", exact: true }).click();
    baseline = await waitForSync(null);
    await page.getByRole("toolbar", { name: "CAD camera views", exact: true }).waitFor();
    report.baseline = baseline;
    await page.screenshot({ path: NodePath.join(output, "baseline-cad.png") });
    note("existing CAD project seeded from offline plate fixture", {
      projectId: baseline.projectId,
      snapshotId: baseline.cad.roots[0].current.snapshotId,
    });
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    const unchanged = await waitForSync(baseline.cad.lastOutcome.operationId);
    NodeAssert.deepEqual(unchanged.cad.roots[0].current, baseline.cad.roots[0].current);
    report.unchangedBaseline = unchanged;
    note("unchanged baseline sync reused its existing snapshot");
    // Prototype-only binding: intercept one real Sync click, then let the normal Sync handler
    // import the validated browser download. No production components are changed.
    let requested;
    const syncRequested = new Promise((resolve) => {
      requested = resolve;
    });
    await page.exposeFunction("__onshapePrototypeSyncRequested", () => requested());
    await page.evaluate(() => {
      const handler = (event) => {
        const button = event.target.closest("button");
        if (button?.textContent.trim() !== "Sync" || button.disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        document.removeEventListener("click", handler, true);
        void window.__onshapePrototypeSyncRequested();
      };
      document.addEventListener("click", handler, true);
    });
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await syncRequested;
    note("Sync click requested acquisition through the browser");
    await page.evaluate(async () => {
      (await import("/src/components/preview/previewActionBus.ts")).dispatchPreviewAction(
        "toggle-panel",
      );
    });
  }
  const urlInput = page.getByPlaceholder("Search or enter URL");
  await urlInput.fill(sourceUrl);
  await urlInput.press("Enter");
  const evaluate = (expression) =>
    page.evaluate(
      ({ tab, expression }) =>
        window.desktopBridge.preview.automation.evaluate(tab, { expression }),
      // DOM actions return undefined; the existing bridge expects a JSON value.
      { tab: runtimeTabId, expression: `(${expression}) ?? null` },
    );
  await until(async () => {
    runtimeTabId = await page.locator("webview").getAttribute("data-preview-tab");
    try {
      return await evaluate(
        "Boolean(Array.from(document.querySelectorAll('[command-id=exportTab]')).find(e=>e.getBoundingClientRect().width>0)) && !document.body.innerText.includes('Loading studio data')",
      );
    } catch {
      return false;
    }
  }, 120_000);
  const guestState = await evaluate(
    "({url:location.href,signInVisible:Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Sign in')})",
  );
  note("anonymous Onshape document ready", guestState);
  NodeAssert.equal(guestState.signInVisible, true, "The proof must use an unsigned-in browser");
  await application.evaluate(
    ({ webContents }, { folder, stage }) => {
      globalThis.__onshapePrototypeDownloads = [];
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === "webview");
      guest.session.on("will-download", (_event, item) => {
        const fileName = item.getFilename().replace(/[^a-zA-Z0-9._ -]/g, "_");
        const record = {
          fileName,
          path: stage ? `${folder}/.${fileName}.download` : `${folder}/${fileName}`,
          state: "started",
          receivedBytes: 0,
        };
        globalThis.__onshapePrototypeDownloads.push(record);
        item.setSavePath(record.path);
        item.once("done", (_event, state) => {
          record.state = state;
          record.receivedBytes = item.getReceivedBytes();
        });
      });
    },
    { folder: projectFolder, stage: syncPrototype },
  );
  await page.evaluate(
    async (tab) => (await import("/src/browser/browserRecording.ts")).startBrowserRecording(tab),
    runtimeTabId,
  );
  browserRecording = true;
  note("in-app browser recording started");
  // DOM clicks still use the app's browser evaluate operation. No direct export HTTP calls.
  await evaluate(
    "Array.from(document.querySelectorAll('[command-id=exportTab]')).find(e=>e.getBoundingClientRect().width>0).click()",
  );
  await until(() =>
    evaluate(
      "Boolean(document.querySelector('.export-dialog.show #export-filename-input')?.getBoundingClientRect().width)",
    ),
  );
  await page.evaluate(
    (tab) =>
      window.desktopBridge.preview.automation.type(tab, {
        selector: "#export-filename-input",
        text: "onshape-browser-proof",
        clear: true,
      }),
    runtimeTabId,
  );
  await evaluate(
    "(()=>{const select=document.querySelector('#export-format-dropdown');select.value=Array.from(select.options).find(o=>o.textContent==='STEP').value;select.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await until(() =>
    evaluate(
      "Array.from(document.querySelectorAll('.export-dialog.show button')).some(e=>e.textContent.trim()==='Export'&&!e.disabled)&&Boolean(document.querySelector('#export-format-dropdown')?.getBoundingClientRect().width)",
    ),
  );
  await page.screenshot({ path: NodePath.join(output, "export-dialog.png") });
  await delay(2_000);
  await evaluate(
    "Array.from(document.querySelectorAll('.export-dialog.show button')).find(e=>e.textContent.trim()==='Export').click()",
  );
  note("STEP export submitted through website");
  const download = await until(
    () =>
      application.evaluate(() =>
        globalThis.__onshapePrototypeDownloads.find((item) => item.state === "completed"),
      ),
    180_000,
  );
  const bytes = await NodeFSP.readFile(download.path);
  NodeAssert.ok(bytes.subarray(0, 100).toString().includes("ISO-10303-21;"));
  NodeAssert.ok(bytes.subarray(-100).toString().includes("END-ISO-10303-21;"));
  NodeAssert.equal(bytes.byteLength, download.receivedBytes);
  if (syncPrototype) {
    NodeAssert.deepEqual((await readProject()).cad.roots[0].current, baseline.cad.roots[0].current);
    NodeAssert.deepEqual(
      await NodeFSP.readFile(stableCadPath),
      await NodeFSP.readFile(
        NodePath.join(root, "packages/featurescript/corpus/bolt-circle/plate.step"),
      ),
    );
    download.stagedPath = download.path;
    await NodeFSP.rename(download.path, stableCadPath);
    download.path = stableCadPath;
    note("validated browser export atomically replaced the linked STEP");
  }
  report.downloads.push({
    ...download,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  });
  note("complete STEP download verified", { bytes: bytes.byteLength });
  const recording = await page.evaluate(
    async (tab) => (await import("/src/browser/browserRecording.ts")).stopBrowserRecording(tab),
    runtimeTabId,
  );
  browserRecording = false;
  await NodeFSP.copyFile(recording.path, NodePath.join(output, "onshape-browser-recording.mp4"));
  // Once CAD is linked, the header's Back button names that file instead of "CAD".
  await page.getByRole("button", { name: /^Back to / }).click();
  await page
    .getByRole("button", { name: syncPrototype ? "Sync" : "Pick a file", exact: true })
    .waitFor();
  // Close the completed website tab so its WebGL scene does not compete with tessellation.
  await page.evaluate(async () => {
    (await import("/src/components/preview/previewActionBus.ts")).dispatchPreviewAction(
      "toggle-panel",
    );
  });
  await page.getByRole("button", { name: "Close browser page", exact: true }).click();
  if (syncPrototype) {
    const before = await readProject();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    note("existing CAD sync submitted with browser-acquired STEP");
    const synced = await waitForSync(before.cad.lastOutcome.operationId);
    NodeAssert.equal(synced.projectId, baseline.projectId);
    NodeAssert.deepEqual(synced.localCadSource, baseline.localCadSource);
    NodeAssert.equal(synced.cad.roots[0].rootId, baseline.cad.roots[0].rootId);
    NodeAssert.notEqual(
      synced.cad.roots[0].current.snapshotId,
      baseline.cad.roots[0].current.snapshotId,
    );
    NodeAssert.equal(
      synced.cad.roots[0].rollback.snapshotId,
      baseline.cad.roots[0].current.snapshotId,
    );
    report.synced = synced;
    note("same project and root advanced to the browser snapshot", {
      projectId: synced.projectId,
      snapshotId: synced.cad.roots[0].current.snapshotId,
    });
  } else {
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, download.path);
    await page.getByRole("button", { name: "Pick a file", exact: true }).click();
    note("import submitted through local CAD UI");
  }
  await page
    .getByRole("toolbar", { name: "CAD camera views", exact: true })
    .waitFor({ timeout: 300_000 });
  await page.getByRole("button", { name: "Reset view to isometric", exact: true }).click();
  await delay(3_000);
  await page.screenshot({ path: NodePath.join(output, "imported-cad.png") });
  if (syncPrototype) {
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    const unchanged = await waitForSync(report.synced.cad.lastOutcome.operationId);
    NodeAssert.deepEqual(unchanged.cad.roots[0].current, report.synced.cad.roots[0].current);
    report.unchangedSynced = unchanged;
    note("unchanged browser-acquired CAD reused the synced snapshot");
    await page.screenshot({ path: NodePath.join(output, "unchanged-sync.png") });
  }
  report.finalUi = await page.locator("body").innerText();
  note("CAD model displayed in CADsense");
  report.success = true;
} catch (error) {
  report.error = String(error);
  note("prototype stopped", { error: report.error });
  if (page) await page.screenshot({ path: NodePath.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browserRecording) {
    await page
      .evaluate(
        async (tab) => (await import("/src/browser/browserRecording.ts")).stopBrowserRecording(tab),
        runtimeTabId,
      )
      .catch(() => {});
  }
  capturing = false;
  await captureLoop;
  await NodeFSP.writeFile(
    NodePath.join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(output, "frame-log.json"), JSON.stringify(frames));
  await application?.close();
  if (web?.pid) {
    if (hostPlatform === "win32") {
      NodeChildProcess.spawnSync("taskkill", ["/PID", String(web.pid), "/T", "/F"]);
    } else {
      try {
        process.kill(-web.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") note("dev process cleanup failed", { error: String(error) });
      }
    }
  }
  if (frames.length) {
    const quoted = (file) => `'${file.replaceAll("'", "'\\''")}'`;
    const entries = frames.map(
      (frame, index) =>
        `file ${quoted(frame.path)}\nduration ${Math.max(0.04, ((frames[index + 1]?.at ?? frame.at + 2_000) - frame.at) / 1_000)}`,
    );
    entries.push(`file ${quoted(frames.at(-1).path)}`);
    const concat = NodePath.join(output, "frames.txt");
    await NodeFSP.writeFile(concat, entries.join("\n"));
    run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concat,
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-r",
      "12",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      NodePath.join(output, `cadsense-browser-${syncPrototype ? "sync" : "export"}-proof.mp4`),
    ]);
  }
  console.log(`Evidence: ${output}`);
}
