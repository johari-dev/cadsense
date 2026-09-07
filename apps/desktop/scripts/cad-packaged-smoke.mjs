import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { _electron } from "playwright-core";
import { extractElectronArchive } from "./ensure-electron-runtime.mjs";
import { cadSmokeThreads, seedCadSmokeFixture } from "./cad-smoke-fixture.mjs";

// oxlint-disable-next-line cadsense/no-global-process-runtime -- Standalone acceptance harness owns its process.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line cadsense/no-global-process-runtime -- Standalone acceptance harness owns its process.
const hostArchitecture = NodeOS.arch();
// Disposable x64 runners have no usable GPU. This opt-in is confined to trusted generated fixtures;
// it does not alter the shipped app's graphics policy or establish hardware performance results.
const softwareGraphics = process.env.GITHUB_ACTIONS === "true" && hostArchitecture === "x64";

const { values } = NodeUtil.parseArgs({
  options: {
    artifact: { type: "string" },
    executable: { type: "string" },
    output: { type: "string" },
    video: { type: "boolean", default: false },
  },
});
if (Boolean(values.artifact) === Boolean(values.executable))
  throw new Error("Provide exactly one --artifact or --executable");
if (hostPlatform === "darwin" && process.env.GITHUB_ACTIONS !== "true")
  throw new Error(
    "macOS smoke runs require a disposable GitHub runner; do not touch a local app profile",
  );

const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cadsense-cad-package-"));
const output = NodePath.resolve(values.output ?? NodePath.join(directory, "evidence"));
await NodeFSP.mkdir(output, { recursive: true });
const baseDir = NodePath.join(directory, "app-state");
await NodeFSP.mkdir(baseDir);
let executablePath = values.executable ? NodePath.resolve(values.executable) : null;
if (values.artifact) {
  const artifact = NodePath.resolve(values.artifact);
  const unpacked = NodePath.join(directory, "package");
  await NodeFSP.mkdir(unpacked);
  if (artifact.endsWith(".AppImage")) {
    await NodeFSP.chmod(artifact, 0o755);
    const result = NodeChildProcess.spawnSync(artifact, ["--appimage-extract"], {
      cwd: unpacked,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`Could not extract AppImage: ${result.stderr}`);
    executablePath = NodePath.join(unpacked, "squashfs-root", "AppRun");
  } else {
    extractElectronArchive(artifact, unpacked);
    const entries = await NodeFSP.readdir(unpacked);
    if (hostPlatform === "darwin") {
      const bundles = entries.filter((name) => name.endsWith(".app"));
      NodeAssert.equal(bundles.length, 1, "Expected one packaged Mac app");
      const binaries = NodePath.join(unpacked, bundles[0], "Contents", "MacOS");
      const names = await NodeFSP.readdir(binaries);
      NodeAssert.equal(names.length, 1, "Expected one Mac app executable");
      executablePath = NodePath.join(binaries, names[0]);
    } else {
      const names = entries.filter((name) => /^Cadsense.*\.exe$/i.test(name));
      NodeAssert.equal(names.length, 1, "Expected one packaged Windows app");
      executablePath = NodePath.join(unpacked, names[0]);
    }
  }
}
NodeAssert.ok(executablePath);
const env = {
  ...process.env,
  CADSENSE_HOME: baseDir,
  APPDATA: NodePath.join(directory, "electron-profile"),
  LOCALAPPDATA: NodePath.join(directory, "electron-local"),
  XDG_CONFIG_HOME: NodePath.join(directory, "electron-config"),
  CADSENSE_DISABLE_AUTO_UPDATE: "true",
};
delete env.VITE_DEV_SERVER_URL;
delete env.CADSENSE_PORT;
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
const report = {
  platform: hostPlatform,
  architecture: hostArchitecture,
  graphics: softwareGraphics ? "CI SwiftShader" : "default platform graphics",
  executablePath,
  baseDir,
  steps: [],
};
const launch = async (record = false) => {
  application = await _electron.launch({
    executablePath,
    env,
    cwd: directory,
    timeout: 45_000,
    ...(record && values.video
      ? { recordVideo: { dir: output, size: { width: 1024, height: 768 } } }
      : {}),
    args: softwareGraphics
      ? ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]
      : [],
  });
  console.log(`CAD smoke Electron PID: ${application.process().pid}`);
  const page = await application.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("sidebar-add-project-trigger").waitFor();
  NodeAssert.equal(
    await application.evaluate(({ app }) => app.isPackaged),
    true,
    "Must exercise a packaged app",
  );
  return page;
};
const close = async () => {
  const current = application;
  application = undefined;
  if (current) await current.close();
};
const openCad = async (page) => {
  await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  await page
    .getByRole("button", { name: "C CAD Inspect the Onshape project.", exact: true })
    .click();
  await page.getByLabel("Camera view", { exact: true }).waitFor();
  await page.locator("canvas").waitFor();
  await page.getByLabel("Explode CAD", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /^Components/ }).waitFor();
};
const waitValue = async (locator, value) => {
  const label = await locator.getAttribute("aria-label");
  NodeAssert.ok(label, "Smoke inputs must have accessible labels");
  await locator
    .page()
    .waitForFunction(
      ({ label, expected }) =>
        document.querySelector(`[aria-label=${JSON.stringify(label)}]`)?.value === expected,
      { label, expected: value },
    );
};
const waitHidden = async (page, name) => {
  await page
    .getByRole("checkbox", { name, exact: true })
    .and(page.locator('[aria-checked="false"]'))
    .waitFor();
};
try {
  await launch();
  await close();
  const fixture = await seedCadSmokeFixture(baseDir);
  report.steps.push("initialized isolated backend and seeded offline assembly/multipart fixtures");
  let page = await launch(true);
  await page.getByTestId(`thread-row-${cadSmokeThreads[0]}`).click();
  await openCad(page);
  const originalBackground = await page.evaluate(() => ({
    value: document.documentElement.style.getPropertyValue("--background"),
    priority: document.documentElement.style.getPropertyPriority("--background"),
  }));
  try {
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--background", "#223344"),
    );
    await page.waitForFunction(() => {
      const gl = document.querySelector('canvas[aria-label="CAD viewer"]')?.getContext("webgl2");
      if (!gl) return false;
      const clear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
      return [34, 51, 68].every((channel, index) => Math.abs(clear[index] * 255 - channel) < 1);
    });
    NodeAssert.equal(
      await page.getByLabel("Camera view", { exact: true }).inputValue(),
      "isometric",
    );
  } finally {
    await page.evaluate(({ value, priority }) => {
      if (value) document.documentElement.style.setProperty("--background", value, priority);
      else document.documentElement.style.removeProperty("--background");
    }, originalBackground);
  }
  report.steps.push("CAD follows the app palette without changing its camera");
  await page.getByLabel("Camera view", { exact: true }).selectOption("front");
  const explosion = page.getByLabel("Explode CAD", { exact: true });
  await explosion.fill("0.5");
  await explosion.press("Tab");
  await page.getByRole("button", { name: /^Components/ }).click();
  await page.getByRole("button", { name: "Collapse Nested assembly", exact: true }).click();
  await page.getByRole("button", { name: "Expand Nested assembly", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show Component A", exact: true }).click();
  await waitHidden(page, "Show Component A");
  await page.screenshot({ path: NodePath.join(output, "assembly.png") });
  report.steps.push("assembly camera, explosion, nested component visibility");
  await page.getByTestId(`thread-row-${cadSmokeThreads[1]}`).click();
  await openCad(page);
  await waitValue(explosion, "0");
  await page.getByLabel("CAD scene", { exact: true }).selectOption(fixture.roots[1]);
  await page.getByRole("button", { name: /^Components/ }).click();
  await page.getByRole("checkbox", { name: "Show Studio body A", exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Show Studio body B", exact: true }).click();
  await waitHidden(page, "Show Studio body B");
  await page.screenshot({ path: NodePath.join(output, "multipart.png") });
  report.steps.push("multipart root, per-body visibility, independent thread state");
  await page.getByTestId(`thread-row-${cadSmokeThreads[0]}`).click();
  await waitValue(explosion, "0.5");
  NodeAssert.equal(
    await page.getByLabel("CAD scene", { exact: true }).inputValue(),
    fixture.roots[0],
  );
  await close();
  page = await launch();
  await page.getByTestId(`thread-row-${cadSmokeThreads[0]}`).click();
  if ((await page.getByRole("button", { name: "Close CAD", exact: true }).count()) === 0)
    await openCad(page);
  await page.locator("canvas").waitFor();
  await waitValue(page.getByLabel("Explode CAD", { exact: true }), "0.5");
  await page.screenshot({ path: NodePath.join(output, "reopened.png") });
  report.steps.push("offline application restart retained thread CAD view");
  const cdp = await page.context().newCDPSession(page);
  const documentKeyListeners = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "document",
      objectGroup: "cad-cleanup-check",
    });
    try {
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId,
      });
      return listeners.filter((listener) => listener.type === "keydown" && listener.useCapture)
        .length;
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "cad-cleanup-check" });
    }
  };
  try {
    await page.getByRole("button", { name: "Close CAD", exact: true }).click();
    const before = await documentKeyListeners();
    await page.evaluate(() => {
      window.__cadClosedCanvases = [];
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      await openCad(page);
      await page.evaluate(() => {
        window.__cadClosedCanvases.push(new WeakRef(document.querySelector("canvas")));
      });
      await page.getByRole("button", { name: "Close CAD", exact: true }).click();
    }
    const after = await documentKeyListeners();
    report.documentKeyListeners = { before, after };
    NodeAssert.equal(after, before, "Closed CAD viewers must release document key listeners");
    await cdp.send("HeapProfiler.collectGarbage");
    report.retainedClosedCanvases = await page.evaluate(
      () => window.__cadClosedCanvases.filter((reference) => reference.deref()).length,
    );
    NodeAssert.equal(report.retainedClosedCanvases, 0, "Closed CAD canvases must be collectable");
  } finally {
    await page.evaluate(() => {
      delete window.__cadClosedCanvases;
    });
    await cdp.detach();
  }
  report.steps.push("repeated CAD close/reopen releases document listeners");
  NodeAssert.deepEqual(errors, [], "Renderer must not raise page errors");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  const page = application?.windows()[0];
  if (page) {
    report.visibleText = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(0, 12_000);
    await page.screenshot({ path: NodePath.join(output, "failure.png") }).catch(() => undefined);
  }
  throw error;
} finally {
  await close();
  await NodeFSP.writeFile(NodePath.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
