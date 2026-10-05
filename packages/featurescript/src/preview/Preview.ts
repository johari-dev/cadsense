// @effect-diagnostics nodeBuiltinImport:off - writes preview artifacts to disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import { toGlb } from "../geometry/Glb.ts";
import { ordered, startsWith, type GeometryState } from "../geometry/Model.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import { isDrawnBody, tessellate, type BodyMesh } from "../geometry/Tessellate.ts";
import type { FeatureRun, FeatureScriptRuntime, PickedConnector } from "../Runtime.ts";
import type { FsFrame } from "../runtime/Errors.ts";
import { STD_PREFIX, type ModuleInstance } from "../runtime/Modules.ts";
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
  /**
   * When `feature` isn't in the module (the file panel's saved choice, after the feature was
   * renamed or moved), run the first feature with its defaults instead of failing.
   */
  readonly fallbackToFirst?: boolean;
}

export interface SolidSummary {
  readonly id: string;
  readonly createdBy: string;
  /** The name a feature gave it with `setProperty`. */
  readonly name: string | null;
  readonly volumeMm3: number;
  /** Its axis-aligned bounding box, up to the tessellation's deflection (0.05 mm) too large. */
  readonly boundsMm: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
}

export interface PreviewResult {
  readonly features: readonly {
    readonly path: string;
    readonly module: ModuleInstance;
    readonly spec: FeatureSpec;
    /** The definition it ran with: defaults, then the step's parameters. */
    readonly definition: FsMap;
    readonly run: FeatureRun | null;
  }[];
  readonly solids: readonly SolidSummary[];
  readonly meshes: readonly BodyMesh[];
  /** The model before the last feature, when asked for. */
  readonly meshesBefore: readonly BodyMesh[] | null;
  /** What the last feature did to the model; null without a kernel or when it didn't run. */
  readonly changes: PreviewChanges | null;
  readonly elapsedMs: number;
}

export interface PreviewChanges {
  /** Total solid volume after the last feature minus before it. */
  readonly volumeMm3: number;
  /** Faces the last feature created, such as hole walls. */
  readonly createdFaces: number;
}

/** A line in a user's script. */
export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Runs `steps` in order in one context (on top of `base`, a STEP file, if given) and summarizes the
 * result. Faces created by the last feature are highlighted in the meshes. Each preview loads its
 * sources fresh, so a warm runtime can preview a script again after it is edited.
 */
export function runPreview(
  runtime: FeatureScriptRuntime,
  steps: readonly PreviewStep[],
  base?: Uint8Array,
  options: { readonly before?: boolean; readonly connectors?: readonly PickedConnector[] } = {},
): PreviewResult {
  runtime.loader.unloadUserModules();
  // A step's source is that file's text for the whole run, imports included, and a later step's
  // wins: the panel's unsaved text for its file over the copy an earlier step read from disk.
  const sources = new Map(steps.map((step) => [step.path, step.source]));
  runtime.loader.useSources(sources);
  const prepared = steps.map((step) => {
    const module = runtime.load(step.path, sources.get(step.path));
    const specs = featureSpecs(runtime.interpreter, module);
    const named = step.feature
      ? specs.find((candidate) => candidate.name === step.feature)
      : specs[0];
    // The inputs were set for the missing feature, so the fallback runs with its own defaults.
    const fallback = !named && step.fallbackToFirst === true && specs.length > 0;
    const spec = fallback ? specs[0] : named;
    if (!spec)
      throw new Error(
        step.feature
          ? `${step.path} has no feature named ${step.feature}.`
          : `${step.path} defines no feature.`,
      );
    const parameters = FsMap.fromEntries(
      Object.entries(fallback ? {} : (step.parameters ?? {})).map(
        ([id, source]) => [id, runtime.evaluate(module, source)] as const,
      ),
    );
    return { path: step.path, module, spec, definition: defaultDefinition(spec, parameters) };
  });
  const started = NodePerfHooks.performance.now();
  const run = runtime.runFeatures(
    prepared.map(({ module, spec, definition }) => ({ module, feature: spec.name, definition })),
    {
      ...(base ? { base } : {}),
      ...(options.connectors ? { connectors: options.connectors } : {}),
    },
  );
  const elapsedMs = NodePerfHooks.performance.now() - started;
  const { oc, geometry, geometryBeforeLast } = run;
  const lastFeature = [`Feature${steps.length}`];
  const createdByLast = (face: { readonly createdBy: readonly string[] }) =>
    startsWith(face.createdBy, lastFeature);
  // Tessellating first leaves each face's triangulation for the bounds below.
  const meshes = oc && geometry ? tessellate(oc, geometry, { highlight: createdByLast }) : [];
  const solids = oc && geometry ? summarizeSolids(oc, geometry) : [];
  const meshesBefore =
    options.before && oc && geometryBeforeLast ? tessellate(oc, geometryBeforeLast) : null;
  // Only when the previewed (last) feature ran; a fault earlier stops the run before it.
  const changes =
    oc && geometry && geometryBeforeLast && run.features.length === steps.length
      ? {
          volumeMm3:
            solids.reduce((sum, solid) => sum + solid.volumeMm3, 0) -
            solidVolumeMm3(oc, geometryBeforeLast),
          // Only faces the preview draws, so the count matches the amber faces on screen.
          createdFaces: ordered(geometry, (body) => isDrawnBody(geometry, body)).reduce(
            (sum, body) =>
              sum +
              ordered(
                geometry,
                (entity) =>
                  entity.body === body.id && entity.type === "FACE" && createdByLast(entity),
              ).length,
            0,
          ),
        }
      : null;
  return {
    features: prepared.map(({ path, module, spec, definition }, i) => ({
      path,
      module,
      spec,
      definition,
      run: run.features[i] ?? null,
    })),
    solids,
    meshes,
    meshesBefore,
    changes,
    elapsedMs,
  };
}

const solidBodies = (geometry: GeometryState) =>
  ordered(geometry, (entity) => entity.type === "BODY" && entity.bodyType === "SOLID");

const volumeMm3 = (oc: Oc, shape: Shape) => {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass() * 1e9;
};

/** Total volume of the solid bodies. */
const solidVolumeMm3 = (oc: Oc, geometry: GeometryState) =>
  solidBodies(geometry).reduce((sum, body) => sum + volumeMm3(oc, body.shape), 0);

/**
 * Volume, bounds and topology counts of every solid body, in creation order. Bounds come from the
 * faces' triangulation when they're tessellated (exact bounds of curved faces take about a
 * thousand times longer), so they can sit up to the tessellation's deflection outside the solid.
 */
function summarizeSolids(oc: Oc, geometry: GeometryState): SolidSummary[] {
  return solidBodies(geometry).map((body) => {
    const count = (type: string) =>
      ordered(geometry, (entity) => entity.body === body.id && entity.type === type).length;
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.AddOptimal(body.shape, box, true, false);
    const name = untag(body.properties.get("NAME") ?? "");
    return {
      id: body.id,
      createdBy: body.createdBy.join("."),
      name: typeof name === "string" && name !== "" ? name : null,
      volumeMm3: volumeMm3(oc, body.shape),
      boundsMm: {
        min: [box.GetXMin() * 1e3, box.GetYMin() * 1e3, box.GetZMin() * 1e3],
        max: [box.GetXMax() * 1e3, box.GetYMax() * 1e3, box.GetZMax() * 1e3],
      },
      faces: count("FACE"),
      edges: count("EDGE"),
      vertices: count("VERTEX"),
    };
  });
}

/**
 * Where `stack` enters the user's own code: the first frame in a loaded module outside std. A failure
 * inside std (a precondition, say) is reported at the user's line that called into it.
 */
export function userLocation(
  runtime: FeatureScriptRuntime,
  stack: readonly FsFrame[],
): SourceLocation | null {
  for (const frame of stack) {
    if (frame.file.startsWith(STD_PREFIX)) continue;
    const module = [...runtime.loader.loaded].find((candidate) => candidate.path === frame.file);
    if (!module) continue;
    return { path: frame.file, ...positionAt(module.file, frame.span.start) };
  }
  return null;
}

/**
 * The exception behind a failed feature, if it was raised. Std catches it last, so it's the last
 * one carrying the reported error (its `regenError` message or enum), or for std's generic
 * `REGEN_ERROR` the last one raised from the user's code; anything std throws while reporting it
 * comes after and has no user frame.
 */
function failureCause(
  runtime: FeatureScriptRuntime,
  run: FeatureRun,
): FeatureRun["exceptions"][number] | undefined {
  const reported = run.message ?? (run.statusEnum === "REGEN_ERROR" ? null : run.statusEnum);
  if (reported !== null)
    return run.exceptions.findLast((exception) => exception.message === reported);
  return (
    run.exceptions.findLast((exception) => userLocation(runtime, exception.stack) !== null) ??
    run.exceptions.at(-1)
  );
}

/** Why a feature failed, and where: the fault that stopped it, or the exception it raised. */
export function featureFailure(
  runtime: FeatureScriptRuntime,
  run: FeatureRun | null,
): {
  readonly message: string;
  readonly location: SourceLocation | null;
  /** The local runtime can't run something the script calls; it isn't a bug in the script. */
  readonly unsupported: boolean;
} | null {
  if (run?.status !== "ERROR") return null;
  const unsupported = run.fault?.reason === "unsupported-builtin";
  const cause = run.fault ?? failureCause(runtime, run);
  if (cause)
    return { message: cause.message, location: userLocation(runtime, cause.stack), unsupported };
  return {
    message: run.message ?? run.statusEnum ?? "The feature failed.",
    location: null,
    unsupported,
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
        changes: result.changes,
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
    if (inner.getField("queryType") !== undefined) return describeQuery(inner);
  }
  return formatValue(value);
}

/** A query as a short phrase: `created by Feature1.port`, `closest to (10, 0, 5) mm`. */
function describeQuery(query: FsMap): string {
  const field = (name: string) => untag(query.getField(name) ?? "");
  const type = field("queryType");
  const subquery = field("subquery");
  const millimeters = (point: ReturnType<typeof field>) =>
    `(${Array.isArray(point) ? point.map((n) => +(Number(untag(n)) * 1000).toFixed(2)).join(", ") : "?"}) mm`;
  if (type === "NOTHING") return "(nothing selected)";
  if (type === "CONTAINS_POINT" && subquery instanceof FsMap)
    return `${describeQuery(subquery)} at ${millimeters(field("point"))}`;
  if (type === "NTH_ELEMENT" && subquery instanceof FsMap)
    return `item ${Number(field("n")) + 1} of ${describeQuery(subquery)}`;
  if (type === "CREATED_BY") {
    const id = field("featureId");
    return `created by ${Array.isArray(id) ? id.map((part) => String(untag(part))).join(".") : "?"}`;
  }
  if (type === "CLOSEST_TO") return `closest to ${millimeters(field("point"))}`;
  if (type === "UNION") {
    const parts = field("subqueries");
    if (!Array.isArray(parts)) return "union";
    return parts.length > 3
      ? `${parts.length} selections`
      : parts.map((part) => formatInput(part)).join(" + ");
  }
  const words = String(type).toLowerCase().replaceAll("_", " ");
  if (!(subquery instanceof FsMap)) return words;
  // Filters narrow their subquery, which says what was picked; anything else picks from it.
  return /_FILTER$|^BODY_TYPE$|^GEOMETRY$/.test(String(type))
    ? describeQuery(subquery)
    : `${words} of ${describeQuery(subquery)}`;
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
    const cause = run?.status === "ERROR" && !run.fault ? failureCause(runtime, run) : undefined;
    if (cause) {
      lines.push(`  cause: ${cause.message}`);
      for (const frame of cause.stack.slice(0, 4))
        lines.push(`    at ${locateFrame(runtime, frame)}`);
    }
    for (const output of run?.console ?? []) lines.push(`  print: ${output.trimEnd()}`);
  }
  const point = (xyz: readonly number[]) => `(${xyz.map((n) => n.toFixed(2)).join(", ")})`;
  for (const solid of result.solids)
    lines.push(
      `solid ${solid.id}${solid.name ? ` "${solid.name}"` : ""} from ${solid.createdBy}: ${solid.volumeMm3.toFixed(3)} mm^3, ${solid.faces} faces, ${solid.edges} edges, ${solid.vertices} vertices, bounds ${point(solid.boundsMm.min)} to ${point(solid.boundsMm.max)} mm`,
    );
  lines.push(`ran in ${Math.round(result.elapsedMs)} ms`);
  return lines.join("\n");
}
