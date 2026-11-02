import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  caseHash,
  probeResultSchema,
  type ConformanceCase,
  type Recording,
  type SpecInput,
} from "../conformance/Case.ts";
import { CASES } from "../conformance/cases/index.ts";
import { compareCase, renderReport, type CaseOutcome } from "../conformance/Compare.ts";
import { runLocal, type LocalRun } from "../conformance/Local.ts";
import { isPlainMap, type Plain, type PlainMap } from "../conformance/Plain.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";

/**
 * How the conformance comparison could fail, each guarded below. Each "recording" here is a real
 * local run of a real case dressed as an Onshape recording, then changed in one controlled way, so
 * the comparison runs on the same data a real recording gives it.
 *
 * 1. A real difference hides: a volume off by 2e-6 relative, a box corner off by 2e-6 m, a face
 *    count off by one, or a value off by 2e-6 relative passes.
 * 2. Float noise fails: differences of 5e-7 relative or 5e-7 m, or -0 against 0, are reported.
 * 3. Body order: the same bodies in another order are reported as different.
 * 4. A body on one side only is dropped silently, or compared with the wrong partner.
 * 5. Errors: a value that throws on one side only passes; two errors with different enums (or
 *    custom messages), or two errors without an enum but with different text, pass; the same
 *    enum error worded differently fails; an uppercase prefix that isn't an ErrorStringEnum
 *    member counts as an enum.
 * 13. A value that evaluates to undefined looks the same as one the probe never read.
 * 6. A variable or value present on one side only passes.
 * 7. A feature status (OK against ERROR) or a compile result (a trailing comma) that differs passes.
 * 8. A case the local runtime can't run comes out as mismatches instead of unsupported; a probe
 *    value that stops the local run comes out as a mismatch. Only an unsupported builtin earns
 *    that: any other fault (a name that doesn't resolve, a bug, a step limit) is a mismatch.
 * 9. A stale or missing recording is compared anyway.
 * 10. A mismatch is filed under the wrong area: sketch bodies belong to sketches, compile results
 *     to the language, dialog inputs to the panel, and a case's `areas` override its own area.
 * 12. The dialog: an input Onshape's spec lists that the local spec doesn't (or in another order,
 *     or inside a list's items) passes.
 * 11. The report leaves out a mismatch, either side's value, or an unsupported case.
 * 14. Bodies that tie on kind, box and measure pair in list order, so the same bodies listed in
 *     another order compare the wrong ones and report differences that aren't there.
 */

let runtime: FeatureScriptRuntime;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const named = (name: string): ConformanceCase => {
  const found = CASES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found;
};

/** What Onshape would have recorded if it agreed with the local run exactly. */
function asRecording(conformanceCase: ConformanceCase, local: LocalRun): Recording {
  return {
    case: conformanceCase.name,
    hash: caseHash(conformanceCase),
    recordedAt: "2026-10-13T00:00:00.000Z",
    onshapeVersion: 3083,
    partStudio: null,
    sources: Object.entries(local.compiled).map(([file, compiled]) => ({
      file,
      version: 3083,
      compiled: compiled === true,
      specs: Object.fromEntries(
        conformanceCase.features
          .filter((feature) => feature.source === file && local.inputs[feature.feature])
          .map((feature) => [feature.feature, { parameters: local.inputs[feature.feature]! }]),
      ),
    })),
    features: local.features.map((feature, i) => ({
      feature: feature.feature,
      featureId: `F${i}`,
      status: feature.status,
      queries: {},
    })),
    probe: local.result ? { result: structuredClone(local.result) } : null,
  };
}

/** A copy of `recording` whose probe result `change` edited in place. */
function edited(recording: Recording, change: (result: Record<string, Plain>) => void): Recording {
  const result = structuredClone(recording.probe!.result!) as Record<string, Plain>;
  change(result);
  // Like a recording read from disk, an edited one has to match the probe schema.
  return {
    ...recording,
    probe: { ...recording.probe!, result: probeResultSchema.decode(result, "edited") },
  };
}
/** The `i`-th body of a probe result, for editing. */
const body = (result: Record<string, Plain>, i: number) => {
  const bodies = result.bodies;
  if (!Array.isArray(bodies) || !isPlainMap(bodies[i])) throw new Error(`no body ${i}`);
  return bodies[i] as Record<string, Plain>;
};
/** Sets `list[index]`, a number, to `change` of itself. */
const adjust = (list: Plain | undefined, index: number, change: (n: number) => number) => {
  const value = Array.isArray(list) ? list[index] : undefined;
  if (typeof value !== "number") throw new Error(`no number at [${index}]`);
  (list as Plain[])[index] = change(value);
};
const field = (map: Plain | undefined, key: string) => (isPlainMap(map) ? map[key] : undefined);
const valuesOf = (result: Record<string, Plain>) => result.values as Record<string, Plain>;

const mismatches = (outcome: CaseOutcome) => {
  if (outcome.kind !== "compared") throw new Error(`expected a comparison, got ${outcome.kind}`);
  return outcome.mismatches;
};
const paths = (outcome: CaseOutcome) => mismatches(outcome).map((mismatch) => mismatch.path);

describe("conformance comparison", () => {
  let boltCircle: ConformanceCase;
  let boltLocal: LocalRun;
  let boltRecording: Recording;
  beforeAll(() => {
    boltCircle = named("corpus-bolt-circle");
    boltLocal = runLocal(runtime, boltCircle);
    boltRecording = asRecording(boltCircle, boltLocal);
  });
  const solidIndex = () =>
    (boltRecording.probe!.result!.bodies as readonly PlainMap[]).findIndex(
      (entry) => field(entry, "volume") !== undefined,
    );

  it("a local run compared with itself matches", () => {
    expect(paths(compareCase(boltCircle, boltRecording, boltLocal))).toEqual([]);
    const evPlane = named("confirm-evplane-origin");
    const local = runLocal(runtime, evPlane);
    expect(paths(compareCase(evPlane, asRecording(evPlane, local), local))).toEqual([]);
  });

  it("flags volumes, box corners and counts just outside tolerance (1)", () => {
    const solid = solidIndex();
    const scaled = edited(boltRecording, (result) => {
      body(result, solid).volume = (body(result, solid).volume as number) * (1 + 2e-6);
    });
    expect(paths(compareCase(boltCircle, scaled, boltLocal))).toEqual([`bodies[${solid}].volume`]);
    const moved = edited(boltRecording, (result) => {
      adjust(body(result, solid).box, 3, (n) => n + 2e-6);
    });
    expect(paths(compareCase(boltCircle, moved, boltLocal))).toEqual([`bodies[${solid}].box[3]`]);
    const counted = edited(boltRecording, (result) => {
      body(result, solid).faces = (body(result, solid).faces as number) + 1;
    });
    expect(paths(compareCase(boltCircle, counted, boltLocal))).toEqual([`bodies[${solid}].faces`]);
  });

  it("flags values just outside tolerance and accepts noise inside it (1, 2)", () => {
    const evPlane = named("confirm-evplane-origin");
    const local = runLocal(runtime, evPlane);
    const recording = asRecording(evPlane, local);
    const shifted = (factor: number) =>
      edited(recording, (result) => {
        adjust(valuesOf(result).blockTopOrigin, 0, (n) => n * factor);
      });
    expect(paths(compareCase(evPlane, shifted(1 + 2e-6), local))).toEqual([
      "values.blockTopOrigin[0]",
    ]);
    expect(paths(compareCase(evPlane, shifted(1 + 5e-7), local))).toEqual([]);
    const negativeZero = edited(recording, (result) => {
      (valuesOf(result).blockTopX as number[])[1] = -0;
    });
    expect(paths(compareCase(evPlane, negativeZero, local))).toEqual([]);
  });

  it("accepts volume and box noise inside tolerance (2)", () => {
    const solid = solidIndex();
    const noisy = edited(boltRecording, (result) => {
      body(result, solid).volume = (body(result, solid).volume as number) * (1 + 5e-7);
      adjust(body(result, solid).box, 0, (n) => n + 5e-7);
    });
    expect(paths(compareCase(boltCircle, noisy, boltLocal))).toEqual([]);
  });

  it("matches bodies regardless of order (3)", () => {
    const reversed = edited(boltRecording, (result) => {
      result.bodies = (result.bodies as Plain[]).toReversed();
    });
    expect(paths(compareCase(boltCircle, reversed, boltLocal))).toEqual([]);
  });

  it("reports a body on one side only as missing, under its own area (4, 10)", () => {
    const sketchIndex = (boltRecording.probe!.result!.bodies as readonly PlainMap[]).findIndex(
      (entry) => field(entry, "sketch") === true,
    );
    const fewer = edited(boltRecording, (result) => {
      result.bodies = (result.bodies as Plain[]).filter((_, i) => i !== sketchIndex);
    });
    const found = mismatches(compareCase(boltCircle, fewer, boltLocal));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ onshape: "<missing>", area: "sketches" });
    expect(found[0]!.path).toMatch(/^bodies\[local \d\]$/);
  });

  it("flags an error on one side only, and errors with different enums or custom messages (5)", () => {
    const evPlane = named("confirm-evplane-origin");
    const local = runLocal(runtime, evPlane);
    const failing = edited(asRecording(evPlane, local), (result) => {
      valuesOf(result).blockTopOrigin = { error: { message: "CANNOT_RESOLVE_PLANE" } };
    });
    expect(paths(compareCase(evPlane, failing, local))).toEqual(["values.blockTopOrigin"]);

    // A local error worded "CANNOT_RESOLVE_PLANE: no face to evaluate." (as before default planes
    // existed locally), against Onshape errors with the same enum, another one, and a message.
    const planes = named("context-default-planes");
    const ran = runLocal(runtime, planes);
    const localResult = structuredClone(ran.result!) as Record<string, Plain>;
    valuesOf(localResult).topNormal = { error: "CANNOT_RESOLVE_PLANE: no face to evaluate." };
    const planesLocal: LocalRun = {
      ...ran,
      result: probeResultSchema.decode(localResult, "edited"),
    };
    const withError = (error: Plain) =>
      paths(
        compareCase(
          planes,
          edited(asRecording(planes, planesLocal), (result) => {
            valuesOf(result).topNormal = { error };
          }),
          planesLocal,
        ),
      );
    expect(withError({ message: "CANNOT_RESOLVE_PLANE" })).toEqual([]);
    expect(withError("CANNOT_RESOLVE_PLANE: the face isn't planar")).toEqual([]);
    expect(withError({ message: "EXTRUDE_NO_DIRECTION" })).toEqual(["values.topNormal"]);
    expect(withError({ message: "CUSTOM_ERROR", customMessage: "No plane" })).toEqual([
      "values.topNormal",
    ]);
    expect(withError("Cannot read field normal of undefined")).toEqual(["values.topNormal"]);

    // Custom messages come from the script, so they must match. Errors without an enum compare
    // by their text, with runs of whitespace treated as one space.
    const custom = (message: string): Plain => ({
      error: { message: "CUSTOM_ERROR", customMessage: message },
    });
    const valuesWith = (onshape: Plain, localValue: Plain) =>
      paths(
        compareCase(
          planes,
          edited(asRecording(planes, planesLocal), (result) => {
            valuesOf(result).originBodies = onshape;
          }),
          {
            ...planesLocal,
            result: {
              ...planesLocal.result!,
              values: { ...(planesLocal.result!.values as PlainMap), originBodies: localValue },
            },
          },
        ),
      );
    expect(valuesWith(custom("Too small"), custom("Too small"))).toEqual([]);
    expect(valuesWith(custom("Too small"), custom("Too big"))).toEqual(["values.originBodies"]);
    // A custom error worded as a string keeps its message too; only real enums drop the wording.
    expect(
      valuesWith(
        { error: "CUSTOM_ERROR: first failure" },
        { error: "CUSTOM_ERROR: other failure" },
      ),
    ).toEqual(["values.originBodies"]);
    expect(valuesWith({ error: "CUSTOM_ERROR: same failure" }, custom("same failure"))).toEqual([]);
    expect(valuesWith({ error: "division by zero" }, { error: "index out of range" })).toEqual([
      "values.originBodies",
    ]);
    expect(valuesWith({ error: "Cannot  read x\n" }, { error: "Cannot read x" })).toEqual([]);
    expect(valuesWith({ error: { message: "not an enum" } }, { error: "not an enum" })).toEqual([]);
    // Only members of std's ErrorStringEnum count as enums; another uppercase prefix is text.
    expect(
      valuesWith(
        { error: "REVIEW_ERROR: onshape failure" },
        { error: "REVIEW_ERROR: local failure" },
      ),
    ).toEqual(["values.originBodies"]);
    expect(
      valuesWith({ error: { message: "REVIEW_ERROR" } }, { error: "REVIEW_ERROR: local" }),
    ).toEqual(["values.originBodies"]);
  });

  it("flags a variable or value on one side only (6)", () => {
    const construction = named("corpus-construction");
    const local = runLocal(runtime, construction);
    const missing = edited(asRecording(construction, local), (result) => {
      const { planeZ: _, ...rest } = result.variables as Record<string, Plain>;
      result.variables = rest;
      valuesOf(result).extra = 1;
    });
    const found = mismatches(compareCase(construction, missing, local));
    expect(found.map((mismatch) => mismatch.path).sort()).toEqual([
      "values.extra",
      "variables.planeZ",
    ]);
    expect(found.find((mismatch) => mismatch.path === "variables.planeZ")).toMatchObject({
      onshape: "<missing>",
      local: 10,
    });
  });

  it("flags a different feature status or compile result (7, 10)", () => {
    const failed: Recording = {
      ...boltRecording,
      features: boltRecording.features.map((feature, i) =>
        i === 1 ? { ...feature, status: "ERROR" } : feature,
      ),
    };
    expect(paths(compareCase(boltCircle, failed, boltLocal))).toEqual(["features[1].status"]);

    const trailing = named("lang-trailing-comma-array");
    const local = runLocal(runtime, trailing);
    expect(local.compiled["trailing-comma-array.fs"]).not.toBe(true);
    const accepted: Recording = {
      ...asRecording(trailing, local),
      sources: [{ file: "trailing-comma-array.fs", version: 3083, compiled: true, specs: {} }],
    };
    expect(mismatches(compareCase(trailing, accepted, local))).toEqual([
      {
        path: "compiled(trailing-comma-array.fs)",
        area: "language",
        onshape: true,
        local: false,
      },
    ]);
  });

  it("reports cases and probe values the local runtime can't run as unsupported (8)", () => {
    const chamfer = named("std-chamfer");
    const local = runLocal(runtime, chamfer);
    const outcome = compareCase(chamfer, { ...asRecording(chamfer, local), probe: null }, local);
    expect(outcome).toMatchObject({ kind: "unsupported" });
    expect(outcome.kind === "unsupported" && outcome.reason).toMatch(/not supported locally/);

    const probeFault: ConformanceCase = {
      ...named("confirm-contains-point"),
      name: "test-probe-fault",
      values: {
        inside: named("confirm-contains-point").values!.bodyInside!,
        // A bottom-facing plane's canonical axes aren't known locally.
        canonical: `alignCanonically(context, plane(vector(0, 0, 0) * meter, vector(0, 0, -1)))`,
      },
    };
    const faultLocal = runLocal(runtime, probeFault);
    expect(Object.keys(faultLocal.probeFaults)).toEqual(["canonical"]);
    const recording = edited(asRecording(probeFault, faultLocal), (result) => {
      valuesOf(result).canonical = [];
    });
    const faultOutcome = compareCase(probeFault, recording, faultLocal);
    expect(paths(faultOutcome)).toEqual([]);
    expect(faultOutcome).toMatchObject({ unsupportedValues: { canonical: expect.any(String) } });
  });

  it("treats faults other than unsupported builtins as mismatches (8)", () => {
    const missing: ConformanceCase = {
      name: "test-missing-name",
      description: "A feature that calls a function that doesn't exist.",
      covers: "test",
      area: "face/body operations",
      features: [{ source: "../test-fixtures/missing-name.fs", feature: "callsMissingFunction" }],
    };
    const local = runLocal(runtime, missing);
    expect(local.unsupported).toBeNull();
    const recording: Recording = {
      ...asRecording(missing, local),
      features: [{ feature: "callsMissingFunction", featureId: "F0", status: "OK", queries: {} }],
      probe: { result: { statuses: [], bodies: [], variables: {}, values: {} } },
    };
    const outcome = compareCase(missing, recording, local);
    expect(outcome.kind).toBe("compared");
    const found = mismatches(outcome).find((mismatch) => mismatch.path === "features[0].fault");
    expect(found).toMatchObject({ onshape: "OK", area: "face/body operations" });
    expect(String(found?.local)).toMatch(/^unresolved-name: .*missingFunction/);

    const probeMissing: ConformanceCase = {
      ...named("confirm-contains-point"),
      name: "test-probe-missing-name",
      values: {
        inside: named("confirm-contains-point").values!.bodyInside!,
        missing: "missingFunction(context)",
      },
    };
    const probeLocal = runLocal(runtime, probeMissing);
    expect(probeLocal.probeFaults.missing?.reason).toBe("unresolved-name");
    const probeOutcome = compareCase(
      probeMissing,
      edited(asRecording(probeMissing, probeLocal), (result) => {
        valuesOf(result).missing = 3;
      }),
      probeLocal,
    );
    expect(probeOutcome).toMatchObject({ kind: "compared", unsupportedValues: {} });
    expect(mismatches(probeOutcome)).toMatchObject([{ path: "values.missing", onshape: 3 }]);
  });

  it("reads a value that evaluates to undefined as an explicit marker (13)", () => {
    const undefinedValue: ConformanceCase = {
      ...named("confirm-contains-point"),
      name: "test-undefined-value",
      values: { nothing: "undefined", something: "1 + 1" },
    };
    expect(runLocal(runtime, undefinedValue).result?.values).toEqual({
      nothing: "<undefined>",
      something: 2,
    });
  });

  it("doesn't compare stale or missing recordings (9)", () => {
    expect(compareCase(boltCircle, null, boltLocal)).toEqual({ kind: "not recorded" });
    expect(compareCase(boltCircle, { ...boltRecording, hash: "older" }, boltLocal)).toMatchObject({
      kind: "stale",
    });
    expect(
      compareCase(boltCircle, { kind: "stale", recordedAt: "2026-10-01T00:00:00.000Z" }, boltLocal),
    ).toEqual({ kind: "stale", recordedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("files a mismatch under the case's area unless `areas` names another (10)", () => {
    const construction = named("corpus-construction");
    const local = runLocal(runtime, construction);
    const changed = edited(asRecording(construction, local), (result) => {
      (result.variables as Record<string, Plain>).planeZ = 11;
      (result.variables as Record<string, Plain>).pointX = 8;
    });
    const overridden: ConformanceCase = {
      ...construction,
      areas: { planeZ: "evaluators/queries" },
    };
    const found = mismatches(
      compareCase(overridden, { ...changed, hash: caseHash(overridden) }, local),
    );
    expect(Object.fromEntries(found.map((mismatch) => [mismatch.path, mismatch.area]))).toEqual({
      "variables.planeZ": "evaluators/queries",
      "variables.pointX": "face/body operations",
    });
  });

  it("flags dialog inputs listed differently, under the panel (10, 12)", () => {
    const wire = named("wire-run-free");
    const local = runLocal(runtime, wire);
    const inputs = local.inputs.wireRun!;
    expect(inputs.map((input) => input.id)).toEqual([
      "label",
      "waypoints",
      "startDirection",
      "flipStart",
      "endDirection",
      "flipEnd",
      "lead",
      "wireCount",
      "sizeType",
      "gauge",
      "insulation",
      "diameter",
      "clocking",
    ]);
    const recording = asRecording(wire, local);
    expect(paths(compareCase(wire, recording, local))).toEqual([]);
    const withSpec = (parameters: readonly SpecInput[]): Recording => ({
      ...recording,
      sources: [{ ...recording.sources[0]!, specs: { wireRun: { parameters } } }],
    });
    const swapped = [inputs[1]!, inputs[0]!, ...inputs.slice(2)];
    expect(mismatches(compareCase(wire, withSpec(swapped), local))).toMatchObject([
      { path: "inputs(wireRun)", area: "the panel" },
    ]);
    const waypoints = inputs[1]!;
    const fewerItems = [
      inputs[0]!,
      { ...waypoints, items: waypoints.items!.slice(1) },
      ...inputs.slice(2),
    ];
    expect(paths(compareCase(wire, withSpec(fewerItems), local))).toEqual(["inputs(wireRun)"]);
  });

  it("the report lists every mismatch with both values, and every unsupported case (11)", () => {
    const solid = solidIndex();
    const scaled = edited(boltRecording, (result) => {
      body(result, solid).volume = 0.5;
    });
    const chamfer = named("std-chamfer");
    const chamferLocal = runLocal(runtime, chamfer);
    const report = renderReport([
      {
        conformanceCase: boltCircle,
        recording: scaled,
        local: boltLocal,
        outcome: compareCase(boltCircle, scaled, boltLocal),
      },
      {
        conformanceCase: chamfer,
        recording: null,
        local: chamferLocal,
        outcome: compareCase(chamfer, null, chamferLocal),
      },
    ]);
    // A value named with a pipe and a newline stays one row of four cells.
    const odd = renderReport([
      {
        conformanceCase: boltCircle,
        recording: boltRecording,
        local: boltLocal,
        outcome: {
          kind: "compared",
          mismatches: [{ path: "values.a|b\nc", area: "language", onshape: 1, local: 2 }],
          unsupportedValues: {},
        },
      },
    ]);
    const row = odd.split("\n").find((line) => line.includes("values.a"));
    expect(row?.split(/(?<!\\)\|/).length).toBe(6);
    expect(report).toContain("corpus-bolt-circle");
    expect(report).toContain(`bodies[${solid}].volume`);
    expect(report).toContain("0.5");
    const localSolid = (boltLocal.result!.bodies as readonly PlainMap[]).find(
      (entry) => field(entry, "volume") !== undefined,
    );
    expect(report).toContain(JSON.stringify(field(localSolid, "volume")));
    expect(report).toContain("std-chamfer");
    expect(report).toContain("Chamfers with two different distances");
  });
});

describe("body pairing", () => {
  it("pairs bodies that tie on box and measure by what else they share (14)", () => {
    // Two solids with one box and volume, 6 and 7 faces: the same bodies in either order match.
    const plain: ConformanceCase = {
      name: "test-tied-bodies",
      description: "",
      covers: "",
      area: "language",
      features: [],
    };
    const solid = (faces: number) => ({
      types: ["SOLID"],
      sketch: false,
      construction: false,
      box: [0, 0, 0, 1, 1, 1],
      volume: 1,
      faces,
      edges: 12,
      vertices: 8,
    });
    const model = { statuses: [], variables: {}, values: {} };
    const recording: Recording = {
      case: plain.name,
      hash: caseHash(plain),
      recordedAt: "2026-10-25T00:00:00.000Z",
      onshapeVersion: 3083,
      partStudio: null,
      sources: [],
      features: [],
      probe: {
        result: probeResultSchema.decode({ ...model, bodies: [solid(6), solid(7)] }, "test"),
      },
    };
    const local = (faces: readonly number[]): LocalRun => ({
      compiled: {},
      features: [],
      unsupported: null,
      stopped: null,
      probeFaults: {},
      inputs: {},
      result: probeResultSchema.decode({ ...model, bodies: faces.map(solid) }, "test"),
    });
    expect(paths(compareCase(plain, recording, local([6, 7])))).toEqual([]);
    expect(paths(compareCase(plain, recording, local([7, 6])))).toEqual([]);
  });
});

describe("case probes", () => {
  // A probe reading entities its case never makes errors even when the case works: std-hole's
  // radius comes from the cylinder the hole cut into the block's body, 3 mm for a 6 mm hole.
  it("reads std-hole's radius from the wall the hole cut", () => {
    const local = runLocal(runtime, named("std-hole"));
    expect(local.probeFaults).toEqual({});
    expect(field(local.result?.values, "holeRadius")).toBeCloseTo(3, 9);
  });
});
