import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * Surfaces: B-spline sheets (opCreateBSplineSurface, evApproximateBSplineSurface), Fill
 * (opFillSurface) and Enclose (opEnclose).
 *
 * Ways it goes wrong:
 * - Control point rows and columns swapped (std reads across a row as v), so the surface comes
 *   out transposed or the knot counts don't match.
 * - Weights dropped, so a rational cylinder strip comes out flat-sided.
 * - UV boundary curves read in 3D, or the trimmed face keeps the whole patch, or an open or
 *   doubled boundary builds an invalid face instead of std's error.
 * - A surface with a crease (an interior knot with only position continuity across it) is built
 *   though std documents that it must be G1, including a crease along only a short stretch of the
 *   knot line, between the places the check looks.
 * - A ruled surface returns no frames for manipulator positions it was asked for.
 * - evApproximateBSplineSurface returns a surface that doesn't rebuild the face it read.
 * - A fill misses its boundary, bulges on a flat boundary, or a tangent condition is applied to
 *   no face (or to a guessed one) without saying so.
 * - Enclose leaves an open shell as a sheet, or makes a solid from sheets that cross each other
 *   without trimming them.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/surfaces${counter++}.fs`,
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
  };
};

const area = (name: string, feature: string) =>
  `setVariable(context, "${name}", evArea(context, { "entities" : qCreatedBy(id + "${feature}", EntityType.FACE) }) / millimeter ^ 2);`;
const volume = (name: string, feature: string) =>
  `setVariable(context, "${name}", evVolume(context, { "entities" : qCreatedBy(id + "${feature}", EntityType.BODY) }) / millimeter ^ 3);`;
const sheets = (name: string, feature: string) =>
  `setVariable(context, "${name}", size(evaluateQuery(context, qBodyType(qCreatedBy(id + "${feature}", EntityType.BODY), BodyType.SHEET))));`;
/** A flat 10 x 10 mm bilinear patch in z = 0; rows run in x (u), columns in y (v). */
const PATCH =
  'bSplineSurface({ "uDegree" : 1, "vDegree" : 1, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([[vector(0, 0, 0) * millimeter, vector(0, 10, 0) * millimeter], [vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter]]) })';
const segment = (from: string, to: string) =>
  `bSplineCurve({ "degree" : 1, "isPeriodic" : false, "controlPoints" : [vector(${from}), vector(${to})] })`;

describe("opCreateBSplineSurface", () => {
  it("builds a flat patch and a rational quarter-cylinder strip as sheets", () => {
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH} });`,
        area("patch", "patch"),
        sheets("sheets", "patch"),
        // u runs up z over 10 mm; v is a rational quarter circle of radius 10.
        "const w = sqrt(2) / 2;",
        'opCreateBSplineSurface(context, id + "strip", { "bSplineSurface" : bSplineSurface({ "uDegree" : 1, "vDegree" : 2, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([[vector(10, 0, 0) * millimeter, vector(10, 10, 0) * millimeter, vector(0, 10, 0) * millimeter], [vector(10, 0, 10) * millimeter, vector(10, 10, 10) * millimeter, vector(0, 10, 10) * millimeter]]), "weights" : matrix([[1, w, 1], [1, w, 1]]) }) });',
        area("strip", "strip"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("sheets")).toBe(1);
    expect(r.number("patch")).toBeCloseTo(100, 6);
    expect(r.number("strip")).toBeCloseTo(10 * 5 * Math.PI, 5);
  });

  it("trims a patch to a loop of UV boundary curves", () => {
    // The UV square from 0.25 to 0.75 is the middle 5 x 5 mm of the patch.
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH}, "boundaryBSplineCurves" : [${segment("0.25, 0.25", "0.75, 0.25")}, ${segment("0.75, 0.25", "0.75, 0.75")}, ${segment("0.75, 0.75", "0.25, 0.75")}, ${segment("0.25, 0.75", "0.25, 0.25")}] });`,
        area("area", "patch"),
        'setVariable(context, "edges", size(evaluateQuery(context, qCreatedBy(id + "patch", EntityType.EDGE))));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(r.number("area")).toBeCloseTo(25, 6);
    expect(r.number("edges")).toBe(4);
  });
});

describe("opCreateBSplineSurface refusals", () => {
  it("refuses a creased surface and a boundary that doesn't close", () => {
    // Rows at x, z = (0, 0), (5, 0), (10, 5): a 45 degree fold along x = 5.
    const creased = run(
      'opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : bSplineSurface({ "uDegree" : 1, "vDegree" : 1, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([[vector(0, 0, 0) * millimeter, vector(0, 10, 0) * millimeter], [vector(5, 0, 0) * millimeter, vector(5, 10, 0) * millimeter], [vector(10, 0, 5) * millimeter, vector(10, 10, 5) * millimeter]]), "uKnots" : knotArray([0, 0, 0.5, 1, 1]), "vKnots" : knotArray([0, 0, 1, 1]) }) });',
    );
    expect([creased.status, creased.statusEnum, creased.fault]).toEqual([
      "ERROR",
      "BSPLINESURFACE_NOT_G1",
      null,
    ]);
    const open = run(
      `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH}, "boundaryBSplineCurves" : [${segment("0.25, 0.25", "0.75, 0.25")}, ${segment("0.75, 0.25", "0.75, 0.75")}, ${segment("0.75, 0.75", "0.25, 0.75")}] });`,
    );
    expect(open.statusEnum).toBe("BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP");
    const twoLoops = run(
      `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH}, "boundaryBSplineCurves" : [${segment("0.1, 0.1", "0.3, 0.1")}, ${segment("0.3, 0.1", "0.1, 0.3")}, ${segment("0.1, 0.3", "0.1, 0.1")}, ${segment("0.6, 0.6", "0.8, 0.6")}, ${segment("0.8, 0.6", "0.6, 0.8")}, ${segment("0.6, 0.8", "0.6, 0.6")}] });`,
    );
    expect(twoLoops.statusEnum).toBe("BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP");
  });

  it("refuses a crease that runs along only a short stretch of its knot line", () => {
    // u: degree 1, rows at x = 0, 20 and 40 mm, joined at a knot at 0.5. v: cubic over 40 spans
    // along 40 mm of y. Lifting pole (2, 7) by `lift` mm folds the surface along u = 0.5 only where
    // that pole acts, v from 0.1 to 0.2: about 9.5 degrees at v = 0.15 for a 5 mm lift.
    const spans = 40;
    const vKnots = [
      0,
      0,
      0,
      0,
      ...Array.from({ length: spans - 1 }, (_, k) => (k + 1) / spans),
      1,
      1,
      1,
      1,
    ];
    const greville = (j: number) => (vKnots[j + 1]! + vKnots[j + 2]! + vKnots[j + 3]!) / 3;
    const surface = (lift: number) => {
      const rows = [0, 1, 2].map(
        (i) =>
          `[${Array.from({ length: spans + 3 }, (_, j) => `vector(${20 * i}, ${40 * greville(j)}, ${i === 2 && j === 7 ? lift : 0}) * millimeter`).join(", ")}]`,
      );
      return `bSplineSurface({ "uDegree" : 1, "vDegree" : 3, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([${rows.join(", ")}]), "uKnots" : knotArray([0, 0, 0.5, 1, 1]), "vKnots" : knotArray([${vKnots.join(", ")}]) })`;
    };
    const creased = run(
      `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${surface(5)} });`,
    );
    expect([creased.status, creased.statusEnum, creased.fault]).toEqual([
      "ERROR",
      "BSPLINESURFACE_NOT_G1",
      null,
    ]);
    // Unlifted, the same knot joins two flat halves smoothly.
    const flat = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${surface(0)} });`,
        area("area", "patch"),
      ].join("\n"),
    );
    expect(flat.status, flat.why).toBe("OK");
    expect(flat.number("area")).toBeCloseTo(40 * 40, 6);
  });
});

describe("evApproximateBSplineSurface", () => {
  it("reads a B-spline face and a planar face back into surfaces that rebuild them", () => {
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH} });`,
        'const read = evApproximateBSplineSurface(context, { "face" : qCreatedBy(id + "patch", EntityType.FACE) });',
        'opCreateBSplineSurface(context, id + "copy", { "bSplineSurface" : read.bSplineSurface });',
        area("copy", "copy"),
        'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 30, 10) * millimeter });',
        'const top = qContainsPoint(qCreatedBy(id + "cube", EntityType.FACE), vector(10, 15, 10) * millimeter);',
        'const flat = evApproximateBSplineSurface(context, { "face" : top });',
        'opCreateBSplineSurface(context, id + "top", { "bSplineSurface" : flat.bSplineSurface, "boundaryBSplineCurves" : flat.boundaryBSplineCurves });',
        area("top", "top"),
        'setVariable(context, "height", evApproximateCentroid(context, { "entities" : qCreatedBy(id + "top", EntityType.FACE) })[2] / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("copy")).toBeCloseTo(100, 6);
    expect(r.number("top")).toBeCloseTo(600, 6);
    expect(r.number("height")).toBeCloseTo(10, 9);
  });
});

describe("opFillSurface", () => {
  const square =
    'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });\n' +
    'skRectangle(sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 10) * millimeter });\n' +
    "skSolve(sketch);";
  const wireEdges =
    'qOwnedByBody(qBodyType(qCreatedBy(id + "sketch", EntityType.BODY), BodyType.WIRE), EntityType.EDGE)';

  it("fills a flat boundary flat, and refuses the same edge twice", () => {
    // std's Fill feature needs Query.ts to follow LAMINAR_DEPENDENCY, so this calls opFillSurface.
    const r = run(
      [
        square,
        `opFillSurface(context, id + "fill", { "edgesG0" : ${wireEdges}, "edgesG1" : qNothing(), "edgesG2" : qNothing() });`,
        area("area", "fill"),
        sheets("sheets", "fill"),
        // The control net's box: a tight box stops on a trimmed spline face whose surface runs past
        // its trim, and a net with no thickness is flat.
        'const box = evBox3d(context, { "topology" : qCreatedBy(id + "fill", EntityType.FACE), "tight" : false });',
        'setVariable(context, "thickness", (box.maxCorner[2] - box.minCorner[2]) / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(r.number("sheets")).toBe(1);
    expect(r.number("area")).toBeCloseTo(100, 4);
    expect(r.number("thickness")).toBeLessThan(1e-3);
    // The sketch's wire edges and its region's edges are the same curves.
    const doubled = run(
      [
        square,
        'opFillSurface(context, id + "fill", { "edgesG0" : qCreatedBy(id + "sketch", EntityType.EDGE), "edgesG1" : qNothing(), "edgesG2" : qNothing() });',
      ].join("\n"),
    );
    expect(doubled.statusEnum).toBe("FILL_SURFACE_DOUBLE_SELECTION");
  });

  it("passes through a guide vertex, and refuses tangency to a solid's edge it can't pick a face for", () => {
    const guided = run(
      [
        square,
        'opPoint(context, id + "peak", { "point" : vector(5, 5, 3) * millimeter });',
        `opFillSurface(context, id + "fill", { "edgesG0" : ${wireEdges}, "edgesG1" : qNothing(), "edgesG2" : qNothing(), "guideVertices" : qCreatedBy(id + "peak", EntityType.VERTEX) });`,
        'setVariable(context, "gap", evDistance(context, { "side0" : qCreatedBy(id + "fill", EntityType.FACE), "side1" : vector(5, 5, 3) * millimeter }).distance / millimeter);',
        area("area", "fill"),
      ].join("\n"),
    );
    expect(guided.status, guided.why).toBe("OK");
    expect(guided.number("gap")).toBeLessThan(1e-3);
    expect(guided.number("area")).toBeGreaterThan(100);
    const tangent = run(
      [
        'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'opFillSurface(context, id + "fill", { "edgesG0" : qNothing(), "edgesG1" : qContainsPoint(qCreatedBy(id + "cube", EntityType.EDGE), vector(5, 0, 10) * millimeter), "edgesG2" : qNothing() });',
      ].join("\n"),
    );
    expect(tangent.status).toBe("ERROR");
    expect(tangent.fault?.message).toMatch(/adjacent face/);
  });
});

describe("opEnclose", () => {
  /** Six 10 mm squares on the faces of the cube from 0 to 10. */
  const cubeSheets = [
    ["5, 5, 0", "0, 0, 1"],
    ["5, 5, 10", "0, 0, 1"],
    ["5, 0, 5", "0, 1, 0"],
    ["5, 10, 5", "0, 1, 0"],
    ["0, 5, 5", "1, 0, 0"],
    ["10, 5, 5", "1, 0, 0"],
  ]
    .map(
      ([origin, normal], i) =>
        `opPlane(context, id + "p${i}", { "plane" : plane(vector(${origin}) * millimeter, vector(${normal})), "width" : 10 * millimeter, "height" : 10 * millimeter });`,
    )
    .join("\n");
  const planes =
    'qUnion([qCreatedBy(id + "p0", EntityType.BODY), qCreatedBy(id + "p1", EntityType.BODY), qCreatedBy(id + "p2", EntityType.BODY), qCreatedBy(id + "p3", EntityType.BODY), qCreatedBy(id + "p4", EntityType.BODY), qCreatedBy(id + "p5", EntityType.BODY)])';

  it("closes sheets that meet edge to edge into a solid", () => {
    const r = run(
      [
        cubeSheets,
        `opEnclose(context, id + "enclose", { "entities" : ${planes} });`,
        volume("volume", "enclose"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(r.number("volume")).toBeCloseTo(1000, 6);
  });

  it("refuses sheets that cross without meeting edge to edge", () => {
    const r = run(
      [
        cubeSheets.replace(
          '"width" : 10 * millimeter, "height" : 10 * millimeter });',
          '"width" : 14 * millimeter, "height" : 14 * millimeter });',
        ),
        `opEnclose(context, id + "enclose", { "entities" : ${planes} });`,
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/cross/);
  });
});

describe("opRuledSurface", () => {
  it("rules a path straight along a vector by the width, and refuses angled rulings", () => {
    // A 10 mm line and a half circle of radius 5 ruled 4 mm up: 40 + 4 * 5 PI.
    const path =
      'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });\n' +
      'skLineSegment(sketch, "line", { "start" : vector(-5, 0) * millimeter, "end" : vector(-15, 0) * millimeter });\n' +
      'skArc(sketch, "arc", { "start" : vector(-5, 0) * millimeter, "mid" : vector(0, 5) * millimeter, "end" : vector(5, 0) * millimeter });\n' +
      "skSolve(sketch);";
    const edges =
      'qOwnedByBody(qBodyType(qCreatedBy(id + "sketch", EntityType.BODY), BodyType.WIRE), EntityType.EDGE)';
    const r = run(
      [
        path,
        `const bases = opRuledSurface(context, id + "ruled", { "path" : ${edges}, "width" : -4 * millimeter, "ruledDirection" : vector(0, 0, -1), "ruledSurfaceType" : RuledSurfaceType.ALIGNED_WITH_VECTOR, "angle" : 0, "vertexOverrides" : [] });`,
        area("area", "ruled"),
        sheets("sheets", "ruled"),
        'setVariable(context, "top", evBox3d(context, { "topology" : qCreatedBy(id + "ruled", EntityType.FACE) }).maxCorner[2] / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(r.number("sheets")).toBe(1);
    expect(r.number("area")).toBeCloseTo(40 + 4 * 5 * Math.PI, 5);
    // Negative width along -z runs up +z.
    expect(r.number("top")).toBeCloseTo(4, 3);
    const angled = run(
      [
        path,
        `opRuledSurface(context, id + "ruled", { "path" : ${edges}, "width" : 4 * millimeter, "ruledDirection" : vector(0, 0, 1), "ruledSurfaceType" : RuledSurfaceType.ANGLE_FROM_VECTOR, "angle" : 30 * degree, "vertexOverrides" : [] });`,
      ].join("\n"),
    );
    expect(angled.fault?.message).toMatch(/ANGLE_FROM_VECTOR/);
    // Frames for manipulators aren't defined for aligned rulings, so asking for them stops the run.
    const framed = run(
      [
        path,
        `opRuledSurface(context, id + "ruled", { "path" : ${edges}, "width" : 4 * millimeter, "ruledDirection" : vector(0, 0, 1), "ruledSurfaceType" : RuledSurfaceType.ALIGNED_WITH_VECTOR, "angle" : 0, "vertexOverrides" : [], "manipulatorPositions" : [{ "edge" : sketchEntityQuery(id + "sketch", EntityType.EDGE, "line"), "parameter" : 0.5 }] });`,
      ].join("\n"),
    );
    expect(framed.status).toBe("ERROR");
    expect(framed.fault?.message).toMatch(/manipulatorPositions/);
  });
});

describe("evSurfaceDefinition", () => {
  // A B-spline face comes back as std's BSplineSurface with its degrees and control points.
  it("returns a B-spline face as std's BSplineSurface", () => {
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "patch", { "bSplineSurface" : ${PATCH} });`,
        'const surface = evSurfaceDefinition(context, { "face" : qCreatedBy(id + "patch", EntityType.FACE) });',
        'setVariable(context, "degrees", surface.uDegree * 10 + surface.vDegree);',
        'setVariable(context, "far", surface.controlPoints[1][1][0] / millimeter + surface.controlPoints[1][1][1] / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("degrees")).toBe(11);
    expect(r.number("far")).toBeCloseTo(20, 9);
  });
});

describe("opRuledSurface on separate paths", () => {
  // A path set of an L (two joined 10 mm lines) and a separate 10 mm line, ruled 4 mm up: the L
  // sews into one sheet and the lone line is its own, 120 mm2 in all.
  it("makes a sheet for every path, joined or not", () => {
    const r = run(
      [
        'const s = newSketchOnPlane(context, id + "s", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1)) });',
        'skLineSegment(s, "a", { "start" : vector(0, 0) * millimeter, "end" : vector(10, 0) * millimeter });',
        'skLineSegment(s, "b", { "start" : vector(10, 0) * millimeter, "end" : vector(10, 10) * millimeter });',
        'skLineSegment(s, "c", { "start" : vector(30, 0) * millimeter, "end" : vector(40, 0) * millimeter });',
        "skSolve(s);",
        'opRuledSurface(context, id + "ruled", { "path" : qCreatedBy(id + "s", EntityType.EDGE), "width" : 4 * millimeter, "ruledDirection" : vector(0, 0, 1), "ruledSurfaceType" : RuledSurfaceType.ALIGNED_WITH_VECTOR });',
        area("area", "ruled"),
        'setVariable(context, "bodies", size(evaluateQuery(context, qCreatedBy(id + "ruled", EntityType.BODY))));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("area")).toBeCloseTo(120, 4);
    expect(r.number("bodies")).toBe(2);
  });
});

describe("periodic B-spline surfaces with a repeated seam knot", () => {
  // The round 1 pentagon curve (doubled seam knot) swept straight up 10 mm in v: smooth and closed,
  // so it builds, as std's full periodic knot vectors allow.
  it("builds the closed sheet", () => {
    const corner = (i: number, z: number) =>
      `vector(${10 * Math.cos((i * 2 * Math.PI) / 5)}, ${10 * Math.sin((i * 2 * Math.PI) / 5)}, ${z}) * millimeter`;
    const rows = [0, 1, 2, 3, 4, 0, 1, 2]
      .map((i) => `[${corner(i, 0)}, ${corner(i, 10)}]`)
      .join(", ");
    const r = run(
      [
        `opCreateBSplineSurface(context, id + "sheet", { "bSplineSurface" : bSplineSurface({ "uDegree" : 3, "vDegree" : 1, "isUPeriodic" : true, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([${rows}]), "uKnots" : knotArray([-0.75, -0.5, -0.25, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1.25, 1.5]), "vKnots" : knotArray([0, 0, 1, 1]) }) });`,
        sheets("sheets", "sheet"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("sheets")).toBe(1);
  });
});
