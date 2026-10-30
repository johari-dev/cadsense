// @effect-diagnostics nodeBuiltinImport:off - reads case sources from disk and hashes them.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { plain } from "./Plain.ts";
import * as S from "./Schema.ts";

/**
 * A conformance case: FeatureScript sources plus the features to run from them with fixed inputs.
 * The same case runs in real Onshape (`record.ts`, once, saved under `recordings/`) and in the local
 * runtime (`test/conformance.test.ts`), and both read the result with the same probe script.
 */
export interface ConformanceCase {
  /** Also the recording's file name. */
  readonly name: string;
  readonly description: string;
  /** What it covers: a corpus case, a FeatureScript.md "to confirm" item, a std feature or the Wire run. */
  readonly covers: string;
  /** Who owns a mismatch in this case, unless `areas` names another for a value. */
  readonly area: Area;
  /** Run in order in one Part Studio. */
  readonly features: readonly CaseFeature[];
  /**
   * FeatureScript expressions read after the features run, with `context` and `features` (the
   * features' ids, in order) in scope. Results must be plain data: divide out units.
   */
  readonly values?: Readonly<Record<string, string>>;
  /** Owners for particular values or variables. */
  readonly areas?: Readonly<Record<string, Area>>;
  /** Number tolerances for particular values or variables; others use {@link DEFAULT_TOLERANCE}. */
  readonly tolerances?: Readonly<Record<string, Tolerance>>;
}

/** The areas the parity work is split into; every mismatch belongs to one. */
export type Area =
  | "context/std version"
  | "language"
  | "sketches"
  | "evaluators/queries"
  | "face/body operations"
  | "holes/helices/curves/surfaces"
  | "the panel";

export interface CaseFeature {
  /** A file in `conformance/cases/`. Each file becomes one Feature Studio in Onshape. */
  readonly source: string;
  /** The `defineFeature` constant. */
  readonly feature: string;
  readonly parameters?: ParameterMap;
}

/** Numbers match when they differ by at most `absolute`, or by at most `relative` of the larger. */
export interface Tolerance {
  readonly relative: number;
  readonly absolute: number;
}
export const DEFAULT_TOLERANCE: Tolerance = { relative: 1e-6, absolute: 1e-9 };

/**
 * A feature input. Locally it becomes a FeatureScript expression (`localExpression`); in Onshape a
 * feature parameter (`record.ts`).
 */
export type Parameter =
  | { readonly kind: "length"; readonly millimeters: number }
  | { readonly kind: "angle"; readonly degrees: number }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "real"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  /** A member of an enum declared in the feature's own source. */
  | { readonly kind: "enum"; readonly enumName: string; readonly value: string }
  /**
   * A query expression, or null for an empty selection. `features[i]` in it is the i-th feature's id.
   * Onshape gets the entities it resolves to just before the feature is added.
   */
  | { readonly kind: "query"; readonly expression: string | null }
  | { readonly kind: "array"; readonly items: readonly ParameterMap[] };
export type ParameterMap = Readonly<Record<string, Parameter>>;

export const length = (millimeters: number): Parameter => ({ kind: "length", millimeters });
export const angle = (degrees: number): Parameter => ({ kind: "angle", degrees });
export const integer = (value: number): Parameter => ({ kind: "integer", value });
export const real = (value: number): Parameter => ({ kind: "real", value });
export const boolean = (value: boolean): Parameter => ({ kind: "boolean", value });
export const text = (value: string): Parameter => ({ kind: "string", value });
export const enumValue = (enumName: string, value: string): Parameter => ({
  kind: "enum",
  enumName,
  value,
});
export const query = (expression: string | null): Parameter => ({ kind: "query", expression });
export const list = (items: readonly ParameterMap[]): Parameter => ({ kind: "array", items });

/** `features[i]` in a query parameter, replaced by the feature's id before it's evaluated. */
export const withFeatureIds = (expression: string, featureIds: readonly string[]): string =>
  expression.replace(/\bfeatures\[(\d+)\]/g, (_, index: string) => {
    const id = featureIds[Number(index)];
    if (id === undefined)
      throw new Error(`${expression} names feature ${index}, which isn't added yet.`);
    return `makeId(${JSON.stringify(id)})`;
  });

/** A parameter as the local runtime takes it: a FeatureScript expression. */
export function localExpression(parameter: Parameter, featureIds: readonly string[]): string {
  switch (parameter.kind) {
    case "length":
      return `${parameter.millimeters} * millimeter`;
    case "angle":
      return `${parameter.degrees} * degree`;
    case "integer":
    case "real":
    case "boolean":
      return String(parameter.value);
    case "string":
      return JSON.stringify(parameter.value);
    case "enum":
      return `${parameter.enumName}.${parameter.value}`;
    case "query":
      // Onshape passes an empty selection as an empty union.
      return parameter.expression === null
        ? "qUnion([])"
        : withFeatureIds(parameter.expression, featureIds);
    case "array":
      return `[${parameter.items
        .map(
          (item) =>
            `{ ${Object.entries(item)
              .map(([id, value]) => `${JSON.stringify(id)} : ${localExpression(value, featureIds)}`)
              .join(", ")} }`,
        )
        .join(", ")}]`;
  }
}

export const CASES_DIR = new URL("cases/", import.meta.url);
export const RECORDINGS_DIR = new URL("recordings/", import.meta.url);

export const readSource = (file: string): string =>
  NodeFS.readFileSync(new URL(file, CASES_DIR), "utf8");

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Identifies a source's content; a Feature Studio uploaded with it is reused while it matches. */
export const sourceHash = (source: string): string => sha256(source).slice(0, 16);

/**
 * Bump when the probe script changes in a way that changes what a recording holds. Every recording
 * made with an older probe becomes stale.
 */
export const PROBE_VERSION = 2;

/**
 * Identifies everything a recording depends on: what the case sends to Onshape, its sources and the
 * probe. Its prose and comparison settings are left out, so rewording or retuning a case keeps its
 * recording. A recording with this hash is current and is never recorded again.
 */
export function caseHash(conformanceCase: ConformanceCase): string {
  const {
    description: _description,
    covers: _covers,
    area: _area,
    areas: _areas,
    tolerances: _tolerances,
    ...recorded
  } = conformanceCase;
  const sources = [...new Set(conformanceCase.features.map((feature) => feature.source))].map(
    (file) => [file, readSource(file)],
  );
  return sha256(JSON.stringify({ probe: PROBE_VERSION, case: recorded, sources })).slice(0, 16);
}

/**
 * Statements that read the Part Studio after the features: each feature's status, every body except
 * the default planes and origin, and the context's variables, into `result`. Bodies carry their
 * types, whether they're sketch or construction bodies, Onshape-style topology counts, a tight
 * bounding box in meters, and volume (m^3), area (m^2) or length (m) by type.
 */
const READ_MODEL = `
    var statuses = [];
    for (var featureId in features)
    {
        var status = "<error>";
        try
        {
            const featureStatus = getFeatureStatus(context, featureId);
            status = { "type" : featureStatus.statusType, "enum" : featureStatus.statusEnum, "message" : featureStatus.statusMsg };
        }
        catch (error)
        {
            status = "<error>";
        }
        statuses = append(statuses, status);
    }
    result.statuses = statuses;

    const defaultGeometry = qUnion([qCreatedBy(makeId("Origin"), EntityType.BODY), qCreatedBy(makeId("Top"), EntityType.BODY),
            qCreatedBy(makeId("Front"), EntityType.BODY), qCreatedBy(makeId("Right"), EntityType.BODY)]);
    var bodies = [];
    for (var body in evaluateQuery(context, qSubtraction(qEverything(EntityType.BODY), defaultGeometry)))
    {
        var types = [];
        for (var bodyType in [BodyType.SOLID, BodyType.SHEET, BodyType.WIRE, BodyType.POINT, BodyType.MATE_CONNECTOR])
        {
            if (!isQueryEmpty(context, qBodyType(body, bodyType)))
                types = append(types, bodyType);
        }
        var entry = {
            "types" : types,
            "sketch" : !isQueryEmpty(context, qSketchFilter(body, SketchObject.YES)),
            "construction" : !isQueryEmpty(context, qConstructionFilter(body, ConstructionObject.YES)),
            "faces" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.FACE))),
            "edges" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.EDGE))),
            "vertices" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.VERTEX)))
        };
        try
        {
            const box = evBox3d(context, { "topology" : body, "tight" : true });
            entry.box = [box.minCorner[0] / meter, box.minCorner[1] / meter, box.minCorner[2] / meter,
                    box.maxCorner[0] / meter, box.maxCorner[1] / meter, box.maxCorner[2] / meter];
        }
        catch (error)
        {
            entry.box = "<error>";
        }
        try
        {
            if (!isQueryEmpty(context, qBodyType(body, BodyType.SOLID)))
                entry.volume = evVolume(context, { "entities" : body }) / meter ^ 3;
            else if (!isQueryEmpty(context, qBodyType(body, BodyType.SHEET)))
                entry.area = evArea(context, { "entities" : qOwnedByBody(body, EntityType.FACE) }) / meter ^ 2;
            else if (!isQueryEmpty(context, qBodyType(body, BodyType.WIRE)))
                entry.length = evLength(context, { "entities" : qOwnedByBody(body, EntityType.EDGE) }) / meter;
        }
        catch (error)
        {
            entry.measure = "<error>";
        }
        bodies = append(bodies, entry);
    }
    result.bodies = bodies;
    result.variables = getAllVariables(context);
`;

/**
 * Statements that store one case value in `result.values`, or the error it throws. A value that
 * evaluates to undefined is stored as "<undefined>", since storing undefined in a map removes the
 * key, so every value the case asks for is always there.
 */
const readValue = (name: string, expression: string) => `
    try
    {
        const value = ${expression};
        result.values[${JSON.stringify(name)}] = value == undefined ? "<undefined>" : value;
    }
    catch (error)
    {
        result.values[${JSON.stringify(name)}] = { "error" : error };
    }
`;

const featuresConstant = (featureIds: readonly string[]) =>
  `const features = [${featureIds.map((id) => `makeId(${JSON.stringify(id)})`).join(", ")}];`;

/**
 * The lambda Onshape's Part Studio FeatureScript endpoint runs after the case's features, with the
 * ids Onshape gave them. It returns `{ statuses, bodies, variables, values }`.
 */
export function onshapeProbe(
  conformanceCase: ConformanceCase,
  featureIds: readonly string[],
): string {
  return `function(context is Context, queries)
{
    ${featuresConstant(featureIds)}
    var result = { "values" : {} };
${READ_MODEL}
${Object.entries(conformanceCase.values ?? {})
  .map(([name, expression]) => readValue(name, expression))
  .join("")}
    return result;
}`;
}

/** The variable each local probe feature stores its `result` in. */
export const PROBE_VARIABLE = "conformanceProbe";

/**
 * The same probe as a module of features for the local runtime, which can only run code inside a
 * feature: `readModel` stores the model reading, and `readValue<i>` the i-th value, each in
 * {@link PROBE_VARIABLE}. Separate features let a value that stops the run (an unsupported builtin)
 * be skipped without losing the others.
 */
export function localProbe(
  conformanceCase: ConformanceCase,
  featureIds: readonly string[],
): string {
  const feature = (name: string, body: string) => `
annotation { "Feature Type Name" : "${name}" }
export const ${name} = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        ${featuresConstant(featureIds)}
        var result = { "values" : {} };
${body}
        setVariable(context, "${PROBE_VARIABLE}", result);
    });
`;
  return `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
${feature("readModel", READ_MODEL)}${Object.entries(conformanceCase.values ?? {})
    .map(([name, expression], i) => feature(`readValue${i}`, readValue(name, expression)))
    .join("")}`;
}

/** A feature's status as the probe reads it with `getFeatureStatus`, or "<error>" if that threw. */
const statusSchema = S.union(
  S.literal("<error>"),
  S.object({ type: S.string(), enum: S.optional(S.string()), message: S.optional(S.string()) }),
);

export const BODY_TYPES = ["SOLID", "SHEET", "WIRE", "POINT", "MATE_CONNECTOR"] as const;

/** A body as the probe reads it; see {@link READ_MODEL}. */
const bodyFields = S.object({
  types: S.array(S.literal(...BODY_TYPES)),
  sketch: S.boolean,
  construction: S.boolean,
  faces: S.count,
  edges: S.count,
  vertices: S.count,
  /** Min then max corner, in meters, or "<error>" if `evBox3d` threw. */
  box: S.union(S.literal("<error>"), S.array(S.number, 6)),
  volume: S.optional(S.number),
  area: S.optional(S.number),
  length: S.optional(S.number),
  /** "<error>" when measuring the body threw. */
  measure: S.optional(S.literal("<error>")),
});
export type ProbeBody = S.Infer<typeof bodyFields>;

/**
 * A body must carry what its type is measured by: a solid its volume, a sheet its area, a wire its
 * length (the probe measures the first of those types it has), and those three their box. Points and
 * mate connectors need neither. A measurement that threw makes the probe incomplete.
 */
function measurementProblem(body: ProbeBody): string | null {
  if (body.types.length === 0) return "a body of a known type";
  if (body.measure !== undefined) return "a body whose measurement didn't fail";
  const kind = (["SOLID", "SHEET", "WIRE"] as const).find((type) => body.types.includes(type));
  if (!kind) return null;
  if (body.box === "<error>") return `a ${kind.toLowerCase()} body with its box`;
  const field = { SOLID: "volume", SHEET: "area", WIRE: "length" } as const;
  return body[field[kind]] === undefined
    ? `a ${kind.toLowerCase()} body with its ${field[kind]}`
    : null;
}
const bodySchema = S.refine(bodyFields, measurementProblem);

/** What `READ_MODEL` reads: each feature's status, the bodies, and the context's variables. */
const modelShape = {
  statuses: S.array(statusSchema),
  bodies: S.array(bodySchema),
  variables: S.record(plain),
};
export const probeModelSchema = S.object(modelShape);
export type ProbeModel = S.Infer<typeof probeModelSchema>;

/** What the probe reads: the model, and the case's values. */
export const probeResultSchema = S.object({ ...modelShape, values: S.record(plain) });
export type ProbeResult = S.Infer<typeof probeResultSchema>;

/**
 * The probe result for one case: a status for each of its features (the probe reads one per
 * feature, "<error>" if it can't), and exactly the values it asks for, every one present.
 */
export const probeSchemaFor = (conformanceCase: ConformanceCase): S.Schema<ProbeResult> =>
  S.object({
    ...modelShape,
    statuses: S.array(statusSchema, conformanceCase.features.length),
    values: S.exactRecord(Object.keys(conformanceCase.values ?? {}), plain),
  });

/**
 * A dialog input in a feature's spec: its id, and for a list its items' inputs. That's all the
 * panel comparison reads, so it's all a recording keeps of Onshape's spec.
 */
export interface SpecInput {
  readonly id: string;
  readonly items?: readonly SpecInput[];
}
export const specInputSchema: S.Schema<SpecInput> = S.lazy(() =>
  S.object({ id: S.identifier, items: S.optional(S.array(specInputSchema)) }),
);

const sourceRecordSchema = S.object({
  file: S.string(),
  /** The std version its header declares, e.g. 3083. */
  version: S.number,
  /** Whether Onshape compiled the Feature Studio: every feature the case uses has a spec. */
  compiled: S.boolean,
  /** Onshape's dialog specs for the features the case uses, trimmed to their input ids. */
  specs: S.record(S.object({ parameters: S.array(specInputSchema) })),
});
export type SourceRecord = S.Infer<typeof sourceRecordSchema>;

const featureRecordSchema = S.object({
  feature: S.string(),
  featureId: S.nullable(S.string()),
  /** `featureState.featureStatus` from adding it: OK, INFO, WARNING or ERROR. */
  status: S.nullable(S.string()),
  /** Query parameters, as the entities Onshape resolved them to. */
  queries: S.record(S.array(S.string())),
});
export type FeatureRecord = S.Infer<typeof featureRecordSchema>;

/**
 * One case as Onshape ran it, saved as `recordings/<case>.json`. A recording only loads if it
 * matches this schema, so the comparison never sees a malformed one.
 */
const recordingFields = (probeResult: S.Schema<ProbeResult>) => ({
  case: S.string(),
  /** {@link caseHash} when it was recorded; the recording is stale once the case changes. */
  hash: S.string(),
  recordedAt: S.string(),
  /** The FeatureScript version Onshape ran the Part Studio at. The case sources pin std 3083. */
  onshapeVersion: S.nullable(S.number),
  /** The case's Part Studio in the scratch document. */
  partStudio: S.nullable(S.string()),
  sources: S.array(sourceRecordSchema),
  features: S.array(featureRecordSchema),
  /**
   * The probe's answer. Null when a source didn't compile, so the probe never ran; a probe that
   * failed is never saved, so its case stays pending. Nothing else Onshape said is kept.
   */
  probe: S.nullable(S.object({ result: probeResult })),
});
export const recordingSchema = S.object(recordingFields(probeResultSchema));
/** A recording of one case: its probe has exactly the values the case asks for. */
export const recordingSchemaFor = (conformanceCase: ConformanceCase) =>
  S.object(recordingFields(probeSchemaFor(conformanceCase)));
export type Recording = S.Infer<typeof recordingSchema>;

/** A recording made before its case (or the probe) last changed: never decoded past its hash. */
export interface StaleRecording {
  readonly kind: "stale";
  readonly recordedAt: string;
}

/** What's on disk for a case: a stale recording, or a current one that matches its schema. */
export type StoredRecording =
  | StaleRecording
  | { readonly kind: "current"; readonly recording: Recording };

/**
 * A case's recording from `dir`, or null if there's none or its file isn't JSON (cut short by a
 * crash). Only its hash and date are read first: a
 * recording whose hash isn't the case's current {@link caseHash} is stale, whatever else it holds,
 * since it was made for other values or an older probe. A current one must match the case's
 * recording schema, or this throws DecodeError, so a malformed recording never loads.
 */
export function loadRecording(
  conformanceCase: ConformanceCase,
  dir: URL = RECORDINGS_DIR,
): StoredRecording | null {
  const url = new URL(`${conformanceCase.name}.json`, dir);
  if (!NodeFS.existsSync(url)) return null;
  const file = `${conformanceCase.name}.json`;
  let json: unknown;
  try {
    json = JSON.parse(NodeFS.readFileSync(url, "utf8"));
  } catch (error) {
    // Cut short by a crash mid-write (older recorders wrote in place): record it again.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const { hash, recordedAt } = S.object({ hash: S.string(), recordedAt: S.string() }).decode(
    json,
    file,
  );
  if (hash !== caseHash(conformanceCase)) return { kind: "stale", recordedAt };
  return { kind: "current", recording: recordingSchemaFor(conformanceCase).decode(json, file) };
}

/** A case's current recording, or null if there's none or it's stale. See {@link loadRecording}. */
export const readRecording = (
  conformanceCase: ConformanceCase,
  dir: URL = RECORDINGS_DIR,
): Recording | null => {
  const stored = loadRecording(conformanceCase, dir);
  return stored?.kind === "current" ? stored.recording : null;
};
