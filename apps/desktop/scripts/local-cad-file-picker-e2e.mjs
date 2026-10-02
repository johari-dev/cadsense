// End-to-end check that the CAD panel's "Pick a file" button opens the native file dialog and
// imports the chosen file. Launches the dev desktop app with an isolated profile, replaces
// Electron's dialog.showOpenDialog in the main process with a stub that records its options and
// answers with prepared paths, then clicks through: add a plain folder project, open CAD, pick a
// file, and wait for the model. Everything between the click and the dialog (preload, IPC, the
// main-process handler) and after it (link, import, render) is the real app.
//
//   node apps/desktop/scripts/local-cad-file-picker-e2e.mjs --web-url http://localhost:7083 \
//     --server-port 15123 --out .cadsense/local-cad-picker-e2e/run
//
// Needs a running web dev server (`node scripts/dev-runner.ts dev:web` prints both ports; the app
// starts its own backend on the server port), the desktop main and
// preload built (`vp pack` in apps/desktop), the server bundle (`vp pack` in apps/server), and a
// display (WSLg provides :0). Keeps a screenshot per step, the dialog calls, and summary.json.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { _electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    "web-url": { type: "string" },
    "server-port": { type: "string" },
    out: { type: "string" },
  },
});
if (!values["web-url"] || !values["server-port"] || !values.out)
  throw new Error("Usage: --web-url <url> --server-port <port> --out <dir>");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const fixture = NodePath.resolve(desktopDir, "../server/src/localCad/testFixtures/dm1-id-214.stp");

const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports"), { recursive: true });
NodeFS.copyFileSync(fixture, NodePath.join(folder, "exports/bracket.step"));
const pickedFile = NodePath.join(folder, "exports/bracket.step");

const summary = { steps: [], dialogCalls: [], pageErrors: [], ok: false };
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: values["web-url"],
  CADSENSE_HOME: NodePath.join(out, "home"),
  XDG_CONFIG_HOME: NodePath.join(out, "electron-config"),
  APPDATA: NodePath.join(out, "electron-profile"),
  LOCALAPPDATA: NodePath.join(out, "electron-local"),
  CADSENSE_DISABLE_AUTO_UPDATE: "true",
  CADSENSE_PORT: values["server-port"],
  DISPLAY: process.env.DISPLAY || ":0",
};
delete env.ELECTRON_RUN_AS_NODE;

const launch = resolveElectronLaunchCommand([
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  `--cadsense-dev-root=${desktopDir}`,
  "dist-electron/main.cjs",
]);
const application = await _electron.launch({
  executablePath: launch.electronPath,
  args: launch.args,
  cwd: desktopDir,
  env,
  timeout: 60_000,
});
try {
  // Each dialog call gets the next path: first the project folder, then the CAD file.
  await application.evaluate(
    ({ dialog }, answers) => {
      globalThis.__cadsenseDialogCalls = [];
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        globalThis.__cadsenseDialogCalls.push(options);
        const path = answers.shift();
        return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] };
      };
    },
    [folder, pickedFile],
  );

  // Development builds also open a detached DevTools window, so find the app's own page.
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = application.windows().find((window) => !window.url().startsWith("devtools:"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page)
    throw new Error(
      `The app window did not open. Windows: ${application
        .windows()
        .map((window) => window.url())
        .join(", ")}`,
    );
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => summary.pageErrors.push(error.message));
  let shots = 0;
  const run = async (name, action) => {
    const started = Date.now();
    const observed = await action().catch(async (error) => {
      await page.screenshot({ path: NodePath.join(out, `failed-${name}.png`) }).catch(() => {});
      throw error;
    });
    const index = String(++shots).padStart(2, "0");
    await page.screenshot({ path: NodePath.join(out, `${index}-${name}.png`) });
    summary.steps.push({ name, ms: Date.now() - started, ...(observed ? { observed } : {}) });
    writeSummary();
    console.log(`${index} ${name}`, observed ?? "");
  };
  const panel = page.getByRole("region", { name: "CAD panel" });

  await run("folder-project", async () => {
    await page.getByTestId("sidebar-add-project-trigger").click();
    await page.getByRole("button", { name: "Folder project" }).click();
    await page
      .getByRole("button", { name: /^New thread in bracket-rig/ })
      .first()
      .waitFor();
  });
  await run("cad-prompt", async () => {
    await page.getByRole("button", { name: "Toggle right panel" }).click();
    await page.getByText("Review this project's CAD.").click();
    await page.getByText("No CAD file linked").waitFor();
    return { text: await page.getByText("No CAD file linked").locator("../..").innerText() };
  });
  await run("model-imported", async () => {
    await page.getByRole("button", { name: "Pick a file" }).click();
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    return { title: (await panel.innerText()).split("\n")[0] };
  });

  summary.dialogCalls = await application.evaluate(() => globalThis.__cadsenseDialogCalls);
  const [folderCall, fileCall] = summary.dialogCalls;
  NodeAssert.deepEqual(folderCall?.properties, ["openDirectory", "createDirectory"]);
  NodeAssert.deepEqual(fileCall?.properties, ["openFile"]);
  NodeAssert.equal(fileCall?.defaultPath, folder, "The file dialog opens in the project folder");
  NodeAssert.ok(
    fileCall?.filters?.[0]?.extensions.includes("step"),
    "The file dialog filters to STEP and IGES",
  );
  NodeAssert.equal(summary.steps.at(-1)?.observed?.title, "exports/bracket.step");
  NodeAssert.deepEqual(summary.pageErrors, []);
  summary.ok = true;
} finally {
  writeSummary();
  await application.close();
}
console.log(`Passed. Evidence in ${out}`);
