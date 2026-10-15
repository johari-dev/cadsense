// @effect-diagnostics nodeBuiltinImport:off
// Drives SolidWorks through PowerShell on the Windows host, staging files in its temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HostProcessEnvironment, HostProcessPlatform } from "@cadsense/shared/hostProcess";
import { LocalCadImportError } from "./LocalCadTessellation.ts";

/** One component in the tree SolidWorks reports, or the part itself when a part was opened. */
export interface SolidWorksNode {
  /** The component's own name, such as `Bracket-2`, without its parents. */
  readonly name: string;
  readonly kind: "assembly" | "part";
  readonly configuration: string;
  readonly suppressed: boolean;
  readonly visible: boolean;
  /** SolidWorks `MathTransform.ArrayData` relative to the root, or null for the root. */
  readonly transform: readonly number[] | null;
  /** The part's geometry key: the file's SHA-256 and configuration. Null for assemblies. */
  readonly key: string | null;
  readonly children: readonly SolidWorksNode[];
}
const SolidWorksNode: Schema.Codec<SolidWorksNode> = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["assembly", "part"]),
  configuration: Schema.String,
  suppressed: Schema.Boolean,
  visible: Schema.Boolean,
  transform: Schema.NullOr(Schema.Array(Schema.Number)),
  key: Schema.NullOr(Schema.String),
  children: Schema.Array(Schema.suspend((): Schema.Codec<SolidWorksNode> => SolidWorksNode)),
});
// `pid` is the SolidWorks the bridge used, and `owned` says whether Cadsense started it.
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        ok: Schema.Literal(true),
        pid: Schema.Number,
        owned: Schema.Boolean,
        root: SolidWorksNode,
        parts: Schema.Record(
          Schema.String,
          Schema.Struct({ name: Schema.String, step: Schema.String }),
        ),
        warnings: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        ok: Schema.Literal(false),
        pid: Schema.Number,
        owned: Schema.Boolean,
        reason: Schema.Literals([
          "not-installed",
          "same-title-open",
          "open-failed",
          "cancelled",
          "failed",
        ]),
        detail: Schema.String,
        names: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ]),
  ),
);

export interface SolidWorksExport {
  readonly root: SolidWorksNode;
  /** The STEP export of every part that was not skipped, by key. */
  readonly parts: ReadonlyMap<string, { readonly name: string; readonly step: Uint8Array }>;
  readonly warnings: readonly string[];
}

export interface SolidWorksExportInput {
  /** Workspace-relative paths and bytes, the picked file first. */
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** Part keys whose geometry the caller already has, so SolidWorks does not export them. */
  readonly skip: readonly string[];
}

/** Opens SolidWorks files in the local SolidWorks. See LocalCad.md, SolidWorks files. */
export class SolidWorks extends Context.Service<
  SolidWorks,
  {
    /**
     * Copies the files into a job folder, opens the picked one there read-only, and returns its
     * component tree with a STEP export of each part. Never writes to the project folder.
     */
    readonly exportParts: (
      input: SolidWorksExportInput,
    ) => Effect.Effect<SolidWorksExport, LocalCadImportError>;
  }
>()("@cadsense/server/localCad/SolidWorksBridge/SolidWorks") {}

/** Where PowerShell is, and the Cadsense folder under the Windows temp folder from both sides. */
export interface SolidWorksHost {
  readonly powershell: string;
  /** The job root as Windows paths it, for SolidWorks. */
  readonly windowsRoot: string;
  /** The same folder as this server reads it: identical on Windows, under /mnt in WSL. */
  readonly serverRoot: string;
}

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const run = (command: string, args: readonly string[]) =>
  new Promise<string>((resolve, reject) =>
    NodeChildProcess.execFile(command, args, { timeout: 60_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );

/**
 * Finds PowerShell on the Windows host: this machine on Windows, or the WSL host through interop.
 * Null anywhere else, where SolidWorks cannot run, or when the host does not answer.
 */
export const detectSolidWorksHost: Effect.Effect<SolidWorksHost | null> = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  if (platform === "win32") {
    const root = NodePath.join(NodeOS.tmpdir(), "cadsense-solidworks");
    return {
      powershell: NodePath.join(
        environment.SystemRoot ?? "C:\\Windows",
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
      windowsRoot: root,
      serverRoot: root,
    };
  }
  const wsl = platform === "linux" && /microsoft/i.test(NodeOS.release());
  if (!wsl || !NodeFS.existsSync(WSL_POWERSHELL)) return null;
  return yield* Effect.tryPromise(async () => {
    const temp = await run(WSL_POWERSHELL, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[IO.Path]::GetTempPath()",
    ]);
    const windowsRoot = `${temp.replace(/\\$/, "")}\\cadsense-solidworks`;
    return {
      powershell: WSL_POWERSHELL,
      windowsRoot,
      serverRoot: await run("wslpath", ["-u", windowsRoot]),
    };
  }).pipe(Effect.orElseSucceed(() => null));
});

/**
 * The C# that drives SolidWorks over COM, compiled once by PowerShell against the installed
 * interop assembly. Rules it keeps: it opens only the staged copies, read-only; it closes only the
 * documents it opened; and it restores the STEP preferences it changes. A conversion never quits
 * SolidWorks. It reports whether Cadsense started the one it used, and the server runs quit mode
 * when nothing else needs it.
 */
const BRIDGE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;

namespace CadsenseSolidWorks {
  public class BridgeFailure : Exception {
    public string Reason; public List<string> Names;
    public BridgeFailure(string reason, string detail, List<string> names = null) : base(detail) { Reason = reason; Names = names; }
  }

  public static class Bridge {
    const int StepApPreference = 75;          // swUserPreferenceIntegerValue_e.swStepAP
    const int StepAppearancesToggle = 787;    // swUserPreferenceToggle_e.swStepExportAppearances
    const int OpenSilentReadOnly = 3;         // swOpenDocOptions_Silent | swOpenDocOptions_ReadOnly
    const int SaveSilentCopy = 3;             // swSaveAsOptions_Silent | swSaveAsOptions_Copy
    const int SameTitleOpen = 65536;          // swFileLoadError_e.swFileWithSameTitleAlreadyOpen
    const int AlreadyOpen = 128;              // swFileLoadWarning_e.swFileLoadWarning_AlreadyOpen

    static string job, input;
    static HashSet<string> skip;
    static Dictionary<string, object> parts = new Dictionary<string, object>();
    static List<string> warnings = new List<string>();
    static Dictionary<string, string> hashes = new Dictionary<string, string>();

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    const int IdNo = 7;
    const uint ButtonClick = 0x00F5;

    static string WindowText(IntPtr hwnd) { var text = new StringBuilder(1024); GetWindowText(hwnd, text, 1024); return text.ToString(); }

    // Presses No on a SolidWorks dialog that names one of the staged copies and has a No button.
    static void AnswerNo(uint pid, ICollection<string> names) {
      EnumWindows((hwnd, _) => {
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        var no = GetDlgItem(hwnd, IdNo);
        if (owner != pid || no == IntPtr.Zero || !IsWindowVisible(hwnd)) return true;
        bool ours = false;
        EnumChildWindows(hwnd, (child, __) => { var text = WindowText(child); ours |= names.Any(name => text.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0); return true; }, IntPtr.Zero);
        if (ours) SendMessage(no, ButtonClick, IntPtr.Zero, IntPtr.Zero);
        return true;
      }, IntPtr.Zero);
    }

    // Add-ins such as SOLIDWORKS CAM ask whether to save every document that closes, even an
    // unchanged read-only one, and wait for an answer. While Cadsense closes its own copy, it
    // answers No to prompts that name one; nothing else is touched.
    static void CloseQuietly(SldWorks sw, ModelDoc2 doc, int pid, ICollection<string> names) {
      var done = new ManualResetEvent(false);
      var watcher = new Thread(() => { while (!done.WaitOne(250)) AnswerNo((uint)pid, names); }) { IsBackground = true };
      watcher.Start();
      try { sw.CloseDoc(doc.GetTitle()); }
      finally { done.Set(); watcher.Join(2000); }
    }

    static string Sha(string text) {
      using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
    }
    // Staged files are hashed before SolidWorks opens and locks them; shared reads cover the rest.
    static string FileSha(string path) {
      string hash;
      var full = Path.GetFullPath(path).ToLowerInvariant();
      if (hashes.TryGetValue(full, out hash)) return hash;
      using (var sha = SHA256.Create())
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
      return hashes[full] = hash;
    }
    static void CheckCancel() {
      if (File.Exists(Path.Combine(job, "cancel"))) throw new BridgeFailure("cancelled", "Cancelled.");
    }
    static bool Staged(string path) {
      return File.Exists(path) && Path.GetFullPath(path).StartsWith(input, StringComparison.OrdinalIgnoreCase);
    }

    // A staged part keys by its own bytes. A part that lives only inside an assembly (a 3D
    // Interconnect insert or a virtual component) keys by the nearest staged file holding it.
    static string PartKey(string path, string configuration, string container) {
      var source = Staged(path) ? FileSha(path) : Sha(container + "|" + Path.GetFileName(path).ToLowerInvariant());
      return Sha(source + "|" + configuration);
    }

    static void Export(ModelDoc2 model, string key, string configuration) {
      if (skip.Contains(key) || parts.ContainsKey(key)) return;
      CheckCancel();
      var active = ((Configuration)model.GetActiveConfiguration()).Name;
      if (active != configuration) model.ShowConfiguration2(configuration);
      var step = Path.Combine("out", parts.Count + ".step");
      int errors = 0, warns = 0;
      bool saved = model.Extension.SaveAs(Path.Combine(job, step), 0, SaveSilentCopy, null, ref errors, ref warns);
      if (active != configuration) model.ShowConfiguration2(active);
      if (!saved) throw new BridgeFailure("failed", "SolidWorks could not export " + model.GetTitle() + " (error " + errors + ").");
      parts[key] = new Dictionary<string, object> { { "name", Path.GetFileNameWithoutExtension(model.GetPathName()) }, { "step", step } };
    }

    static Dictionary<string, object> Node(string name, string kind, string configuration, bool suppressed, bool visible, double[] transform, string key, List<object> children) {
      return new Dictionary<string, object> {
        { "name", name }, { "kind", kind }, { "configuration", configuration }, { "suppressed", suppressed },
        { "visible", visible }, { "transform", transform }, { "key", key }, { "children", children },
      };
    }

    static List<object> Walk(Component2 parent, string container) {
      var nodes = new List<object>();
      foreach (Component2 component in (object[])parent.GetChildren() ?? new object[0]) {
        var path = component.GetPathName() ?? "";
        var name = (component.Name2 ?? "Component").Split('/').Last();
        var configuration = component.ReferencedConfiguration ?? "";
        var suppressed = component.IsSuppressed();
        var visible = component.Visible == 1;
        var transform = component.Transform2 == null ? null : (double[])component.Transform2.ArrayData;
        var assembly = path.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase);
        if (!suppressed && !Staged(path) && path.IndexOf("IC~~", StringComparison.OrdinalIgnoreCase) < 0 && File.Exists(path))
          warnings.Add(name + " loaded from " + path + " instead of the project folder.");
        if (assembly) {
          var children = suppressed ? new List<object>() : Walk(component, Staged(path) ? FileSha(path) : container);
          nodes.Add(Node(name, "assembly", configuration, suppressed, visible, transform, null, children));
          continue;
        }
        string key = null;
        if (!suppressed) {
          key = PartKey(path, configuration, container);
          var model = component.GetModelDoc2() as ModelDoc2;
          if (model == null) { warnings.Add(name + " did not load, so it is left out."); key = null; }
          else Export(model, key, configuration);
        }
        nodes.Add(Node(name, "part", configuration, suppressed, visible, transform, key, new List<object>()));
      }
      return nodes;
    }

    // Quits the SolidWorks that Cadsense started, if it still runs with nothing open in it.
    // CreateInstance attaches to it (GetActiveObject cannot see a SolidWorks that COM started).
    // If it exited meanwhile, CreateInstance starts a new one, which is Cadsense's to quit too. A
    // SolidWorks that ran before this call and is not the owned one is the user's, and stays.
    static void Quit(int ownedPid) {
      var before = Process.GetProcessesByName("SLDWORKS").Select(p => p.Id).ToList();
      if (!before.Contains(ownedPid)) return;
      var sw = (SldWorks)Activator.CreateInstance(Type.GetTypeFromProgID("SldWorks.Application"));
      var pid = sw.GetProcessID();
      if ((pid != ownedPid && before.Contains(pid)) || sw.GetDocumentCount() > 0) return;
      sw.ExitApp();
      // Waits for the exit, so the next conversion cannot attach to a SolidWorks shutting down.
      // A SolidWorks started through COM only exits once its clients let go, so release first.
      Marshal.FinalReleaseComObject(sw);
      sw = null;
      GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); GC.WaitForPendingFinalizers();
      try { Process.GetProcessById(pid).WaitForExit(120000); } catch (ArgumentException) { }
    }

    public static void Run(string jobDir) {
      job = jobDir;
      input = Path.GetFullPath(Path.Combine(job, "in")) + Path.DirectorySeparatorChar;
      var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1000 };
      var request = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(job, "request.json")));
      int ownedPid = Convert.ToInt32(request["ownedPid"]);
      if ((string)request["mode"] == "quit") { Quit(ownedPid); return; }
      var file = Path.Combine(input, (string)request["file"]);
      skip = new HashSet<string>(((System.Collections.ArrayList)request["skip"]).Cast<string>());
      Directory.CreateDirectory(Path.Combine(job, "out"));
      foreach (var copy in Directory.GetFiles(input, "*", SearchOption.AllDirectories)) FileSha(copy);
      var result = new Dictionary<string, object>();

      var before = Process.GetProcessesByName("SLDWORKS").Select(p => p.Id).ToList();
      SldWorks sw = null;
      ModelDoc2 doc = null;
      bool opened = false, owned = false, changed = false;
      int pid = 0, stepAp = 0;
      var staged = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      bool appearances = false;
      try {
        var type = Type.GetTypeFromProgID("SldWorks.Application");
        if (type == null) throw new BridgeFailure("not-installed", "SolidWorks is not installed.");
        sw = (SldWorks)Activator.CreateInstance(type);
        var after = Process.GetProcessesByName("SLDWORKS").Select(p => p.Id).ToList();
        pid = after.Except(before).FirstOrDefault();
        owned = pid != 0 || after.Contains(ownedPid);
        if (pid == 0) pid = after.Contains(ownedPid) ? ownedPid : after.FirstOrDefault();

        // SolidWorks cannot open two documents with one name. Refuse rather than read, or close,
        // a document the user has open.
        staged = new HashSet<string>(Directory.GetFiles(input, "*", SearchOption.AllDirectories).Select(Path.GetFileName), StringComparer.OrdinalIgnoreCase);
        var clashes = ((object[])sw.GetDocuments() ?? new object[0]).Cast<ModelDoc2>()
          .Select(open => Path.GetFileName(open.GetPathName() ?? open.GetTitle())).Where(staged.Contains).Distinct().ToList();
        if (clashes.Count > 0) throw new BridgeFailure("same-title-open", "Close these in SolidWorks first.", clashes);

        stepAp = sw.GetUserPreferenceIntegerValue(StepApPreference);
        appearances = sw.GetUserPreferenceToggle(StepAppearancesToggle);
        changed = true;
        // AP214 carries colors; the default AP203 drops them.
        sw.SetUserPreferenceIntegerValue(StepApPreference, 214);
        sw.SetUserPreferenceToggle(StepAppearancesToggle, true);

        var assembly = file.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase);
        int errors = 0, warns = 0;
        doc = (ModelDoc2)sw.OpenDoc6(file, assembly ? 2 : 1, OpenSilentReadOnly, "", ref errors, ref warns);
        if (doc == null) {
          if ((errors & SameTitleOpen) != 0) throw new BridgeFailure("same-title-open", "Close it in SolidWorks first.", new List<string> { Path.GetFileName(file) });
          throw new BridgeFailure("open-failed", "SolidWorks could not open the file (error " + errors + ").");
        }
        if ((warns & AlreadyOpen) != 0) { doc = null; throw new BridgeFailure("same-title-open", "Close it in SolidWorks first.", new List<string> { Path.GetFileName(file) }); }
        opened = true;
        // Hidden right away. A document opened hidden from the start has no display data, and
        // exporting its parts crashes SolidWorks.
        doc.Visible = false;

        var configuration = ((Configuration)doc.GetActiveConfiguration()).Name;
        Dictionary<string, object> root;
        if (assembly) {
          ((AssemblyDoc)doc).ResolveAllLightWeightComponents(false);
          var top = ((Configuration)doc.GetActiveConfiguration()).GetRootComponent3(true);
          root = Node(Path.GetFileNameWithoutExtension(file), "assembly", configuration, false, true, null, null, Walk(top, FileSha(file)));
        } else {
          var key = PartKey(file, configuration, "");
          Export(doc, key, configuration);
          root = Node(Path.GetFileNameWithoutExtension(file), "part", configuration, false, true, null, key, new List<object>());
        }
        result["ok"] = true;
        result["root"] = root;
        result["parts"] = parts;
        result["warnings"] = warnings;
      } catch (BridgeFailure failure) {
        result["ok"] = false;
        result["reason"] = failure.Reason;
        result["detail"] = failure.Message;
        if (failure.Names != null) result["names"] = failure.Names;
      } catch (Exception error) {
        result["ok"] = false;
        result["reason"] = "failed";
        result["detail"] = error.Message;
      } finally {
        try { if (opened) CloseQuietly(sw, doc, pid, staged); } catch (Exception) { }
        try {
          if (changed) {
            sw.SetUserPreferenceIntegerValue(StepApPreference, stepAp);
            sw.SetUserPreferenceToggle(StepAppearancesToggle, appearances);
          }
        } catch (Exception) { }
        result["pid"] = pid;
        result["owned"] = owned;
        File.WriteAllText(Path.Combine(job, "result.json"), json.Serialize(result));
      }
    }
  }
}
`;

const scriptHash = NodeCrypto.createHash("sha256").update(BRIDGE_SOURCE).digest("hex").slice(0, 16);

// Finds the interop assembly through the COM registration, so any install folder works.
const BRIDGE_SCRIPT = `param([string]$Job)
$ErrorActionPreference = "Stop"
function Fail([string]$reason, [string]$detail) {
  $json = @{ ok = $false; reason = $reason; detail = $detail; pid = 0; owned = $false } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $Job "result.json"), $json)
  exit 0
}
try {
  $clsid = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\SldWorks.Application\\CLSID")."(default)"
  $server = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsid\\LocalServer32")."(default)"
} catch { Fail "not-installed" "SolidWorks is not installed." }
$exe = [regex]::Match($server, '^\\s*"?([^"]*?\\.exe)', "IgnoreCase").Groups[1].Value
$interop = Join-Path (Split-Path -Parent $exe) "api\\redist\\SolidWorks.Interop.sldworks.dll"
if (-not (Test-Path -LiteralPath $interop)) { Fail "not-installed" "The SolidWorks API is not installed." }
try {
  Add-Type -Path $interop
  # Compiled once per bridge version and SolidWorks install, then reused.
  $dll = Join-Path $PSScriptRoot ("bridge-${scriptHash}-" + (Get-Item -LiteralPath $interop).LastWriteTimeUtc.Ticks + ".dll")
  if (-not (Test-Path -LiteralPath $dll)) {
    Add-Type -ReferencedAssemblies $interop, "System.Web.Extensions" -OutputAssembly $dll -OutputType Library -TypeDefinition @'
${BRIDGE_SOURCE}
'@
  }
  Add-Type -Path $dll
  [CadsenseSolidWorks.Bridge]::Run($Job)
} catch { Fail "failed" $_.Exception.Message }
`;
const SCRIPT_NAME = `bridge-${NodeCrypto.createHash("sha256").update(BRIDGE_SCRIPT).digest("hex").slice(0, 16)}.ps1`;

/** The UTF-8 byte order mark, which Windows PowerShell needs to read a script as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const CONVERSION_TIMEOUT = "30 minutes";
const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.Literals(["convert", "quit"]),
      file: Schema.String,
      skip: Schema.Array(Schema.String),
      ownedPid: Schema.Number,
    }),
  ),
);
const unavailable = () => new LocalCadImportError({ reason: "solidworks-unavailable" });
// One short line: the detail ends up in the operation outcome shown in the CAD panel.
const failed = (detail: string) =>
  new LocalCadImportError({
    reason: "solidworks-failed",
    detail: detail.replace(/\s+/g, " ").trim().slice(0, 200),
  });

export interface SolidWorksOptions {
  /** Where PowerShell is. Detected on first use when absent; null means no SolidWorks. */
  readonly host?: SolidWorksHost | null;
  /** How long a caller that stops waiting (cancel or timeout) gives the bridge to stop. */
  readonly cancelGrace?: Duration.Input;
}

/**
 * One bridge at a time, through a single slot. SolidWorks is single-threaded, and two bridges
 * would fight over its preferences and its lifetime. A job holds the slot from staging until its
 * bridge process exits and its folder is gone, even when its caller stopped waiting long before.
 * Quitting a SolidWorks that Cadsense started is decided while holding the slot, never by the
 * bridge. See LocalCad.md, SolidWorks files.
 */
export const make = (options: SolidWorksOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const slot = yield* Semaphore.make(1);
    const host = yield* Effect.cached(
      options.host === undefined ? detectSolidWorksHost : Effect.succeed(options.host),
    );
    const cancelGrace = options.cancelGrace ?? "2 minutes";
    // The SolidWorks process Cadsense started and left running, or 0.
    let ownedPid = 0;
    // Callers waiting for the slot. While any wait, a SolidWorks Cadsense started stays warm.
    let waiting = 0;
    // Job folders that outlived their job because SolidWorks or a virus scanner still held a file
    // open. Every reconcile tries them again.
    const leftovers = new Set<string>();
    const removeFolder = (folder: string) =>
      Effect.promise(async () => {
        await NodeFSP.rm(folder, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        }).catch(() => {});
        if (NodeFS.existsSync(folder)) leftovers.add(folder);
        else leftovers.delete(folder);
      });

    /**
     * Writes a job folder with its request and files, runs the bridge on it, and resolves when the
     * bridge process exits. Interrupted only when the server stops: it then leaves a cancel marker
     * and lets the bridge finish on its own.
     */
    const runBridge = (
      resolved: SolidWorksHost,
      folder: string,
      request: Parameters<typeof encodeRequest>[0],
      files: SolidWorksExportInput["files"],
    ) =>
      Effect.gen(function* () {
        const body = yield* encodeRequest(request).pipe(
          Effect.mapError(() => failed("Could not write the SolidWorks request.")),
        );
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.join(folder, "in"), { recursive: true });
            const script = NodePath.join(resolved.serverRoot, SCRIPT_NAME);
            // Windows PowerShell reads a script without a byte order mark as ANSI.
            if (!NodeFS.existsSync(script)) await NodeFSP.writeFile(script, BOM + BRIDGE_SCRIPT);
            for (const file of files) {
              const target = NodePath.join(folder, "in", ...file.path.split("/"));
              await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
              await NodeFSP.writeFile(target, file.bytes);
            }
            await NodeFSP.writeFile(NodePath.join(folder, "request.json"), body);
          },
          catch: () => failed("Could not stage the files for SolidWorks."),
        });
        yield* Effect.callback<void, LocalCadImportError>((resume) => {
          let settled = false;
          const settle = (effect: Effect.Effect<void, LocalCadImportError>) => {
            if (settled) return;
            settled = true;
            resume(effect);
          };
          const child = NodeChildProcess.spawn(
            resolved.powershell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              `${resolved.windowsRoot}\\${SCRIPT_NAME}`,
              "-Job",
              `${resolved.windowsRoot}\\${NodePath.basename(folder)}`,
            ],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
          );
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4000);
          });
          child.stdout.resume();
          child.once("error", () => settle(Effect.fail(unavailable())));
          child.once("close", () =>
            settle(
              stderr.trim()
                ? Effect.logWarning("SolidWorks bridge stderr", { stderr })
                : Effect.void,
            ),
          );
          return Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(folder, "cancel"), "").catch(() => {}),
          );
        });
      });

    /**
     * Converts in the job's folder and reads what the bridge left, then removes the folder. It
     * records whether Cadsense owns the SolidWorks used even when the caller already gave up.
     */
    const convert = (
      resolved: SolidWorksHost,
      input: SolidWorksExportInput,
      job: { readonly folder: string; cancelled: boolean },
    ) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        if (job.cancelled) return yield* failed("Cancelled before SolidWorks started.");
        yield* runBridge(
          resolved,
          job.folder,
          {
            mode: "convert",
            file: input.files[0]!.path.split("/").join("\\"),
            skip: input.skip,
            ownedPid,
          },
          input.files,
        );
        const result = yield* Effect.tryPromise({
          try: () => NodeFSP.readFile(NodePath.join(job.folder, "result.json"), "utf8"),
          catch: () => failed("SolidWorks stopped before it finished."),
        }).pipe(
          Effect.flatMap((text) => decodeResult(text.startsWith(BOM) ? text.slice(1) : text)),
          Effect.mapError((error) =>
            error._tag === "SchemaError" ? failed("The SolidWorks bridge replied oddly.") : error,
          ),
        );
        ownedPid = result.owned ? result.pid : 0;
        if (!result.ok)
          return yield* result.reason === "not-installed"
            ? unavailable()
            : result.reason === "same-title-open"
              ? new LocalCadImportError({
                  reason: "solidworks-file-open",
                  missing: result.names ?? [],
                })
              : failed(result.detail);
        const parts = new Map<string, { name: string; step: Uint8Array }>();
        for (const [key, part] of Object.entries(result.parts))
          parts.set(key, {
            name: part.name,
            step: yield* Effect.tryPromise({
              try: () => NodeFSP.readFile(NodePath.join(job.folder, ...part.step.split("\\"))),
              catch: () => failed(`SolidWorks did not export ${part.name}.`),
            }),
          });
        yield* Effect.logInfo("Converted a SolidWorks file with SolidWorks", {
          file: input.files[0]!.path,
          exportedParts: parts.size,
          reusedParts: input.skip.length,
          seconds: Math.round(((yield* Clock.currentTimeMillis) - started) / 100) / 10,
        });
        return { root: result.root, parts, warnings: result.warnings } satisfies SolidWorksExport;
      }).pipe(Effect.ensuring(removeFolder(job.folder)));

    /**
     * Quits the SolidWorks Cadsense started once nothing runs or waits, then retries leftover job
     * folders. It takes the slot to decide, so a job that starts first inherits SolidWorks warm,
     * and runs after every job and every waiter that gives up.
     */
    const reconcile = (resolved: SolidWorksHost) =>
      slot.withPermits(1)(
        Effect.suspend(() => (waiting > 0 ? Effect.void : quit(resolved))).pipe(
          Effect.andThen(sweep),
        ),
      );
    const sweep = Effect.suspend(() =>
      Effect.forEach([...leftovers], removeFolder, { discard: true }),
    );

    /** Runs quit mode on the SolidWorks Cadsense started, if there is one. */
    const quit = (resolved: SolidWorksHost) =>
      Effect.suspend(() => {
        if (ownedPid === 0) return Effect.void;
        const folder = NodePath.join(resolved.serverRoot, NodeCrypto.randomUUID());
        return runBridge(resolved, folder, { mode: "quit", file: "", skip: [], ownedPid }, []).pipe(
          // Quit mode writes a result only when it fails.
          Effect.andThen(
            Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(folder, "result.json"), "utf8").catch(() => null),
            ),
          ),
          Effect.flatMap((failure) =>
            failure
              ? Effect.logWarning("Could not quit the SolidWorks Cadsense started", { failure })
              : Effect.void,
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not quit the SolidWorks Cadsense started", { error }),
          ),
          // Only once quit mode ran to the end: an interrupted quit leaves it for the next try.
          Effect.andThen(
            Effect.sync(() => {
              ownedPid = 0;
            }),
          ),
          Effect.ensuring(removeFolder(folder)),
        );
      });

    // On a graceful stop, quits the SolidWorks Cadsense started even if its reconcile was cut
    // short. Quit mode leaves a SolidWorks alone while a document is open, so a bridge still
    // running keeps it.
    let resolvedHost: SolidWorksHost | null = null;
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        resolvedHost
          ? quit(resolvedHost).pipe(
              Effect.andThen(sweep),
              Effect.timeout("2 minutes"),
              Effect.ignore,
            )
          : Effect.void,
      ),
    );

    const exportParts = Effect.fn("SolidWorks.exportParts")(function* (
      input: SolidWorksExportInput,
    ) {
      const resolved = yield* host;
      if (!resolved) return yield* unavailable();
      resolvedHost = resolved;
      const job = {
        folder: NodePath.join(resolved.serverRoot, NodeCrypto.randomUUID()),
        cancelled: false,
      };
      const done = yield* Deferred.make<SolidWorksExport, LocalCadImportError>();
      waiting++;
      // Taking the slot and handing it to the job's own fiber happen together, so the slot is
      // released exactly once: when the job is over, whenever the caller stops waiting.
      yield* Effect.uninterruptibleMask((restore) =>
        restore(slot.take(1)).pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              waiting--;
            }),
          ),
          // A waiter that gives up may have been the reason to keep SolidWorks running.
          Effect.onInterrupt(() => Effect.forkIn(reconcile(resolved), scope)),
          Effect.andThen(
            convert(resolved, input, job).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(done, exit)),
              Effect.ensuring(slot.release(1)),
              Effect.andThen(reconcile(resolved)),
              Effect.forkIn(scope),
            ),
          ),
        ),
      );
      // Cancel and timeout ask the bridge to stop between parts and wait a grace period for it.
      // A bridge stuck in SolidWorks keeps the slot until it exits.
      const giveUp = Effect.sync(() => {
        job.cancelled = true;
      }).pipe(
        Effect.andThen(
          Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(job.folder, "cancel"), "").catch(() => {}),
          ),
        ),
        Effect.andThen(Deferred.await(done).pipe(Effect.timeout(cancelGrace), Effect.ignore)),
      );
      return yield* Deferred.await(done).pipe(
        Effect.onInterrupt(() => giveUp),
        Effect.timeoutOrElse({
          duration: CONVERSION_TIMEOUT,
          orElse: () => Effect.fail(new LocalCadImportError({ reason: "solidworks-timeout" })),
        }),
      );
    });

    return SolidWorks.of({ exportParts });
  });

export const layer = Layer.effect(SolidWorks, make());
