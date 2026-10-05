// @effect-diagnostics nodeBuiltinImport:off - a worker thread entry that talks over its parent port.
/**
 * Runs FeatureScript previews off the server's main thread. OpenCascade calls are synchronous and a
 * preview can take seconds, so FeatureScriptPreviews keeps one of these warm, sends it one job at a
 * time, and terminates it on timeout. Std and OpenCascade load on the first job.
 */
import type {
  CadFeatureScriptPreviewResult,
  FeatureScriptChanges,
  FeatureScriptFailure,
  FeatureScriptPanelPreview,
} from "@cadsense/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import {
  describePreview,
  dialogInputs,
  featureFailure,
  FeatureScriptRuntime,
  featureSpecs,
  formatDiagnostic,
  formatValue,
  FsFault,
  FsThrow,
  locate,
  ModuleLoadError,
  runPreview,
  toGlb,
  writePreview,
  type PickedConnector,
  type PreviewStep,
  type SolidSummary,
  type View,
} from "@cadsense/featurescript";

export interface FeatureScriptWorkerData {
  /** The vendored std directory as a file URL, when it isn't beside the package source. */
  readonly stdDir: string | null;
}

/**
 * Where a job's results go. An agent's preview writes every view, a GLB and a report to `outDir`
 * and returns the `view` PNG. The file panel's writes only the GLBs it shows, before and after the
 * feature, and returns the feature's dialog.
 */
export type PreviewOutput =
  | { readonly kind: "agent"; readonly view: View; readonly outDir: string }
  | { readonly kind: "panel"; readonly after: string; readonly before: string };

export interface PreviewJob {
  readonly id: number;
  readonly steps: readonly PreviewStep[];
  /**
   * The workspace (its real path) that `.fs` files the steps import are read from, relative to the
   * importing file, and their size limit.
   */
  readonly workspace: { readonly root: string; readonly maxModuleBytes: number };
  /** Points picked in the panel, made into mate connectors before the features run. */
  readonly connectors: readonly PickedConnector[];
  /** A STEP file whose bodies are created by `makeId("Base")`. */
  readonly base: Uint8Array | null;
  readonly output: PreviewOutput;
}

export type PreviewJobResult =
  | {
      readonly id: number;
      readonly kind: "ran";
      readonly summary: string;
      readonly failure: FeatureScriptFailure | null;
      readonly changes: FeatureScriptChanges | null;
      readonly features: CadFeatureScriptPreviewResult["features"];
      readonly solids: readonly SolidSummary[];
      readonly elapsedMs: number;
      /** The `view` PNG, for agent jobs. */
      readonly png: Uint8Array | null;
      /** Panel jobs: the last feature's dialog, and which GLBs were written (none for no bodies). */
      readonly panel:
        | (Pick<FeatureScriptPanelPreview, "features" | "feature" | "inputs"> & {
            readonly after: boolean;
            readonly before: boolean;
          })
        | null;
    }
  /** The script couldn't run: syntax errors, a missing feature, a bad parameter or base file. */
  | {
      readonly id: number;
      readonly kind: "invalid";
      readonly summary: string;
      readonly failure: FeatureScriptFailure;
    };

/** A message for a preview that couldn't start, with file:line:column for syntax errors. */
const describeFailure = (error: unknown): string => {
  if (error instanceof ModuleLoadError)
    return [
      error.message,
      ...error.diagnostics.map((diagnostic) =>
        error.file ? formatDiagnostic(locate(error.file, diagnostic)) : diagnostic.message,
      ),
    ].join("\n");
  if (error instanceof FsThrow) return `A parameter threw ${formatValue(error.value)}.`;
  if (error instanceof FsFault || error instanceof Error) return error.message;
  return String(error);
};

/** The first syntax error, located; otherwise the whole description. */
const locateFailure = (error: unknown, summary: string): FeatureScriptFailure => {
  const first = error instanceof ModuleLoadError ? error.diagnostics[0] : undefined;
  if (error instanceof ModuleLoadError && error.file && first) {
    const located = locate(error.file, first);
    return {
      message: located.message,
      location: { path: located.file, line: located.start.line, column: located.start.column },
      unsupported: false,
    };
  }
  return { message: summary, location: null, unsupported: false };
};

/**
 * Reads a module the job's scripts import, by workspace-relative path. Anything that isn't a `.fs`
 * file inside the workspace (through links too) or is over the limit reads as missing.
 */
const readImport = ({ root, maxModuleBytes }: PreviewJob["workspace"], relative: string) => {
  if (!relative.endsWith(".fs")) return undefined;
  try {
    const real = NodeFS.realpathSync(NodePath.resolve(root, relative));
    const inside = NodePath.relative(root, real);
    if (inside.startsWith("..") || NodePath.isAbsolute(inside)) return undefined;
    const info = NodeFS.statSync(real);
    if (!info.isFile() || info.size > maxModuleBytes) return undefined;
    return NodeFS.readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
};

const port = NodeWorkerThreads.parentPort;
const { stdDir } = NodeWorkerThreads.workerData as FeatureScriptWorkerData;
let runtime: Promise<FeatureScriptRuntime> | undefined;
/** The running job's workspace; the warm runtime reads imports through it. */
let workspace: PreviewJob["workspace"] | undefined;

const run = async (job: PreviewJob): Promise<PreviewJobResult> => {
  const loaded = await (runtime ??= FeatureScriptRuntime.withGeometry({
    ...(stdDir ? { stdDir: new URL(stdDir) } : {}),
    readModule: (path) => (workspace ? readImport(workspace, path) : undefined),
  }));
  workspace = job.workspace;
  const { output } = job;
  let result;
  try {
    result = runPreview(loaded, job.steps, job.base ?? undefined, {
      before: output.kind === "panel",
      connectors: job.connectors,
    });
  } catch (error) {
    const summary = describeFailure(error);
    return { id: job.id, kind: "invalid", summary, failure: locateFailure(error, summary) };
  }
  const failure =
    result.features
      .map(({ run }) => featureFailure(loaded, run))
      .find((failure) => failure !== null) ?? null;
  const last = result.features.at(-1);
  let png: Uint8Array | null = null;
  let panel: Extract<PreviewJobResult, { kind: "ran" }>["panel"] = null;
  if (output.kind === "agent") {
    writePreview(result, output.outDir, {
      steps: job.steps.map(({ path, feature, parameters }) => ({ path, feature, parameters })),
    });
    png = NodeFS.readFileSync(NodePath.join(output.outDir, `${output.view}.png`));
  } else if (last) {
    const meshesBefore = result.meshesBefore ?? [];
    if (result.meshes.length) NodeFS.writeFileSync(output.after, toGlb(result.meshes));
    if (meshesBefore.length) NodeFS.writeFileSync(output.before, toGlb(meshesBefore));
    panel = {
      features: featureSpecs(loaded.interpreter, last.module).map(({ name, typeName }) => ({
        name,
        typeName,
      })),
      feature: last.spec.name,
      inputs: dialogInputs(loaded, last.module, last.spec, last.definition),
      after: result.meshes.length > 0,
      before: meshesBefore.length > 0,
    };
  }
  return {
    id: job.id,
    kind: "ran",
    summary: describePreview(loaded, result),
    failure,
    changes: result.changes,
    features: result.features.map(({ path, spec, run }) => ({
      path,
      feature: spec.name,
      typeName: spec.typeName,
      status: run?.status ?? "NOT_RUN",
      message: run?.message ?? null,
      // Why it failed: the fault that stopped it, the exception behind its error, or else its
      // reported message.
      cause: featureFailure(loaded, run)?.message ?? null,
    })),
    solids: result.solids,
    elapsedMs: result.elapsedMs,
    png,
    panel,
  };
};

// A rejected job (OpenCascade failed to load, the disk is full) crashes the worker; the parent
// reports that as a failed preview and starts a fresh worker next time.
port?.on("message", (job: PreviewJob) => {
  void run(job).then((result) => port.postMessage(result));
});
