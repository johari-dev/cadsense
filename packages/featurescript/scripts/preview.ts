// @effect-diagnostics globalConsole:off - a CLI that prints its report.
// @effect-diagnostics nodeBuiltinImport:off - reads scripts and writes artifacts directly.
/**
 * Previews a FeatureScript feature locally, without Onshape:
 *
 *   node packages/featurescript/scripts/preview.ts path/to/feature.fs \
 *     [--feature boltCircle] [--param 'count=8' --param 'face=qContainsPoint(...)'] \
 *     [--before path/to/setup.fs:plate] [--base base.step] [--out dir]
 *
 * Runs `--before` features first (in order), then the feature, as Feature1, Feature2, ... on top of
 * `--base` (a STEP file whose bodies are created by `makeId("Base")`). Parameters are FeatureScript
 * expressions; unset inputs take their defaults. Prints a summary and writes iso/top/front/right PNGs
 * (faces the feature created in amber), result.glb and report.json to `--out`
 * (default `.cadsense/fs-preview/<file name>`). Exits 1 if any feature fails.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  describePreview,
  runPreview,
  writePreview,
  type PreviewStep,
} from "../src/preview/Preview.ts";
import { ModuleLoadError } from "../src/runtime/Modules.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { formatDiagnostic, locate } from "../src/syntax/Diagnostic.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    feature: { type: "string" },
    param: { type: "string", multiple: true, default: [] },
    before: { type: "string", multiple: true, default: [] },
    base: { type: "string" },
    out: { type: "string" },
  },
});
const file = positionals[0];
if (!file) {
  console.error(
    "Usage: preview.ts <feature.fs> [--feature name] [--param id=expression]... [--before file.fs:feature]... [--base model.step] [--out dir]",
  );
  process.exit(2);
}

const step = (
  path: string,
  feature?: string,
  parameters?: Record<string, string>,
): PreviewStep => ({
  path,
  source: NodeFS.readFileSync(path, "utf8"),
  ...(feature ? { feature } : {}),
  ...(parameters ? { parameters } : {}),
});
const parameters = Object.fromEntries(
  values.param.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--param needs id=expression, got ${pair}`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  }),
);
const steps = [
  ...values.before.map((spec) => {
    const [path, feature] = spec.split(":");
    return step(path!, feature);
  }),
  step(file, values.feature, parameters),
];
const out = values.out ?? NodePath.join(".cadsense", "fs-preview", NodePath.basename(file, ".fs"));

const runtime = await FeatureScriptRuntime.withGeometry();
try {
  const result = runPreview(
    runtime,
    steps,
    values.base ? NodeFS.readFileSync(values.base) : undefined,
  );
  console.log(describePreview(runtime, result));
  for (const path of writePreview(result, out, { file, parameters })) console.log(`wrote ${path}`);
  process.exit(result.features.every(({ run }) => run?.status === "OK") ? 0 : 1);
} catch (error) {
  if (error instanceof ModuleLoadError) {
    for (const diagnostic of error.diagnostics)
      console.error(
        error.file ? formatDiagnostic(locate(error.file, diagnostic)) : diagnostic.message,
      );
    process.exit(1);
  }
  throw error;
}
