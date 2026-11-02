// @effect-diagnostics nodeBuiltinImport:off - writes preview artifacts to disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import { toGlb } from "../geometry/Glb.ts";
import { ordered, startsWith, type Entity, type GeometryState } from "../geometry/Model.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import { errorOverlay, isDrawnBody, tessellate, type BodyMesh } from "../geometry/Tessellate.ts";
import type { FeatureRun, FeatureScriptRuntime, PickedConnector } from "../Runtime.ts";
import type { FsFrame } from "../runtime/Errors.ts";
import { STD_PREFIX, type ModuleInstance } from "../runtime/Modules.ts";
import { formatValue, FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { defaultDefinition, featureSpecs, type FeatureSpec } from "../spec/FeatureSpec.ts";
import { positionAt } from "../syntax/Source.ts";
import {
  changedParameters,
  DIALOG_MODULE,
  dialogStep,
  editingState,
  evaluateInputs,
  plainValue,
  standingEdits,
  valueExpression,
  type DialogEditing,
  type EditingState,
  type ManipulatorChange,
  type PlainValue,
} from "./Dialog.ts";
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
    /**
     * The definition it ran with: defaults, then the step's parameters (evaluated just before it
     * when they read variables), then what the editing logic changed.
     */
    readonly definition: FsMap;
    /** The inputs it was given, as expressions. */
    readonly parameters: Readonly<Record<string, string>>;
    /**
     * The inputs whose expression the dialog shows as typed (`#width`; see `dialogInputs`): its
     * parameters, less any the editing logic replaced with a value.
     */
    readonly shown: Readonly<Record<string, string>>;
    readonly run: FeatureRun | null;
    /** Its INFO or WARNING message; see {@link featureNotice}. */
    readonly notice: ReturnType<typeof featureNotice>;
  }[];
  readonly solids: readonly SolidSummary[];
  /**
   * The model after the last feature: its faces in the highlight material, and the entities it
   * marked as errors in the error material (in place, or in one extra mesh when they're gone).
   */
  readonly meshes: readonly BodyMesh[];
  /**
   * How many entities the last feature marked as errors (`setErrorEntities`) the meshes draw in
   * red; one with nothing to draw isn't counted.
   */
  readonly errorEntities: number;
  /**
   * When the run was asked to act as the dialog and the feature has an editing logic function:
   * the state to send with the next run.
   */
  readonly editing: EditingState | null;
  /** Manipulators the last feature added, for drawing them and sending one back dragged. */
  readonly manipulators: readonly PreviewManipulator[];
  /**
   * After a manipulator change: the last step's inputs as the change function set them, which the
   * caller keeps as the person's. Null otherwise, and when the change function failed.
   */
  readonly parameters: Readonly<Record<string, string>> | null;
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

/** One manipulator a feature added with `addManipulators`. */
export interface PreviewManipulator {
  readonly key: string;
  /** Its `ManipulatorType` member: `LINEAR_1D`, `LINEAR_3D`, `ANGULAR`, `FLIP`, ... */
  readonly type: string;
  /** The `Manipulator` as an expression, to send back with a change; null if it has none. */
  readonly expression: string | null;
  /** Its fields (`base`, `direction`, `offset`, `angle`, `flipped`, ...) in meters and radians. */
  readonly fields: Readonly<Record<string, PlainValue>>;
}

/** A line in a user's script. */
export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface PreviewOptions {
  /** Also mesh the model before the last feature. */
  readonly before?: boolean;
  /** Points picked in the panel, made into mate connectors before the features run. */
  readonly connectors?: readonly PickedConnector[];
  /**
   * Run the last step as Onshape's feature dialog does, given the state the previous run returned
   * (null when the dialog opens): its "Editing Logic Function" runs when an input changed, and the
   * feature runs with (and the dialog shows) the definition it returns. See `dialogStep`.
   */
  readonly editing?: DialogEditing;
  /**
   * A manipulator of the last feature was dragged: run its "Manipulator Change Function" on the
   * context before the feature, then run the feature (and editing logic) with the inputs it set.
   */
  readonly manipulatorChange?: ManipulatorChange;
  /**
   * Roll back, as Onshape's rollback bar does: run only the first `rollback` steps and mesh the
   * model they leave, with nothing highlighted and no step run as the dialog. Every step's source
   * still counts, so the panel's unsaved text wins for an earlier step of the same file.
   */
  readonly rollback?: number;
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
  options: PreviewOptions = {},
): PreviewResult {
  const { manipulatorChange, ...rest } = options;
  if (!manipulatorChange)
    return summarize(runtime, runSteps(runtime, steps, base, options), options);
  // The change function runs in a run of its own, which is thrown away; then the feature runs
  // with the inputs it set, as for any input change, editing logic included.
  const change = runSteps(runtime, steps, base, options);
  const target = change.prepared.at(-1);
  const given = untag(change.dialogs.at(-1)?.given.value);
  const changed = untag(change.dialogs.at(-1)?.resolved.value);
  if (!target || !(given instanceof FsMap) || !(changed instanceof FsMap))
    return {
      ...summarize(runtime, change, options),
      // The change failed, at its line; the dialog's state stays as it was.
      editing: options.editing?.previous ?? null,
    };
  const parameters = changedParameters(runtime, target, given, changed);
  const moved = steps.map((step, i) => (i === steps.length - 1 ? { ...step, parameters } : step));
  return { ...runPreview(runtime, moved, base, rest), parameters };
}

/** Prepares `steps` (each as Onshape's dialog would run it) and runs them; see `runPreview`. */
function runSteps(
  runtime: FeatureScriptRuntime,
  steps: readonly PreviewStep[],
  base: Uint8Array | undefined,
  options: PreviewOptions,
) {
  runtime.loader.unloadUserModules();
  // A step's source is that file's text for the whole run, imports included, and a later step's
  // wins: the panel's unsaved text for its file over the copy an earlier step read from disk.
  const sources = new Map(steps.map((step) => [step.path, step.source]));
  runtime.loader.useSources(sources);
  const running = options.rollback === undefined ? steps : steps.slice(0, options.rollback);
  const prepared = running.map((step) => {
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
    const parameters = fallback ? {} : (step.parameters ?? {});
    const { values, lazy } = evaluateInputs(runtime, module, parameters);
    return {
      path: step.path,
      module,
      spec,
      parameters,
      lazy,
      values,
      definition: defaultDefinition(spec, values),
    };
  });
  // Each step as Onshape's dialog would run it, where that differs from calling the feature: its
  // inputs read variables, or it's the previewed feature and the dialog is open on it.
  const dialogs = prepared.map((step, i) =>
    dialogStep(
      runtime,
      step,
      i === prepared.length - 1 && options.rollback === undefined
        ? {
            ...(options.editing ? { editing: options.editing } : {}),
            ...(options.manipulatorChange ? { manipulatorChange: options.manipulatorChange } : {}),
          }
        : {},
    ),
  );
  const started = NodePerfHooks.performance.now();
  const run = runtime.runFeatures(
    prepared.map(
      ({ module, spec, definition }, i) => dialogs[i] ?? { module, feature: spec.name, definition },
    ),
    {
      ...(base ? { base } : {}),
      ...(options.connectors ? { connectors: options.connectors } : {}),
    },
  );
  const elapsedMs = NodePerfHooks.performance.now() - started;
  return { prepared, dialogs, run, elapsedMs };
}

/** The result of steps `runSteps` ran: models, solids, changes, and each feature's dialog. */
function summarize(
  runtime: FeatureScriptRuntime,
  { prepared, dialogs, run, elapsedMs }: ReturnType<typeof runSteps>,
  options: PreviewOptions,
): PreviewResult {
  const { oc, geometry, geometryBeforeLast } = run;
  const last = prepared.at(-1);
  const dialog = dialogs.at(-1) ?? null;
  const lastFeature = [`Feature${prepared.length}`];
  // Rolled back, the last step that ran isn't the previewed feature: nothing is its.
  const previewed = options.rollback === undefined && run.features.length === prepared.length;
  const createdByLast = (face: { readonly createdBy: readonly string[] }) =>
    options.rollback === undefined && startsWith(face.createdBy, lastFeature);
  // The previewed feature's error entities: faces and bodies still drawn turn red in place, and
  // anything else (a rolled-back body, edges, vertices) is drawn over the model.
  const errors = previewed ? (run.features.at(-1)?.errorEntities ?? []) : [];
  const errorIds = new Set(errors.map((entity) => entity.id));
  const drawn = (entity: Entity) => {
    const body = geometry?.entities.get(entity.body);
    return (
      (entity.type === "FACE" || entity.type === "BODY") &&
      geometry?.entities.get(entity.id) !== undefined &&
      body !== undefined &&
      isDrawnBody(geometry, body)
    );
  };
  // Tessellating first leaves each face's triangulation for the bounds below.
  const overlay = oc && errors.length > 0 ? errorOverlay(oc, errors, drawn) : null;
  const drawnErrors = errors.filter(drawn).length + (overlay?.drawn ?? 0);
  const meshes =
    oc && geometry
      ? [
          ...tessellate(oc, geometry, {
            highlight: createdByLast,
            error: (face) => errorIds.has(face.id) || errorIds.has(face.body),
          }),
          ...(overlay?.mesh ? [overlay.mesh] : []),
        ]
      : [];
  const solids = oc && geometry ? summarizeSolids(oc, geometry) : [];
  const meshesBefore =
    options.before && oc && geometryBeforeLast ? tessellate(oc, geometryBeforeLast) : null;
  // Only when the previewed (last) feature ran; a fault earlier stops the run before it.
  const changes =
    oc && geometry && geometryBeforeLast && previewed
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
  // The definition each dialog step ran its feature with, or had before that failed.
  const ranWith = (i: number) => {
    const resolved = untag(dialogs[i]?.resolved.value);
    return resolved instanceof FsMap ? resolved : dialogs[i]?.unresolved;
  };
  const evaluated = untag(dialog?.evaluated.value);
  const returned = untag(dialog?.resolved.value);
  // Onshape's UI spec lets editing logic return a quantity as an expression string. Locally a string
  // can't be evaluated inside the run (and Onshape's own syntax, "3/8 in", isn't FeatureScript), so
  // instead of the feature failing its precondition the run stops on it.
  const quantityText =
    dialog?.logic && last && returned instanceof FsMap
      ? last.spec.inputs.find(
          (input) =>
            ["length", "angle", "integer", "real"].includes(input.kind) &&
            typeof untag(returned.get(input.id)) === "string",
        )
      : undefined;
  const lastRun = run.features.at(-1);
  const stoppedLast: FeatureRun | null =
    quantityText && lastRun && run.features.length === prepared.length
      ? {
          ...lastRun,
          status: "ERROR",
          fault: {
            reason: "unsupported-builtin",
            message: `The Editing Logic Function set ${quantityText.id} to a string; evaluating quantity expressions an editing logic returns is not supported locally yet.`,
            stack: [],
          },
        }
      : null;
  const runOf = (i: number) =>
    i === prepared.length - 1 && stoppedLast ? stoppedLast : (run.features[i] ?? null);
  const editing =
    !options.editing || !dialog?.logic || !last
      ? null
      : returned instanceof FsMap
        ? editingState(
            runtime,
            last,
            returned,
            evaluated instanceof FsMap ? evaluated : FsMap.empty,
          )
        : // The logic threw or an input's variable was missing: no definition came back, and the
          // dialog's state stays as it was, as Onshape leaves a failed regeneration's inputs.
          options.editing.previous;
  // The inputs the dialog shows the logic's values for: what it set this run, or after a failed
  // run, its earlier edits that still stand (not to an input the person just set, say).
  const logicSet =
    !options.editing || editing === null || !last
      ? {}
      : returned instanceof FsMap
        ? editing.edited
        : standingEdits(options.editing, last.parameters);
  return {
    features: prepared.map(({ path, module, spec, definition, parameters }, i) => ({
      path,
      module,
      spec,
      definition: ranWith(i) ?? definition,
      parameters,
      // The logic's values replace the expressions it overrode, as Onshape's dialog shows them.
      shown:
        i === prepared.length - 1
          ? Object.fromEntries(
              Object.entries(parameters).filter(([id]) => logicSet[id] === undefined),
            )
          : parameters,
      run: runOf(i),
      notice: featureNotice(runOf(i)),
    })),
    solids,
    meshes,
    errorEntities: drawnErrors,
    editing,
    manipulators:
      last && previewed
        ? (run.features.at(-1)?.manipulators.entries() ?? []).map(([key, manipulator]) =>
            previewManipulator(runtime, last.module, key, manipulator),
          )
        : [],
    parameters: null,
    meshesBefore,
    changes,
    elapsedMs,
  };
}

/** A manipulator the feature in `module` added under `key`, for the caller to draw or send back. */
function previewManipulator(
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  key: FsValue,
  manipulator: FsValue,
): PreviewManipulator {
  const fields = untag(manipulator);
  const entries = fields instanceof FsMap ? fields.entries() : [];
  return {
    key: String(untag(key)),
    type: String(untag(fields instanceof FsMap ? fields.getField("manipulatorType") : undefined)),
    expression: valueExpression(runtime, module, manipulator),
    fields: Object.fromEntries(
      entries.flatMap(([name, value]) =>
        typeof name === "string" && name !== "manipulatorType" ? [[name, plainValue(value)]] : [],
      ),
    ),
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
    // The dialog's step is ours, not the user's; a failure in it is located in std or not at all.
    if (frame.file.startsWith(STD_PREFIX) || frame.file === DIALOG_MODULE) continue;
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

/**
 * What a feature that worked but reported INFO or WARNING says, as Onshape shows it beside the
 * feature: its custom message, or else its `ErrorStringEnum` member. Error entities this runtime
 * couldn't find to draw add a sentence (an INFO of their own for OK and ERROR features). Null
 * otherwise.
 */
export function featureNotice(run: FeatureRun | null): {
  readonly status: "INFO" | "WARNING";
  readonly message: string;
} | null {
  const undrawn = run?.undrawnErrorEntities[0];
  const drawing =
    undrawn === undefined ? null : `Some error entities can't be drawn locally: ${undrawn}`;
  if (run?.status === "INFO" || run?.status === "WARNING") {
    const own = run.message ?? run.statusEnum ?? run.status;
    return { status: run.status, message: drawing ? `${own} ${drawing}` : own };
  }
  return drawing ? { status: "INFO", message: drawing } : null;
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
