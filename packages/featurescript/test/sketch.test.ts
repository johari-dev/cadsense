// @effect-diagnostics nodeBuiltinImport:off - reads the redundant-constraint fixtures from disk.
import * as NodeFS from "node:fs";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import type { SketchConstraint, SketchEntity, SketchRef } from "../src/geometry/Sketch.ts";
import { solveConstraints } from "../src/geometry/SketchSolver.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { untag, type FsValue } from "../src/runtime/Value.ts";

/**
 * Sketches end to end through std: constraints, topology, entities.
 *
 * Constraint solving can go wrong in these ways, each guarded below:
 * 1. Constraints are ignored: a HORIZONTAL line stays at 17 degrees.
 * 2. Geometry that already satisfies its constraints moves (std's rectangle and polygon helpers).
 * 3. The solve moves more than it must: a fixed point moves, or one endpoint moves when moving the
 *    other would do.
 * 4. A reference resolves to the wrong thing: `r.left.start` vs an entity named `line.0`, or an arc's
 *    `start` that isn't its counterclockwise start (std's hem relies on that).
 * 5. Units: lengths taken as millimeters, angles as degrees.
 * 6. A dimension picks the wrong side or branch: an ALIGNED/ANTI_ALIGNED distance with the wrong
 *    sign, a tangent flipping internal/external, an angle solved to its supplement.
 * 7. FIX on an arc also pins its endpoints (std's hem needs them to slide).
 * 8. Conflicting constraints "solve" to geometry that breaks some of them; consistent but redundant
 *    ones (std's rectangle) are reported as a failure.
 * 9. A constraint type or reference this runtime can't solve is silently skipped; a missing entity
 *    is silently ignored.
 * 10. Regions are built from the unsolved positions.
 * 11. Geometry no constraint touches (a far-off point) loosens the check that every constraint
 *    holds, so conflicting dimensions pass. (Review finding.)
 * 12. `alignment` is ignored where std's DimensionAlignment applies (coincident and parallel axes),
 *    or silently dropped where we don't know what it means. (Review finding.)
 * 13. A length or distance can't grow from zero: at coincident points it has no direction to grow
 *    in, so the solve never moves. (Review finding.)
 * 14. A small line far from the sketch origin can't hold an angle to zeroAngle, because its own
 *    coordinates can't represent its direction that finely, so a valid sketch fails. (Review
 *    finding.)
 * 15. Degenerate geometry weakens the check instead: a constraint between zero-length lines is
 *    dropped, a line that collapses to nothing gets unlimited angular tolerance, or the precision
 *    floor is loose enough to pass a representable conflict. (Review findings.)
 * 16. A degenerate start the solver can't get out of: a collapsed rectangle, a point at a circle's
 *    center, an ellipse drawn without radii; or getting out of it moves what FIX holds. (Review
 *    findings.)
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const feature = (body: string) =>
  runtime.load(
    `test/sketch${counter++}.fs`,
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

/** Runs `body` as one feature and reads back what it recorded with `setVariable`. */
const run = (body: string) => {
  const result = runtime.runFeatures([{ module: feature(body), feature: "test" }]);
  const outcome = result.features[0]!;
  const read = (name: string): FsValue => outcome.variables.getField(name);
  return {
    geometry: result.geometry!,
    status: outcome.status,
    statusEnum: outcome.statusEnum,
    fault: outcome.fault?.message ?? null,
    exceptions: JSON.stringify(outcome.exceptions.map((e) => e.message)),
    number: (name: string) => {
      const value = untag(read(name));
      if (typeof value !== "number") throw new Error(`${name} is ${String(value)}`);
      return value;
    },
    flag: (name: string) => {
      const value = untag(read(name));
      if (typeof value !== "boolean") throw new Error(`${name} is ${String(value)}`);
      return value;
    },
    vector: (name: string) => {
      const value = untag(read(name));
      if (!Array.isArray(value)) throw new Error(`${name} is not a vector`);
      return value.map((n) => Number(untag(n)));
    },
  };
};

/** A sketch on the XY plane named `id + "sketch"`, with `lines` of FeatureScript inside. */
const sketch = (lines: readonly string[]) =>
  [
    'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * meter, vector(0, 0, 1), vector(1, 0, 0)) });',
    ...lines,
    "skSolve(sketch);",
  ].join("\n");
const mm = (x: number, y: number) => `vector(${x}, ${y}) * millimeter`;
type Mm = readonly [number, number];
const line = (name: string, [x0, y0]: Mm, [x1, y1]: Mm, more = "") =>
  `skLineSegment(sketch, "${name}", { "start" : ${mm(x0, y0)}, "end" : ${mm(x1, y1)}${more} });`;
const constrain = (name: string, type: string, fields: string) =>
  `skConstraint(sketch, "${name}", { "constraintType" : ConstraintType.${type}, ${fields} });`;
const edge = (entity: string) => `sketchEntityQuery(id + "sketch", EntityType.EDGE, "${entity}")`;
/** Records the point at `parameter` (0 = start, 1 = end) along a sketch edge, in millimeters. */
const at = (name: string, entity: string, parameter: number) =>
  `setVariable(context, "${name}", evEdgeTangentLine(context, { "edge" : ${edge(entity)}, "parameter" : ${parameter} }).origin / millimeter);`;
const circleOf = (name: string, entity: string) =>
  [
    `setVariable(context, "${name}Center", evCurveDefinition(context, { "edge" : ${edge(entity)} }).coordSystem.origin / millimeter);`,
    `setVariable(context, "${name}Radius", evCurveDefinition(context, { "edge" : ${edge(entity)} }).radius / millimeter);`,
  ].join("\n");
const record = (name: string, expression: string) =>
  `setVariable(context, "${name}", ${expression});`;
const regionArea = record(
  "area",
  'evArea(context, { "entities" : qSketchRegion(id + "sketch") }) / millimeter^2',
);

/**
 * `count` std rectangles 10 mm square in a row, each joined at its bottom right corner to the next
 * one's bottom left and sized 10 by 10 by LENGTH; the last is drawn `lastWidth` wide.
 */
const rectangleRow = (count: number, lastWidth = 10) =>
  Array.from({ length: count }, (_, i) => [
    `skRectangle(sketch, "r${i}", { "firstCorner" : ${mm(i * 10, 10)}, "secondCorner" : ${mm(i * 10 + (i === count - 1 ? lastWidth : 10), 0)} });`,
    ...(i > 0
      ? [
          constrain(
            `k${i}`,
            "COINCIDENT",
            `"localFirst" : "r${i - 1}.right.end", "localSecond" : "r${i}.left.end"`,
          ),
        ]
      : []),
    constrain(`w${i}`, "LENGTH", `"localFirst" : "r${i}.top", "length" : 10 * millimeter`),
    constrain(`h${i}`, "LENGTH", `"localFirst" : "r${i}.left", "length" : 10 * millimeter`),
  ]).flat();

const close = (actual: readonly number[], expected: readonly number[], digits = 9) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((n, i) => expect(n, `[${i}] of ${actual}`).toBeCloseTo(expected[i]!, digits));
};

describe("sketch constraints", () => {
  const rad17 = (17 * Math.PI) / 180;
  const tilted: [number, number] = [10 * Math.cos(rad17), 10 * Math.sin(rad17)];

  it("levels a 17 degree line; with its start fixed, only the end moves", () => {
    const r = run(
      [
        sketch([
          line("l1", [0, 0], tilted),
          constrain("fix", "FIX", '"localFirst" : "l1.start"'),
          constrain("h", "HORIZONTAL", '"localFirst" : "l1"'),
        ]),
        at("start", "l1", 0),
        at("end", "l1", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("start"), [0, 0, 0]);
    close(r.vector("end"), [tilted[0], 0, 0]);
  });

  it("moves a free line as little as it can: both ends meet halfway", () => {
    // Minimal movement: the residual y difference splits evenly between the two endpoints.
    const r = run(
      [
        sketch([line("l1", [0, 0], tilted), constrain("h", "HORIZONTAL", '"localFirst" : "l1"')]),
        at("start", "l1", 0),
        at("end", "l1", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("start"), [0, tilted[1] / 2, 0]);
    close(r.vector("end"), [tilted[0], tilted[1] / 2, 0]);
  });

  it("solves a dimensioned right triangle, and builds its region and extrude from the result", () => {
    // Legs 30 and 40 from sloppy starting points: hypotenuse 50, area 600 mm^2, 10 mm deep 6000 mm^3.
    const r = run(
      [
        sketch([
          line("a", [0, 0], [28, 2]),
          line("b", [29, 1], [31, 38]),
          line("c", [30, 39], [1, -1]),
          constrain("c0", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "b.start"'),
          constrain("c1", "COINCIDENT", '"localFirst" : "b.end", "localSecond" : "c.start"'),
          constrain("c2", "COINCIDENT", '"localFirst" : "c.end", "localSecond" : "a.start"'),
          constrain("h", "HORIZONTAL", '"localFirst" : "a"'),
          constrain("v", "VERTICAL", '"localFirst" : "b"'),
          constrain("fix", "FIX", '"localFirst" : "a.start"'),
          constrain("la", "LENGTH", '"localFirst" : "a", "length" : 30 * millimeter'),
          constrain("lb", "LENGTH", '"localFirst" : "b", "length" : 4 * centimeter'),
        ]),
        at("corner", "b", 1),
        record("hypotenuse", `evLength(context, { "entities" : ${edge("c")} }) / millimeter`),
        regionArea,
        'extrude(context, id + "extrude", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 10 * millimeter });',
        record(
          "volume",
          'evVolume(context, { "entities" : qCreatedBy(id + "extrude", EntityType.BODY) }) / millimeter^3',
        ),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("corner"), [30, 40, 0]);
    expect(r.number("hypotenuse")).toBeCloseTo(50, 9);
    expect(r.number("area")).toBeCloseTo(600, 6);
    expect(r.number("volume")).toBeCloseTo(6000, 5);
  });

  it("leaves std's rectangle, polygon and constrained polyline exactly where they were drawn", () => {
    const r = run(
      [
        sketch([
          `skRectangle(sketch, "r", { "firstCorner" : ${mm(0, 0)}, "secondCorner" : ${mm(30, 20)} });`,
          `skRegularPolygon(sketch, "hex", { "center" : ${mm(60, 10)}, "firstVertex" : ${mm(70, 10)}, "sides" : 6 });`,
          `skPolyline(sketch, "tri", { "points" : [${mm(0, 40)}, ${mm(10, 40)}, ${mm(0, 50)}, ${mm(0, 40)}], "constrained" : true });`,
        ]),
        regionArea,
        at("rTop", "r.top", 0),
        at("rRight", "r.right", 1),
        at("tri", "tri.line1", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    // 600 + hexagon (3 sqrt(3) / 2 * 10^2) + 50
    expect(r.number("area")).toBeCloseTo(600 + (3 * Math.sqrt(3) * 100) / 2 + 50, 6);
    close(r.vector("rTop"), [0, 0, 0], 12);
    close(r.vector("rRight"), [30, 20, 0], 12);
    close(r.vector("tri"), [0, 50, 0], 12);
  });

  it("keeps a sketch with redundant angle constraints as near its drawing as without them", () => {
    // Review round 9: at a drawing that doesn't satisfy them, redundant angle equations aren't
    // quite dependent, so the minimum-norm step divided their second-order mismatch by a slope
    // near zero along a direction nothing constrains, and flung the geometry there: a rectangle
    // drawn 1 mm skewed with one HORIZONTAL too many solved 0.127 mm wide. Each step now leaves
    // out the equations nearly dependent on the others, so the corners move by about the skew,
    // and what no equation needs moved stays where it was drawn. Which equations a step uses
    // still steers Gauss-Newton a little: with or without the redundant HORIZONTAL the corners
    // land within a micrometer of the nearest rectangle, not on the same point.
    const names = ["bottom", "right", "top", "left"];
    /** Four lines joined corner to corner as drawn, and where each corner (each line's start) solves to. */
    const quad = (corners: readonly Mm[], constraints: readonly string[]) => {
      const r = run(
        [
          sketch([
            ...corners.map((p, i) => line(names[i]!, p, corners[(i + 1) % 4]!)),
            ...names.map((name, i) =>
              constrain(
                `c${i}`,
                "COINCIDENT",
                `"localFirst" : "${name}.end", "localSecond" : "${names[(i + 1) % 4]}.start"`,
              ),
            ),
            ...constraints,
          ]),
          ...names.map((name) => at(name, name, 0)),
        ].join("\n"),
      );
      expect(r.status, r.fault ?? r.exceptions).toBe("OK");
      return names.map((name) => r.vector(name).slice(0, 2));
    };
    const twoLines = (type: string, first: string, second: string) =>
      constrain(`${type}${first}`, type, `"localFirst" : "${first}", "localSecond" : "${second}"`);
    const oneLine = (type: string, name: string) =>
      constrain(`${type}${name}`, type, `"localFirst" : "${name}"`);
    // std skRectangle's own set (PARALLEL pairs, VERTICAL left, HORIZONTAL top), drawn 1 mm
    // skewed. The nearest axis-aligned rectangle averages each side's drawn corners, 0.71 mm from
    // each; a Gauss-Newton solve lands within a few micrometers of it.
    const skewed: Mm[] = [
      [0, 0],
      [30, 1],
      [31, 20],
      [-1, 19],
    ];
    const std = [
      twoLines("PARALLEL", "left", "right"),
      twoLines("PARALLEL", "top", "bottom"),
      oneLine("VERTICAL", "left"),
      oneLine("HORIZONTAL", "top"),
    ];
    const nearest = [
      [-0.5, 0.5],
      [30.5, 0.5],
      [30.5, 19.5],
      [-0.5, 19.5],
    ];
    for (const extra of [[], [oneLine("HORIZONTAL", "bottom")]])
      quad(skewed, [...std, ...extra]).forEach((corner, i) => close(corner, nearest[i]!, 2));
    // H and V sides drawn with only the bottom right corner 0.3 mm high, and a redundant PARALLEL:
    // only the bottom's height needs to move, so every x stays exactly as drawn.
    const hv = [
      oneLine("HORIZONTAL", "bottom"),
      oneLine("VERTICAL", "right"),
      oneLine("HORIZONTAL", "top"),
      oneLine("VERTICAL", "left"),
      twoLines("PARALLEL", "bottom", "top"),
    ];
    const level = quad(
      [
        [0, 0],
        [30, 0.3],
        [30, 20],
        [0, 20],
      ],
      hv,
    );
    const levelled = [
      [0, 0.15],
      [30, 0.15],
      [30, 20],
      [0, 20],
    ];
    level.forEach((corner, i) => close(corner, levelled[i]!, 11));
    // A 30 x 20 rectangle turned 30 degrees, one corner drawn (1, -0.5) mm off, held square at
    // three corners or, redundantly, at all four: the same rectangle either way (to a
    // micrometer), and no corner moves more than the 1.12 mm the drawing is off.
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const turned: Mm[] = [
      [0, 0],
      [30, 0],
      [30, 20],
      [0, 20],
    ].map(([u, v]) => [10 + u! * c - v! * s, 5 + u! * s + v! * c]);
    turned[2] = [turned[2]![0] + 1, turned[2]![1] - 0.5];
    const square = names.map((name, i) => twoLines("PERPENDICULAR", name, names[(i + 1) % 4]!));
    const [three, four] = [quad(turned, square.slice(0, 3)), quad(turned, square)];
    four.forEach((corner, i) => {
      close(corner, three[i]!, 3);
      expect(Math.hypot(corner[0]! - turned[i]![0], corner[1]! - turned[i]![1])).toBeLessThan(
        Math.hypot(1, 0.5),
      );
    });
  });

  it("stretches a rectangle away from a fixed side", () => {
    // Left side fixed on x = 0; top dimensioned to 20 mm; the right side follows; height stays 10.
    const r = run(
      [
        sketch([
          `skRectangle(sketch, "r", { "firstCorner" : ${mm(0, 10)}, "secondCorner" : ${mm(10, 0)} });`,
          constrain("fix", "FIX", '"localFirst" : "r.left"'),
          constrain("width", "LENGTH", '"localFirst" : "r.top", "length" : 20 * millimeter'),
        ]),
        regionArea,
        at("leftStart", "r.left", 0),
        at("leftEnd", "r.left", 1),
        at("rightEnd", "r.right", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.number("area")).toBeCloseTo(200, 6);
    close(r.vector("leftStart"), [0, 10, 0]);
    close(r.vector("leftEnd"), [0, 0, 0]);
    close(r.vector("rightEnd"), [20, 0, 0]);
  });

  it("solves circles: radius, external tangency, concentric, diameter, equal", () => {
    // c1 r 5 fixed at the origin. c2 starts at (20, 1) r 3: radius 8, level with c1, tangent
    // outside, so its center lands at (13, 0). c3 shares c2's center, diameter 6. The arc takes c1's
    // radius.
    const r = run(
      [
        sketch([
          `skCircle(sketch, "c1", { "center" : ${mm(0, 0)}, "radius" : 5 * millimeter });`,
          `skCircle(sketch, "c2", { "center" : ${mm(20, 1)}, "radius" : 3 * millimeter });`,
          `skCircle(sketch, "c3", { "center" : ${mm(40, 40)}, "radius" : 2 * millimeter });`,
          `skArc(sketch, "a1", { "start" : ${mm(4, 30)}, "mid" : ${mm(0, 34)}, "end" : ${mm(-4, 30)} });`,
          constrain("fix", "FIX", '"localFirst" : "c1"'),
          constrain("r2", "RADIUS", '"localFirst" : "c2", "length" : 8 * millimeter'),
          constrain(
            "level",
            "HORIZONTAL",
            '"localFirst" : "c1.center", "localSecond" : "c2.center"',
          ),
          constrain("t", "TANGENT", '"localFirst" : "c1", "localSecond" : "c2"'),
          constrain("con", "CONCENTRIC", '"localFirst" : "c3", "localSecond" : "c2"'),
          constrain("d3", "DIAMETER", '"localFirst" : "c3", "length" : 6 * millimeter'),
          constrain("eq", "EQUAL", '"localFirst" : "a1", "localSecond" : "c1"'),
        ]),
        circleOf("c1", "c1"),
        circleOf("c2", "c2"),
        circleOf("c3", "c3"),
        circleOf("a1", "a1"),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("c1Center"), [0, 0, 0]);
    expect(r.number("c1Radius")).toBeCloseTo(5, 9);
    close(r.vector("c2Center"), [13, 0, 0]);
    expect(r.number("c2Radius")).toBeCloseTo(8, 9);
    close(r.vector("c3Center"), [13, 0, 0]);
    expect(r.number("c3Radius")).toBeCloseTo(3, 9);
    expect(r.number("a1Radius")).toBeCloseTo(5, 9);
  });

  it("solves points on lines, midpoints, perpendicular, parallel, equal and point distances", () => {
    // l1 is the fixed segment (0,0)-(20,0). l2 starts at l1's midpoint, perpendicular, 10 long.
    // l3 starts on l1's line, 6 from l2's start (the nearer of x = 4 and x = 16), parallel to l2
    // and as long.
    const r = run(
      [
        sketch([
          line("l1", [0, 0], [20, 0]),
          line("l2", [12, 1], [15, 9]),
          line("l3", [2, 5], [7, 14]),
          constrain("f0", "FIX", '"localFirst" : "l1.start"'),
          constrain("f1", "FIX", '"localFirst" : "l1.end"'),
          constrain("perp", "PERPENDICULAR", '"localFirst" : "l1", "localSecond" : "l2"'),
          constrain("mid", "MIDPOINT", '"localFirst" : "l2.start", "localSecond" : "l1"'),
          constrain("len", "LENGTH", '"localFirst" : "l2", "length" : 10 * millimeter'),
          constrain("on", "COINCIDENT", '"localFirst" : "l3.start", "localSecond" : "l1"'),
          constrain(
            "gap",
            "DISTANCE",
            '"localFirst" : "l3.start", "localSecond" : "l2.start", "direction" : DimensionDirection.MINIMUM, "length" : 6 * millimeter',
          ),
          constrain("par", "PARALLEL", '"localFirst" : "l3", "localSecond" : "l2"'),
          constrain("eq", "EQUAL", '"localFirst" : "l3", "localSecond" : "l2"'),
        ]),
        at("l2s", "l2", 0),
        at("l2e", "l2", 1),
        at("l3s", "l3", 0),
        at("l3e", "l3", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("l2s"), [10, 0, 0]);
    close(r.vector("l2e"), [10, 10, 0]);
    close(r.vector("l3s"), [4, 0, 0]);
    close(r.vector("l3e"), [4, 10, 0]);
  });

  it("mirrors a point across a construction line", () => {
    const r = run(
      [
        sketch([
          line("m", [0, -10], [0, 10], ', "construction" : true'),
          `skPoint(sketch, "p1", { "position" : ${mm(5, 3)} });`,
          `skPoint(sketch, "p2", { "position" : ${mm(-4, 2.5)} });`,
          constrain("fm", "FIX", '"localFirst" : "m"'),
          constrain("fp", "FIX", '"localFirst" : "p1"'),
          constrain(
            "sym",
            "MIRROR",
            '"localFirst" : "p1", "localSecond" : "p2", "localMirror" : "m"',
          ),
        ]),
        record(
          "p2",
          'evVertexPoint(context, { "vertex" : sketchEntityQuery(id + "sketch", EntityType.VERTEX, "p2") }) / millimeter',
        ),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("p2"), [-5, 3, 0]);
  });

  it("signs directional distances by alignment, as std's hem uses them", () => {
    // ALIGNED: the second point is that far along +x; ANTI_ALIGNED: that far along -y.
    const r = run(
      [
        sketch([
          line("l", [0, 0], [3, 4]),
          constrain("f", "FIX", '"localFirst" : "l.start"'),
          constrain(
            "dx",
            "DISTANCE",
            '"localFirst" : "l.start", "localSecond" : "l.end", "direction" : DimensionDirection.HORIZONTAL, "alignment" : DimensionAlignment.ALIGNED, "length" : 10 * millimeter',
          ),
          constrain(
            "dy",
            "DISTANCE",
            '"localFirst" : "l.start", "localSecond" : "l.end", "direction" : DimensionDirection.VERTICAL, "alignment" : DimensionAlignment.ANTI_ALIGNED, "length" : 2 * millimeter',
          ),
        ]),
        at("end", "l", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("end"), [10, -2, 0]);
  });

  it("solves an angle in degrees to the branch nearest the drawing, and inch lengths", () => {
    // l2 starts 32 degrees up; ANGLE 30 degrees keeps it above l1. Its length is 1 inch.
    const r = run(
      [
        sketch([
          line("l1", [0, 0], [10, 0]),
          line("l2", [0, 0], [8, 5]),
          constrain("f0", "FIX", '"localFirst" : "l1.start"'),
          constrain("f1", "FIX", '"localFirst" : "l1.end"'),
          constrain("join", "COINCIDENT", '"localFirst" : "l1.start", "localSecond" : "l2.start"'),
          constrain(
            "angle",
            "ANGLE",
            '"localFirst" : "l1", "localSecond" : "l2", "angle" : 30 * degree',
          ),
          constrain("len", "LENGTH", '"localFirst" : "l2", "length" : 1 * inch'),
        ]),
        at("end", "l2", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("end"), [25.4 * Math.cos(Math.PI / 6), 25.4 * Math.sin(Math.PI / 6), 0]);
  });

  it("slides a fixed arc's end around its circle to meet a tangent line (std's hem)", () => {
    // Arc r 10 at the origin, fixed (center and radius only). The line from its end to the fixed
    // point (-20, -10) must be tangent: the tangent point nearest (-10, 0) is (-8, 6).
    const r = run(
      [
        sketch([
          `skArc(sketch, "a", { "start" : ${mm(10, 0)}, "mid" : ${mm(0, 10)}, "end" : ${mm(-10, 0)} });`,
          line("t", [-10, 0], [-20, -10]),
          constrain("fixArc", "FIX", '"localFirst" : "a"'),
          constrain("fixEnd", "FIX", '"localFirst" : "t.end"'),
          constrain("join", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "t.start"'),
          constrain("tan", "TANGENT", '"localFirst" : "a", "localSecond" : "t"'),
        ]),
        at("arcStart", "a", 0),
        at("arcEnd", "a", 1),
        record("arcLength", `evLength(context, { "entities" : ${edge("a")} }) / millimeter`),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("arcStart"), [10, 0, 0]);
    close(r.vector("arcEnd"), [-8, 6, 0]);
    expect(r.number("arcLength")).toBeCloseTo(10 * Math.atan2(6, -8), 9);
  });

  it("only treats points held on each other as a joint for tangency, not points on one curve", () => {
    // Review round 5: the line's end and the arc's end both lie on a construction line, which
    // doesn't join them. The line must still be truly tangent: from (0, 20) to y = 0, touching the
    // fixed r 10 arc at (30, 0), it ends at x = 40 - sqrt(1600 - 3200 / 3) (the root nearer 12).
    const r = run(
      [
        sketch([
          line("cl", [-50, 0], [50, 0], ', "construction" : true'),
          `skArc(sketch, "a", { "start" : ${mm(20, 0)}, "mid" : ${mm(30, 10)}, "end" : ${mm(40, 0)} });`,
          line("l", [0, 20], [12, 0]),
          constrain("fcl", "FIX", '"localFirst" : "cl"'),
          constrain("fa", "FIX", '"localFirst" : "a"'),
          constrain("fl", "FIX", '"localFirst" : "l.start"'),
          constrain("le", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "cl"'),
          constrain("ae", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "cl"'),
          constrain("as", "COINCIDENT", '"localFirst" : "a.start", "localSecond" : "cl"'),
          constrain("t", "TANGENT", '"localFirst" : "l", "localSecond" : "a"'),
        ]),
        at("end", "l", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("end"), [40 - Math.sqrt(1600 - 3200 / 3), 0, 0]);

    // Two arcs whose ends both lie on one circle aren't joined either: they end up tangent.
    const arcs = run(
      [
        sketch([
          `skCircle(sketch, "k", { "center" : ${mm(0, 0)}, "radius" : 30 * millimeter });`,
          `skArc(sketch, "a", { "start" : ${mm(30, 0)}, "mid" : ${mm(40, 10)}, "end" : ${mm(50, 0)} });`,
          `skArc(sketch, "b", { "start" : ${mm(-30, 0)}, "mid" : ${mm(-20, 15)}, "end" : ${mm(0, 30)} });`,
          constrain("fk", "FIX", '"localFirst" : "k"'),
          constrain("fa", "FIX", '"localFirst" : "a"'),
          constrain("ra", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "k"'),
          constrain("rb", "COINCIDENT", '"localFirst" : "b.start", "localSecond" : "k"'),
          constrain("t", "TANGENT", '"localFirst" : "a", "localSecond" : "b"'),
        ]),
        circleOf("a", "a"),
        circleOf("b", "b"),
      ].join("\n"),
    );
    expect(arcs.status, arcs.fault ?? arcs.exceptions).toBe("OK");
    const [ac, bc] = [arcs.vector("aCenter"), arcs.vector("bCenter")];
    const [ar, br] = [arcs.number("aRadius"), arcs.number("bRadius")];
    const apart = Math.hypot(ac[0]! - bc[0]!, ac[1]! - bc[1]!);
    expect(Math.min(Math.abs(apart - ar - br), Math.abs(apart - Math.abs(ar - br)))).toBeLessThan(
      1e-6,
    );
  });

  it("never solves a circle to a negative radius", () => {
    // Review round 5: each of these pushes a radius below zero. OpenCascade can't build that (it
    // crashed the run); Onshape solves another branch or fails, never returns a negative radius.
    // Each does solve with its one sided equation on the other side from where it's drawn (r 10
    // above the line, internal tangency, inside the circle), which Onshape might choose, so the
    // run stops saying so rather than fail.
    const cases = {
      "tangent circle pushed across a fixed line": [
        line("l", [-10, 10], [10, 10]),
        `skPoint(sketch, "p", { "position" : ${mm(0, 0)} });`,
        `skCircle(sketch, "k", { "center" : ${mm(0, 1)}, "radius" : 5 * millimeter });`,
        constrain("fl", "FIX", '"localFirst" : "l"'),
        constrain("fp", "FIX", '"localFirst" : "p"'),
        constrain(
          "cx",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "k.center", "direction" : DimensionDirection.HORIZONTAL, "length" : 0 * millimeter',
        ),
        constrain(
          "cy",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "k.center", "direction" : DimensionDirection.VERTICAL, "length" : 20 * millimeter',
        ),
        constrain("t", "TANGENT", '"localFirst" : "l", "localSecond" : "k"'),
      ],
      "external tangent circles forced to overlap": [
        `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 10 * millimeter });`,
        `skCircle(sketch, "d", { "center" : ${mm(13, 0)}, "radius" : 3 * millimeter });`,
        constrain("fc", "FIX", '"localFirst" : "c"'),
        constrain("t", "TANGENT", '"localFirst" : "c", "localSecond" : "d"'),
        constrain(
          "d",
          "DISTANCE",
          '"localFirst" : "c.center", "localSecond" : "d.center", "length" : 5 * millimeter',
        ),
      ],
      "point-circle distance past the center": [
        `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 2 * millimeter });`,
        `skPoint(sketch, "p", { "position" : ${mm(5, 0)} });`,
        constrain("fc", "FIX", '"localFirst" : "c.center"'),
        constrain("fp", "FIX", '"localFirst" : "p"'),
        constrain(
          "d",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "c", "length" : 8 * millimeter',
        ),
      ],
    };
    for (const [name, lines] of Object.entries(cases)) {
      const r = run(sketch(lines));
      expect(r.fault, name).toMatch(/other side from where it's drawn/);
    }
    // A negative radius given straight to the builtin is no circle either.
    const drawn = run(
      sketch([`@skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : -5 * millimeter });`]),
    );
    expect(drawn.statusEnum).toBe("SKETCH_INPUT_INVALID");
  });

  it("judges a line by both its solved ends when they solve apart", () => {
    // Review round 5: each end of the line is placed on its own, so they solve in separate groups.
    // The start moves exactly where the end was drawn; the line isn't collapsing, it's sliding.
    const fixedPoint = (name: string, x: number) => [
      `skPoint(sketch, "${name}", { "position" : ${mm(x, 0)} });`,
      constrain(`f${name}`, "FIX", `"localFirst" : "${name}"`),
    ];
    const slid = run(
      [
        sketch([
          line("l", [0, 0], [10, 0]),
          ...fixedPoint("p", 10),
          ...fixedPoint("q", 20),
          constrain("cs", "COINCIDENT", '"localFirst" : "l.start", "localSecond" : "p"'),
          constrain("ce", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "q"'),
        ]),
        at("start", "l", 0),
        at("end", "l", 1),
      ].join("\n"),
    );
    expect(slid.status, slid.fault ?? slid.exceptions).toBe("OK");
    close(slid.vector("start"), [10, 0, 0]);
    close(slid.vector("end"), [20, 0, 0]);

    const polyline = run(
      [
        sketch([
          line("a", [0, 0], [10, 0]),
          line("b", [10, 0], [20, 0]),
          ...fixedPoint("p1", 10),
          ...fixedPoint("p2", 20),
          ...fixedPoint("p3", 30),
          constrain("j", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "b.start"'),
          constrain("c1", "COINCIDENT", '"localFirst" : "a.start", "localSecond" : "p1"'),
          constrain("c2", "COINCIDENT", '"localFirst" : "b.start", "localSecond" : "p2"'),
          constrain("c3", "COINCIDENT", '"localFirst" : "b.end", "localSecond" : "p3"'),
        ]),
        at("b", "b", 1),
      ].join("\n"),
    );
    expect(polyline.status, polyline.fault ?? polyline.exceptions).toBe("OK");
    close(polyline.vector("b"), [30, 0, 0]);

    // A collapse across groups still fails: both ends pinned to one point.
    const pinched = run(
      sketch([
        line("l", [0, 0], [10, 0]),
        ...fixedPoint("p", 5),
        constrain("cs", "COINCIDENT", '"localFirst" : "l.start", "localSecond" : "p"'),
        constrain("ce", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "p"'),
      ]),
    );
    expect(pinched.statusEnum).toBe("SKETCH_SOLVE_FAILED");
  });

  it("picks a tangency branch the same way whichever circle comes first", () => {
    // Review round 5: two r 10 circles drawn 5 apart, then sized 10 and 15. The drawing ties
    // between "c holds d" and "d holds c"; only the second can hold, in either argument order.
    const tangent = (first: string, second: string, fixCenters = false) =>
      run(
        [
          sketch([
            `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 10 * millimeter });`,
            `skCircle(sketch, "d", { "center" : ${mm(5, 0)}, "radius" : 10 * millimeter });`,
            ...(fixCenters
              ? [
                  constrain("fc", "FIX", '"localFirst" : "c"'),
                  constrain("fd", "FIX", '"localFirst" : "d.center"'),
                ]
              : [constrain("rc", "RADIUS", '"localFirst" : "c", "length" : 10 * millimeter')]),
            constrain("rd", "RADIUS", '"localFirst" : "d", "length" : 15 * millimeter'),
            constrain("t", "TANGENT", `"localFirst" : "${first}", "localSecond" : "${second}"`),
          ]),
          circleOf("c", "c"),
          circleOf("d", "d"),
        ].join("\n"),
      );
    for (const [first, second, fixCenters] of [
      ["c", "d", false],
      ["d", "c", false],
      ["c", "d", true],
    ] as const) {
      const r = tangent(first, second, fixCenters);
      const label = `${first},${second}${fixCenters ? " fixed" : ""}`;
      expect(r.status, `${label}: ${r.fault ?? r.exceptions}`).toBe("OK");
      // Already 5 apart, as "d holds c" needs: nothing moves.
      close(r.vector("cCenter"), [0, 0, 0]);
      close(r.vector("dCenter"), [5, 0, 0]);
      expect(r.number("dRadius"), label).toBeCloseTo(15, 9);
    }
  });

  it("won't close an arc into a full circle by pinning its ends together", () => {
    // Review round 5: as with a line, a solution may not collapse an arc drawn with two ends.
    const arc = `skArc(sketch, "a", { "start" : ${mm(10, 0)}, "mid" : ${mm(0, 10)}, "end" : ${mm(-10, 0)} });`;
    const pinned = run(
      sketch([
        arc,
        `skPoint(sketch, "p", { "position" : ${mm(0, 10)} });`,
        constrain("fp", "FIX", '"localFirst" : "p"'),
        constrain("fa", "FIX", '"localFirst" : "a"'),
        constrain("s", "COINCIDENT", '"localFirst" : "a.start", "localSecond" : "p"'),
        constrain("e", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "p"'),
      ]),
    );
    expect(pinned.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    const closed = run(
      sketch([
        arc,
        constrain("fa", "FIX", '"localFirst" : "a.center"'),
        constrain(
          "d",
          "DISTANCE",
          '"localFirst" : "a.start", "localSecond" : "a.end", "length" : 0 * millimeter',
        ),
      ]),
    );
    expect(closed.statusEnum).toBe("SKETCH_SOLVE_FAILED");
  });

  it("never moves a fixed line to satisfy a sided equation", () => {
    // Review round 6: FIX held only each end on the line's infinite line, so a tangency or
    // distance taking its side from the line's direction could be met by reversing the line. The
    // circle and point here are drawn above a fixed line but held 5 below it: the drawn side
    // can't hold, and the line must not move to make it hold.
    const fixedLine = [
      line("l", [0, 0], [50, 0]),
      `skPoint(sketch, "q", { "position" : ${mm(20, -5)} });`,
      constrain("fl", "FIX", '"localFirst" : "l"'),
      constrain("fq", "FIX", '"localFirst" : "q"'),
    ];
    const tangent = run(
      sketch([
        ...fixedLine,
        `skCircle(sketch, "c", { "center" : ${mm(20, 1)}, "radius" : 5 * millimeter });`,
        constrain("cq", "COINCIDENT", '"localFirst" : "c.center", "localSecond" : "q"'),
        constrain("r", "RADIUS", '"localFirst" : "c", "length" : 5 * millimeter'),
        constrain("t", "TANGENT", '"localFirst" : "c", "localSecond" : "l"'),
      ]),
    );
    // It would solve with the circle below, the other side from where it's drawn: Onshape's
    // choice there isn't known, so the run stops naming the constraint (round 6 follow-up).
    expect(tangent.fault).toMatch(/TANGENT t .*other side from where it's drawn/);
    const apart = (drawnY: number) =>
      run(
        [
          sketch([
            ...fixedLine,
            `skPoint(sketch, "p", { "position" : ${mm(20, drawnY)} });`,
            constrain("pq", "COINCIDENT", '"localFirst" : "p", "localSecond" : "q"'),
            constrain(
              "d",
              "DISTANCE",
              '"localFirst" : "p", "localSecond" : "l", "length" : 5 * millimeter',
            ),
          ]),
          at("start", "l", 0),
          at("end", "l", 1),
        ].join("\n"),
      );
    expect(apart(1).fault).toMatch(/DISTANCE d .*other side from where it's drawn/);
    // Held 7 below, a radius 5 circle can't be tangent on either side: a plain failure.
    const neither = run(
      sketch([
        line("l", [0, 0], [50, 0]),
        `skPoint(sketch, "q", { "position" : ${mm(20, -7)} });`,
        constrain("fl", "FIX", '"localFirst" : "l"'),
        constrain("fq", "FIX", '"localFirst" : "q"'),
        `skCircle(sketch, "c", { "center" : ${mm(20, 1)}, "radius" : 5 * millimeter });`,
        constrain("cq", "COINCIDENT", '"localFirst" : "c.center", "localSecond" : "q"'),
        constrain("r", "RADIUS", '"localFirst" : "c", "length" : 5 * millimeter'),
        constrain("t", "TANGENT", '"localFirst" : "c", "localSecond" : "l"'),
      ]),
    );
    expect(neither.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    // Drawn on the side it's held on, it solves, and the line is exactly where it was drawn.
    const below = apart(-1);
    expect(below.status, below.fault ?? below.exceptions).toBe("OK");
    close(below.vector("start"), [0, 0, 0], 12);
    close(below.vector("end"), [50, 0, 0], 12);
  });

  it("forks a sided equation drawn exactly on its tie, whichever way the line runs", () => {
    // Review round 6: a point, a circle's center, or a blank circle (drawn at the origin, on the
    // line) sits on the line, so the drawing says nothing about the side. Held 5 below the fixed
    // line by a fixed point, each must solve below it in either line direction.
    const below = (from: [number, number], to: [number, number], lines: readonly string[]) =>
      run(
        sketch([
          line("l", from, to),
          `skPoint(sketch, "q", { "position" : ${mm(20, -5)} });`,
          constrain("fl", "FIX", '"localFirst" : "l"'),
          constrain("fq", "FIX", '"localFirst" : "q"'),
          ...lines,
        ]),
      );
    const cases = {
      "point on the line, DISTANCE 5": [
        `skPoint(sketch, "p", { "position" : ${mm(20, 0)} });`,
        constrain("pq", "COINCIDENT", '"localFirst" : "p", "localSecond" : "q"'),
        constrain(
          "d",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "l", "length" : 5 * millimeter',
        ),
      ],
      "blank circle, TANGENT": [
        'skCircle(sketch, "c", {});',
        constrain("cq", "COINCIDENT", '"localFirst" : "c.center", "localSecond" : "q"'),
        constrain("r", "RADIUS", '"localFirst" : "c", "length" : 5 * millimeter'),
        constrain("t", "TANGENT", '"localFirst" : "c", "localSecond" : "l"'),
      ],
      "circle centered on the line, DISTANCE 2": [
        `skCircle(sketch, "c", { "center" : ${mm(20, 0)}, "radius" : 3 * millimeter });`,
        constrain("cq", "COINCIDENT", '"localFirst" : "c.center", "localSecond" : "q"'),
        constrain(
          "d",
          "DISTANCE",
          '"localFirst" : "l", "localSecond" : "c", "length" : 2 * millimeter',
        ),
      ],
    };
    for (const [name, lines] of Object.entries(cases))
      for (const [from, to] of [
        [
          [0, 0],
          [50, 0],
        ],
        [
          [50, 0],
          [0, 0],
        ],
      ] as const) {
        const r = below([...from], [...to], lines);
        expect(r.status, `${name} ${from}->${to}: ${r.fault ?? r.exceptions}`).toBe("OK");
      }
  });

  it("stops rather than drop branches when one group ties too many ways", () => {
    // Five tied tangencies held in one group by concentric circles: 2^5 = 32 combinations, more
    // than are tried, so the run stops naming the count instead of skipping some.
    const pairs = [0, 1, 2, 3, 4].flatMap((i) => [
      `skCircle(sketch, "a${i}", { "center" : ${mm(0, 0)}, "radius" : 10 * millimeter });`,
      `skCircle(sketch, "b${i}", { "center" : ${mm(2, 0)}, "radius" : 10 * millimeter });`,
      constrain(`t${i}`, "TANGENT", `"localFirst" : "a${i}", "localSecond" : "b${i}"`),
      ...(i > 0
        ? [constrain(`c${i}`, "CONCENTRIC", `"localFirst" : "a${i}", "localSecond" : "a0"`)]
        : []),
    ]);
    const r = run(sketch(pairs));
    expect(r.fault).toMatch(/32 combinations/);
  });

  it("doesn't see a tie in an angle whose branches are the same angle", () => {
    // Review round 7: ANGLE 90's targets (90, -90, 180 - 90, 90 - 180) repeat, so every right
    // angle looked tied and five of them stopped as "32 combinations". Two rectangles sharing a
    // side, drawn leaning about 81 degrees, squared up by five ANGLE 90s. Review round 8: targets
    // were merged only within 1e-12 rad but tie within zeroAngle (1e-11), so an angle a few 1e-12
    // off 90 degrees, as a computed value can be, kept 90 + e and 90 - e apart and tied them.
    const sides: [string, [number, number], [number, number]][] = [
      ["b1", [0, 0], [30, 0]],
      ["b2", [30, 0], [60, 0]],
      ["r", [60, 0], [63, 20]],
      ["t2", [63, 20], [33, 20]],
      ["t1", [33, 20], [3, 20]],
      ["l", [3, 20], [0, 0]],
      ["m", [30, 0], [33, 20]],
    ];
    const joins = [
      ["b1.end", "b2.start"],
      ["b2.end", "r.start"],
      ["r.end", "t2.start"],
      ["t2.end", "t1.start"],
      ["t1.end", "l.start"],
      ["l.end", "b1.start"],
      ["m.start", "b1.end"],
      ["m.end", "t2.end"],
    ];
    const corners = [
      ["b1", "l"],
      ["b1", "m"],
      ["b2", "r"],
      ["t2", "r"],
      ["t1", "l"],
    ];
    for (const off of ["0", "5e-13", "2e-12", "5e-12"]) {
      const r = run(
        [
          sketch([
            ...sides.map(([name, from, to]) => line(name, from, to)),
            ...joins.map(([p, q], i) =>
              constrain(`j${i}`, "COINCIDENT", `"localFirst" : "${p}", "localSecond" : "${q}"`),
            ),
            ...corners.map(([p, q], i) =>
              constrain(
                `a${i}`,
                "ANGLE",
                `"localFirst" : "${p}", "localSecond" : "${q}", "angle" : 90 * degree + ${off} * radian`,
              ),
            ),
          ]),
          record("regions", 'size(evaluateQuery(context, qSketchRegion(id + "sketch")))'),
          // Nothing fixes the orientation, so each corner is checked for square, not the axes.
          ...corners.map(([p, q], i) =>
            record(
              `square${i}`,
              `dot(evEdgeTangentLine(context, { "edge" : ${edge(p!)}, "parameter" : 0 }).direction, evEdgeTangentLine(context, { "edge" : ${edge(q!)}, "parameter" : 0 }).direction)`,
            ),
          ),
        ].join("\n"),
      );
      expect(r.status, `${off}: ${r.fault ?? r.exceptions}`).toBe("OK");
      expect(r.number("regions")).toBe(2);
      corners.forEach((_, i) => expect(r.number(`square${i}`)).toBeCloseTo(0, 9));
    }
  });

  it("says so when a sketch only solves if a fixed line's ends slide along it", () => {
    // Review round 7: FIX pins a line's ends, but Onshape may store a line like an arc (a fixed
    // line with ends free along it), which std documents for arcs. Where pinned fails and sliding
    // in drawn order solves, the run stops naming the fixed line; where sliding doesn't help, or
    // would need the ends to pass each other, it's a plain failure.
    const fixed = (extra: readonly string[]) =>
      run(
        sketch([line("l", [0, 0], [10, 0]), constrain("f", "FIX", '"localFirst" : "l"'), ...extra]),
      );
    const point = (name: string, x: number, y: number) => [
      `skPoint(sketch, "${name}", { "position" : ${mm(x, y)} });`,
      constrain(`f${name}`, "FIX", `"localFirst" : "${name}"`),
    ];
    const longer = fixed([
      constrain("n", "LENGTH", '"localFirst" : "l", "length" : 15 * millimeter'),
    ]);
    expect(longer.fault).toMatch(/fixed line l's ends slide along it/);
    const joined = fixed([
      line("m", [10, 0], [10, 5]),
      ...point("q", 15, 5),
      constrain("j", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "m.start"'),
      constrain("k", "COINCIDENT", '"localFirst" : "m.end", "localSecond" : "q"'),
      constrain("v", "VERTICAL", '"localFirst" : "m"'),
    ]);
    expect(joined.fault).toMatch(/fixed line l's ends slide along it/);
    // Off the line: sliding can't reach it.
    const off = fixed([
      ...point("q", 10, 5),
      constrain("j", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "q"'),
    ]);
    expect(off.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    // Behind the start: only a reversal reaches it.
    const behind = fixed([
      ...point("q", -5, 0),
      constrain("j", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "q"'),
    ]);
    expect(behind.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    // Sliding never tilts the line: a point can't be 10 from one fixed line and 5 from a parallel
    // one 20 away, however short the ends slide together (a near-collapsed line could otherwise
    // tilt within zeroLength of its drawn line and fake a different distance).
    const parallel = run(
      sketch([
        line("a", [0, 0], [50, 0]),
        line("b", [0, 20], [50, 20]),
        constrain("fa", "FIX", '"localFirst" : "a"'),
        constrain("fb", "FIX", '"localFirst" : "b"'),
        `skPoint(sketch, "p", { "position" : ${mm(25, 8)} });`,
        constrain(
          "d1",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "a", "length" : 10 * millimeter',
        ),
        constrain(
          "d2",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "b", "length" : 5 * millimeter',
        ),
      ]),
    );
    expect(parallel.statusEnum).toBe("SKETCH_SOLVE_FAILED");
  });

  it("stops when a tie's sides move the drawing equally, whichever way it's written", () => {
    // Review round 7: with nothing but the drawing to choose by, a tie's two sides moved it
    // equally and the line's direction or the argument order decided. Onshape's choice is
    // unknown, so the run stops naming the constraint.
    for (const [from, to] of [
      [
        [0, 0],
        [50, 0],
      ],
      [
        [50, 0],
        [0, 0],
      ],
    ] as const) {
      const r = run(
        sketch([
          line("l", [...from], [...to]),
          `skPoint(sketch, "p", { "position" : ${mm(20, 0)} });`,
          constrain("f", "FIX", '"localFirst" : "l"'),
          constrain(
            "d",
            "DISTANCE",
            '"localFirst" : "p", "localSecond" : "l", "length" : 5 * millimeter',
          ),
        ]),
      );
      expect(r.fault, `${from}->${to}`).toMatch(/DISTANCE d .*either side/);
    }
    for (const [first, second] of [
      ["p", "q"],
      ["q", "p"],
    ]) {
      const r = run(
        sketch([
          `skPoint(sketch, "p", { "position" : ${mm(0, 0)} });`,
          `skPoint(sketch, "q", { "position" : ${mm(0, 10)} });`,
          constrain("f", "FIX", '"localFirst" : "p"'),
          constrain(
            "d",
            "DISTANCE",
            `"localFirst" : "${first}", "localSecond" : "${second}", "direction" : DimensionDirection.HORIZONTAL, "length" : 10 * millimeter`,
          ),
        ]),
      );
      expect(r.fault, `${first},${second}`).toMatch(/DISTANCE d .*either side/);
    }
  });

  it("tries every flip in full, whatever order the constraints come in", () => {
    // Review round 8: the flips shared one work budget, the size of the failure's own, and a
    // flip that fails runs until its work is spent. So the flip that would solve might never run:
    // std rectangles in a row, the last drawn 1 mm too wide and held 0.5 from a fixed line on the
    // wrong side, failed outright once a PARALLEL flip used up the budget. Each flip now gets its
    // own allowance, and the outcome can't depend on how many fail before it.
    for (const count of [1, 2]) {
      const x = 10 * count + 0.5;
      const r = run(
        sketch([
          ...rectangleRow(count, 11),
          constrain("f0", "FIX", '"localFirst" : "r0.left.end"'),
          line("v", [x, -5], [x, 15]),
          constrain("fv0", "FIX", '"localFirst" : "v.start"'),
          constrain("fv1", "FIX", '"localFirst" : "v.end"'),
          constrain(
            "dist",
            "DISTANCE",
            `"localFirst" : "v", "localSecond" : "r${count - 1}.right", "length" : 0.5 * millimeter`,
          ),
        ]),
      );
      expect(`${r.fault ?? r.statusEnum}`, `${count} rectangles`).toMatch(
        /DISTANCE dist .*other side from where it's drawn/,
      );
    }
    // A point held 10 from one fixed line and 30 from another, and k more distances that agree
    // with the solution, but only once d1 is on the other side. Each of the k fails flipped.
    const pinned = (name: string, y: number) => [
      line(name, [-50, y], [50, y]),
      constrain(`${name}s`, "FIX", `"localFirst" : "${name}.start"`),
      constrain(`${name}e`, "FIX", `"localFirst" : "${name}.end"`),
    ];
    const distance = (name: string, to: string, length: number) =>
      constrain(
        name,
        "DISTANCE",
        `"localFirst" : "p", "localSecond" : "${to}", "length" : ${length} * millimeter`,
      );
    const agreeing = [0, 1, 2, 3, 4, 5].flatMap((k) => [
      ...pinned(`m${k}`, -20 - k),
      distance(`e${k}`, `m${k}`, 10 + k),
    ]);
    const held = [
      `skPoint(sketch, "p", { "position" : ${mm(0, 5)} });`,
      ...pinned("a", 0),
      ...pinned("b", 20),
      distance("d2", "b", 30),
    ];
    for (const order of [
      [...held, ...agreeing, distance("d1", "a", 10)],
      [...held, distance("d1", "a", 10), ...agreeing],
    ]) {
      const r = run(sketch(order));
      expect(`${r.fault ?? r.statusEnum}`).toMatch(
        /DISTANCE d1 .*other side from where it's drawn/,
      );
    }
  });

  it("gives a flip as much work as its group's own solve took", () => {
    // Review round 9: a fixed TRY_WORK (60) cut off flips that needed 61 to 94. A rigid zig-zag
    // chain of n lines anchored at its start has its far end on a fixed line t and a distance
    // from a fixed line r drawn on the wrong side; only that distance on the other side solves,
    // and swinging the whole chain round takes about 30 iterations.
    for (const [n, y] of [
      [50, 30],
      [50, 25],
      [30, 12],
    ] as const) {
      const d = (n - y) / 2;
      const chain = Array.from({ length: n }, (_, i) => [
        line(`l${i}`, [i % 2, i], [(i + 1) % 2, i + 1]),
        constrain(
          `len${i}`,
          "LENGTH",
          `"localFirst" : "l${i}", "length" : ${Math.SQRT2} * millimeter`,
        ),
        ...(i > 0
          ? [
              constrain(
                `c${i}`,
                "COINCIDENT",
                `"localFirst" : "l${i - 1}.end", "localSecond" : "l${i}.start"`,
              ),
            ]
          : []),
      ]).flat();
      const r = run(
        sketch([
          ...chain,
          constrain("anchor", "FIX", '"localFirst" : "l0.start"'),
          line("t", [-200, y], [200, y]),
          line("r", [-200, y + d], [200, y + d]),
          constrain("ft", "FIX", '"localFirst" : "t"'),
          constrain("fr", "FIX", '"localFirst" : "r"'),
          constrain("on", "COINCIDENT", `"localFirst" : "l${n - 1}.end", "localSecond" : "t"`),
          constrain(
            "dist",
            "DISTANCE",
            `"localFirst" : "l${n - 1}.end", "localSecond" : "r", "length" : ${d} * millimeter`,
          ),
        ]),
      );
      expect(`${r.fault ?? r.statusEnum}`, `${n} lines, t at ${y}`).toMatch(
        /DISTANCE dist .*other side from where it's drawn/,
      );
    }
  });

  it("flips from the drawing when the drawing leaves the solve nothing to follow", () => {
    // Review round 8: flips started where the failed solve stopped. A line drawn with no length
    // leaves an equation undefined there, and a point drawn on the point it's measured from gives
    // its distance no slope, so the flip settled back onto it. Either way every flip failed, where
    // the same sketch drawn a little differently stopped naming the flip.
    const pinned = (name: string, y: number) => [
      line(name, [-50, y], [50, y]),
      constrain(`${name}s`, "FIX", `"localFirst" : "${name}.start"`),
      constrain(`${name}e`, "FIX", `"localFirst" : "${name}.end"`),
    ];
    // q vertical with fixed o and 10 from it, and 9 from a fixed line 1 mm up, drawn below it:
    // only q 10 above o, on the other side of the line, solves.
    for (const y of [0, -0.5]) {
      const r = run(
        sketch([
          `skPoint(sketch, "o", { "position" : ${mm(0, 0)} });`,
          `skPoint(sketch, "q", { "position" : ${mm(0, y)} });`,
          ...pinned("l", 1),
          constrain("fo", "FIX", '"localFirst" : "o"'),
          constrain("v", "VERTICAL", '"localFirst" : "o", "localSecond" : "q"'),
          constrain(
            "oq",
            "DISTANCE",
            '"localFirst" : "o", "localSecond" : "q", "length" : 10 * millimeter',
          ),
          constrain(
            "dq",
            "DISTANCE",
            '"localFirst" : "q", "localSecond" : "l", "length" : 9 * millimeter',
          ),
        ]),
      );
      expect(`${r.fault ?? r.statusEnum}`, `q drawn at y ${y}`).toMatch(
        /DISTANCE dq .*other side from where it's drawn/,
      );
    }
    // p on a level line z from a fixed start, z 10 long, and p 2 from a fixed line 2 mm up, drawn
    // above it: on z, only the other side solves. Drawn with no length, z has no direction yet.
    for (const end of [0, 1]) {
      const r = run(
        sketch([
          line("z", [0, 0], [end, 0]),
          `skPoint(sketch, "p", { "position" : ${mm(5, 3)} });`,
          ...pinned("l", 2),
          constrain("fz", "FIX", '"localFirst" : "z.start"'),
          constrain("hz", "HORIZONTAL", '"localFirst" : "z"'),
          constrain("lz", "LENGTH", '"localFirst" : "z", "length" : 10 * millimeter'),
          constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "z"'),
          constrain(
            "d",
            "DISTANCE",
            '"localFirst" : "p", "localSecond" : "l", "length" : 2 * millimeter',
          ),
        ]),
      );
      expect(`${r.fault ?? r.statusEnum}`, `z drawn ${end} long`).toMatch(
        /DISTANCE d .*other side from where it's drawn/,
      );
    }
    // Review round 9: p on circle k (radius 13) and 3 from circle c (radius 10), both centered on
    // fixed points at the origin, with p drawn at the center: inside c is nearest, and conflicts
    // with k; outside solves. At the center every equation on p has no slope along p, only along
    // the radii, which the RADIUS constraints hold, so the flip from where the solve stopped made
    // no progress at all. A flip that makes none is tried from the drawing and its perturbations.
    for (const x of [0, 1]) {
      const r = run(
        sketch([
          `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 10 * millimeter });`,
          `skCircle(sketch, "k", { "center" : ${mm(0, 0)}, "radius" : 13 * millimeter });`,
          `skPoint(sketch, "p", { "position" : ${mm(x, 0)} });`,
          constrain("fc", "FIX", '"localFirst" : "c.center"'),
          constrain("fk", "FIX", '"localFirst" : "k.center"'),
          constrain("rc", "RADIUS", '"localFirst" : "c", "length" : 10 * millimeter'),
          constrain("rk", "RADIUS", '"localFirst" : "k", "length" : 13 * millimeter'),
          constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "k"'),
          constrain(
            "d",
            "DISTANCE",
            '"localFirst" : "p", "localSecond" : "c", "length" : 3 * millimeter',
          ),
        ]),
      );
      expect(`${r.fault ?? r.statusEnum}`, `p drawn at x ${x}`).toMatch(
        /DISTANCE d .*other side from where it's drawn/,
      );
    }
  });

  it("stops when any combination that moves the drawing as little lands elsewhere", () => {
    // Review round 8: the tie rule compared only the two least-moving combinations. Two equal
    // circles drawn on each other and TANGENT tie (either holds the other) but solve the same
    // either way; c's center drawn on a fixed line and held 5 from it ties with two mirror
    // solutions. When the two TANGENT branches on one side sorted first, the sketch silently took
    // that side, in half the constraint orders.
    const permutations = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const constraints: Record<string, string> = {
      t: constrain("t", "TANGENT", '"localFirst" : "c", "localSecond" : "d"'),
      rc: constrain("rc", "RADIUS", '"localFirst" : "c", "length" : 10 * millimeter'),
      rd: constrain("rd", "RADIUS", '"localFirst" : "d", "length" : 10 * millimeter'),
      dist: constrain(
        "dist",
        "DISTANCE",
        '"localFirst" : "c.center", "localSecond" : "l", "length" : 5 * millimeter',
      ),
    };
    const circles = {
      "drawn on each other": `{ "center" : ${mm(0, 0)}, "radius" : 10 * millimeter }`,
      blank: "{}",
    };
    for (const [drawn, fields] of Object.entries(circles))
      for (const order of permutations(Object.keys(constraints))) {
        const r = run(
          sketch([
            `skCircle(sketch, "c", ${fields});`,
            `skCircle(sketch, "d", ${fields});`,
            line("l", [-50, 0], [50, 0]),
            constrain("fl0", "FIX", '"localFirst" : "l.start"'),
            constrain("fl1", "FIX", '"localFirst" : "l.end"'),
            ...order.map((name) => constraints[name]!),
          ]),
        );
        expect(`${r.fault ?? r.statusEnum}`, `${drawn}: ${order.join(" ")}`).toMatch(
          /DISTANCE dist on either side/,
        );
      }
  });

  it("only says a fixed line's ends would slide when the whole sketch then solves", () => {
    // Review round 8: the slide solve brought along only the equations that read the fixed line's
    // ends, and set free an end FIXed again on its own. Whatever moves with the line's end was
    // left free to follow, so it "solved" sketches that fail under either rule for fixed lines.
    // Here f is fixed and a runs from f's end to a fixed w, 15 apart but 20 long.
    const fixedLine = (extra: readonly string[]) =>
      run(
        sketch([
          line("f", [0, 0], [10, 0]),
          line("a", [10, 0], [25, 0]),
          `skPoint(sketch, "w", { "position" : ${mm(25, 0)} });`,
          constrain("ff", "FIX", '"localFirst" : "f"'),
          constrain("fw", "FIX", '"localFirst" : "w"'),
          constrain("j1", "COINCIDENT", '"localFirst" : "f.end", "localSecond" : "a.start"'),
          constrain("j2", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "w"'),
          constrain("len", "LENGTH", '"localFirst" : "a", "length" : 20 * millimeter'),
          ...extra,
        ]),
      );
    // Alone, sliding f's end back 5 solves it.
    expect(fixedLine([]).fault).toMatch(/fixed line f's ends slide along it/);
    const cases = {
      "a vertical line from f's end, pinned at its top": [
        line("b", [10, 0], [10, 10]),
        constrain("fb", "FIX", '"localFirst" : "b.end"'),
        constrain("j3", "COINCIDENT", '"localFirst" : "f.end", "localSecond" : "b.start"'),
        constrain("vb", "VERTICAL", '"localFirst" : "b"'),
      ],
      "a point on f's end, kept 5 from a fixed point": [
        `skPoint(sketch, "p", { "position" : ${mm(10, 0)} });`,
        `skPoint(sketch, "z", { "position" : ${mm(10, 5)} });`,
        constrain("fz", "FIX", '"localFirst" : "z"'),
        constrain("j4", "COINCIDENT", '"localFirst" : "f.end", "localSecond" : "p"'),
        constrain(
          "dz",
          "DISTANCE",
          '"localFirst" : "p", "localSecond" : "z", "length" : 5 * millimeter',
        ),
      ],
      "f's end fixed again on its own": [constrain("ffe", "FIX", '"localFirst" : "f.end"')],
    };
    for (const [name, extra] of Object.entries(cases)) {
      const r = fixedLine(extra);
      expect(`${r.fault ?? r.statusEnum}`, name).toBe("SKETCH_SOLVE_FAILED");
    }
    // f's end also holds a fixed arc's end, which can only slide round the arc's circle: at y 0
    // that's x 10 or 20, and neither is 18 from w.
    const arc = run(
      sketch([
        line("f", [0, 0], [10, 0]),
        `skArc(sketch, "r", { "start" : ${mm(10, 0)}, "mid" : ${mm(15, 5)}, "end" : ${mm(20, 0)} });`,
        line("a", [10, 0], [10, -15]),
        `skPoint(sketch, "w", { "position" : ${mm(10, -15)} });`,
        constrain("ff", "FIX", '"localFirst" : "f"'),
        constrain("fr", "FIX", '"localFirst" : "r"'),
        constrain("fw", "FIX", '"localFirst" : "w"'),
        constrain("j0", "COINCIDENT", '"localFirst" : "f.end", "localSecond" : "r.end"'),
        constrain("j1", "COINCIDENT", '"localFirst" : "f.end", "localSecond" : "a.start"'),
        constrain("j2", "COINCIDENT", '"localFirst" : "a.end", "localSecond" : "w"'),
        constrain("len", "LENGTH", '"localFirst" : "a", "length" : 18 * millimeter'),
      ]),
    );
    expect(`${arc.fault ?? arc.statusEnum}`).toBe("SKETCH_SOLVE_FAILED");
  });

  it("solves a sided equation against a line drawn with no length", () => {
    // Review round 8, a regression from feb93e371: std draws a blank skLineSegment at the origin,
    // with no length and so no sides. Both sides of a point's distance from it, or of a tangency
    // with it, measured NaN from the drawing, neither was kept, and the sketch failed. Neither
    // side is nearer, so both count as tied and the solve picks as for any tie.
    // Each case: what's drawn and constrained besides the line, where the point or center that
    // must sit `offset` from the line ends up, and that offset.
    const cases = {
      "a point 3 from it": {
        lines: [
          `skPoint(sketch, "p", { "position" : ${mm(5, 5)} });`,
          constrain(
            "d",
            "DISTANCE",
            '"localFirst" : "p", "localSecond" : "l", "length" : 3 * millimeter',
          ),
        ],
        target: `evVertexPoint(context, { "vertex" : sketchEntityQuery(id + "sketch", EntityType.VERTEX, "p") })`,
        offset: 3,
        tie: /DISTANCE d on either side/,
      },
      "a radius 5 circle tangent to it": {
        lines: [
          `skCircle(sketch, "c", { "center" : ${mm(10, 10)}, "radius" : 5 * millimeter });`,
          constrain("r", "RADIUS", '"localFirst" : "c", "length" : 5 * millimeter'),
          constrain("t", "TANGENT", '"localFirst" : "l", "localSecond" : "c"'),
        ],
        target: `evCurveDefinition(context, { "edge" : ${edge("c")} }).coordSystem.origin`,
        offset: 5,
        tie: /TANGENT t on either side/,
      },
    };
    const blank = [
      'skLineSegment(sketch, "l", {});',
      constrain("len", "LENGTH", '"localFirst" : "l", "length" : 10 * millimeter'),
    ];
    for (const [name, { lines, target, offset, tie }] of Object.entries(cases)) {
      // With nothing else placing the line, either side solves by moving the drawing exactly as
      // much (the line can turn to put the point on either side), so it's a tie Onshape settles.
      const free = run(sketch([...blank, ...lines]));
      expect(`${free.fault ?? free.statusEnum}`, name).toMatch(tie);
      // With its end held at a fixed point 10 along x, the line runs from about the origin to
      // there (its start shares the movement), and the nearer side, above it, wins.
      const r = run(
        [
          sketch([
            ...blank,
            `skPoint(sketch, "q", { "position" : ${mm(10, 0)} });`,
            constrain("fq", "FIX", '"localFirst" : "q"'),
            constrain("lq", "COINCIDENT", '"localFirst" : "l.end", "localSecond" : "q"'),
            ...lines,
          ]),
          record("target", `${target} / millimeter`),
          at("start", "l", 0),
          at("end", "l", 1),
        ].join("\n"),
      );
      expect(r.status, `${name}: ${r.fault ?? r.statusEnum}`).toBe("OK");
      const [start, end, p] = [r.vector("start"), r.vector("end"), r.vector("target")];
      close(end, [10, 0, 0]);
      const [dx, dy] = [end[0]! - start[0]!, end[1]! - start[1]!];
      const length = Math.hypot(dx, dy);
      expect(length, name).toBeCloseTo(10, 9);
      expect((dx * (p[1]! - start[1]!) - dy * (p[0]! - start[0]!)) / length, name).toBeCloseTo(
        offset,
        9,
      );
    }
  });

  it("names a clockwise arc's ends counterclockwise, as std's hem expects", () => {
    // Drawn from (-10, 0) over the top to (10, 0): internally it starts at (10, 0), so pulling
    // "a.start" to (6, 8) leaves the arc running from (6, 8) round to (-10, 0).
    const r = run(
      [
        sketch([
          `skArc(sketch, "a", { "start" : ${mm(-10, 0)}, "mid" : ${mm(0, 10)}, "end" : ${mm(10, 0)} });`,
          `skPoint(sketch, "p", { "position" : ${mm(6, 8)} });`,
          constrain("fixArc", "FIX", '"localFirst" : "a"'),
          constrain("fixPoint", "FIX", '"localFirst" : "p"'),
          constrain("join", "COINCIDENT", '"localFirst" : "a.start", "localSecond" : "p"'),
        ]),
        at("arcStart", "a", 0),
        at("arcEnd", "a", 1),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("arcStart"), [6, 8, 0]);
    close(r.vector("arcEnd"), [-10, 0, 0]);
  });

  it("fails a conflicting sketch with SKETCH_SOLVE_FAILED, and accepts redundant constraints", () => {
    const conflict = run(
      sketch([
        line("l", [0, 0], [10, 1]),
        constrain("h", "HORIZONTAL", '"localFirst" : "l"'),
        constrain("v", "VERTICAL", '"localFirst" : "l"'),
        constrain("len", "LENGTH", '"localFirst" : "l", "length" : 10 * millimeter'),
      ]),
    );
    expect(conflict.status).toBe("ERROR");
    expect(conflict.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    expect(conflict.fault).toBeNull();

    const redundant = run(
      [
        sketch([
          `skRectangle(sketch, "r", { "firstCorner" : ${mm(0, 0)}, "secondCorner" : ${mm(30, 20)} });`,
          constrain("h1", "HORIZONTAL", '"localFirst" : "r.bottom"'),
          constrain("h2", "HORIZONTAL", '"localFirst" : "r.top"'),
        ]),
        regionArea,
      ].join("\n"),
    );
    expect(redundant.status, redundant.fault ?? redundant.exceptions).toBe("OK");
    expect(redundant.number("area")).toBeCloseTo(600, 6);
  });

  it("checks each constraint on its own, however far away unrelated geometry sits", () => {
    // A construction point a thousand kilometers out must not let 10 mm and 11 mm both pass, nor
    // stop an exact solve elsewhere in the sketch.
    const far =
      'skPoint(sketch, "far", { "position" : vector(1000000, 0) * meter, "construction" : true });';
    const conflict = run(
      sketch([
        line("l", [0, 0], [10, 0]),
        far,
        constrain("l1", "LENGTH", '"localFirst" : "l", "length" : 10 * millimeter'),
        constrain("l2", "LENGTH", '"localFirst" : "l", "length" : 11 * millimeter'),
      ]),
    );
    expect(conflict.status).toBe("ERROR");
    expect(conflict.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    const exact = run(
      [
        sketch([
          line("l1", [0, 0], tilted),
          far,
          constrain("fix", "FIX", '"localFirst" : "l1.start"'),
          constrain("h", "HORIZONTAL", '"localFirst" : "l1"'),
        ]),
        at("end", "l1", 1),
      ].join("\n"),
    );
    expect(exact.status, exact.fault ?? exact.exceptions).toBe("OK");
    close(exact.vector("end"), [tilted[0], 0, 0]);
  });

  it("grows zero-length lines and coincident points to the length or distance they need", () => {
    // Drawn with no positions, as skSetInitialGuess users do: the start is fixed at the origin.
    const grown = (direction: string) =>
      run(
        [
          sketch([
            'skLineSegment(sketch, "z", {});',
            constrain("fix", "FIX", '"localFirst" : "z.start"'),
            constrain("d", direction, '"localFirst" : "z"'),
            constrain("len", "LENGTH", '"localFirst" : "z", "length" : 10 * millimeter'),
          ]),
          at("end", "z", 1),
        ].join("\n"),
      );
    const horizontal = grown("HORIZONTAL");
    expect(horizontal.status, horizontal.fault ?? horizontal.exceptions).toBe("OK");
    close(horizontal.vector("end"), [10, 0, 0]);
    const vertical = grown("VERTICAL");
    expect(vertical.status, vertical.fault ?? vertical.exceptions).toBe("OK");
    close(vertical.vector("end"), [0, 10, 0]);

    // Two points on top of each other, 10 apart once solved; nothing says which way.
    const apart = run(
      [
        sketch([
          `skPoint(sketch, "p", { "position" : ${mm(5, 5)} });`,
          `skPoint(sketch, "q", { "position" : ${mm(5, 5)} });`,
          constrain("fix", "FIX", '"localFirst" : "p"'),
          constrain(
            "d",
            "DISTANCE",
            '"localFirst" : "p", "localSecond" : "q", "direction" : DimensionDirection.MINIMUM, "length" : 10 * millimeter',
          ),
        ]),
        record(
          "gap",
          'norm(evVertexPoint(context, { "vertex" : sketchEntityQuery(id + "sketch", EntityType.VERTEX, "q") }) - vector(5, 5, 0) * millimeter) / millimeter',
        ),
      ].join("\n"),
    );
    expect(apart.status, apart.fault ?? apart.exceptions).toBe("OK");
    expect(apart.number("gap")).toBeCloseTo(10, 9);

    // A fixed zero-length line just stays put. One that a direction constraint holds and that
    // nothing lengthens has no direction to hold, so the sketch fails.
    const fixed = run(
      sketch([
        line("z", [0, 0], [0, 0]),
        line("a", [0, 0], [10, 0]),
        constrain("fix", "FIX", '"localFirst" : "z"'),
      ]),
    );
    expect(fixed.status, fixed.fault ?? fixed.exceptions).toBe("OK");
    for (const body of [
      constrain("on", "COINCIDENT", '"localFirst" : "z", "localSecond" : "a"'),
      constrain("par", "PARALLEL", '"localFirst" : "z", "localSecond" : "a"'),
      constrain("h", "HORIZONTAL", '"localFirst" : "z"'),
    ]) {
      const r = run(sketch([line("z", [0, 0], [0, 0]), line("a", [0, 0], [10, 0]), body]));
      expect(r.statusEnum, body).toBe("SKETCH_SOLVE_FAILED");
    }

    // EQUAL to a fixed 10 mm line grows a line drawn as a point (review finding 4).
    const equal = run(
      [
        sketch([
          line("a", [0, 0], [10, 0]),
          line("z", [0, 10], [0, 10]),
          ...["a.start", "a.end", "z.start"].map((end, i) =>
            constrain(`f${i}`, "FIX", `"localFirst" : "${end}"`),
          ),
          constrain("h", "HORIZONTAL", '"localFirst" : "z"'),
          constrain("e", "EQUAL", '"localFirst" : "a", "localSecond" : "z"'),
        ]),
        at("end", "z", 1),
      ].join("\n"),
    );
    expect(equal.status, equal.fault ?? equal.exceptions).toBe("OK");
    close(equal.vector("end"), [10, 10, 0]);
  });

  it("never weakens a constraint because the drawing starts degenerate", () => {
    // Review finding 1: two lines drawn as points 10 apart, each horizontal and 10 long, can't
    // also be collinear.
    const collinear = run(
      sketch([
        line("a", [0, 0], [0, 0]),
        line("b", [0, 10], [0, 10]),
        constrain("fa", "FIX", '"localFirst" : "a.start"'),
        constrain("fb", "FIX", '"localFirst" : "b.start"'),
        constrain("cc", "COINCIDENT", '"localFirst" : "a", "localSecond" : "b"'),
        constrain("ha", "HORIZONTAL", '"localFirst" : "a"'),
        constrain("hb", "HORIZONTAL", '"localFirst" : "b"'),
        constrain("la", "LENGTH", '"localFirst" : "a", "length" : 10 * millimeter'),
        constrain("lb", "LENGTH", '"localFirst" : "b", "length" : 10 * millimeter'),
      ]),
    );
    expect(collinear.statusEnum).toBe("SKETCH_SOLVE_FAILED");
    // Review finding 2: parallel and perpendicular at once can't hold; collapsing the second line
    // to nothing isn't a way out, whether or not anything is fixed.
    for (const fixes of [["a.start", "a.end", "b.start"], []]) {
      const both = run(
        sketch([
          line("a", [0, 0], [10, 0]),
          line("b", [0, 0], [10, 0]),
          ...fixes.map((end, i) => constrain(`f${i}`, "FIX", `"localFirst" : "${end}"`)),
          constrain("p", "PARALLEL", '"localFirst" : "a", "localSecond" : "b"'),
          constrain("q", "PERPENDICULAR", '"localFirst" : "a", "localSecond" : "b"'),
        ]),
      );
      expect(both.statusEnum, fixes.join()).toBe("SKETCH_SOLVE_FAILED");
    }
    // Review finding 3: two fixed 0.001 mm lines 1e-8 rad apart at (500, 500) mm can't be at
    // angle 0 and at 1e-8 rad both; the coordinates there resolve about 1e-10 rad.
    const tiny = run(
      sketch([
        line("a", [500, 500], [500.001, 500]),
        line("b", [500, 500], [500.001, 500 + 1e-11]),
        ...["a.start", "a.end", "b.start", "b.end"].map((end, i) =>
          constrain(`f${i}`, "FIX", `"localFirst" : "${end}"`),
        ),
        constrain("a0", "ANGLE", '"localFirst" : "a", "localSecond" : "b", "angle" : 0 * radian'),
        constrain(
          "a1",
          "ANGLE",
          '"localFirst" : "a", "localSecond" : "b", "angle" : 1e-8 * radian',
        ),
      ]),
    );
    expect(tiny.statusEnum).toBe("SKETCH_SOLVE_FAILED");
  });

  it("holds an angle on a tiny line as finely as its own coordinates allow, wherever it sits", () => {
    // A 0.001 mm line at 30 degrees to a fixed 10 mm one, at the origin, 0.5 m and 5 m out. A
    // second, conflicting angle still fails out there.
    const angled = (offset: number, extra: readonly string[] = []) =>
      run(
        [
          sketch([
            line("a", [offset, offset], [offset + 10, offset]),
            line(
              "b",
              [offset, offset],
              [offset + 0.001 * Math.cos(0.55), offset + 0.001 * Math.sin(0.55)],
            ),
            ...["a.start", "a.end", "b.start"].map((end, i) =>
              constrain(`f${i}`, "FIX", `"localFirst" : "${end}"`),
            ),
            constrain(
              "angle",
              "ANGLE",
              '"localFirst" : "a", "localSecond" : "b", "angle" : 30 * degree',
            ),
            constrain("len", "LENGTH", '"localFirst" : "b", "length" : 0.001 * millimeter'),
            ...extra,
          ]),
          record(
            "direction",
            `evEdgeTangentLine(context, { "edge" : ${edge("b")}, "parameter" : 0 }).direction`,
          ),
        ].join("\n"),
      );
    for (const offset of [0, 500, 5000]) {
      const r = angled(offset);
      expect(r.status, `${offset}: ${r.fault ?? r.exceptions}`).toBe("OK");
      close(r.vector("direction"), [Math.cos(Math.PI / 6), 0.5, 0], 7);
    }
    const conflict = angled(500, [
      constrain("other", "ANGLE", '"localFirst" : "a", "localSecond" : "b", "angle" : 31 * degree'),
    ]);
    expect(conflict.statusEnum).toBe("SKETCH_SOLVE_FAILED");
  });

  it("holds coincident and dimensioned parallel lines to their alignment", () => {
    // a runs +x and b runs -x, all four ends fixed: ALIGNED can't hold, ANTI_ALIGNED already does.
    const outcome = (type: string, alignment: string, b: readonly [Mm, Mm]) =>
      run(
        sketch([
          line("a", [0, 0], [10, 0]),
          line("b", ...b),
          ...["a.start", "a.end", "b.start", "b.end"].map((end, i) =>
            constrain(`f${i}`, "FIX", `"localFirst" : "${end}"`),
          ),
          constrain(
            "c",
            type,
            `"localFirst" : "a", "localSecond" : "b", "alignment" : DimensionAlignment.${alignment}${type === "DISTANCE" ? ', "length" : 5 * millimeter' : ""}`,
          ),
        ]),
      );
    for (const [type, b] of [
      [
        "COINCIDENT",
        [
          [10, 0],
          [0, 0],
        ],
      ],
      [
        "DISTANCE",
        [
          [10, 5],
          [0, 5],
        ],
      ],
    ] as const) {
      const aligned = outcome(type, "ALIGNED", b);
      expect(aligned.statusEnum, type).toBe("SKETCH_SOLVE_FAILED");
      const anti = outcome(type, "ANTI_ALIGNED", b);
      expect(anti.status, `${type} ${anti.fault ?? anti.exceptions}`).toBe("OK");
    }
    // Where we don't know what an alignment would mean, it stops rather than being dropped.
    const perpendicular = run(
      sketch([
        line("a", [0, 0], [10, 0]),
        line("b", [0, 0], [0, 10]),
        constrain(
          "p",
          "PERPENDICULAR",
          '"localFirst" : "a", "localSecond" : "b", "alignment" : DimensionAlignment.ALIGNED',
        ),
      ]),
    );
    expect(perpendicular.fault).toMatch(/PERPENDICULAR.*alignment|alignment.*PERPENDICULAR/);
  });

  it("gets out of any degenerate start without moving what FIX holds", () => {
    const vertex = (name: string) =>
      `evVertexPoint(context, { "vertex" : sketchEntityQuery(id + "sketch", EntityType.VERTEX, "${name}") }) / millimeter`;
    // Review rounds 4 and 6: FIX holds the line exactly as drawn, through any perturbed start. A
    // free point drawn on its start, 10 from it once solved, moves; the line doesn't. Asking the
    // fixed line's start itself to move fails.
    const fixedLine = (moving: string, extra: readonly string[] = []) =>
      run(
        [
          sketch([
            line("a", [0, 0], [0, 10]),
            `skPoint(sketch, "p", { "position" : ${mm(0, 0)} });`,
            constrain("fa", "FIX", '"localFirst" : "a"'),
            ...(moving === "p" ? [] : [constrain("fp", "FIX", '"localFirst" : "p"')]),
            constrain(
              "d",
              "DISTANCE",
              '"localFirst" : "p", "localSecond" : "a.start", "length" : 10 * millimeter',
            ),
            ...extra,
          ]),
          record("start", vertex("a.start")),
          record("end", vertex("a.end")),
          record("reach", `norm(${vertex("p")})`),
        ].join("\n"),
      );
    const held = fixedLine("p");
    expect(held.status, held.fault ?? held.exceptions).toBe("OK");
    close(held.vector("start"), [0, 0, 0], 12);
    close(held.vector("end"), [0, 10, 0], 12);
    expect(held.number("reach")).toBeCloseTo(10, 9);
    expect(fixedLine("a.start").statusEnum).toBe("SKETCH_SOLVE_FAILED");

    // Review finding 2: std's rectangle drawn with no corners, then 10 by 20.
    const rectangle = run(
      [
        sketch([
          'skRectangle(sketch, "r", {});',
          constrain("l", "LENGTH", '"localFirst" : "r.left", "length" : 10 * millimeter'),
          constrain("t", "LENGTH", '"localFirst" : "r.top", "length" : 20 * millimeter'),
        ]),
        regionArea,
      ].join("\n"),
    );
    expect(rectangle.status, rectangle.fault ?? rectangle.exceptions).toBe("OK");
    expect(rectangle.number("area")).toBeCloseTo(200, 6);

    // Review finding 3: a point drawn at a fixed circle's center, put on the circle or 5 from it.
    for (const [type, fields, reach] of [
      ["COINCIDENT", "", 10],
      ["DISTANCE", ', "length" : 5 * millimeter', 5],
    ] as const) {
      const r = run(
        [
          sketch([
            `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 10 * millimeter });`,
            `skPoint(sketch, "p", { "position" : ${mm(0, 0)} });`,
            constrain("fc", "FIX", '"localFirst" : "c"'),
            constrain("pc", type, `"localFirst" : "p", "localSecond" : "c"${fields}`),
          ]),
          record("reach", `norm(${vertex("p")})`),
        ].join("\n"),
      );
      expect(r.status, `${type} ${r.fault ?? r.exceptions}`).toBe("OK");
      expect(r.number("reach"), type).toBeCloseTo(reach, 9);
    }

    // Review finding 4: an ellipse drawn with nothing, sized by its diameters.
    const ellipse = run(
      [
        sketch([
          'skEllipse(sketch, "e", {});',
          constrain("major", "MAJOR_DIAMETER", '"localFirst" : "e", "length" : 40 * millimeter'),
          constrain("minor", "MINOR_DIAMETER", '"localFirst" : "e", "length" : 20 * millimeter'),
        ]),
        regionArea,
      ].join("\n"),
    );
    expect(ellipse.status, ellipse.fault ?? ellipse.exceptions).toBe("OK");
    expect(ellipse.number("area")).toBeCloseTo(200 * Math.PI, 6);
  });

  it("reports a missing entity and invalid pairs as errors, and stops on what it can't solve", () => {
    const missing = run(
      sketch([
        line("l", [0, 0], [10, 1]),
        constrain("c", "COINCIDENT", '"localFirst" : "l.start", "localSecond" : "nope.end"'),
      ]),
    );
    expect(missing.statusEnum).toBe("SKETCH_MISSING_ENTITY");
    expect(missing.fault).toBeNull();

    const invalid = run(
      sketch([
        line("l", [0, 0], [10, 1]),
        `skCircle(sketch, "c", { "center" : ${mm(0, 20)}, "radius" : 2 * millimeter });`,
        constrain("p", "PARALLEL", '"localFirst" : "l", "localSecond" : "c"'),
      ]),
    );
    expect(invalid.statusEnum).toBe("SKETCH_PARALLEL_INPUT_ERROR");

    const projected = run(
      sketch([line("l", [0, 0], [10, 1]), constrain("p", "PROJECTED", '"localFirst" : "l"')]),
    );
    expect(projected.status).toBe("ERROR");
    expect(projected.fault).toMatch(/PROJECTED/);

    const external = run(
      sketch([
        line("l", [0, 0], [10, 1]),
        constrain(
          "on",
          "COINCIDENT",
          '"localFirst" : "l.start", "externalSecond" : qCreatedBy(makeId("Origin"), EntityType.VERTEX)',
        ),
      ]),
    );
    expect(external.fault).toMatch(/external/i);
  });
});

describe("evOwnerSketchPlane", () => {
  // Ways this goes wrong: it returns a plane for something no sketch made (a cube face) instead of
  // CANNOT_RESOLVE_PLANE; it only knows edges, not a sketch's vertices, regions or bodies; its plane
  // isn't the sketch's (origin or x axis moved, normal flipped); checkAllEntities accepts entities
  // from sketches on different planes; an entity moved after its sketch still reports the old plane.
  const tilted = "plane(vector(1, 2, 3) * millimeter, normalize(vector(0, 1, 1)), vector(1, 0, 0))";
  const owner = (name: string, query: string, extra = "") =>
    [
      `const ${name} = evOwnerSketchPlane(context, { "entity" : ${query}${extra} });`,
      record(`${name}Origin`, `${name}.origin / millimeter`),
      record(`${name}Normal`, `${name}.normal`),
      record(`${name}X`, `${name}.x`),
    ].join("\n");
  const sketchOn = (name: string, plane: string) =>
    [
      `const ${name} = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${plane} });`,
      `skRectangle(${name}, "r", { "firstCorner" : ${mm(0, 0)}, "secondCorner" : ${mm(10, 5)} });`,
      `skPoint(${name}, "p", { "position" : ${mm(20, 0)} });`,
      `skSolve(${name});`,
    ].join("\n");
  const r2 = Math.SQRT1_2;

  it("returns the sketch's plane for its edges, vertices, regions, points and bodies", () => {
    const r = run(
      [
        sketchOn("s", tilted),
        owner("edge", 'sketchEntityQuery(id + "s", EntityType.EDGE, "r.top")'),
        owner("region", 'qSketchRegion(id + "s")'),
        owner("point", 'sketchEntityQuery(id + "s", EntityType.VERTEX, "p")'),
        owner("body", 'qCreatedBy(id + "s", EntityType.BODY)'),
        owner("vertex", 'qCreatedBy(id + "s", EntityType.VERTEX)'),
        record("isSketch", 'isIdForSketch(context, id + "s")'),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.flag("isSketch")).toBe(true);
    for (const name of ["edge", "region", "point", "body", "vertex"]) {
      close(r.vector(`${name}Origin`), [1, 2, 3]);
      close(r.vector(`${name}Normal`), [0, r2, r2]);
      close(r.vector(`${name}X`), [1, 0, 0]);
    }
  });

  it("refuses what no sketch made, and planes that differ under checkAllEntities", () => {
    const cube =
      'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
    const level = "plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0))";
    const raised = "plane(vector(5, 5, 7) * millimeter, vector(0, 0, -1), vector(0, 1, 0))";
    const both =
      'qUnion([qCreatedBy(id + "a", EntityType.EDGE), qCreatedBy(id + "b", EntityType.EDGE)])';
    const r = run(
      [
        cube,
        sketchOn("a", level),
        sketchOn("b", raised),
        sketchOn("c", "plane(vector(3, 4, 0) * millimeter, vector(0, 0, -1), vector(0, 1, 0))"),
        record(
          "cubeFace",
          'try silent(evOwnerSketchPlane(context, { "entity" : qCreatedBy(id + "cube", EntityType.FACE) })) == undefined',
        ),
        record("cubeIsSketch", 'isIdForSketch(context, id + "cube")'),
        owner("first", both),
        record(
          "mixed",
          `try silent(evOwnerSketchPlane(context, { "entity" : ${both}, "checkAllEntities" : true })) == undefined`,
        ),
        owner(
          "coplanar",
          'qUnion([qCreatedBy(id + "a", EntityType.EDGE), qCreatedBy(id + "c", EntityType.EDGE)])',
          ', "checkAllEntities" : true',
        ),
        'const error = try(evOwnerSketchPlane(context, { "entity" : qCreatedBy(id + "cube", EntityType.FACE) }));',
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.flag("cubeFace")).toBe(true);
    expect(r.flag("cubeIsSketch")).toBe(false);
    expect(r.flag("mixed")).toBe(true);
    close(r.vector("firstOrigin"), [0, 0, 0]);
    close(r.vector("firstNormal"), [0, 0, 1]);
    close(r.vector("coplanarOrigin"), [0, 0, 0]);
    expect(r.exceptions).toMatch(/CANNOT_RESOLVE_PLANE/);
  });

  it("stops rather than report the old plane for a sketch entity moved after its sketch", () => {
    const r = run(
      [
        sketchOn("s", "plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0))"),
        'opTransform(context, id + "lift", { "bodies" : qCreatedBy(id + "s", EntityType.BODY), "transform" : transform(vector(0, 0, 5) * millimeter) });',
        'evOwnerSketchPlane(context, { "entity" : sketchEntityQuery(id + "s", EntityType.EDGE, "r.top") });',
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault).toMatch(/moved/);
  });
});

describe("sketch topology", () => {
  // Std documents: every sketch curve becomes a WIRE body ("a sketch line or curve"), queried per
  // sketch entity down to the body (sketchEntityQuery); points and circle centers become POINT
  // bodies; regions are SHEET bodies whose edges and vertices are sketch entities too; wire and
  // point bodies come from the sketch's "wireOp" operation (queryVariable.fs); endpoints are named
  // "<curve>.start" / "<curve>.end" (curvePattern.fs, sheetMetalHem.fs).
  // Ways this goes wrong: all curves share one wire body, so sketchEntityQuery(BODY) finds nothing;
  // endpoints carry no names, or an arc's carry its drawn order; circle centers are missing;
  // qCreatedBy(sketch + "wireOp") finds nothing; construction curves have unflagged vertices.
  const count = (name: string, query: string) =>
    record(name, `size(evaluateQuery(context, ${query}))`);
  const created = (type: string, op = "") =>
    `qCreatedBy(id + "sketch"${op ? ` + "${op}"` : ""}, EntityType.${type})`;
  const entity = (type: string, name: string) =>
    `sketchEntityQuery(id + "sketch", EntityType.${type}, "${name}")`;
  const point = (name: string, query: string) =>
    record(name, `evVertexPoint(context, { "vertex" : ${query} }) / millimeter`);

  it("makes a wire body per curve and a point body per point and center, named per entity", () => {
    const r = run(
      [
        sketch([
          `skRectangle(sketch, "r", { "firstCorner" : ${mm(0, 0)}, "secondCorner" : ${mm(30, 20)} });`,
          `skCircle(sketch, "c", { "center" : ${mm(50, 10)}, "radius" : 5 * millimeter });`,
          `skArc(sketch, "a", { "start" : ${mm(-5, 50)}, "mid" : ${mm(0, 55)}, "end" : ${mm(5, 50)} });`,
          `skPoint(sketch, "p", { "position" : ${mm(70, 0)} });`,
          line("k", [100, 0], [110, 0], ', "construction" : true'),
        ]),
        count("wires", `qBodyType(${created("BODY")}, BodyType.WIRE)`),
        count("points", `qBodyType(${created("BODY")}, BodyType.POINT)`),
        count("sheets", `qBodyType(${created("BODY")}, BodyType.SHEET)`),
        count("edges", created("EDGE")),
        count("wireEdges", created("EDGE", "wireOp")),
        count("vertices", created("VERTEX")),
        count("wireVertices", created("VERTEX", "wireOp")),
        count(
          "regionEdges",
          `qBodyType(qSketchFilter(${created("EDGE")}, SketchObject.YES), BodyType.SHEET)`,
        ),
        count("leftBody", `qBodyType(${entity("BODY", "r.left")}, BodyType.WIRE)`),
        count("leftEdge", entity("EDGE", "r.left")),
        count("leftAll", `sketchEntityQuery(id + "sketch", undefined, "r.left")`),
        point("topStart", entity("VERTEX", "r.top.start")),
        point("topEnd", entity("VERTEX", "r.top.end")),
        point("arcStart", entity("VERTEX", "a.start")),
        point("arcEnd", entity("VERTEX", "a.end")),
        point("circleCenter", entity("VERTEX", "c.center")),
        point("arcCenter", entity("VERTEX", "a.center")),
        point("p", entity("VERTEX", "p")),
        count(
          "constructionBodies",
          `qConstructionFilter(${created("BODY")}, ConstructionObject.YES)`,
        ),
        count(
          "constructionVertices",
          `qConstructionFilter(${created("VERTEX")}, ConstructionObject.YES)`,
        ),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    // Rectangle sides, circle, arc, construction line; point, circle center, arc center; one sheet.
    expect([r.number("wires"), r.number("points"), r.number("sheets")]).toEqual([7, 3, 1]);
    // 7 wire edges, plus the regions' 4 rectangle edges and 1 circle edge.
    expect([r.number("wireEdges"), r.number("edges"), r.number("regionEdges")]).toEqual([7, 12, 5]);
    // Unshared endpoints: 8 rectangle, 2 arc, 2 construction; 3 points; 4 region corners.
    expect([r.number("wireVertices"), r.number("vertices")]).toEqual([15, 19]);
    // With no entity type, the curve's body and its edge ("`undefined` to match both").
    expect([r.number("leftBody"), r.number("leftEdge"), r.number("leftAll")]).toEqual([1, 1, 2]);
    close(r.vector("topStart"), [0, 0, 0]);
    close(r.vector("topEnd"), [30, 0, 0]);
    // Drawn clockwise, so its counterclockwise start is the drawn end.
    close(r.vector("arcStart"), [5, 50, 0]);
    close(r.vector("arcEnd"), [-5, 50, 0]);
    close(r.vector("circleCenter"), [50, 10, 0]);
    close(r.vector("arcCenter"), [0, 50, 0]);
    close(r.vector("p"), [70, 0, 0]);
    expect([r.number("constructionBodies"), r.number("constructionVertices")]).toEqual([1, 2]);
  });
});

describe("std's cone sketch", () => {
  // std's fCone draws its profile as four lines; a pointed cone (top radius 0) makes the second a
  // zero-length segment at the apex, which Onshape accepts. Ways this goes wrong: the whole sketch
  // fails as invalid input; the empty segment becomes a degenerate edge that breaks the region;
  // genuinely impossible entities (an ellipse with no minor radius) get waved through too.
  // fCone then finds its axis with sketchEntityQuery(sketchId + "wireOp", ...), which Query.ts
  // doesn't resolve yet, so this test revolves the region itself, as fCone does.
  const cone = (top: number) => {
    const profile: readonly Mm[] = [
      [0, 0],
      [0, 20],
      [top, 20],
      [10, 0],
    ];
    return [
      sketch(profile.map((point, i) => line(`line.${i}`, point, profile[(i + 1) % 4]!))),
      record(
        "wireEdges",
        'size(evaluateQuery(context, qCreatedBy(id + "sketch" + "wireOp", EntityType.EDGE)))',
      ),
      regionArea,
      `opRevolve(context, id + "revolve", { "entities" : qSketchRegion(id + "sketch"), "axis" : evLine(context, { "edge" : ${edge("line.0")} }), "angleForward" : 2 * PI });`,
      record(
        "volume",
        'evVolume(context, { "entities" : qCreatedBy(id + "revolve", EntityType.BODY) }) / millimeter^3',
      ),
    ].join("\n");
  };

  it("revolves a pointed cone: the zero-length apex segment makes no edge", () => {
    const pointed = run(cone(0));
    expect(pointed.status, pointed.fault ?? pointed.exceptions).toBe("OK");
    expect(pointed.number("wireEdges")).toBe(3);
    expect(pointed.number("area")).toBeCloseTo(100, 6);
    expect(pointed.number("volume")).toBeCloseTo((2000 * Math.PI) / 3, 5);
    const frustum = run(cone(5));
    expect(frustum.status, frustum.fault ?? frustum.exceptions).toBe("OK");
    expect(frustum.number("volume")).toBeCloseTo((3500 * Math.PI) / 3, 5);
  });

  it("sizes a circle drawn without a center or radius, like other entities drawn empty", () => {
    // std's skCircle allows both to be missing (for initial-guess data). As for points, lines and
    // ellipses, a missing center is the origin and a missing radius 0, so constraints can size it.
    const sized = (definition: string, extra: readonly string[]) =>
      run([sketch([`skCircle(sketch, "k", ${definition});`, ...extra]), regionArea].join("\n"));
    const radius = constrain("r", "RADIUS", '"localFirst" : "k", "length" : 5 * millimeter');
    const noRadius = sized(`{ "center" : ${mm(0, 0)} }`, [radius]);
    expect(noRadius.status, noRadius.fault ?? noRadius.exceptions).toBe("OK");
    expect(noRadius.number("area")).toBeCloseTo(25 * Math.PI, 6);
    const noCenter = sized('{ "radius" : 5 * millimeter }', []);
    expect(noCenter.status, noCenter.fault ?? noCenter.exceptions).toBe("OK");
    expect(noCenter.number("area")).toBeCloseTo(25 * Math.PI, 6);
    expect(sized("{}", []).statusEnum).toBe("SKETCH_INPUT_INVALID");
    // A point on it doesn't size it either (review round 6): still never sized, not a conflict.
    const pointOn = sized("{}", [
      `skPoint(sketch, "p", { "position" : ${mm(0, 0)} });`,
      constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "k"'),
    ]);
    expect(pointOn.statusEnum).toBe("SKETCH_INPUT_INVALID");
  });

  it("still refuses entities that can't be geometry", () => {
    const flat = run(
      sketch([
        `skEllipse(sketch, "e", { "center" : ${mm(0, 0)}, "majorRadius" : 10 * millimeter });`,
      ]),
    );
    expect(flat.statusEnum).toBe("SKETCH_INPUT_INVALID");
  });

  it("records the wire operation on every sketch curve, body and end it names", () => {
    // What sketchEntityQuery(sketchId + "wireOp", ...) has to match: each entity the query names by
    // sketch entity id is created by the sketch's "wireOp" operation, while its sketch stays the
    // sketch's own id.
    const r = run(
      sketch([
        line("line.0", [0, 0], [10, 0]),
        `skPoint(sketch, "p", { "position" : ${mm(5, 5)} });`,
      ]),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    const named = ordered(r.geometry, (entity) => entity.sketch?.entityId != null);
    expect(named.map((entity) => entity.sketch!.entityId).sort()).toEqual(
      ["line.0", "line.0", "line.0.end", "line.0.start", "p", "p"].sort(),
    );
    for (const entity of named) {
      expect(entity.createdBy).toEqual(["Feature1", "sketch", "wireOp"]);
      expect(entity.sketch!.sketchId).toEqual(["Feature1", "sketch"]);
    }
  });
});

describe("sketch planes", () => {
  // Coordinator follow-up: on some tilted planes a 2 mm circle's region came out as the 2016 mm
  // square sheet regions are cut from, because the outside face was told apart by its world-axis
  // bounding box, which on a tilted plane never reaches the sheet's rim. Every plane orientation
  // must give the same regions: swept over the axes, the diagonals, the reported normal and
  // seeded random directions, each with std's default x axis (perpendicularVector).
  it("cuts the same regions on a plane facing any way", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const normals = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
      [1, -1, 1],
      [-1, -1, -1],
      [-1, 2, 2],
      [13.2, 26.6, 26.6],
      ...Array.from({ length: 25 }, () => [random(), random(), random()]),
    ];
    const checks = normals.map((n, i) => {
      const plane = `plane(vector(${-6.6 + i}, -13.3, ${-13.3 + 2 * i}) * millimeter, normalize(vector(${n.join(", ")})))`;
      const name = `id + "s${i}"`;
      const region = (point: string) => `qContainsPoint(qSketchRegion(${name}), ${point})`;
      const facts = (point: string) =>
        `evArea(context, { "entities" : ${region(point)} }) / millimeter^2, norm(evApproximateCentroid(context, { "entities" : ${region(point)} }) - ${point}) / millimeter`;
      return [
        `const p${i} = ${plane};`,
        `const k${i} = newSketchOnPlane(context, ${name}, { "sketchPlane" : p${i} });`,
        `skCircle(k${i}, "c", { "center" : ${mm(0, 0)}, "radius" : 2 * millimeter });`,
        `skRectangle(k${i}, "r", { "firstCorner" : ${mm(5, 5)}, "secondCorner" : ${mm(9, 8)} });`,
        `skSolve(k${i});`,
        record(
          `n${i}`,
          `[size(evaluateQuery(context, qSketchRegion(${name}))), evArea(context, { "entities" : qCreatedBy(${name}, EntityType.FACE) }) / millimeter^2, ${facts(`p${i}.origin`)}, ${facts(`planeToWorld(p${i}, ${mm(7, 6.5)})`)}]`,
        ),
      ].join("\n");
    });
    const r = run(checks.join("\n"));
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    normals.forEach((n, i) => {
      const [regions, total, circle, circleOff, rectangle, rectangleOff] = r.vector(`n${i}`);
      const label = `normal ${n.map((c) => c.toFixed(3))}`;
      expect(regions, label).toBe(2);
      expect(total, label).toBeCloseTo(4 * Math.PI + 12, 6);
      expect(circle, label).toBeCloseTo(4 * Math.PI, 6);
      expect(circleOff, label).toBeLessThan(1e-6);
      expect(rectangle, label).toBeCloseTo(12, 6);
      expect(rectangleOff, label).toBeLessThan(1e-6);
    });
  });
});

describe("sketch entities", () => {
  // Ways these go wrong: an ellipse's radii or axis swapped or ignored (or OpenCascade refusing a
  // major radius shorter than the minor one); elliptical-arc parameters read as radians instead of
  // period 1, or run clockwise; a Bézier interpolating its control points; a conic's rho mapped to
  // the wrong weight; a fit spline missing its points, its parameters or its end derivative; an
  // initial guess ignored, read in the wrong order, or guessed at for a format nobody documented;
  // std's internal spline entities silently drawing nothing; constraints on curves the solver can't
  // move treating them as fixed; ellipse dimensions ignored; regions not closing with these curves.
  const areaOf = (lines: readonly string[]) => run([sketch(lines), regionArea].join("\n"));
  const onEdge = (name: string, entity: string, points: readonly [number, number][]) =>
    record(
      name,
      `size(evaluateQuery(context, qUnion([${points
        .map(([x, y]) => `qContainsPoint(${edge(entity)}, vector(${x}, ${y}, 0) * millimeter)`)
        .join(", ")}]))) == 1`,
    );
  const vertexAt = (name: string, entity: string) =>
    record(
      name,
      `evVertexPoint(context, { "vertex" : sketchEntityQuery(id + "sketch", EntityType.VERTEX, "${entity}") }) / millimeter`,
    );

  it("extrudes an ellipse to pi a b h, whichever radius is longer", () => {
    const r = run(
      [
        sketch([
          `skEllipse(sketch, "e", { "center" : ${mm(0, 0)}, "majorAxis" : normalize(vector(1, 1)), "majorRadius" : 20 * millimeter, "minorRadius" : 10 * millimeter });`,
          `skEllipse(sketch, "tall", { "center" : ${mm(100, 0)}, "majorAxis" : vector(1, 0), "majorRadius" : 10 * millimeter, "minorRadius" : 20 * millimeter });`,
        ]),
        regionArea,
        onEdge("tallOnEdge", "tall", [
          [110, 0],
          [100, 20],
          [90, 0],
        ]),
        onEdge("tiltedOnEdge", "e", [[20 * Math.SQRT1_2, 20 * Math.SQRT1_2]]),
        vertexAt("center", "tall.center"),
        'extrude(context, id + "extrude", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 5 * millimeter });',
        record(
          "volume",
          'evVolume(context, { "entities" : qCreatedBy(id + "extrude", EntityType.BODY) }) / millimeter^3',
        ),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.number("area")).toBeCloseTo(2 * Math.PI * 200, 6);
    expect(r.flag("tallOnEdge")).toBe(true);
    expect(r.flag("tiltedOnEdge")).toBe(true);
    close(r.vector("center"), [100, 0, 0]);
    expect(r.number("volume")).toBeCloseTo(2 * Math.PI * 200 * 5, 5);
  });

  it("runs an elliptical arc counterclockwise over parameters of period 1", () => {
    // The upper half of a 20 x 10 ellipse closed by its major axis: half of pi a b.
    const r = run(
      [
        sketch([
          `skEllipticalArc(sketch, "half", { "center" : ${mm(0, 0)}, "majorAxis" : vector(1, 0), "majorRadius" : 20 * millimeter, "minorRadius" : 10 * millimeter, "startParameter" : 0, "endParameter" : 0.5 });`,
          line("chord", [-20, 0], [20, 0]),
          `skEllipticalArc(sketch, "quarter", { "center" : ${mm(0, 50)}, "majorAxis" : vector(1, 0), "majorRadius" : 20 * millimeter, "minorRadius" : 10 * millimeter, "startParameter" : 0, "endParameter" : 0.25 });`,
          // The "major" radius may be the shorter one; parameter 0 is still along majorAxis.
          `skEllipticalArc(sketch, "short", { "center" : ${mm(0, 100)}, "majorAxis" : vector(1, 0), "majorRadius" : 10 * millimeter, "minorRadius" : 20 * millimeter, "startParameter" : 0, "endParameter" : 0.25 });`,
        ]),
        regionArea,
        vertexAt("start", "half.start"),
        vertexAt("end", "half.end"),
        vertexAt("quarterEnd", "quarter.end"),
        vertexAt("shortStart", "short.start"),
        vertexAt("shortEnd", "short.end"),
        onEdge("shortMiddle", "short", [[10 * Math.SQRT1_2, 100 + 20 * Math.SQRT1_2]]),
        onEdge("top", "half", [[0, 10]]),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.number("area")).toBeCloseTo(Math.PI * 100, 6);
    close(r.vector("start"), [20, 0, 0]);
    close(r.vector("end"), [-20, 0, 0]);
    close(r.vector("quarterEnd"), [0, 60, 0]);
    close(r.vector("shortStart"), [10, 100, 0]);
    close(r.vector("shortEnd"), [0, 120, 0]);
    expect(r.flag("shortMiddle")).toBe(true);
    expect(r.flag("top")).toBe(true);
  });

  it("draws Bézier curves through their end poles, and conics by rho", () => {
    // Cubic (0,0) (0,30) (30,30) (30,0) over its chord: integral of y dx = 16200 / 30 = 540.
    const bezier = areaOf([
      `skBezier(sketch, "b", { "points" : [${mm(0, 0)}, ${mm(0, 30)}, ${mm(30, 30)}, ${mm(30, 0)}] });`,
      line("chord", [30, 0], [0, 0]),
    ]);
    expect(bezier.status, bezier.fault ?? bezier.exceptions).toBe("OK");
    expect(bezier.number("area")).toBeCloseTo(540, 6);
    // rho 0.5 is a parabola: 2/3 of the control triangle (0,0) (10,10) (20,0), whose area is 100.
    const parabola = areaOf([
      `skConicSegment(sketch, "c", { "start" : ${mm(0, 0)}, "controlPoint" : ${mm(10, 10)}, "end" : ${mm(20, 0)}, "rho" : 0.5 });`,
      line("chord", [20, 0], [0, 0]),
    ]);
    expect(parabola.number("area")).toBeCloseTo(200 / 3, 6);
    // rho sqrt(2) - 1 (weight cos 45 degrees) is an exact quarter circle of radius 10.
    const quarter = areaOf([
      `skConicSegment(sketch, "c", { "start" : ${mm(10, 0)}, "controlPoint" : ${mm(10, 10)}, "end" : ${mm(0, 10)}, "rho" : sqrt(2) - 1 });`,
      line("up", [0, 10], [0, 0]),
      line("across", [0, 0], [10, 0]),
    ]);
    expect(quarter.number("area")).toBeCloseTo(25 * Math.PI, 6);
  });

  it("cuts the region of a spline that swings far past its points", () => {
    // Review round 9: the region sheet was sized from the entities' points, but a fit spline
    // swings past them. Through (0, 0) and (10, 0) mm and leaving the start at 10 m along y, it
    // reaches 1.48 m up where the sheet reached 1.04 m, and its region silently vanished. Closed
    // by a line, the region is 1000 mm2 per meter of start derivative.
    for (const d of [1, 10, 20]) {
      const r = run(
        [
          sketch([
            `skFitSpline(sketch, "s", { "points" : [${mm(0, 0)}, ${mm(10, 0)}], "startDerivative" : vector(0, ${d}) * meter });`,
            line("l", [0, 0], [10, 0]),
          ]),
          record("regions", 'size(evaluateQuery(context, qSketchRegion(id + "sketch")))'),
          regionArea,
        ].join("\n"),
      );
      expect(r.status, r.fault ?? r.exceptions).toBe("OK");
      expect(r.number("regions"), `${d} m`).toBe(1);
      expect(r.number("area"), `${d} m`).toBeCloseTo(1000 * d, 3);
    }
  });

  it("fits splines through their points, with parameters, end derivatives and closing", () => {
    const fit = `skFitSpline(sketch, "s", { "points" : [${mm(0, 0)}, ${mm(10, 10)}, ${mm(20, 0)}], "parameters" : [0, 0.2, 1], "startDerivative" : vector(0, 30) * millimeter });`;
    const r = run(
      [
        sketch([
          fit,
          `skFitSpline(sketch, "loop", { "points" : [${mm(50, 0)}, ${mm(60, 10)}, ${mm(50, 20)}, ${mm(40, 10)}, ${mm(50, 0)}] });`,
        ]),
        onEdge("through", "s", [
          [0, 0],
          [10, 10],
          [20, 0],
        ]),
        // The spline's own parameter: edge parameters measure arc length unless told otherwise.
        record(
          "atParameter",
          `evEdgeTangentLine(context, { "edge" : ${edge("s")}, "parameter" : 0.2, "arcLengthParameterization" : false }).origin / millimeter`,
        ),
        record(
          "startDirection",
          `evEdgeTangentLine(context, { "edge" : ${edge("s")}, "parameter" : 0 }).direction`,
        ),
        record("regions", 'size(evaluateQuery(context, qSketchRegion(id + "sketch")))'),
        vertexAt("end", "s.end"),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.flag("through")).toBe(true);
    close(r.vector("atParameter"), [10, 10, 0]);
    close(r.vector("startDirection"), [0, 1, 0]);
    expect(r.number("regions")).toBe(1);
    close(r.vector("end"), [20, 0, 0]);
  });

  it("places entities from skSetInitialGuess, in the formats Onshape uses", () => {
    // Onshape's own example (forum.onshape.com/discussion/6438): center, unit major axis, major and
    // minor radius in meters, then start and end angles in radians.
    const [c, s, half] = [Math.cos(3), Math.sin(3), Math.SQRT1_2];
    const r = run(
      [
        sketch([
          'skEllipticalArc(sketch, "ellipticalArc", {});',
          'skLineSegment(sketch, "line", {});',
          'skSetInitialGuess(sketch, { "ellipticalArc" : [2, 0, sqrt(2) / 2, sqrt(2) / 2, 1, 0.5, 0, 3], "line" : [0.01, 0, 1, 0, 0, 0.02] });',
        ]),
        vertexAt("start", "ellipticalArc.start"),
        vertexAt("end", "ellipticalArc.end"),
        record("length", `evLength(context, { "entities" : ${edge("line")} }) / millimeter`),
        vertexAt("lineEnd", "line.end"),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("start"), [(2 + half) * 1000, half * 1000, 0], 6);
    close(
      r.vector("end"),
      [(2 + c * half - 0.5 * s * half) * 1000, (c * half + 0.5 * s * half) * 1000, 0],
      6,
    );
    expect(r.number("length")).toBeCloseTo(20, 9);
    close(r.vector("lineEnd"), [30, 0, 0]);

    const circle = run(
      sketch([
        `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 1 * millimeter });`,
        'skSetInitialGuess(sketch, { "c" : [0, 0, 1, 0, 0.005, 0] });',
      ]),
    );
    expect(circle.fault).toMatch(/initial guess/);
  });

  it("stops on std's internal spline entities and on constraints it can't solve for these curves", () => {
    for (const builtin of [
      "skSpline",
      "skSplineSegment",
      "skInterpolatedSpline",
      "skInterpolatedSplineSegment",
    ]) {
      const r = run(sketch([`${builtin}(sketch, "s", {});`]));
      expect(r.fault, builtin).toMatch(new RegExp(builtin));
    }
    const onBezier = run(
      sketch([
        `skBezier(sketch, "b", { "points" : [${mm(0, 0)}, ${mm(0, 30)}, ${mm(30, 0)}] });`,
        line("l", [30, 1], [40, 0]),
        constrain("join", "COINCIDENT", '"localFirst" : "l.start", "localSecond" : "b.end"'),
      ]),
    );
    expect(onBezier.fault).toMatch(/b \(a Bézier curve\)/);
    const tangentEllipse = run(
      sketch([
        `skEllipse(sketch, "e", { "center" : ${mm(0, 0)}, "majorRadius" : 20 * millimeter, "minorRadius" : 10 * millimeter });`,
        line("l", [-30, 12], [30, 12]),
        constrain("t", "TANGENT", '"localFirst" : "e", "localSecond" : "l"'),
      ]),
    );
    expect(tangentEllipse.fault).toMatch(/TANGENT.*ellipse/);
  });

  it("solves ellipse diameters, concentricity and a horizontal major axis", () => {
    // Drawn 10 degrees off, centered at (3, 4), radii 15 and 8: it ends up horizontal, centered on
    // the fixed circle at the origin, 40 by 20.
    const axis = `vector(cos(10 * degree), sin(10 * degree))`;
    const r = run(
      [
        sketch([
          `skCircle(sketch, "c", { "center" : ${mm(0, 0)}, "radius" : 2 * millimeter });`,
          `skEllipse(sketch, "e", { "center" : ${mm(3, 4)}, "majorAxis" : ${axis}, "majorRadius" : 15 * millimeter, "minorRadius" : 8 * millimeter });`,
          constrain("fix", "FIX", '"localFirst" : "c"'),
          constrain("con", "CONCENTRIC", '"localFirst" : "e", "localSecond" : "c"'),
          constrain("major", "MAJOR_DIAMETER", '"localFirst" : "e", "length" : 40 * millimeter'),
          constrain("minor", "MINOR_DIAMETER", '"localFirst" : "e", "length" : 20 * millimeter'),
          constrain("level", "HORIZONTAL", '"localFirst" : "e"'),
        ]),
        onEdge("onEdge", "e", [
          [20, 0],
          [0, 10],
          [-20, 0],
        ]),
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    expect(r.flag("onEdge")).toBe(true);
  });
});

describe("redundant constraints", () => {
  // Review round 10: the round 9 fix judged redundancy once, at the drawing, in constraint order,
  // and only where equations didn't outnumber unknowns. A rectangle with more equations than
  // unknowns still collapsed (1.12 mm3 for 9813), the order of std's rectangle set plus one
  // HORIZONTAL decided whether a 3 mm skew solved 33 or 0.34 mm wide, and a failed reduced solve
  // was final, so 17 random sketches the solver before it solved failed. Each Gauss-Newton step
  // now leaves out the equations nearly dependent where it stands, chosen by size, not order.
  // Solved on the solver alone: the orders run to the hundreds.
  type Corner = readonly [number, number];
  const names = ["b", "r", "t", "l"];
  const ref = (name: string): SketchRef => {
    const [entity, part] = name.split(".");
    return { entity: entity!, part: part === "start" || part === "end" ? part : null };
  };
  const constraint = (type: string, first: string, second: string | null = null) => ({
    id: `${type}-${first}-${second}`,
    type,
    first: ref(first),
    second: second ? ref(second) : null,
    mirror: null,
    length: null,
    angle: null,
    direction: "MINIMUM" as const,
    alignment: "UNSPECIFIED" as const,
  });
  /** Four lines drawn through `corners` (millimeters), joined corner to corner. */
  const quad = (corners: readonly Corner[]) => ({
    entities: corners.map(
      (p, i): SketchEntity => ({
        kind: "line",
        id: names[i]!,
        construction: false,
        start: [p[0] * 1e-3, p[1] * 1e-3],
        end: [corners[(i + 1) % 4]![0] * 1e-3, corners[(i + 1) % 4]![1] * 1e-3],
      }),
    ),
    joins: names.map((n, i) => constraint("COINCIDENT", `${n}.end`, `${names[(i + 1) % 4]}.start`)),
  });
  const skewed = (skew: number): Corner[] => [
    [0, 0],
    [30, skew],
    [30 + skew, 20],
    [-skew, 20 - skew],
  ];
  /** Every corner, in millimeters, of a solve that must succeed. */
  const corners = (entities: SketchEntity[], constraints: SketchConstraint[]) => {
    const solved = solveConstraints(entities, constraints);
    expect(solved).not.toBeNull();
    return solved!
      .flatMap((e) => (e.kind === "line" ? [...e.start, ...e.end] : []))
      .map((v) => v * 1e3);
  };
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );
  const furthest = (p: readonly number[], q: readonly number[]) =>
    Math.max(...p.map((v, i) => Math.abs(v - q[i]!)));

  it("solves std's rectangle with a redundant HORIZONTAL the same in every order", () => {
    for (const skew of [1, 2, 3, 4]) {
      const { entities, joins } = quad(skewed(skew));
      const set = [
        constraint("PARALLEL", "l", "r"),
        constraint("PARALLEL", "t", "b"),
        constraint("VERTICAL", "l"),
        constraint("HORIZONTAL", "t"),
        constraint("HORIZONTAL", "b"),
      ];
      // The nearest axis-aligned rectangle averages each side's drawn corners.
      const h = skew / 2;
      const nearest = [
        -h,
        h,
        30 + h,
        h,
        30 + h,
        h,
        30 + h,
        20 - h,
        30 + h,
        20 - h,
        -h,
        20 - h,
      ].concat([-h, 20 - h, -h, h]);
      const first = corners(entities, [...joins, ...set]);
      expect(furthest(first, nearest), `${skew} mm`).toBeLessThan(0.05);
      for (const order of permutations(set))
        expect(furthest(corners(entities, [...joins, ...order]), first)).toBeLessThan(1e-6);
    }
  });

  it("solves a rectangle held square at all four corners the same in every order", () => {
    for (const skew of [1, 3, 6]) {
      const { entities, joins } = quad(skewed(skew));
      const square = names.map((n, i) => constraint("PERPENDICULAR", n, names[(i + 1) % 4]!));
      const three = corners(entities, [...joins, ...square.slice(0, 3)]);
      for (const order of permutations(square))
        expect(furthest(corners(entities, [...joins, ...order]), three), `${skew} mm`).toBeLessThan(
          0.05,
        );
    }
  });

  it("solves with more equations than unknowns as it does without the redundant ones", () => {
    const hv = [
      constraint("HORIZONTAL", "b"),
      constraint("VERTICAL", "r"),
      constraint("HORIZONTAL", "t"),
      constraint("VERTICAL", "l"),
    ];
    const square = names.map((n, i) => constraint("PERPENDICULAR", n, names[(i + 1) % 4]!));
    // A 40 x 25 rectangle drawn 1 mm off with a corner fixed, H and V on every side and square at
    // every corner: 16 equations for 14 unknowns.
    const anchored = quad([
      [0, 0],
      [40, 1],
      [41, 25],
      [1, 24],
    ]);
    const fixed = [...anchored.joins, constraint("FIX", "b.start"), ...hv];
    expect(
      furthest(
        corners(anchored.entities, [...fixed, ...square]),
        corners(anchored.entities, fixed),
      ),
    ).toBeLessThan(1e-6);
    // H and V on every side, both PARALLELs and three PERPENDICULARs: 17 for 16.
    for (const skew of [0.5, 1]) {
      const { entities, joins } = quad(skewed(skew));
      const parallel = [
        ...joins,
        ...hv,
        constraint("PARALLEL", "b", "t"),
        constraint("PARALLEL", "l", "r"),
      ];
      expect(
        furthest(
          corners(entities, [...parallel, ...square.slice(0, 3)]),
          corners(entities, parallel),
        ),
        `${skew} mm`,
      ).toBeLessThan(1e-6);
    }
  });

  it("solves the random sketches the round 9 solver failed, moving them no more than before", () => {
    // Quadrilaterals and hexagons drawn a little off with random constraint sets, from the review's
    // random comparison; the solver before round 9 solved each, moving the drawing `parentMoved`.
    const fixtures = JSON.parse(
      NodeFS.readFileSync(new URL("sketch-redundant.fixtures.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      parentMoved: number;
      entities: SketchEntity[];
      constraints: SketchConstraint[];
    }[];
    expect(fixtures).toHaveLength(17);
    const flat = (entities: SketchEntity[]) =>
      entities.flatMap((e) => (e.kind === "line" ? [...e.start, ...e.end] : []));
    for (const { name, parentMoved, entities, constraints } of fixtures) {
      const solved = solveConstraints(entities, constraints);
      expect(solved, name).not.toBeNull();
      const [after, before] = [flat(solved!), flat(entities)];
      const moved = Math.hypot(...after.map((v, i) => v - before[i]!));
      expect(moved, name).toBeLessThan(parentMoved + 1e-9);
    }
  });
});

// Cost ratios between solves depend on the machine (CI runners read some past their bounds without
// a slowdown), so they're checked off CI only.
describe.skipIf(process.env.CI)("sketch solve cost", () => {
  // Review round 6: tying every line's ends into one group made a std constrained polyline (only
  // point-to-point coincidences) one dense system, seconds to fail at a few hundred segments.
  // Independent pieces must stay independent: cost follows the group that moves, not the sketch.
  // Timed on the solver alone; building hundreds of edges would time OpenCascade instead.
  //
  // Review round 8: each time is compared with a baseline measured in the same test (a smaller or
  // a solvable version of the sketch), not with a fixed number of milliseconds, so a busy shared
  // machine slows both alike. Each bound is about three times the ratio measured when it was set.
  const constraint = (
    id: string,
    type: string,
    first: string,
    second: string | null,
    length: number | null = null,
  ): SketchConstraint => {
    const ref = (name: string): SketchRef => {
      const [entity, part] = name.split(".");
      return { entity: entity!, part: part === "start" || part === "end" ? part : null };
    };
    return {
      id,
      type,
      first: ref(first),
      second: second ? ref(second) : null,
      mirror: null,
      length,
      angle: null,
      direction: "MINIMUM",
      alignment: "UNSPECIFIED",
    };
  };
  /** A std-style constrained polyline: segments joined end to start, one drawn 1 degree off level. */
  const polyline = (segments: number) => {
    const points: [number, number][] = Array.from({ length: segments + 1 }, (_, i) => [
      i * 0.01,
      i % 2 ? 0.005 : 0,
    ]);
    const middle = Math.floor(segments / 2);
    // One segment drawn 1 degree off level.
    points[middle + 1] = [
      points[middle]![0] + 0.01,
      points[middle]![1] + 0.01 * Math.tan(Math.PI / 180),
    ];
    const entities: SketchEntity[] = points.slice(0, -1).map((start, i) => ({
      kind: "line",
      id: `l${i}`,
      construction: false,
      start,
      end: points[i + 1]!,
    }));
    const joins = entities
      .slice(1)
      .map((_, i) => constraint(`j${i}`, "COINCIDENT", `l${i}.end`, `l${i + 1}.start`));
    return { entities, joins, middle };
  };
  /** The fastest of a few runs of `work`, in milliseconds, after one run to warm up. */
  const fastest = (work: () => unknown, runs = 5) => {
    work();
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      work();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("fails a polyline with conflicting lengths at the cost of its moving segment, not its size", () => {
    const failing = (segments: number) => {
      const { entities, joins } = polyline(segments);
      const constraints = [
        ...joins,
        constraint("a", "LENGTH", "l1", null, 0.01),
        constraint("b", "LENGTH", "l1", null, 0.012),
      ];
      expect(solveConstraints(entities, constraints)).toBeNull();
      return fastest(() => solveConstraints(entities, constraints));
    };
    // A hundred times the segments, the same three-segment group failing: setting up the other
    // segments is all that grows (6 to 8 times when set). Dense, it would be thousands of times.
    expect(failing(400) / failing(4)).toBeLessThan(25);
  });

  it("fails 16 joined std rectangles with a conflicting length, flips included, within a few solves of them", () => {
    const rectangles = rectangleRow(16);
    const conflict = constrain(
      "x",
      "LENGTH",
      '"localFirst" : "r0.bottom", "length" : 11 * millimeter',
    );
    expect(run(sketch([...rectangles, conflict])).statusEnum).toBe("SKETCH_SOLVE_FAILED");
    expect(run(sketch(rectangles)).status).toBe("OK");
    // Both through std; the solvable one also builds its 64 edges and 16 regions. About 6 times
    // when set.
    const ratio =
      fastest(() => run(sketch([...rectangles, conflict])), 2) /
      fastest(() => run(sketch(rectangles)), 2);
    expect(ratio).toBeLessThan(30);
  });

  it("fails a 33-gon with every side and corner dimensioned plus a conflict, each flip within its allowance", () => {
    const n = 33;
    const gon = (size: number) => {
      const reach = size / (2 * Math.sin(Math.PI / n));
      const corner = (i: number): [number, number] => [
        reach * Math.cos((2 * Math.PI * i) / n),
        reach * Math.sin((2 * Math.PI * i) / n),
      ];
      return Array.from(
        { length: n },
        (_, i): SketchEntity => ({
          kind: "line",
          id: `s${i}`,
          construction: false,
          start: corner(i),
          end: corner(i + 1),
        }),
      );
    };
    const constraints = Array.from({ length: n }, (_, i) => [
      constraint(`j${i}`, "COINCIDENT", `s${i}.end`, `s${(i + 1) % n}.start`),
      constraint(`len${i}`, "LENGTH", `s${i}`, null, 0.01),
      ...(i < n - 1
        ? [{ ...constraint(`a${i}`, "ANGLE", `s${i}`, `s${i + 1}`), angle: (2 * Math.PI) / n }]
        : []),
    ]).flat();
    const conflicting = [...constraints, constraint("x", "LENGTH", "s0", null, 0.011)];
    expect(solveConstraints(gon(0.01), conflicting)).toBeNull();
    // The baseline is the same sketch drawn 2% too big, which iterates to a solution. The failure
    // costs about 480 of those when set, nearly all of it flips: every one of the 32 angles is
    // off where the solve stops, and each has three other branches, so 96 flips run to TRY_WORK.
    expect(solveConstraints(gon(0.0102), constraints)).not.toBeNull();
    const ratio =
      fastest(() => solveConstraints(gon(0.01), conflicting)) /
      fastest(() => solveConstraints(gon(0.0102), constraints));
    expect(ratio).toBeLessThan(1500);
  });

  it("fails a conflict among 32 sided distances, every one flipped, within a few hundred solves of them", () => {
    // One free line, held level through a fixed point 1 mm up, and 32 fixed points 5 mm above it,
    // each a sided DISTANCE 5 from it. Every distance is off where the solve stops, so each is
    // flipped and solved once more, and none of those solves: below the line, a point would need
    // it 10 mm up. Review round 8: this used two conflicting LENGTHs, which left every distance
    // holding, so no flip ran at all.
    const entities: SketchEntity[] = [
      { kind: "line", id: "l", construction: false, start: [0, 0], end: [0.32, 0] },
      { kind: "point", id: "q", construction: false, position: [0, 0.001] },
      ...Array.from(
        { length: 32 },
        (_, i): SketchEntity => ({
          kind: "point",
          id: `p${i}`,
          construction: false,
          position: [i * 0.01, 0.005],
        }),
      ),
    ];
    const distances = entities
      .slice(2)
      .flatMap((point) => [
        constraint(`f${point.id}`, "FIX", point.id, null),
        constraint(`d${point.id}`, "DISTANCE", point.id, "l", 0.005),
      ]);
    const conflicting = [
      ...distances,
      constraint("fq", "FIX", "q", null),
      constraint("on", "COINCIDENT", "l.start", "q"),
      constraint("h", "HORIZONTAL", "l", null),
    ];
    expect(solveConstraints(entities, conflicting)).toBeNull();
    expect(solveConstraints(entities, distances)).not.toBeNull();
    // Against the same distances holding the line where it's drawn: about 135 times when set.
    const ratio =
      fastest(() => solveConstraints(entities, conflicting)) /
      fastest(() => solveConstraints(entities, distances));
    expect(ratio).toBeLessThan(400);
  });

  it("levels one segment of a polyline at the cost of that segment, not the polyline's size", () => {
    const level = (segments: number) => {
      const { entities, joins, middle } = polyline(segments);
      const constraints = [...joins, constraint("h", "HORIZONTAL", `l${middle}`, null)];
      const solved = solveConstraints(entities, constraints)?.[middle];
      expect(solved?.kind === "line" && Math.abs(solved.end[1] - solved.start[1])).toBeLessThan(
        1e-12,
      );
      return fastest(() => solveConstraints(entities, constraints));
    };
    // Ten times the segments costs about 14 times when set (a little more than linear: allocation);
    // a cost quadratic in the sketch's size, as judging each group against every span was, is 100.
    expect(level(800) / level(80)).toBeLessThan(45);
  });
});

describe("sketch points as axes", () => {
  // evAxis with allowSketchPoints gives a sketch point's axis along its sketch's normal: std's Hole
  // places holes at sketch points that way. A 6 mm hole through a 40 x 30 x 10 mm block at one.
  it("drills std's hole at a sketch point", () => {
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skPoint(sketch, "center", { "position" : vector(20, 15) * millimeter });',
        "skSolve(sketch);",
        'const axis = evAxis(context, { "axis" : qCreatedBy(id + "sketch", EntityType.VERTEX), "allowSketchPoints" : true });',
        'setVariable(context, "axis", concatenateArrays([axis.origin / millimeter, axis.direction]));',
        'hole(context, id + "hole", { "locations" : qCreatedBy(id + "sketch", EntityType.VERTEX), "scope" : qCreatedBy(id + "block", EntityType.BODY), "style" : HoleStyle.SIMPLE, "endStyle" : HoleEndStyle.THROUGH, "holeDiameter" : 6 * millimeter });',
        'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "block", EntityType.BODY) }) / millimeter ^ 3);',
      ].join("\n"),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("axis"), [20, 15, 10, 0, 0, 1]);
    expect(r.number("volume")).toBeCloseTo(12000 - Math.PI * 9 * 10, 6);
  });
});

describe("review round 2: mirrored lines and points beside slender ellipses", () => {
  // Symmetric "only constrains the underlying curve": two fixed vertical lines at x = -10 and 10 mm
  // mirror across x = 0 whatever their spans, so the sketch solves without moving them.
  it("mirrors lines by their underlying lines", () => {
    const r = run(
      sketch([
        line("axis", [0, -50], [0, 50], ', "construction" : true'),
        line("a", [-10, 0], [-10, 10]),
        line("b", [10, 20], [10, 40]),
        constrain("fixaxis", "FIX", '"localFirst" : "axis"'),
        constrain("fixa", "FIX", '"localFirst" : "a"'),
        constrain("fixb", "FIX", '"localFirst" : "b"'),
        constrain(
          "mirror",
          "MIRROR",
          '"localFirst" : "a", "localSecond" : "b", "localMirror" : "axis"',
        ),
      ]),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
  });

  // A 1 um segment's reflected ends both lie within a nanometer of a line turned 0.001 rad from its
  // own, so the positions alone pass; the underlying lines aren't symmetric, so the solve fails.
  it("checks mirrored lines' directions, not only a short segment's ends", () => {
    const r = run(
      sketch([
        line("axis", [0, -100], [0, 100], ', "construction" : true'),
        line("a", [-10, 0], [-9.999, 0]),
        line("b", [10, 0], [0, 0.01]),
        constrain("fixaxis", "FIX", '"localFirst" : "axis"'),
        constrain("fixa", "FIX", '"localFirst" : "a"'),
        constrain("fixb", "FIX", '"localFirst" : "b"'),
        constrain(
          "mirror",
          "MIRROR",
          '"localFirst" : "a", "localSecond" : "b", "localMirror" : "axis"',
        ),
      ]),
    );
    expect(r.status).toBe("ERROR");
  });

  // A fixed point 1 um past the end of a fixed 1 m by 0.005 mm ellipse (and a hair off its axis)
  // is 1 um from the curve, far past zeroLength, so the coincidence fails; ordinary points on an
  // ellipse still solve.
  it("checks a point's true distance from a slender ellipse", () => {
    const far = run(
      sketch([
        'skEllipse(sketch, "e", { "center" : vector(0, 0) * meter, "majorAxis" : vector(1, 0), "majorRadius" : 1 * meter, "minorRadius" : 0.005 * millimeter, "construction" : true });',
        'skPoint(sketch, "p", { "position" : vector(1.000001, 0.00000000707106781) * meter });',
        constrain("fixe", "FIX", '"localFirst" : "e"'),
        constrain("fixp", "FIX", '"localFirst" : "p"'),
        constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "e"'),
      ]),
    );
    expect(far.status).toBe("ERROR");
    for (const [x, y] of [
      [0, 5],
      [15, 2],
      [0, -20],
      [19, 1],
    ] as const) {
      const near = run(
        sketch([
          'skEllipse(sketch, "e", { "center" : vector(0, 0) * meter, "majorAxis" : vector(1, 0), "majorRadius" : 20 * millimeter, "minorRadius" : 10 * millimeter, "construction" : true });',
          `skPoint(sketch, "p", { "position" : ${mm(x, y)} });`,
          constrain("fixe", "FIX", '"localFirst" : "e"'),
          constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "e"'),
        ]),
      );
      expect(near.status, `${x}, ${y}`).toBe("OK");
    }
  });
});

describe("review: arc mirrors and slender ellipses", () => {
  // Onshape's Symmetric constrains arcs' underlying circles, not their ends: two radius 10 mm arcs
  // on one center on the axis already mirror each other, so neither span moves.
  it("mirrors arcs by their circles and leaves their spans", () => {
    const r = run(
      sketch([
        line("axis", [-20, 0], [20, 0], ', "construction" : true'),
        `skArc(sketch, "a", { "start" : ${mm(10, 0)}, "mid" : ${mm(0, 10)}, "end" : ${mm(-10, 0)} });`,
        `skArc(sketch, "b", { "start" : ${mm(10, 0)}, "mid" : ${mm(Math.SQRT1_2 * 10, Math.SQRT1_2 * 10)}, "end" : ${mm(0, 10)} });`,
        constrain("fixaxis", "FIX", '"localFirst" : "axis"'),
        constrain(
          "mirror",
          "MIRROR",
          '"localFirst" : "a", "localSecond" : "b", "localMirror" : "axis"',
        ),
      ]) +
        "\n" +
        at("bMid", "b", 0.5),
    );
    expect(r.status, r.fault ?? r.exceptions).toBe("OK");
    close(r.vector("bMid"), [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10, 0]);
  });

  // A point 0.5 mm past the end of a fixed 1 m by 0.01 mm ellipse can't lie on it: the solve fails
  // instead of passing a residual the minor radius scaled under the tolerance.
  it("measures a point's gap from a slender ellipse as a distance", () => {
    const r = run(
      sketch([
        'skEllipse(sketch, "e", { "center" : vector(0, 0) * meter, "majorAxis" : vector(1, 0), "majorRadius" : 1 * meter, "minorRadius" : 0.01 * millimeter, "construction" : true });',
        'skPoint(sketch, "p", { "position" : vector(1.0005, 0) * meter });',
        constrain("fixe", "FIX", '"localFirst" : "e"'),
        constrain("fixp", "FIX", '"localFirst" : "p"'),
        constrain("on", "COINCIDENT", '"localFirst" : "p", "localSecond" : "e"'),
      ]),
    );
    expect(r.status).toBe("ERROR");
  });
});
