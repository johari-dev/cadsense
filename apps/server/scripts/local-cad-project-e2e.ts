// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of local CAD projects through the real app. Starts the dev server and web app on
 * a fresh data directory, then drives headless Chromium through the whole flow and keeps the
 * evidence under --out:
 *
 *   bracket-rig/         the project folder: the STEP file, an older export, and a corrupt file
 *   NN-*.png             a screenshot after each step
 *   dev.log              dev runner, server, and web output
 *   summary.json         step timings and what each step observed
 *
 *   node apps/server/scripts/local-cad-project-e2e.ts --out .cadsense/local-cad-e2e/run \
 *     [--step path/to/assembly.step] [--ask "How many bolts?" --model "Opus 5.5"] \
 *     [--solidworks "path/to/SolidWorks folder" --solidworks-assembly Frame.SLDASM \
 *      --solidworks-part Bracket.SLDPRT --solidworks-large Robot.SLDASM \
 *      --solidworks-empty path/to/Sketch.SLDPRT]
 *
 * --step defaults to the dm1 fixture in src/localCad/testFixtures. --ask sends one prompt in a new
 * chat with the model the picker's search finds for --model, and keeps the answer in
 * agent-answer.txt. It runs a real agent turn, so it needs that provider signed in and costs tokens.
 *
 * --solidworks needs SolidWorks on this machine or its Windows host, and copies files out of that
 * folder into one project folder per case under --out, each with the files its assembly uses:
 *
 *   sw-part       --solidworks-part, converted while SolidWorks is already open with a document of
 *                 the user's own, which must stay open, visible, and running afterwards
 *   sw-assembly   --solidworks-assembly, then a Sync of the unchanged files that must not convert
 *   sw-large      --solidworks-large (optional), which must render
 *   sw-empty      --solidworks-empty (optional), a part with only sketches: the no-geometry message
 *   sw-missing    --solidworks-assembly less one file it uses: a message naming that file
 *
 * --solidworks-sample copies a folder as it is, subfolders included (such as one of the tutorial
 * assemblies SolidWorks installs under Public Documents), and imports
 * --solidworks-sample-assembly from it, then --solidworks-sample-part on its own. These make
 * screenshots that show no one's own design.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache and renders with
 * SwiftShader.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { chromium, type Page } from "playwright-core";
import { detectSolidWorksHost } from "../src/localCad/SolidWorksBridge.ts";
import { planSolidWorksFiles, readSolidWorksReferences } from "../src/localCad/SolidWorksFiles.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    step: { type: "string" },
    ask: { type: "string" },
    model: { type: "string" },
    solidworks: { type: "string" },
    "solidworks-assembly": { type: "string" },
    "solidworks-part": { type: "string" },
    "solidworks-large": { type: "string" },
    "solidworks-empty": { type: "string" },
    "solidworks-sample": { type: "string" },
    "solidworks-sample-assembly": { type: "string" },
    "solidworks-sample-part": { type: "string" },
  },
});
if (
  !values.out ||
  (values.ask !== undefined && !values.model) ||
  (values.solidworks !== undefined &&
    (!values["solidworks-assembly"] || !values["solidworks-part"]))
)
  throw new Error(
    "Usage: --out <dir> [--step <file.step>] [--ask <prompt> --model <name>] " +
      "[--solidworks <folder> --solidworks-assembly <file> --solidworks-part <file> " +
      "[--solidworks-large <file>] [--solidworks-empty <path>]]",
  );

/**
 * Plays a SolidWorks user for the --solidworks case: `start` launches SolidWorks from its own
 * executable, as a person would, and opens a document of theirs; `check` reports the session;
 * `stop` closes it. It attaches with GetActiveObject, which never starts SolidWorks.
 */
const USER_SESSION_SCRIPT = String.raw`param([string]$Action, [string]$Document)
$ErrorActionPreference = "Stop"
$clsid = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\SldWorks.Application\CLSID")."(default)"
$server = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid\LocalServer32")."(default)"
$exe = [regex]::Match($server, '^\s*"?([^"]*?\.exe)', "IgnoreCase").Groups[1].Value
$interop = Join-Path (Split-Path -Parent $exe) "api\redist\SolidWorks.Interop.sldworks.dll"
Add-Type -Path $interop
Add-Type -ReferencedAssemblies $interop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using SolidWorks.Interop.sldworks;
public static class UserSession {
  static string Report(SldWorks sw, int pid) {
    var titles = ((object[])sw.GetDocuments() ?? new object[0]).Cast<ModelDoc2>().Select(doc => "\"" + doc.GetTitle().Replace("\"", "") + "\"");
    return "{\"pid\":" + pid + ",\"visible\":" + (sw.Visible ? "true" : "false") + ",\"documents\":[" + string.Join(",", titles) + "]}";
  }
  public static string Run(string exe, string action, string document) {
    var running = Process.GetProcessesByName("SLDWORKS");
    if (action == "start") {
      if (running.Length > 0) throw new Exception("SolidWorks is already running.");
      Process.Start(exe);
    } else if (running.Length == 0) return "{\"pid\":0,\"visible\":false,\"documents\":[]}";
    SldWorks sw = null;
    for (int i = 0; sw == null; i++) {
      try { sw = (SldWorks)Marshal.GetActiveObject("SldWorks.Application"); }
      catch (COMException) { if (i > 600) throw; Thread.Sleep(1000); }
    }
    while (!sw.StartupProcessCompleted) Thread.Sleep(1000);
    int pid = Process.GetProcessesByName("SLDWORKS").First().Id;
    if (action == "start") {
      int errors = 0, warnings = 0;
      if (sw.OpenDoc6(document, 1, 1, "", ref errors, ref warnings) == null) throw new Exception("Could not open " + document + " (" + errors + ")");
    }
    if (action == "stop") {
      sw.CloseAllDocuments(true);
      sw.ExitApp();
      Process.GetProcessById(pid).WaitForExit(120000);
      return "{\"pid\":0,\"visible\":false,\"documents\":[]}";
    }
    return Report(sw, pid);
  }
}
'@
[UserSession]::Run($exe, $Action, $Document)
`;
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const repo = NodePath.resolve(import.meta.dirname, "../../..");
const step = NodePath.resolve(
  values.step ?? NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
);
const stepName = `exports/${NodePath.basename(step)}`;

const folder = NodePath.join(out, "bracket-rig");
NodeFS.mkdirSync(NodePath.join(folder, "exports/old"), { recursive: true });
NodeFS.copyFileSync(step, NodePath.join(folder, stepName));
NodeFS.copyFileSync(
  NodePath.join(repo, "apps/server/src/localCad/testFixtures/dm1-id-214.stp"),
  NodePath.join(folder, "exports/old/previous.step"),
);
NodeFS.writeFileSync(NodePath.join(folder, "exports/old/corrupt.step"), "ISO-10303-21;\nbroken\n");
NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "# Not CAD, so not listed\n");

const summary: { steps: { name: string; ms: number; observed?: unknown }[]; ok: boolean } = {
  steps: [],
  ok: false,
};
const writeSummary = () =>
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const log = NodeFS.openSync(NodePath.join(out, "dev.log"), "a");
const dev = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(repo, "scripts/dev-runner.ts"), "dev", "--home-dir", NodePath.join(out, "home")],
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
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let shots = 0;
const run = async (name: string, action: (page: Page) => Promise<unknown>) => {
  const started = Date.now();
  const observed = await action(page).catch(async (error: unknown) => {
    // Keep what the page showed when the step failed.
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
// The model's name and its Sync button sit in the right panel's header, outside the CAD panel.
// A local file is the only model, so its name is a heading rather than a scene picker.
const syncButton = page.getByRole("button", { name: "Sync", exact: true });
const sceneTitle = syncButton.locator("xpath=ancestor::div[.//h2][1]//h2");
// The right panel opens on the CAD view. Opens it unless it is already open.
const openRightPanel = async (page: Page) => {
  const toggle = page.getByRole("button", { name: /^Toggle right panel/ });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
};
// A new project opens on a draft, and the CAD view loads once the draft is a thread. Sending a
// message is how a user gets there; the turn is stopped as soon as it starts. A message can't
// start a turn while the project's first import runs, so like a user, keep sending until it does.
// A failed first send gives the draft a new thread id, and panel state is kept per thread id, so
// the panel closes. The prompt going away only means a thread started if the panel stayed open.
const startThread = async (page: Page) => {
  const placeholder = page.getByText("Start a thread to open its CAD view.");
  const composer = page
    .locator('[data-chat-composer-form="true"] [contenteditable="true"]')
    .first();
  // Opens the draft's panel until it asks for a thread. It can start closed while the draft loads.
  const showPrompt = async () => {
    for (let attempt = 0; !(await placeholder.isVisible()); attempt++) {
      if (attempt === 30) throw new Error("The draft's right panel never asked for a thread");
      await openRightPanel(page);
      await placeholder.waitFor({ timeout: 1_000 }).catch(() => {});
    }
  };
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    await showPrompt();
    if (!(await composer.innerText()).trim()) {
      await composer.click();
      await page.keyboard.type("Open the CAD view.");
    }
    await page.getByRole("button", { name: "Send message" }).click();
    const promptGone = await placeholder.waitFor({ state: "detached", timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    const panelOpen =
      (await page
        .getByRole("button", { name: /^Toggle right panel/ })
        .getAttribute("aria-pressed")) === "true";
    if (promptGone && panelOpen) break;
    if (Date.now() > deadline) throw new Error("Sending never started a thread");
  }
  // Stops the turn if it is still running. A turn that ends by itself first is just as good.
  await page
    .getByRole("button", { name: "Stop generation" })
    .click({ timeout: 15_000 })
    .catch(() => {});
};
const manifestDir = NodePath.join(out, "home/userdata/cad/manifests");
const manifests = () => NodeFS.readdirSync(manifestDir).filter((name) => name.endsWith(".json"));
// Components in the newest imported snapshot, read from the snapshot store.
const componentCount = () => {
  const newest = manifests()
    .map((name) => NodePath.join(manifestDir, name))
    .toSorted((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  if (!newest) return 0;
  return (JSON.parse(NodeFS.readFileSync(newest, "utf8")) as { nodes: unknown[] }).nodes.length;
};

try {
  await run("add-project", async (page) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Dismiss notification" })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Local CAD file" }).click();
  });
  await run("folder-scanned", async (page) => {
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).waitFor({ timeout: 30_000 });
    const form = page.getByRole("form", { name: "Create local CAD project" });
    return {
      listed: (await form.locator("label").allInnerTexts()).map((text) => text.split("\n")[0]),
    };
  });
  // The file list belongs to the scanned folder. Editing the folder drops it, and a folder that
  // fails to scan leaves nothing to create from, rather than the previous folder's file.
  await run("other-folder-failed", async (page) => {
    const form = page.getByRole("form", { name: "Create local CAD project" });
    await page.getByLabel("Folder").fill(`${folder}-missing`);
    if (await form.getByText(stepName, { exact: true }).isVisible())
      throw new Error("The previous folder's files are still listed");
    await page.getByRole("button", { name: "Scan" }).click();
    const scanError = (await form.getByRole("alert").innerText()).trim();
    if (await page.getByRole("button", { name: "Create project" }).isEnabled())
      throw new Error("Create still targets the previous folder");
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(stepName, { exact: true }).waitFor({ timeout: 30_000 });
    return { scanError };
  });
  // Start from the corrupt export, so the panel has to recover through its file prompt.
  await run("corrupt-file-chosen", (page) =>
    page.getByText("exports/old/corrupt.step", { exact: true }).click(),
  );
  await run("project-created", async (page) => {
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "detached" });
    return { url: page.url() };
  });
  await run("cad-panel-import-failed", async (page) => {
    await startThread(page);
    await panel.getByText(/Could not read this CAD file/).waitFor({ timeout: 120_000 });
    return { prompt: (await panel.innerText()).split("\n").filter(Boolean) };
  });
  await run("cad-panel-file-menu", async (page) => {
    // A browser has no native file dialog, so the button lists the folder's CAD files.
    await panel.getByRole("button", { name: "Pick a file" }).click();
    await page.getByRole("menuitem", { name: stepName }).waitFor();
    return { listed: await page.getByRole("menuitem").allInnerTexts() };
  });
  await run("cad-panel-model", async (page) => {
    await page.getByRole("menuitem", { name: stepName }).click();
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    return { title: (await sceneTitle.innerText()).trim(), components: componentCount() };
  });
  await run("re-exported-and-synced", async (page) => {
    // A new export of the same model: different bytes, same structure.
    const file = NodePath.join(folder, stepName);
    NodeFS.writeFileSync(
      file,
      NodeFS.readFileSync(file, "utf8").replace("FILE_NAME(", "FILE_NAME( /* re-export */ "),
    );
    const before = new Set(manifests());
    await syncButton.click();
    // The import can finish before "Importing…" renders, so watch the snapshot store instead.
    const created = await waitFor("the re-imported snapshot", () =>
      manifests().find((name) => !before.has(name)),
    );
    await syncButton.waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);
    const revision = (name: string) =>
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(manifestDir, name), "utf8")) as {
          root: { microversionId: string };
        }
      ).root.microversionId;
    return {
      components: componentCount(),
      revisions: [...before].map(revision).concat(revision(created)),
    };
  });
  await run("project-settings", async (page) => {
    // The settings icon sits under the row until the row is hovered.
    const settings = page.getByRole("button", { name: /^Project settings for / }).first();
    await settings.hover({ force: true });
    await settings.click({ force: true });
    await page.getByText("CAD file", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    const section = page.getByText("Rescan folder").locator("xpath=ancestor::section[1]");
    return { text: (await section.innerText()).split("\n").slice(0, 12) };
  });
  /** Conversions the server reports finishing, from its log. */
  const conversions = () =>
    NodeFS.readFileSync(NodePath.join(out, "dev.log"), "utf8").match(
      /Converted a SolidWorks file with SolidWorks/g,
    )?.length ?? 0;
  /** The last CAD outcome of the project in `folder`, read from the dev database. */
  const lastOutcome = (folder: string) => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(out, "home/userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT cad_json AS cad FROM projection_projects WHERE workspace_root = ?")
        .get(folder);
      const cad = typeof row?.cad === "string" ? JSON.parse(row.cad) : null;
      return cad?.lastOutcome as
        | { operationId: string; status: string; reason?: string }
        | undefined;
    } finally {
      db.close();
    }
  };
  /** Waits up to 20 minutes for the folder's next CAD outcome after `after`. */
  const settled = (folder: string, after?: string) =>
    waitFor(
      `the import in ${NodePath.basename(folder)}`,
      () => {
        const latest = lastOutcome(folder);
        return latest && latest.operationId !== after ? latest : undefined;
      },
      20 * 60_000,
    );
  /** Adds a local CAD project for `file` in `folder` and shows its CAD panel. */
  const addProject = async (page: Page, folder: string, file: string) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("button", { name: "Local CAD file" }).click();
    await page.getByLabel("Folder").fill(folder);
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByText(file, { exact: true }).click({ timeout: 60_000 });
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "detached" });
    await startThread(page);
  };
  const rendered = async (page: Page, folder: string) => {
    const outcome = await settled(folder);
    if (outcome.status !== "succeeded") throw new Error(`Import failed: ${outcome.reason}`);
    await panel.locator("canvas").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(8000);
    return { outcome, components: await componentCount() };
  };

  const solidworksDir = values.solidworks;
  if (solidworksDir !== undefined) {
    const host = await Effect.runPromise(detectSolidWorksHost);
    if (!host) throw new Error("SolidWorks needs Windows: run this on Windows or in WSL.");
    /** A project folder holding `file` and the files it uses from the SolidWorks folder. */
    const stage = (name: string, file: string, leaveOut?: string) => {
      const folder = NodePath.join(out, name);
      NodeFS.mkdirSync(folder, { recursive: true });
      const source = NodePath.isAbsolute(file) ? file : NodePath.join(solidworksDir, file);
      const references = /\.sldasm$/i.test(file)
        ? readSolidWorksReferences(NodeFS.readFileSync(source))
        : [];
      if (!references) throw new Error(`${file} has no readable file list`);
      const uses = planSolidWorksFiles({
        assemblyPath: NodePath.basename(file),
        references,
        folderFiles: NodeFS.readdirSync(solidworksDir),
      }).files;
      for (const used of [source, ...uses.map((use) => NodePath.join(solidworksDir, use))])
        if (NodePath.basename(used) !== leaveOut)
          NodeFS.copyFileSync(used, NodePath.join(folder, NodePath.basename(used)));
      return { folder, file: NodePath.basename(file), uses };
    };
    // Plays the user: SolidWorks started from its own executable, with a document of theirs open.
    const userSession = (action: "start" | "check" | "stop", document = "") => {
      const script = NodePath.join(host.serverRoot, "e2e-user-session.ps1");
      NodeFS.mkdirSync(host.serverRoot, { recursive: true });
      NodeFS.writeFileSync(script, String.fromCharCode(0xfeff) + USER_SESSION_SCRIPT);
      const result = NodeChildProcess.spawnSync(
        host.powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          `${host.windowsRoot}\\e2e-user-session.ps1`,
          "-Action",
          action,
          "-Document",
          document,
        ],
        { encoding: "utf8", timeout: 10 * 60_000 },
      );
      const line = result.stdout.trim().split("\n").at(-1) ?? "";
      if (!line.startsWith("{"))
        throw new Error(`user session ${action}: ${result.stdout} ${result.stderr}`);
      return JSON.parse(line) as { pid: number; visible: boolean; documents: string[] };
    };

    const part = stage("sw-part", values["solidworks-part"]!);
    // The user's own document lives outside every project, under a name no project uses.
    const userName = "My own sketch.SLDPRT";
    const userSource = values["solidworks-empty"] ?? NodePath.join(solidworksDir, part.file);
    NodeFS.mkdirSync(NodePath.join(host.serverRoot, "e2e-user"), { recursive: true });
    NodeFS.copyFileSync(userSource, NodePath.join(host.serverRoot, "e2e-user", userName));
    let user = userSession("start", `${host.windowsRoot}\\e2e-user\\${userName}`);
    try {
      await run("solidworks-part-with-user-session", async (page) => {
        const before = conversions();
        await addProject(page, part.folder, part.file);
        const result = await rendered(page, part.folder);
        const after = userSession("check");
        if (after.pid !== user.pid || !after.visible)
          throw new Error("Cadsense changed the user's SolidWorks session");
        if (!after.documents.some((title) => title.toLowerCase().startsWith("my own sketch")))
          throw new Error("The user's own document was closed");
        return {
          ...result,
          conversions: conversions() - before,
          userBefore: user,
          userAfter: after,
        };
      });
    } finally {
      user = userSession("stop");
    }

    const assembly = stage("sw-assembly", values["solidworks-assembly"]!);
    await run("solidworks-assembly-model", async (page) => {
      await addProject(page, assembly.folder, assembly.file);
      return rendered(page, assembly.folder);
    });
    await run("solidworks-assembly-unchanged-sync", async () => {
      const before = { outcome: lastOutcome(assembly.folder), conversions: conversions() };
      await syncButton.click();
      const outcome = await settled(assembly.folder, before.outcome?.operationId);
      if (outcome.status !== "succeeded") throw new Error(`Sync failed: ${outcome.reason}`);
      if (conversions() !== before.conversions)
        throw new Error("The unchanged sync converted again");
      return { before, outcome, conversions: conversions() };
    });

    const large = values["solidworks-large"];
    if (large !== undefined) {
      const staged = stage("sw-large", large);
      await run("solidworks-large-model", async (page) => {
        const started = Date.now();
        await addProject(page, staged.folder, staged.file);
        const result = await rendered(page, staged.folder);
        return { ...result, files: staged.uses.length + 1, seconds: (Date.now() - started) / 1000 };
      });
    }

    const empty = values["solidworks-empty"];
    if (empty !== undefined) {
      const staged = stage("sw-empty", empty);
      await run("solidworks-empty-part", async (page) => {
        await addProject(page, staged.folder, staged.file);
        const outcome = await settled(staged.folder);
        await panel.getByText(/no solid geometry/).waitFor({ timeout: 60_000 });
        return { outcome };
      });
    }

    const missing = stage("sw-missing", values["solidworks-assembly"]!, assembly.uses[0]);
    await run("solidworks-missing-part", async (page) => {
      const before = conversions();
      await addProject(page, missing.folder, missing.file);
      const outcome = await settled(missing.folder);
      await panel.getByText(/not in the project folder/).waitFor({ timeout: 60_000 });
      if (!outcome.reason?.includes(assembly.uses[0]!))
        throw new Error("The missing file is not named");
      return { outcome, conversions: conversions() - before };
    });
    const leftover = userSession("check");
    summary.steps.push({ name: "solidworks-after", ms: 0, observed: { running: leftover } });
  }

  const sampleDir = values["solidworks-sample"];
  const sampleAssembly = values["solidworks-sample-assembly"];
  if (sampleDir !== undefined && sampleAssembly !== undefined) {
    const sample = NodePath.join(out, NodePath.basename(NodePath.resolve(sampleDir)));
    NodeFS.cpSync(sampleDir, sample, { recursive: true });
    await run("solidworks-sample-folder-scanned", async (page) => {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add project" }).first().click();
      await page.getByRole("button", { name: "Local CAD file" }).click();
      await page.getByLabel("Folder").fill(sample);
      await page.getByRole("button", { name: "Scan" }).click();
      await page.getByText(sampleAssembly, { exact: true }).waitFor({ timeout: 60_000 });
      const form = page.getByRole("form", { name: "Create local CAD project" });
      return {
        listed: (await form.locator("label").allInnerTexts()).map((label) => label.split("\n")[0]),
      };
    });
    await run("solidworks-sample-model", async (page) => {
      await page.getByText(sampleAssembly, { exact: true }).click();
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "detached" });
      await startThread(page);
      return rendered(page, sample);
    });
    const samplePart = values["solidworks-sample-part"];
    if (samplePart !== undefined) {
      const folder = NodePath.join(out, "sw-sample-part");
      NodeFS.mkdirSync(folder, { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(sampleDir, samplePart),
        NodePath.join(folder, NodePath.basename(samplePart)),
      );
      await run("solidworks-sample-part-model", async (page) => {
        await addProject(page, folder, NodePath.basename(samplePart));
        return rendered(page, folder);
      });
    }
  }
  const { ask, model } = values;
  if (ask !== undefined && model !== undefined)
    await run("agent-answer", async (page) => {
      await page.goto(url, { waitUntil: "networkidle" });
      await page
        .getByRole("button", { name: /^New thread in / })
        .first()
        .click({ force: true });
      // The model picker is the composer's first button; it has no label of its own.
      await page.locator('[data-chat-composer-form="true"] button').first().click();
      await page.getByPlaceholder("Search models...").fill(model);
      await page.getByRole("option").first().click();
      await page.locator('[contenteditable="true"]').first().click();
      await page.keyboard.type(ask);
      await page.getByRole("button", { name: "Send message" }).click();
      const stop = page.getByRole("button", { name: "Stop generation" });
      await stop.waitFor({ timeout: 60_000 });
      await stop.waitFor({ state: "detached", timeout: 15 * 60_000 });
      await page.waitForTimeout(3000);
      const transcript = await page.locator("main").first().innerText();
      NodeFS.writeFileSync(NodePath.join(out, "agent-answer.txt"), transcript);
      return { worked: /Worked for [^\n]+/.exec(transcript)?.[0] ?? null };
    });
  summary.ok = pageErrors.length === 0;
} finally {
  summary.steps.push({ name: "page-errors", ms: 0, observed: pageErrors });
  writeSummary();
  await browser.close();
  stopDev();
}
console.log(summary.ok ? `Passed. Evidence in ${out}` : `Failed. See ${out}/summary.json`);
process.exit(summary.ok ? 0 : 1);
