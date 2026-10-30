// @effect-diagnostics nodeBuiltinImport:off - writes preview artifacts to disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import { toGlb } from "../geometry/Glb.ts";
import { ordered, startsWith } from "../geometry/Model.ts";
import { tessellate, type BodyMesh } from "../geometry/Tessellate.ts";
import type { FeatureRun, FeatureScriptRuntime } from "../Runtime.ts";
import type { FsFrame } from "../runtime/Errors.ts";
import { formatValue, FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { defaultDefinition, featureSpecs, type FeatureSpec } from "../spec/FeatureSpec.ts";
import { positionAt } from "../syntax/Source.ts";
import { renderPng, type View } from "./Render.ts";

/** One feature to run: a module's source, which feature in it, and parameters as FeatureScript expressions. */
export interface PreviewStep {
  readonly path: string;
  readonly source: string;
  /** The `defineFeature` constant; defaults to the module's first feature. */
  readonly feature?: string;
  /** Input id to a FeatureScript expression, e.g. `{ "count" : "8" }`. Unset inputs take their defaults. */
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface SolidSummary {
  readonly id: string;
  readonly createdBy: string;
  readonly volumeMm3: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
}

export interface PreviewResult {
  readonly features: readonly {
    readonly path: string;
    readonly spec: FeatureSpec;
    readonly run: FeatureRun | null;
  }[];
  readonly solids: readonly SolidSummary[];
  readonly meshes: readonly BodyMesh[];
  readonly elapsedMs: number;
}

/**
 * Runs `steps` in order in one context (on top of `base`, a STEP file, if given) and summarizes the
 * result. Faces created by the last feature are highlighted in the meshes.
 */
export function runPreview(
  runtime: FeatureScriptRuntime,
  steps: readonly PreviewStep[],
  base?: Uint8Array,
): PreviewResult {
  const prepared = steps.map((step) => {
    const module = runtime.load(step.path, step.source);
    const specs = featureSpecs(runtime.interpreter, module);
    const spec = step.feature
      ? specs.find((candidate) => candidate.name === step.feature)
      : specs[0];
    if (!spec)
      throw new Error(
        step.feature
          ? `${step.path} has no feature named ${step.feature}.`
          : `${step.path} defines no feature.`,
      );
    const parameters = FsMap.fromEntries(
      Object.entries(step.parameters ?? {}).map(
        ([id, source]) => [id, runtime.evaluate(module, source)] as const,
      ),
    );
    return { path: step.path, module, spec, definition: defaultDefinition(spec, parameters) };
  });
  const started = NodePerfHooks.performance.now();
  const run = runtime.runFeatures(
    prepared.map(({ module, spec, definition }) => ({ module, feature: spec.name, definition })),
    base ? { base } : {},
  );
  const elapsedMs = NodePerfHooks.performance.now() - started;
  const { oc, geometry } = run;
  const solids =
    oc && geometry
      ? ordered(geometry, (entity) => entity.type === "BODY" && entity.bodyType === "SOLID").map(
          (body) => {
            const props = new oc.GProp_GProps();
            oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
            const count = (type: string) =>
              ordered(geometry, (entity) => entity.body === body.id && entity.type === type).length;
            return {
              id: body.id,
              createdBy: body.createdBy.join("."),
              volumeMm3: props.Mass() * 1e9,
              faces: count("FACE"),
              edges: count("EDGE"),
              vertices: count("VERTEX"),
            };
          },
        )
      : [];
  const lastFeature = [`Feature${steps.length}`];
  const meshes =
    oc && geometry
      ? tessellate(oc, geometry, { highlight: (face) => startsWith(face.createdBy, lastFeature) })
      : [];
  return {
    features: prepared.map(({ path, spec }, i) => ({ path, spec, run: run.features[i] ?? null })),
    solids,
    meshes,
    elapsedMs,
  };
}

export const VIEWS: readonly View[] = ["iso", "top", "front", "right"];

/** Writes `<view>.png` for each view, `result.glb` and `report.json` into `dir`. Returns the paths. */
export function writePreview(
  result: PreviewResult,
  dir: string,
  extra: Record<string, unknown> = {},
): string[] {
  NodeFS.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (name: string, data: Uint8Array | string) => {
    const path = NodePath.join(dir, name);
    NodeFS.writeFileSync(path, data);
    files.push(path);
  };
  for (const view of VIEWS) write(`${view}.png`, renderPng(result.meshes, view));
  write("result.glb", toGlb(result.meshes));
  write(
    "report.json",
    `${JSON.stringify(
      {
        ...extra,
        elapsedMs: Math.round(result.elapsedMs),
        features: result.features.map(({ path, spec, run }) => ({
          path,
          feature: spec.name,
          status: run?.status ?? "NOT_RUN",
          statusEnum: run?.statusEnum,
          message: run?.message,
          fault: run?.fault,
          exceptions: run?.exceptions,
        })),
        solids: result.solids,
      },
      null,
      2,
    )}\n`,
  );
  return files;
}

/** `file:line:column  source line` for a stack frame, when the file is loaded. */
export function locateFrame(runtime: FeatureScriptRuntime, frame: FsFrame): string {
  const module = [...runtime.loader.loaded].find((candidate) => candidate.path === frame.file);
  if (!module) return `${frame.function} (${frame.file})`;
  const { line, column } = positionAt(module.file, frame.span.start);
  return `${frame.file}:${line}:${column} in ${frame.function}: ${module.file.text.split("\n")[line - 1]?.trim() ?? ""}`;
}

/** A parameter value as a person would type it: lengths in mm, angles in degrees, enum names, queries summarized. */
export function formatInput(value: FsValue): string {
  const inner = untag(value);
  if (value instanceof FsTagged && value.tag.kind === "enum")
    return `${value.tag.name}.${String(inner)}`;
  if (inner instanceof FsMap) {
    const magnitude = inner.getField("value");
    const unit = untag(inner.getField("unit"));
    if (typeof magnitude === "number" && unit instanceof FsMap && unit.size === 1) {
      if (unit.getField("meter") === 1) return `${+(magnitude * 1000).toPrecision(12)} mm`;
      if (unit.getField("radian") === 1)
        return `${+((magnitude * 180) / Math.PI).toPrecision(12)} deg`;
    }
    if (untag(inner.getField("queryType")) === "NOTHING") return "(nothing selected)";
  }
  return formatValue(value);
}

/** A plain-text summary for people and agents: inputs, outcome per feature, and the resulting solids. */
export function describePreview(runtime: FeatureScriptRuntime, result: PreviewResult): string {
  const lines: string[] = [];
  for (const { path, spec, run } of result.features) {
    lines.push(
      `${spec.typeName} (${spec.name} in ${path}): ${run?.status ?? "NOT RUN"}${run?.statusEnum ? ` ${run.statusEnum}` : ""}${run?.message ? `: ${run.message}` : ""}`,
    );
    for (const input of spec.inputs)
      lines.push(
        `  input ${input.id} (${input.kind}) default ${formatInput(input.defaultValue).slice(0, 80)}${input.conditions.length ? ` when ${input.conditions.join(" && ")}` : ""}`,
      );
    if (run?.fault) {
      lines.push(`  stopped: ${run.fault.message}`);
      for (const frame of run.fault.stack.slice(0, 6))
        lines.push(`    at ${locateFrame(runtime, frame)}`);
    }
    const cause = run?.status === "ERROR" && !run.fault ? run.exceptions[0] : undefined;
    if (cause) {
      lines.push(`  cause: ${cause.message}`);
      for (const frame of cause.stack.slice(0, 4))
        lines.push(`    at ${locateFrame(runtime, frame)}`);
    }
    for (const output of run?.console ?? []) lines.push(`  print: ${output.trimEnd()}`);
  }
  for (const solid of result.solids)
    lines.push(
      `solid ${solid.id} from ${solid.createdBy}: ${solid.volumeMm3.toFixed(3)} mm^3, ${solid.faces} faces, ${solid.edges} edges, ${solid.vertices} vertices`,
    );
  lines.push(`ran in ${Math.round(result.elapsedMs)} ms`);
  return lines.join("\n");
}
