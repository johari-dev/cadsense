import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * Curve features: std's Composite curve (opExtractWires), Intersection curve (opIntersectFaces),
 * Projected curve onto faces (opDropCurve) and 3D fit spline (opFitSpline, opSplineThroughEdges).
 *
 * Ways it goes wrong:
 * - Edges that touch end to end come out as separate wires, or disjoint ones as one wire.
 * - Extracted wires share topology with the sketch, so a later change to one moves the other.
 * - An intersection or projection misses part of the curve, or returns faces instead of wires.
 * - A projection goes the wrong way along its direction, or lands on the wrong side of a target.
 * - A normal projection onto a curved face is approximated without saying so.
 * - A spline through tangent edges drifts from them, or edges that kink are joined anyway (a
 *   closed loop's closing corner included: joining must not move the spline's start into a kink).
 * - opFitSpline given a zero derivative lets OpenCascade's exception escape and stop the whole
 *   run, instead of raising std's zero-magnitude error; likewise opSplineThroughEdges with an edge
 *   that comes to rest at an end.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/curves${counter++}.fs`,
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
    statusEnum: feature.statusEnum,
    fault: feature.fault,
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    number: (name: string) => Number(untag(feature.variables.getField(name))),
    numbers: (name: string) => {
      const value = untag(feature.variables.getField(name));
      if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
      return value.map((item) => Number(untag(item)));
    },
  };
};

const xy = (z = 0) => `plane(vector(0, 0, ${z}) * millimeter, vector(0, 0, 1), vector(1, 0, 0))`;
const sketch = (name: string, z: number, entities: string) =>
  [
    `const ${name} = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${xy(z)} });`,
    entities.replaceAll("SKETCH", name),
    `skSolve(${name});`,
  ].join("\n");
const wires = (feature: string) =>
  `qBodyType(qCreatedBy(id + "${feature}", EntityType.BODY), BodyType.WIRE)`;
/** Records the wire bodies a feature made, their edges, and their total length (mm). */
const measure = (feature: string) =>
  [
    `setVariable(context, "wires", size(evaluateQuery(context, ${wires(feature)})));`,
    `setVariable(context, "edges", size(evaluateQuery(context, qOwnedByBody(${wires(feature)}, EntityType.EDGE))));`,
    `setVariable(context, "length", evLength(context, { "entities" : qOwnedByBody(${wires(feature)}, EntityType.EDGE) }) / millimeter);`,
  ].join("\n");
const line = (name: string, from: string, to: string) =>
  `skLineSegment(SKETCH, "${name}", { "start" : vector(${from}) * millimeter, "end" : vector(${to}) * millimeter });`;

describe("std's Composite curve", () => {
  it("joins edges that meet end to end into one wire, and keeps disjoint ones apart", () => {
    const r = run(
      [
        sketch(
          "lines",
          0,
          [
            line("a", "0, 0", "10, 0"),
            line("b", "10, 0", "10, 10"),
            line("c", "10, 10", "0, 10"),
            line("far", "30, 0", "30, 7"),
          ].join("\n"),
        ),
        'compositeCurve(context, id + "composite", { "edges" : qCreatedBy(id + "lines", EntityType.EDGE) });',
        measure("composite"),
        // The composite is a copy: deleting the sketch leaves it whole.
        'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(id + "lines", EntityType.BODY) });',
        `setVariable(context, "after", evLength(context, { "entities" : qOwnedByBody(${wires("composite")}, EntityType.EDGE) }) / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.number("wires"), r.number("edges")]).toEqual([2, 4]);
    expect(r.number("length")).toBeCloseTo(37, 9);
    expect(r.number("after")).toBeCloseTo(37, 9);
  });
});

describe("std's Intersection curve", () => {
  it("intersects a cylinder's wall with a plane into a circle", () => {
    const r = run(
      [
        'fCylinder(context, id + "cylinder", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 10 * millimeter });',
        `opPlane(context, id + "plane", { "plane" : ${xy(5)} });`,
        'intersectionCurve(context, id + "intersection", { "group1" : qGeometry(qCreatedBy(id + "cylinder", EntityType.FACE), GeometryType.CYLINDER), "group2" : qCreatedBy(id + "plane", EntityType.FACE) });',
        measure("intersection"),
        `setVariable(context, "height", evApproximateCentroid(context, { "entities" : qOwnedByBody(${wires("intersection")}, EntityType.EDGE) })[2] / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("wires")).toBe(1);
    expect(r.number("length")).toBeCloseTo(20 * Math.PI, 6);
    expect(r.number("height")).toBeCloseTo(5, 9);
  });
});

describe("std's Projected curve, curve to face", () => {
  const circleAbove = sketch(
    "circle",
    30,
    'skCircle(SKETCH, "c", { "center" : vector(20, 20) * millimeter, "radius" : 5 * millimeter });',
  );
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 40, 10) * millimeter });\n' +
    'const top = qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(20, 20, 10) * millimeter);';

  it("drops a circle along a direction onto a face below it", () => {
    const r = run(
      [
        circleAbove,
        block,
        'projectCurves(context, id + "projected", { "curveProjectionType" : CurveProjectionType.CURVE_TO_FACE, "dropTools" : qCreatedBy(id + "circle", EntityType.EDGE), "projectionType" : ProjectionType.DIRECTION, "directionQuery" : top, "oppositeDirection" : true, "targets" : top });',
        measure("projected"),
        `setVariable(context, "centroid", evApproximateCentroid(context, { "entities" : qOwnedByBody(${wires("projected")}, EntityType.EDGE) }) / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("wires")).toBe(1);
    expect(r.number("length")).toBeCloseTo(10 * Math.PI, 6);
    r.numbers("centroid").forEach((c, i) => expect(c).toBeCloseTo([20, 20, 10][i]!, 6));
  });

  it("projects square onto a planar target, and refuses curved targets it can't project exactly", () => {
    const planar = run(
      [
        circleAbove,
        block,
        'projectCurves(context, id + "projected", { "curveProjectionType" : CurveProjectionType.CURVE_TO_FACE, "dropTools" : qCreatedBy(id + "circle", EntityType.EDGE), "projectionType" : ProjectionType.NORMAL_TO_TARGET, "targets" : top });',
        measure("projected"),
      ].join("\n"),
    );
    expect(planar.status, planar.why).toBe("OK");
    expect(planar.number("length")).toBeCloseTo(10 * Math.PI, 6);
    const curved = run(
      [
        circleAbove,
        'fCylinder(context, id + "cylinder", { "bottomCenter" : vector(0, 20, 0) * millimeter, "topCenter" : vector(40, 20, 0) * millimeter, "radius" : 10 * millimeter });',
        'projectCurves(context, id + "projected", { "curveProjectionType" : CurveProjectionType.CURVE_TO_FACE, "dropTools" : qCreatedBy(id + "circle", EntityType.EDGE), "projectionType" : ProjectionType.NORMAL_TO_TARGET, "targets" : qGeometry(qCreatedBy(id + "cylinder", EntityType.FACE), GeometryType.CYLINDER) });',
      ].join("\n"),
    );
    expect(curved.status).toBe("ERROR");
    expect(curved.fault?.message).toMatch(/normal to a non-planar/);
  });
});

describe("std's 3D fit spline", () => {
  it("fits a spline through vertices in order", () => {
    const r = run(
      [
        sketch(
          "points",
          0,
          [
            'skPoint(SKETCH, "p0", { "position" : vector(0, 0) * millimeter });',
            'skPoint(SKETCH, "p1", { "position" : vector(50, 0) * millimeter });',
            'skPoint(SKETCH, "p2", { "position" : vector(100, 0) * millimeter });',
          ].join("\n"),
        ),
        'fitSpline(context, id + "fit", { "fitType" : FitSplineType.VERTICES, "vertices" : qCreatedBy(id + "points", EntityType.VERTEX) });',
        measure("fit"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.number("wires"), r.number("edges")]).toEqual([1, 1]);
    expect(r.number("length")).toBeCloseTo(100, 6);
  });

  it("replaces a tangent chain of edges with one spline along them, and refuses a kink", () => {
    // A 10 mm line into a quarter arc of radius 10: 10 + 5 PI long, tangent where they meet.
    const r = run(
      [
        sketch(
          "chain",
          0,
          [
            line("line", "0, 0", "10, 0"),
            'skArc(SKETCH, "arc", { "start" : vector(10, 0) * millimeter, "mid" : vector(10 + 10 * sin(45 * degree), 10 - 10 * cos(45 * degree)) * millimeter, "end" : vector(20, 10) * millimeter });',
          ].join("\n"),
        ),
        'fitSpline(context, id + "fit", { "fitType" : FitSplineType.EDGES, "edges" : qCreatedBy(id + "chain", EntityType.EDGE) });',
        measure("fit"),
        `setVariable(context, "middle", evDistance(context, { "side0" : qOwnedByBody(${wires("fit")}, EntityType.EDGE), "side1" : vector(10 + 10 * sin(45 * degree), 10 - 10 * cos(45 * degree), 0) * millimeter }).distance / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.number("wires"), r.number("edges")]).toEqual([1, 1]);
    expect(r.number("length")).toBeCloseTo(10 + 5 * Math.PI, 5);
    expect(r.number("middle")).toBeCloseTo(0, 6);

    const kink = run(
      [
        sketch("chain", 0, [line("a", "0, 0", "10, 0"), line("b", "10, 0", "10, 10")].join("\n")),
        'fitSpline(context, id + "fit", { "fitType" : FitSplineType.EDGES, "edges" : qCreatedBy(id + "chain", EntityType.EDGE) });',
      ].join("\n"),
    );
    expect(kink.status).toBe("ERROR");
    expect(kink.fault).toBeNull();
    expect(kink.statusEnum).toBe("SPLINE_THROUGH_EDGES_TANGENT_DISCONTINUITY_AT_EDGE_ENDS");
  });
});

describe("opSplineThroughEdges on closed loops", () => {
  const loop = (radii: string) =>
    `opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter, vector(0, 0, 0) * millimeter], "bendRadii" : [${radii}] });`;

  it("starts a loop with one sharp corner at that corner, smooth everywhere else", () => {
    const r = run(
      [
        loop("1 * millimeter, 1 * millimeter, 1 * millimeter, 0 * millimeter"),
        'opSplineThroughEdges(context, id + "spline", { "edges" : qCreatedBy(id + "path", EntityType.EDGE) });',
        'const ends = evEdgeTangentLines(context, { "edge" : qCreatedBy(id + "spline", EntityType.EDGE), "parameters" : [0, 1], "arcLengthParameterization" : false });',
        'setVariable(context, "start", ends[0].origin / millimeter);',
        'setVariable(context, "turn", dot(ends[0].direction, ends[1].direction));',
        'setVariable(context, "length", evLength(context, { "entities" : qCreatedBy(id + "spline", EntityType.EDGE) }) / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    r.numbers("start").forEach((c) => expect(c).toBeCloseTo(0, 9));
    // It leaves along +x and arrives along -y: a right angle at the start and end.
    expect(r.number("turn")).toBeCloseTo(0, 9);
    expect(r.number("length")).toBeCloseTo(4 * 8 + 3 * (Math.PI / 2) + 2, 6);
    const two = run(
      [
        loop("1 * millimeter, 0 * millimeter, 1 * millimeter, 0 * millimeter"),
        'opSplineThroughEdges(context, id + "spline", { "edges" : qCreatedBy(id + "path", EntityType.EDGE) });',
      ].join("\n"),
    );
    expect(two.statusEnum).toBe("SPLINE_THROUGH_EDGES_TANGENT_DISCONTINUITY_AT_EDGE_ENDS");
  });
});

describe("opEditCurve", () => {
  it("gives a wire body another edge's curve, keeping the body", () => {
    // A straight 100 mm fit spline becomes a semicircle of radius 10 (its id stays).
    const r = run(
      [
        'opFitSpline(context, id + "wire", { "points" : [vector(0, 0, 0) * millimeter, vector(100, 0, 0) * millimeter] });',
        'const before = evaluateQuery(context, qCreatedBy(id + "wire", EntityType.BODY))[0];',
        sketch(
          "arc",
          0,
          'skArc(SKETCH, "arc", { "start" : vector(0, 0) * millimeter, "mid" : vector(10, 10) * millimeter, "end" : vector(20, 0) * millimeter });',
        ),
        'opEditCurve(context, id + "edit", { "wire" : before, "edge" : qCreatedBy(id + "arc", EntityType.EDGE) });',
        'setVariable(context, "length", evLength(context, { "entities" : qOwnedByBody(before, EntityType.EDGE) }) / millimeter);',
        'setVariable(context, "bodies", size(evaluateQuery(context, qCreatedBy(id + "wire", EntityType.BODY))));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("length")).toBeCloseTo(10 * Math.PI, 6);
    expect(r.number("bodies")).toBe(1);
  });
});

describe("opFitSpline spacing", () => {
  it("spaces points by the square root of their distances, as Onshape's centripetal knots do", () => {
    // std/fitSpline.fs: "the server uses centripetal knots". Points at x = 0, 1, 10 sit at
    // parameters 0, sqrt 1 / (sqrt 1 + sqrt 9) = 1/4, and 1 (chord spacing would put x = 1 at 1/10).
    const r = run(
      [
        'opFitSpline(context, id + "fit", { "points" : [vector(0, 0, 0) * millimeter, vector(1, 0, 0) * millimeter, vector(10, 0, 0) * millimeter] });',
        'setVariable(context, "x", evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "fit", EntityType.EDGE), "parameter" : 0.25, "arcLengthParameterization" : false }).origin[0] / millimeter);',
        // A closed spline spaces its closing chord the same way: the square's corners at quarters.
        'opFitSpline(context, id + "loop", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter, vector(0, 0, 0) * millimeter] });',
        'setVariable(context, "corner", evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "loop", EntityType.EDGE), "parameter" : 0.5, "arcLengthParameterization" : false }).origin / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("x")).toBeCloseTo(1, 9);
    r.numbers("corner").forEach((c, i) => expect(c).toBeCloseTo([10, 10, 0][i]!, 9));
  });
});

describe("opSplineThroughEdges at rest", () => {
  it("stops where an edge comes to rest at a join, without crashing", () => {
    // The first edge's last two control points coincide: zero derivative at its end, arriving
    // along +x all the same, as the second edge leaves. Before, the kernel threw on the zero vector
    // and ended the run. The chain is tangent, which is all std asks, so Onshape likely joins it;
    // the joined spline would stop dead there, which this runtime can't build yet.
    const r = run(
      [
        'opCreateBSplineCurve(context, id + "a", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [vector(0, 0, 0) * millimeter, vector(5, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 0, 0) * millimeter] }) });',
        'opCreateBSplineCurve(context, id + "b", { "bSplineCurve" : bSplineCurve({ "degree" : 2, "isPeriodic" : false, "controlPoints" : [vector(10, 0, 0) * millimeter, vector(15, 0, 0) * millimeter, vector(20, 5, 0) * millimeter] }) });',
        'opSplineThroughEdges(context, id + "joined", { "edges" : qUnion([qCreatedBy(id + "a", EntityType.EDGE), qCreatedBy(id + "b", EntityType.EDGE)]) });',
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/comes to rest/);
  });
});

describe("opFitSpline zero derivatives", () => {
  it("raises std's zero-magnitude errors for zero end derivatives, and refuses a zero inner one", () => {
    // std/fitSpline.fs raises these itself before calling opFitSpline; routingCurve.fs drops zero
    // inner derivatives. Passed straight to the builtin they must fault, not crash the kernel.
    const points =
      '"points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(20, 5, 0) * millimeter]';
    const fit = (fields: string) =>
      run(
        [
          `opFitSpline(context, id + "fit", { ${points}, ${fields} });`,
          'setVariable(context, "edges", size(evaluateQuery(context, qCreatedBy(id + "fit", EntityType.EDGE))));',
        ].join("\n"),
      );
    const start = fit('"startDerivative" : vector(0, 0, 0) * millimeter');
    expect([start.status, start.statusEnum, start.fault]).toEqual([
      "ERROR",
      "FIT_SPLINE_ZERO_START_MAGNITUDE",
      null,
    ]);
    const end = fit('"endDerivative" : vector(0, 0, 0) * millimeter');
    expect([end.status, end.statusEnum, end.fault]).toEqual([
      "ERROR",
      "FIT_SPLINE_ZERO_END_MAGNITUDE",
      null,
    ]);
    const inner = fit('"derivatives" : { 1 : vector(0, 0, 0) * millimeter }');
    expect(inner.status).toBe("ERROR");
    expect(inner.why).toMatch(/opFitSpline derivatives\[1\] is zero/);
    // The kernel is still usable: the same fit with real derivatives builds its edge.
    const fine = fit(
      '"startDerivative" : vector(10, 0, 0) * millimeter, "derivatives" : { 1 : vector(10, 2, 0) * millimeter }',
    );
    expect(fine.status, fine.why).toBe("OK");
    expect(fine.number("edges")).toBe(1);
  });
});
