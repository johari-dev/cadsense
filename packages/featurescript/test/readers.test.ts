import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { formatValue } from "../src/runtime/Value.ts";
import { allValid } from "./valid.ts";

/**
 * Builtins that read a curve or surface off the model must leave it as it was.
 *
 * Ways it goes wrong: a reader takes the edge's or face's own curve handle and segments,
 * reverses or raises its degree in place, so the model's geometry changes under it: a second read
 * disagrees with the first, a start point moves to the other end, a body fails OpenCascade's
 * checker. An operation that shares the edges it was built from passes such edits on to them.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/readers${counter++}.fs`,
    `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });
`,
  );
  const result = runtime.runFeatures([{ module, feature: "test" }]);
  const feature = result.features[0]!;
  return {
    valid: allValid(result),
    status: feature.status,
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    text: (name: string) => formatValue(feature.variables.getField(name)),
  };
};

const spline = (degree: number, points: readonly (readonly number[])[]) =>
  `bSplineCurve({ "degree" : ${degree}, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}] })`;
/** A degree 2 arch ending at (10, 0, 0), and a degree 3 curve drawn from (25, 0, 0) to it. */
const CURVES = [
  `opCreateBSplineCurve(context, id + "a", { "bSplineCurve" : ${spline(2, [
    [0, 0, 0],
    [5, 5, 0],
    [10, 0, 0],
  ])} });`,
  `opCreateBSplineCurve(context, id + "b", { "bSplineCurve" : ${spline(3, [
    [25, 0, 0],
    [20, 0, 0],
    [15, -5, 0],
    [10, 0, 0],
  ])} });`,
].join("\n");
/** Records what the curves look like (degrees, b's first control point and start) as `name`. */
const look = (name: string) =>
  [
    `const ${name}A = evApproximateBSplineCurve(context, { "edge" : qCreatedBy(id + "a", EntityType.EDGE) });`,
    `const ${name}B = evApproximateBSplineCurve(context, { "edge" : qCreatedBy(id + "b", EntityType.EDGE) });`,
    `const ${name}Start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "b", EntityType.EDGE), "parameter" : 0, "arcLengthParameterization" : false }).origin;`,
    `setVariable(context, "${name}", [${name}A.degree, ${name}B.degree, ${name}B.controlPoints[0] / millimeter, ${name}Start / millimeter]);`,
  ].join("\n");

describe("readers leave the model unchanged", () => {
  it("curve readers: approximation, spline through edges, path deviation", () => {
    const r = run(
      [
        CURVES,
        look("before"),
        'evApproximateBSplineCurve(context, { "edge" : qCreatedBy(id + "a", EntityType.EDGE), "forceCubic" : true });',
        'opSplineThroughEdges(context, id + "joined", { "edges" : qUnion([qCreatedBy(id + "a", EntityType.EDGE), qCreatedBy(id + "b", EntityType.EDGE)]) });',
        'evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "b", EntityType.EDGE), "side2" : qCreatedBy(id + "a", EntityType.EDGE) });',
        'evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "b", EntityType.EDGE), "side2" : qCreatedBy(id + "a", EntityType.EDGE) });',
        look("after"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.text("after")).toBe(r.text("before"));
    expect(r.valid).toBe(true);
  });

  it("a ruled surface's edges stay its own when they're read", () => {
    // The sheet ruled from a degree 2 wire; reading its edges must change neither.
    const r = run(
      [
        CURVES,
        'opRuledSurface(context, id + "ruled", { "path" : qCreatedBy(id + "a", EntityType.EDGE), "width" : 5 * millimeter, "ruledDirection" : vector(0, 0, 1), "ruledSurfaceType" : RuledSurfaceType.ALIGNED_WITH_VECTOR, "angle" : 0, "vertexOverrides" : [] });',
        'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "a", EntityType.EDGE), "parameter" : 0, "arcLengthParameterization" : false }).origin;',
        'evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "ruled", EntityType.EDGE), "side2" : qCreatedBy(id + "a", EntityType.EDGE) });',
        'evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "ruled", EntityType.EDGE), "side2" : qCreatedBy(id + "a", EntityType.EDGE) });',
        'setVariable(context, "before", start / millimeter);',
        'setVariable(context, "after", evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "a", EntityType.EDGE), "parameter" : 0, "arcLengthParameterization" : false }).origin / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.text("after")).toBe(r.text("before"));
    expect(r.valid).toBe(true);
  });

  it("surface readers: forced cubic, then plain, and trim loops read twice", () => {
    const patch =
      'bSplineSurface({ "uDegree" : 1, "vDegree" : 1, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([[vector(0, 0, 0) * millimeter, vector(0, 10, 0) * millimeter], [vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter]]) })';
    const segment = (from: string, to: string) =>
      `bSplineCurve({ "degree" : 1, "isPeriodic" : false, "controlPoints" : [vector(${from}), vector(${to})] })`;
    // Wound clockwise, so the face holds its loop's edges reversed.
    const loop = [
      segment("0.25, 0.25", "0.25, 0.75"),
      segment("0.25, 0.75", "0.75, 0.75"),
      segment("0.75, 0.75", "0.75, 0.25"),
      segment("0.75, 0.25", "0.25, 0.25"),
    ].join(", ");
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${patch}, "boundaryBSplineCurves" : [${loop}] });`,
        'const face = qCreatedBy(id + "patch", EntityType.FACE);',
        'const first = evApproximateBSplineSurface(context, { "face" : face });',
        'evApproximateBSplineSurface(context, { "face" : face, "forceCubic" : true });',
        'const second = evApproximateBSplineSurface(context, { "face" : face });',
        'setVariable(context, "before", [first.bSplineSurface.uDegree, mapArray(first.boundaryBSplineCurves, c => c.controlPoints[0])]);',
        'setVariable(context, "after", [second.bSplineSurface.uDegree, mapArray(second.boundaryBSplineCurves, c => c.controlPoints[0])]);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.text("after")).toBe(r.text("before"));
    expect(r.valid).toBe(true);
  });
});
