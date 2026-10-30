import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * opHelix, std's Helix feature, and sweeps along a helix.
 *
 * Ways it goes wrong:
 * - Handedness flipped: `clockwise` (seen looking along `direction`) turns the wrong way, so threads
 *   come out left-handed.
 * - The curve doesn't pass through `startPoint` at revolution 0, or `interval` is read as angles,
 *   lengths or a 0..1 fraction rather than revolutions.
 * - Pitch or spiral pitch applied per radian or per whole interval instead of per revolution.
 * - A planar spiral (zero helical pitch) or a conical helix (spiral and helical pitch) degenerates.
 * - The approximation drifts off the true helix (length, end point) by more than 0.1 um, or a
 *   cap on its size silently coarsens long helices (one point per turn on a 20000-turn coil).
 * - A start point on the axis, or a spiral that crosses the axis, builds garbage instead of failing.
 * - std's Helix feature measures the start angle from a different x axis than Onshape's, so the
 *   helix starts somewhere else around the circle. Only the default planes' x axes are known, so
 *   alignCanonically refuses other normals rather than guess.
 * - A sweep along the helix twists or self-intersects, losing volume (a tube's volume is its
 *   section area times the path length).
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/helix${counter++}.fs`,
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
    rows: (name: string) => {
      const value = untag(feature.variables.getField(name));
      if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
      return value.map((row) => {
        const items = untag(row);
        if (!Array.isArray(items)) throw new Error(`${name} has a row that isn't an array`);
        return items.map((item) => Number(untag(item)));
      });
    },
  };
};

const edge = (name: string) => `qCreatedBy(id + "${name}", EntityType.EDGE)`;
/** Records the curve's length, its end points and its start and end tangents (in mm). */
const measure = (name: string) =>
  [
    `setVariable(context, "length", evLength(context, { "entities" : ${edge(name)} }) / millimeter);`,
    `const ends = evEdgeTangentLines(context, { "edge" : ${edge(name)}, "parameters" : [0, 1] });`,
    'setVariable(context, "start", ends[0].origin / millimeter);',
    'setVariable(context, "end", ends[1].origin / millimeter);',
    'setVariable(context, "startTangent", ends[0].direction);',
    `setVariable(context, "wires", size(evaluateQuery(context, qBodyType(qCreatedBy(id + "${name}", EntityType.BODY), BodyType.WIRE))));`,
  ].join("\n");
const helix = (fields: string) =>
  `opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, ${fields} });`;
const close = (actual: number[], expected: number[], digits = 6) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));

describe("opHelix", () => {
  it("winds a right-handed helix through its start point, by revolutions and pitch", () => {
    // 5 turns of radius 10 at pitch 4: each turn is sqrt((20 PI)^2 + 4^2) long.
    const r = run(
      [
        helix(
          '"interval" : [0, 5], "clockwise" : true, "helicalPitch" : 4 * millimeter, "spiralPitch" : 0 * millimeter',
        ),
        measure("helix"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("wires")).toBe(1);
    expect(r.number("length")).toBeCloseTo(5 * Math.hypot(20 * Math.PI, 4), 5);
    close(r.numbers("start"), [10, 0, 0]);
    close(r.numbers("end"), [10, 0, 20]);
    // Clockwise seen looking along +z turns from +x toward +y, rising.
    const tangent = r.numbers("startTangent");
    const speed = Math.hypot(20 * Math.PI, 4);
    close(tangent, [0, (20 * Math.PI) / speed, 4 / speed]);
  });

  it("turns the other way counterclockwise, and trims to a fractional interval", () => {
    const r = run(
      [
        helix(
          '"interval" : [0.25, 1.5], "clockwise" : false, "helicalPitch" : 4 * millimeter, "spiralPitch" : 0 * millimeter',
        ),
        measure("helix"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // A quarter turn clockwise-negative from +x is -y, a quarter pitch up; 1.5 turns is -x.
    close(r.numbers("start"), [0, -10, 1]);
    close(r.numbers("end"), [-10, 0, 6]);
    expect(r.number("length")).toBeCloseTo(1.25 * Math.hypot(20 * Math.PI, 4), 5);
  });

  it("winds a flat Archimedean spiral when the helical pitch is zero", () => {
    // r = 10 + 5 t over 2 turns: length is the integral of sqrt((2 PI r)^2 + 5^2) dt.
    const r = run(
      [
        helix(
          '"interval" : [0, 2], "clockwise" : true, "helicalPitch" : 0 * millimeter, "spiralPitch" : 5 * millimeter',
        ),
        measure("helix"),
        `const along = evEdgeTangentLines(context, { "edge" : ${edge("helix")}, "parameters" : [0.13, 0.5, 0.87] });`,
        'setVariable(context, "heights", [along[0].origin[2] / millimeter, along[1].origin[2] / millimeter, along[2].origin[2] / millimeter]);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const steps = 20000;
    let length = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * (2 / steps);
      length += Math.hypot(2 * Math.PI * (10 + 5 * t), 5) * (2 / steps);
    }
    expect(r.number("length")).toBeCloseTo(length, 4);
    close(r.numbers("end"), [20, 0, 0]);
    close(r.numbers("heights"), [0, 0, 0], 9);
  });

  it("winds a conical helix when both pitches are set", () => {
    const r = run(
      [
        helix(
          '"interval" : [0, 3], "clockwise" : true, "helicalPitch" : 5 * millimeter, "spiralPitch" : -2 * millimeter',
        ),
        measure("helix"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.numbers("end"), [4, 0, 15]);
  });

  it("follows an axis that isn't z, from a start point off the axis start's plane", () => {
    // Axis along +x through (0, 5, 5); the start point is 3 mm along the axis and 10 mm out in +z.
    const r = run(
      [
        'opHelix(context, id + "helix", { "direction" : vector(1, 0, 0), "axisStart" : vector(0, 5, 5) * millimeter, "startPoint" : vector(3, 5, 15) * millimeter, "interval" : [0, 1.25], "clockwise" : true, "helicalPitch" : 8 * millimeter, "spiralPitch" : 0 * millimeter });',
        measure("helix"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.numbers("start"), [3, 5, 15]);
    // 1.25 right-handed turns about +x from +z lands on -y of the axis: z (0,0,1) -> -y after 90 degrees.
    close(r.numbers("end"), [13, -5, 5]);
  });

  it("stays within 0.1 um of long helices, and refuses a flat spiral it can't fit that closely", () => {
    // 1000 turns of radius 100 at pitch 1: check a point a fortieth of a turn in, and one halfway.
    const r = run(
      [
        'opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(100, 0, 0) * millimeter, "interval" : [0, 1000], "clockwise" : true, "helicalPitch" : 1 * millimeter, "spiralPitch" : 0 * millimeter });',
        `setVariable(context, "points", mapArray(evEdgeTangentLines(context, { "edge" : ${edge("helix")}, "parameters" : [0.025 / 1000, 500.5 / 1000], "arcLengthParameterization" : false }), line => line.origin / millimeter));`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const at = (turns: number) => [
      100 * Math.cos(2 * Math.PI * turns),
      100 * Math.sin(2 * Math.PI * turns),
      turns,
    ];
    const points = r.rows("points");
    [0.025, 500.5].forEach((turns, i) =>
      expect(Math.hypot(...points[i]!.map((c, k) => c - at(turns)[k]!))).toBeLessThan(1e-4),
    );
    // 20000 turns of radius 10 at pitch 1: half a turn in is opposite the start.
    const coil = run(
      [
        'opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, 20000], "clockwise" : true, "helicalPitch" : 1 * millimeter, "spiralPitch" : 0 * millimeter });',
        `setVariable(context, "points", mapArray(evEdgeTangentLines(context, { "edge" : ${edge("helix")}, "parameters" : [0.5 / 20000, 19999.25 / 20000], "arcLengthParameterization" : false }), line => line.origin / millimeter));`,
      ].join("\n"),
    );
    expect(coil.status, coil.why).toBe("OK");
    const [half, late] = coil.rows("points");
    expect(Math.hypot(half![0]! + 10, half![1]!, half![2]! - 0.5)).toBeLessThan(1e-4);
    expect(Math.hypot(late![0]!, late![1]! - 10, late![2]! - 19999.25)).toBeLessThan(1e-4);
    // A flat spiral lies on no surface as a line, so it's interpolated, and past 50000 points refused.
    const spiral = run(
      'opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, 1000], "clockwise" : true, "helicalPitch" : 0 * millimeter, "spiralPitch" : 1 * millimeter });',
    );
    expect(spiral.status).toBe("ERROR");
    expect(spiral.fault?.message).toMatch(/within 1e-7 m/);
  });

  it("fails on a start point on the axis, and on a spiral that would cross it", () => {
    const onAxis = run(
      'opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(0, 0, 5) * millimeter, "interval" : [0, 2], "clockwise" : true, "helicalPitch" : 4 * millimeter, "spiralPitch" : 0 * millimeter });',
    );
    expect(onAxis.status).toBe("ERROR");
    expect(onAxis.fault).toBeNull();
    expect(onAxis.statusEnum).toBe("HELIX_FAILED");
    const crossing = run(
      helix(
        '"interval" : [0, 3], "clockwise" : true, "helicalPitch" : 4 * millimeter, "spiralPitch" : -5 * millimeter',
      ),
    );
    expect(crossing.status).toBe("ERROR");
    expect(crossing.statusEnum).toBe("HELIX_FAILED");
  });

  // A 1 mm circle square to the helix's start tangent, swept along turns of radius 10, pitch 5.
  // 300 turns once read 7.1% high, when long swept faces were integrated at a fixed order.
  it.each([3, 300])(
    "sweeps a circle along %i helix turns into a tube of area times path length",
    (turns) => {
      const speed = "sqrt((20 * PI) ^ 2 + 25)";
      const r = run(
        [
          helix(
            `"interval" : [0, ${turns}], "clockwise" : true, "helicalPitch" : 5 * millimeter, "spiralPitch" : 0 * millimeter`,
          ),
          `const sketch = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, 20 * PI, 5) / ${speed}, vector(1, 0, 0)) });`,
          'skCircle(sketch, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
          "skSolve(sketch);",
          `opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : ${edge("helix")} });`,
          'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "sweep", EntityType.BODY) }) / millimeter ^ 3);',
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.valid).toBe(true);
      // Within 1e-5: the swept surface is fitted to 0.1 um, and its volume integral adds ~3e-6.
      const tube = Math.PI * turns * Math.hypot(20 * Math.PI, 5);
      expect(Math.abs(r.number("volume") / tube - 1)).toBeLessThan(1e-5);
    },
  );
});

describe("std's Helix feature", () => {
  /** A 10 mm circle at the origin in the XY plane, and std's helix around it. */
  const stdHelix = (fields: string, extra = "") =>
    run(
      [
        'const sketch = newSketchOnPlane(context, id + "circle", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skCircle(sketch, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 10 * millimeter });',
        "skSolve(sketch);",
        `helix(context, id + "helix", { "axisType" : AxisType.CIRCLE, "edge" : ${edge("circle")}, "startType" : StartType.START_ANGLE, ${fields} });`,
        measure("helix"),
        extra,
      ].join("\n"),
    );

  it("winds turns over a height from the circle, starting at the start angle", () => {
    const r = stdHelix(
      '"pathType" : PathType.TURNS, "endType" : EndType.HEIGHT, "height" : 20 * millimeter, "revolutions" : 4, "handedness" : Direction.CW, "startAngle" : 90 * degree',
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("length")).toBeCloseTo(4 * Math.hypot(20 * Math.PI, 5), 4);
    close(r.numbers("start"), [0, 10, 0]);
    close(r.numbers("end"), [0, 10, 20]);
  });

  it("derives turns from a pitch and a height, either hand", () => {
    // 22 mm at 4 mm pitch is 5.5 turns, so the helix ends opposite its start.
    const cw = stdHelix(
      '"pathType" : PathType.PITCH, "endType" : EndType.HEIGHT, "height" : 22 * millimeter, "helicalPitch" : 4 * millimeter, "handedness" : Direction.CW, "startAngle" : 0 * degree',
    );
    expect(cw.status, cw.why).toBe("OK");
    close(cw.numbers("start"), [10, 0, 0]);
    close(cw.numbers("end"), [-10, 0, 22]);
    expect(cw.number("length")).toBeCloseTo(5.5 * Math.hypot(20 * Math.PI, 4), 4);
    expect(cw.numbers("startTangent")[1]).toBeGreaterThan(0);
    const ccw = stdHelix(
      '"pathType" : PathType.PITCH, "endType" : EndType.HEIGHT, "height" : 22 * millimeter, "helicalPitch" : 4 * millimeter, "handedness" : Direction.CCW, "startAngle" : 0 * degree',
    );
    expect(ccw.status, ccw.why).toBe("OK");
    expect(ccw.numbers("startTangent")[1]).toBeLessThan(0);
  });

  it("combines turns and pitch into a height", () => {
    const r = stdHelix(
      '"pathType" : PathType.TURNS_PITCH, "revolutions" : 3, "helicalPitch" : 6 * millimeter, "handedness" : Direction.CW, "startAngle" : 0 * degree',
    );
    expect(r.status, r.why).toBe("OK");
    close(r.numbers("end"), [10, 0, 18]);
  });

  it("stops when its axis faces a way whose canonical x axis isn't known (opposite direction)", () => {
    // Blocked until Onshape's frame for a -z plane is confirmed.
    const r = stdHelix(
      '"pathType" : PathType.TURNS_PITCH, "revolutions" : 3, "helicalPitch" : 6 * millimeter, "handedness" : Direction.CW, "startAngle" : 0 * degree, "oppositeDirection" : true',
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/alignCanonically/);
  });
});

describe("alignCanonically", () => {
  it("gives the default planes their x axes and refuses other normals", () => {
    const x = (normal: string) =>
      `alignCanonically(context, plane(vector(1, 2, 3) * millimeter, vector(${normal}), vector(0.6, 0.8, 0) - dot(vector(0.6, 0.8, 0), vector(${normal})) * vector(${normal})))`;
    const r = run(
      [
        `setVariable(context, "top", ${x("0, 0, 1")}.x);`,
        `setVariable(context, "front", ${x("0, -1, 0")}.x);`,
        `setVariable(context, "right", ${x("1, 0, 0")}.x);`,
        `setVariable(context, "origin", ${x("0, 0, 1")}.origin / millimeter);`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.numbers("top"), [1, 0, 0]);
    close(r.numbers("front"), [1, 0, 0]);
    close(r.numbers("right"), [0, 1, 0]);
    close(r.numbers("origin"), [1, 2, 3]);
    const tilted = run(`${x("0, 0.6, 0.8")};`);
    expect(tilted.status).toBe("ERROR");
    expect(tilted.fault?.message).toMatch(/alignCanonically/);
  });
});
