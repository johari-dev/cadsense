import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { FsMap, untag } from "../src/runtime/Value.ts";

/**
 * B-spline curves: building them from std's `BSplineCurve`, evaluating them, approximating edges
 * and point sets with them, measuring deviation, and polylines.
 *
 * Ways it goes wrong:
 * - Knots misread: std's flat knot vector (with multiplicity) handed to OpenCascade as distinct
 *   knots, a periodic spline's padded knots and overlapping control points left in, weights
 *   dropped so a rational circle comes out a parabola.
 * - Units: control points in meters read as millimeters, or derivatives missing the unit.
 * - evaluateSpline's derivatives wrong for rational splines (the quotient rule skipped), or
 *   parameters outside the knot range silently extrapolated.
 * - A spline that isn't G1, isn't 3D, or claims to be periodic without closing is built anyway
 *   instead of raising std's error.
 * - evApproximateBSplineCurve returns a spline whose shape drifts from the edge, or ignores
 *   forceCubic and forceNonRational.
 * - approximateSpline misses its points by more than the tolerance, or gives a family of targets
 *   different parameterizations.
 * - evMaxPathDeviation reports zero for curves that differ, or reads only one side, or samples so
 *   coarsely that a bump within one narrow knot span slips between samples, or refines only the
 *   highest samples, so a narrow bump beside a plateau in one high-degree span is never refined.
 * - opPolyline loses its bends, cuts corners by the wrong length, or leaves a closed polyline open.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/bspline${counter++}.fs`,
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
  const numbers = (value: unknown): number[] => {
    const items = untag(value as never);
    if (!Array.isArray(items)) throw new Error("not an array");
    return items.map((item) => Number(untag(item)));
  };
  return {
    valid: allValid(result),
    status: feature.status,
    statusEnum: feature.statusEnum,
    fault: feature.fault,
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    get: (name: string) => feature.variables.getField(name),
    number: (name: string) => Number(untag(feature.variables.getField(name))),
    numbers: (name: string) => numbers(feature.variables.getField(name)),
    /** An array of vectors, as rows of numbers. */
    rows: (name: string) => {
      const items = untag(feature.variables.getField(name));
      if (!Array.isArray(items)) throw new Error(`${name} is not an array`);
      return items.map(numbers);
    },
    field: (name: string, key: string) => {
      const value = untag(feature.variables.getField(name));
      if (!(value instanceof FsMap)) throw new Error(`${name} is not a map`);
      return untag(value.getField(key));
    },
  };
};

const close = (actual: readonly number[], expected: readonly number[], digits = 6) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));
const edge = (name: string) => `qCreatedBy(id + "${name}", EntityType.EDGE)`;
/** A rational quadratic quarter circle of radius 10 mm about the origin, from +x to +y. */
const QUARTER = `bSplineCurve({ "degree" : 2, "isPeriodic" : false, "controlPoints" : [vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter], "weights" : [1, sqrt(2) / 2, 1], "knots" : knotArray([0, 1]) })`;
const length = (name: string, query: string) =>
  `setVariable(context, "${name}", evLength(context, { "entities" : ${query} }) / millimeter);`;

describe("opCreateBSplineCurve", () => {
  it("builds a rational quarter circle exactly, as one wire edge", () => {
    const r = run(
      [
        `opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : ${QUARTER} });`,
        length("length", edge("curve")),
        `setVariable(context, "wires", size(evaluateQuery(context, qBodyType(qCreatedBy(id + "curve", EntityType.BODY), BodyType.WIRE))));`,
        `setVariable(context, "radii", mapArray(evEdgeTangentLines(context, { "edge" : ${edge("curve")}, "parameters" : [0.1, 0.3, 0.5, 0.7, 0.9] }), line => norm(line.origin) / millimeter));`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("wires")).toBe(1);
    // Every point of the curve is 10 mm from the origin; the length integral is good to ~1e-7.
    close(r.numbers("radii"), [10, 10, 10, 10, 10], 9);
    expect(r.number("length")).toBeCloseTo(5 * Math.PI, 5);
  });

  it("closes a periodic spline from its unique control points, symmetric about the origin", () => {
    const r = run(
      [
        'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : true, "controlPoints" : [vector(10, 10, 0) * millimeter, vector(-10, 10, 0) * millimeter, vector(-10, -10, 0) * millimeter, vector(10, -10, 0) * millimeter] }) });',
        `const ends = evEdgeTangentLines(context, { "edge" : ${edge("curve")}, "parameters" : [0, 1] });`,
        'setVariable(context, "gap", norm(ends[0].origin - ends[1].origin) / millimeter);',
        'setVariable(context, "turn", dot(ends[0].direction, ends[1].direction));',
        `setVariable(context, "centroid", evApproximateCentroid(context, { "entities" : ${edge("curve")} }) / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("gap")).toBeCloseTo(0, 9);
    expect(r.number("turn")).toBeCloseTo(1, 9);
    close(r.numbers("centroid"), [0, 0, 0]);
  });

  it("refuses splines that kink, are 2D, or are periodic without closing", () => {
    const kink = run(
      'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : bSplineCurve({ "degree" : 1, "isPeriodic" : false, "controlPoints" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter] }) });',
    );
    expect([kink.status, kink.statusEnum, kink.fault]).toEqual([
      "ERROR",
      "BSPLINECURVE_NOT_G1",
      null,
    ]);
    const flat = run(
      'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : bSplineCurve({ "degree" : 1, "isPeriodic" : false, "controlPoints" : [vector(0, 0) * millimeter, vector(10, 0) * millimeter] }) });',
    );
    expect(flat.statusEnum).toBe("REQUIRE_3D_BSPLINECURVE_DATA");
    const open = run(
      'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : { "degree" : 2, "dimension" : 3, "isRational" : false, "isPeriodic" : true, "controlPoints" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter, vector(5, 5, 0) * millimeter], "knots" : knotArray([-2, -1, 0, 1, 2, 3, 4, 5]) } as BSplineCurve });',
    );
    expect(open.statusEnum).toBe("PERIODIC_BSPLINECURVE_NOT_CLOSED");
  });
});

describe("evaluateSpline", () => {
  it("evaluates points and derivatives of a rational spline, in meters", () => {
    const r = run(
      [
        `const values = evaluateSpline({ "spline" : ${QUARTER}, "parameters" : [0, 0.5, 1], "nDerivatives" : 2 });`,
        'setVariable(context, "points", mapArray(values[0], p => p / millimeter));',
        'setVariable(context, "firsts", mapArray(values[1], p => p / millimeter));',
        'setVariable(context, "seconds", mapArray(values[2], p => p / millimeter));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const s = Math.SQRT1_2 * 10;
    const [start, middle, end] = r.rows("points");
    close(start!, [10, 0, 0]);
    close(middle!, [s, s, 0]);
    close(end!, [0, 10, 0]);
    // C'(0) = 2 (w1 / w0) (P1 - P0) for a rational quadratic.
    close(r.rows("firsts")[0]!, [0, 2 * Math.SQRT1_2 * 10, 0]);
    // The curve is a circle, so speed^2 / radius is the centripetal part of C''.
    const [vx, vy] = r.rows("firsts")[1]!;
    const [ax, ay] = r.rows("seconds")[1]!;
    const speed = Math.hypot(vx!, vy!);
    // The centripetal component (toward the center) is speed^2 / 10.
    expect(-(ax! * middle![0]! + ay! * middle![1]!) / 10).toBeCloseTo((speed * speed) / 10, 6);
  });

  it("refuses parameters outside the knot range", () => {
    const r = run(`evaluateSpline({ "spline" : ${QUARTER}, "parameters" : [1.5] });`);
    expect(r.status).toBe("ERROR");
    expect(r.fault).toBeNull();
  });
});

describe("evApproximateBSplineCurve", () => {
  it("returns an arc exactly as a rational spline, and as a cubic within tolerance when forced", () => {
    const arc =
      'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });\n' +
      'skArc(sketch, "arc", { "start" : vector(10, 0) * millimeter, "mid" : vector(0, 10) * millimeter, "end" : vector(-10, 0) * millimeter });\n' +
      "skSolve(sketch);";
    const r = run(
      [
        arc,
        `const exact = evApproximateBSplineCurve(context, { "edge" : ${edge("sketch")} });`,
        'setVariable(context, "exact", exact);',
        `const cubic = evApproximateBSplineCurve(context, { "edge" : ${edge("sketch")}, "forceCubic" : true, "forceNonRational" : true, "tolerance" : 1e-7 });`,
        'setVariable(context, "cubic", cubic);',
        "var worst = 0;",
        "const knots = cubic.knots;",
        "for (var i = 0; i <= 40; i += 1)",
        "{",
        "    const u = knots[0] + (knots[size(knots) - 1] - knots[0]) * i / 40;",
        '    const p = evaluateSpline({ "spline" : cubic, "parameters" : [u] })[0][0];',
        "    worst = max(worst, abs(norm(p) - 10 * millimeter) / millimeter);",
        "}",
        'setVariable(context, "worst", worst);',
        'opCreateBSplineCurve(context, id + "copy", { "bSplineCurve" : exact });',
        length("copyLength", edge("copy")),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.field("exact", "isRational"), r.field("exact", "dimension")]).toEqual([true, 3]);
    expect([r.field("cubic", "degree"), r.field("cubic", "isRational")]).toEqual([3, false]);
    expect(r.number("worst")).toBeLessThan(1e-4);
    expect(r.number("copyLength")).toBeCloseTo(10 * Math.PI, 6);
  });
});

describe("evApproximateBSplineCurve on a periodic spline", () => {
  it("returns std's padded periodic form, the same curve it was built from", () => {
    const r = run(
      [
        'const built = bSplineCurve({ "degree" : 3, "isPeriodic" : true, "controlPoints" : [vector(10, 10, 0) * millimeter, vector(-10, 10, 0) * millimeter, vector(-10, -10, 0) * millimeter, vector(10, -10, 0) * millimeter] });',
        'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : built });',
        `const read = evApproximateBSplineCurve(context, { "edge" : ${edge("curve")} });`,
        'setVariable(context, "periodic", read.isPeriodic);',
        'setVariable(context, "sizes", [size(read.controlPoints), size(read.knots)]);',
        "const params = [0, 0.2, 0.55, 0.9];",
        'const a = evaluateSpline({ "spline" : built, "parameters" : params })[0];',
        'const b = evaluateSpline({ "spline" : read, "parameters" : params })[0];',
        "var gap = 0;",
        "for (var i = 0; i < size(params); i += 1) gap = max(gap, norm(a[i] - b[i]) / millimeter);",
        'setVariable(context, "gap", gap);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.get("periodic")).toBe(true);
    expect(r.numbers("sizes")).toEqual([7, 11]);
    expect(r.number("gap")).toBeCloseTo(0, 9);
  });
});

describe("approximateSpline", () => {
  it("passes within tolerance of every point, with one parameterization for all targets", () => {
    // Two targets sampled from y = sin(x) and y = cos(x) over 0..PI, 30 mm scale.
    const r = run(
      [
        "var a = [];",
        "var b = [];",
        "for (var i = 0; i <= 20; i += 1)",
        "{",
        "    const x = PI * i / 20;",
        "    a = append(a, vector(30 * x, 30 * sin(x * radian), 0) * millimeter);",
        "    b = append(b, vector(30 * x, 30 * cos(x * radian), 5) * millimeter);",
        "}",
        'const splines = approximateSpline(context, { "degree" : 3, "tolerance" : 1e-5 * meter, "isPeriodic" : false, "targets" : [approximationTarget({ "positions" : a }), approximationTarget({ "positions" : b })] });',
        'setVariable(context, "count", size(splines));',
        'setVariable(context, "sameKnots", splines[0].knots == splines[1].knots);',
        'setVariable(context, "controlPoints", size(splines[0].controlPoints));',
        'opCreateBSplineCurve(context, id + "a", { "bSplineCurve" : splines[0] });',
        "var worst = 0;",
        "for (var p in a)",
        `    worst = max(worst, evDistance(context, { "side0" : ${edge("a")}, "side1" : p }).distance / millimeter);`,
        'setVariable(context, "worst", worst);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("count")).toBe(2);
    expect(r.get("sameKnots")).toBe(true);
    // An approximation, not an interpolation through all 21 points.
    expect(r.number("controlPoints")).toBeLessThan(21);
    expect(r.number("worst")).toBeLessThan(0.01);
  });
});

describe("evMaxPathDeviation", () => {
  it("finds the largest gap between two paths, from either side", () => {
    // A 20 mm line along x, and an arc through its ends bulging 5 mm in +y at x = 10.
    const r = run(
      [
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skLineSegment(sketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(20, 0) * millimeter });',
        'skArc(sketch, "arc", { "start" : vector(0, 0) * millimeter, "mid" : vector(10, 5) * millimeter, "end" : vector(20, 0) * millimeter });',
        "skSolve(sketch);",
        'const line = sketchEntityQuery(id + "sketch", EntityType.EDGE, "line");',
        'const arc = sketchEntityQuery(id + "sketch", EntityType.EDGE, "arc");',
        'const result = evMaxPathDeviation(context, { "side1" : line, "side2" : arc });',
        'setVariable(context, "deviation", result.deviation / millimeter);',
        'setVariable(context, "onArc", result.side2Point / millimeter);',
        'setVariable(context, "reverse", evMaxPathDeviation(context, { "side1" : arc, "side2" : line }).deviation / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("deviation")).toBeCloseTo(5, 4);
    close(r.numbers("onArc"), [10, 5, 0], 3);
    expect(r.number("reverse")).toBeCloseTo(5, 4);
  });
});

describe("evMaxPathDeviation on narrow spans", () => {
  it("finds a 6.25 mm bump confined to a knot span 1e-4 of the parameter wide, wherever it sits", () => {
    // A degree-5 spline along a 100 mm line, lifted by control points packed into [lo, hi].
    for (const center of [0.103, 0.203, 0.3333, 0.503, 0.803]) {
      const [lo, hi] = [center - 0.00005, center + 0.00005];
      const lifts = [0, 0, 10, 10, 0, 0];
      const points = [
        ...Array.from({ length: 6 }, (_, j) => [(100 * lo * j) / 5, 0, 0]),
        ...Array.from({ length: 5 }, (_, i) => [
          100 * (lo + ((hi - lo) * (i + 1)) / 5),
          lifts[i + 1]!,
          0,
        ]),
        ...Array.from({ length: 5 }, (_, i) => [100 * (hi + ((1 - hi) * (i + 1)) / 5), 0, 0]),
      ];
      const knots = [
        ...Array(6).fill(0),
        ...Array(5).fill(lo),
        ...Array(5).fill(hi),
        ...Array(6).fill(1),
      ];
      const r = run(
        [
          `opCreateBSplineCurve(context, id + "bump", { "bSplineCurve" : bSplineCurve({ "degree" : 5, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([${knots.join(", ")}]) }) });`,
          'opPolyline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(100, 0, 0) * millimeter] });',
          'setVariable(context, "deviation", evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "bump", EntityType.EDGE), "side2" : qCreatedBy(id + "line", EntityType.EDGE) }).deviation / millimeter);',
          'setVariable(context, "reverse", evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "line", EntityType.EDGE), "side2" : qCreatedBy(id + "bump", EntityType.EDGE) }).deviation / millimeter);',
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.number("deviation"), `bump at ${center}`).toBeCloseTo(6.25, 6);
      expect(r.number("reverse"), `bump at ${center}, reversed`).toBeCloseTo(6.25, 6);
    }
  });

  it("finds a narrow bump beside a plateau within one high-degree span", () => {
    // One degree-25 span along a 100 mm line: control point 1 lifted 35 mm makes a narrow bump
    // near x = 4, and points 4 to 21 lifted 10 mm make a plateau that's nearly as high.
    const degree = 25;
    const lifts = Array.from({ length: degree + 1 }, (_, i) =>
      i === 1 ? 35 : i >= 4 && i <= 21 ? 10 : 0,
    );
    const choose = (n: number, k: number) => {
      let c = 1;
      for (let j = 1; j <= k; j++) c = (c * (n - k + j)) / j;
      return c;
    };
    // x runs evenly with t, so the gap from the line is the lift itself.
    const lift = (t: number) =>
      lifts.reduce<number>(
        (sum, y, i) => sum + y * choose(degree, i) * t ** i * (1 - t) ** (degree - i),
        0,
      );
    let [lo, hi] = [0.02, 0.07];
    for (let i = 0; i < 200; i++) {
      const [a, b] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
      if (lift(a) > lift(b)) hi = b;
      else lo = a;
    }
    const peak = (lo + hi) / 2;
    // The bump beats the plateau by about a third.
    expect(lift(peak)).toBeGreaterThan(13);
    expect(lift(0.5)).toBeLessThan(10);
    const curve = `bSplineCurve({ "degree" : ${degree}, "isPeriodic" : false, "controlPoints" : [${lifts.map((y, i) => `vector(${(100 * i) / degree}, ${y}, 0) * millimeter`).join(", ")}] })`;
    const r = run(
      [
        `opCreateBSplineCurve(context, id + "bump", { "bSplineCurve" : ${curve} });`,
        'opPolyline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(100, 0, 0) * millimeter] });',
        'const result = evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "bump", EntityType.EDGE), "side2" : qCreatedBy(id + "line", EntityType.EDGE) });',
        'setVariable(context, "deviation", result.deviation / millimeter);',
        'setVariable(context, "onBump", result.side1Point / millimeter);',
        'setVariable(context, "reverse", evMaxPathDeviation(context, { "side1" : qCreatedBy(id + "line", EntityType.EDGE), "side2" : qCreatedBy(id + "bump", EntityType.EDGE) }).deviation / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("deviation")).toBeCloseTo(lift(peak), 6);
    close(r.numbers("onBump"), [100 * peak, lift(peak), 0], 4);
    expect(r.number("reverse")).toBeCloseTo(lift(peak), 6);
  });
});

describe("opPolyline", () => {
  it("draws an open polyline with a bend, cutting the corner by the bend's tangent length", () => {
    // A right-angle corner with a 2 mm bend: each leg loses 2 mm, and a quarter circle adds PI mm.
    const r = run(
      [
        'opPolyline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter], "bendRadii" : [2 * millimeter] });',
        length("length", edge("line")),
        `setVariable(context, "edges", size(evaluateQuery(context, ${edge("line")})));`,
        `setVariable(context, "arcs", size(evaluateQuery(context, qGeometry(${edge("line")}, GeometryType.ARC))));`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("length")).toBeCloseTo(16 + Math.PI, 6);
    expect(r.number("edges")).toBe(3);
    expect(r.number("arcs")).toBe(1);
  });

  it("closes when the last point repeats the first, bending every corner it's given", () => {
    const square =
      "[vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter, vector(0, 0, 0) * millimeter]";
    const plain = run(
      [
        `opPolyline(context, id + "line", { "points" : ${square} });`,
        length("length", edge("line")),
        `setVariable(context, "edges", size(evaluateQuery(context, ${edge("line")})));`,
        `setVariable(context, "vertices", size(evaluateQuery(context, qCreatedBy(id + "line", EntityType.VERTEX))));`,
      ].join("\n"),
    );
    expect(plain.status, plain.why).toBe("OK");
    expect([plain.number("length"), plain.number("edges"), plain.number("vertices")]).toEqual([
      40, 4, 4,
    ]);
    const rounded = run(
      [
        `opPolyline(context, id + "line", { "points" : ${square}, "bendRadii" : [1 * millimeter, 1 * millimeter, 1 * millimeter, 1 * millimeter] });`,
        length("length", edge("line")),
      ].join("\n"),
    );
    expect(rounded.status, rounded.why).toBe("OK");
    expect(rounded.number("length")).toBeCloseTo(32 + 2 * Math.PI, 6);
  });
});

describe("evCurveDefinition", () => {
  // A B-spline edge comes back as std's BSplineCurve: the rational quarter circle keeps its
  // degree, weights and control points instead of stopping or losing its weights.
  it("returns a B-spline edge as std's BSplineCurve", () => {
    const r = run(
      [
        `opCreateBSplineCurve(context, id + "quarter", { "bSplineCurve" : ${QUARTER} });`,
        `const curve = evCurveDefinition(context, { "edge" : ${edge("quarter")} });`,
        'setVariable(context, "curve", { "degree" : curve.degree, "isRational" : curve.isRational, "weight" : curve.weights[1], "corner" : curve.controlPoints[1] / millimeter });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.field("curve", "degree"), r.field("curve", "isRational")]).toEqual([2, true]);
    expect(r.field("curve", "weight")).toBeCloseTo(Math.SQRT1_2, 12);
    const corner = untag(r.get("curve") as never) as FsMap;
    close(
      (untag(corner.getField("corner")!) as readonly unknown[]).map((c) =>
        Number(untag(c as never)),
      ),
      [10, 10, 0],
    );
  });
});

describe("periodic splines with a repeated seam knot", () => {
  // Five pentagon control points (the first three repeated) with the seam knot doubled: std's full
  // periodic knot vector. The curve closes with matching tangents, so it builds as one edge.
  it("builds one closed edge", () => {
    const corner = (i: number) =>
      `vector(${10 * Math.cos((i * 2 * Math.PI) / 5)}, ${10 * Math.sin((i * 2 * Math.PI) / 5)}, 0) * millimeter`;
    const points = [0, 1, 2, 3, 4, 0, 1, 2].map(corner).join(", ");
    const r = run(
      [
        `const spline = bSplineCurve({ "degree" : 3, "isPeriodic" : true, "controlPoints" : [${points}], "knots" : knotArray([-0.75, -0.5, -0.25, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1.25, 1.5]) });`,
        'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : spline });',
        `setVariable(context, "edges", size(evaluateQuery(context, ${edge("curve")})));`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("edges")).toBe(1);
  });

  // Read back, the same curve: std's knot vector rebuilt around the doubled seam, so it evaluates
  // where the original does and builds again.
  it("reads back as the same spline", () => {
    const corner = (i: number) =>
      `vector(${10 * Math.cos((i * 2 * Math.PI) / 5)}, ${10 * Math.sin((i * 2 * Math.PI) / 5)}, 0) * millimeter`;
    const points = [0, 1, 2, 3, 4, 0, 1, 2].map(corner).join(", ");
    const r = run(
      [
        `const spline = bSplineCurve({ "degree" : 3, "isPeriodic" : true, "controlPoints" : [${points}], "knots" : knotArray([-0.75, -0.5, -0.25, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1.25, 1.5]) });`,
        'opCreateBSplineCurve(context, id + "curve", { "bSplineCurve" : spline });',
        `const back = evApproximateBSplineCurve(context, { "edge" : ${edge("curve")} });`,
        "var gap = 0;",
        "for (var u in [0, 0.1, 0.3, 0.55, 0.9])",
        '    gap = max(gap, norm(evaluateSpline({ "spline" : back, "parameters" : [u] })[0][0] - evaluateSpline({ "spline" : spline, "parameters" : [u] })[0][0]) / millimeter);',
        'setVariable(context, "gap", gap);',
        'opCreateBSplineCurve(context, id + "again", { "bSplineCurve" : back });',
        `setVariable(context, "again", size(evaluateQuery(context, ${edge("again")})));`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("gap")).toBeLessThan(1e-9);
    expect(r.number("again")).toBe(1);
  });
});
