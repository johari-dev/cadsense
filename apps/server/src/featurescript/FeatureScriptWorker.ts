// @effect-diagnostics nodeBuiltinImport:off - a worker thread entry that talks over its parent port.
/**
 * Runs FeatureScript previews off the server's main thread. OpenCascade calls are synchronous and a
 * preview can take seconds, so FeatureScriptPreviews keeps one of these warm, sends it one job at a
 * time, and terminates it on timeout. Std and OpenCascade load on the first job.
 */
import type { CadFeatureScriptPreviewResult } from "@cadsense/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import {
  describePreview,
  FeatureScriptRuntime,
  formatDiagnostic,
  formatValue,
  FsFault,
  FsThrow,
  locate,
  ModuleLoadError,
  runPreview,
  writePreview,
  type PreviewStep,
  type SolidSummary,
  type View,
} from "@cadsense/featurescript";

export interface FeatureScriptWorkerData {
  /** The vendored std directory as a file URL, when it isn't beside the package source. */
  readonly stdDir: string | null;
}

export interface PreviewJob {
  readonly id: number;
  readonly steps: readonly PreviewStep[];
  /** A STEP file whose bodies are created by `makeId("Base")`. */
  readonly base: Uint8Array | null;
  /** The view returned as `png`; every view is written to `outDir`. */
  readonly view: View;
  readonly outDir: string;
}

export type PreviewJobResult =
  | {
      readonly id: number;
      readonly kind: "ran";
      readonly summary: string;
      readonly features: CadFeatureScriptPreviewResult["features"];
      readonly solids: readonly SolidSummary[];
      readonly files: readonly string[];
      readonly png: Uint8Array;
    }
  /** The script couldn't run: syntax errors, a missing feature, a bad parameter or base file. */
  | { readonly id: number; readonly kind: "invalid"; readonly summary: string };

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

const port = NodeWorkerThreads.parentPort;
const { stdDir } = NodeWorkerThreads.workerData as FeatureScriptWorkerData;
let runtime: Promise<FeatureScriptRuntime> | undefined;

const run = async (job: PreviewJob): Promise<PreviewJobResult> => {
  const loaded = await (runtime ??= FeatureScriptRuntime.withGeometry(
    stdDir ? { stdDir: new URL(stdDir) } : {},
  ));
  let result;
  try {
    result = runPreview(loaded, job.steps, job.base ?? undefined);
  } catch (error) {
    return { id: job.id, kind: "invalid", summary: describeFailure(error) };
  }
  const files = writePreview(result, job.outDir, {
    steps: job.steps.map(({ path, feature, parameters }) => ({ path, feature, parameters })),
  });
  return {
    id: job.id,
    kind: "ran",
    summary: describePreview(loaded, result),
    features: result.features.map(({ path, spec, run }) => ({
      path,
      feature: spec.name,
      typeName: spec.typeName,
      status: run?.status ?? "NOT_RUN",
      message: run?.message ?? null,
      // Why it failed: the fault that stopped it, or the first exception std caught.
      cause:
        run?.fault?.message ??
        (run?.status === "ERROR" ? (run.exceptions[0]?.message ?? null) : null),
    })),
    solids: result.solids,
    files,
    png: NodeFS.readFileSync(NodePath.join(job.outDir, `${job.view}.png`)),
  };
};

// A rejected job (OpenCascade failed to load, the disk is full) crashes the worker; the parent
// reports that as a failed preview and starts a fresh worker next time.
port?.on("message", (job: PreviewJob) => {
  void run(job).then((result) => port.postMessage(result));
});
