import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, variable } from "./partStudio.ts";

/**
 * Edge and face evaluators, end to end through std's wrappers on hand-built geometry.
 *
 * Ways these can fail:
 * - Edge parameters map uniformly in the curve's own parameter instead of by arc length (std's
 *   default), which only shows on curves whose speed varies, such as splines.
 * - The `face` / `usingFaceOrientation` direction is backwards: the face must stay on the left
 *   walking the edge with the face's outward normal up.
 * - A tangent plane at an edge takes the wrong face's normal, or an x axis that isn't the edge's
 *   tangent.
 * - Convexity reads the interior angle from the wrong side (a cube edge as concave), or calls a
 *   fillet's tangent edge convex.
 * - A planar-edge plane that doesn't contain the edges, or one returned for edges that share no
 *   plane.
 * - evCornerType invents sheet metal corners where there is no sheet metal.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
const at = (x: number, y: number, z: number, type = "EDGE") =>
  `qContainsPoint(qCreatedBy(id, EntityType.${type}), vector(${x}, ${y}, ${z}) * millimeter)`;
/** Runs one custom feature and returns its variables, failing on any fault or error. */
const evaluate = (body: string) => {
  const run = studio.run([{ body }]);
  const feature = run.features[0]!;
  if (feature.fault || feature.status !== "OK")
    throw new Error(
      `${feature.fault?.message ?? feature.status}: ${feature.exceptions.map((e) => e.message).join("; ")}`,
    );
  return run;
};
const vector = (run: ReturnType<typeof evaluate>, name: string): number[] =>
  (untag(variable(run, name)) as readonly unknown[]).map((x) => untag(x as never) as number);
const expectVector = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i], `component ${i}`).toBeCloseTo(value, 9));
};

describe("edge tangents", () => {
  // A straight 10 mm spline whose speed varies: x(u) = 2u + 8u^2 mm, from end derivatives 2 and
  // 18 mm per unit parameter. Its arc length midpoint is x = 5; its parameter midpoint is x = 3.
  const spline = `
    opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter],
        "startDerivative" : vector(2, 0, 0) * millimeter, "endDerivative" : vector(18, 0, 0) * millimeter });
    const edge = qCreatedBy(id + "spline", EntityType.EDGE);`;

  it("measure parameters by arc length unless told otherwise", () => {
    const run = evaluate(`${spline}
      const lines = evEdgeTangentLines(context, { "edge" : edge, "parameters" : [0, 0.25, 0.5, 1] });
      setVariable(context, "x", mapArray(lines, line => line.origin[0] / millimeter));
      setVariable(context, "direction", lines[2].direction);
      const fast = evEdgeTangentLines(context, { "edge" : edge, "parameters" : [0.5], "arcLengthParameterization" : false });
      setVariable(context, "fastX", fast[0].origin[0] / millimeter);`);
    const x = untag(variable(run, "x")) as number[];
    expect(x[0]).toBeCloseTo(0, 9);
    expect(x[1]).toBeCloseTo(2.5, 9);
    expect(x[2]).toBeCloseTo(5, 9);
    expect(x[3]).toBeCloseTo(10, 9);
    expectVector(vector(run, "direction"), [1, 0, 0]);
    // Std calls this parameterization arbitrary; locally it's the curve's own (x(0.5) = 3 mm).
    expect(numberVariable(run, "fastX")).toBeCloseTo(3, 9);
  });

  it("agree with the curve's own parameter on lines and arcs, whose speed is constant", () => {
    // The cube's vertical edge at the origin is a line; the pin's top rim is a circle.
    const run = evaluate(`${cube}
      fCylinder(context, id + "pin", { "bottomCenter" : vector(20, 0, 0) * millimeter, "topCenter" : vector(20, 0, 10) * millimeter, "radius" : 5 * millimeter });
      const line = ${at(0, 0, 5)};
      const arc = qGeometry(${at(25, 0, 10)}, GeometryType.CIRCLE);
      setVariable(context, "gaps", mapArray([line, arc], edge => norm(
          evEdgeTangentLine(context, { "edge" : edge, "parameter" : 0.3 }).origin -
          evEdgeTangentLine(context, { "edge" : edge, "parameter" : 0.3, "arcLengthParameterization" : false }).origin) / millimeter));`);
    for (const gap of untag(variable(run, "gaps")) as number[]) expect(gap).toBeCloseTo(0, 9);
  });

  it("follow a face's orientation when given one", () => {
    // The top front edge of a cube: walking it with the top face on the left (up +Z) goes +X; with
    // the front face on the left (up -Y) it goes -X.
    const run = evaluate(`${cube}
      const top = evEdgeTangentLine(context, { "edge" : ${at(5, 0, 10)}, "parameter" : 0, "face" : ${at(5, 5, 10, "FACE")} });
      const front = evEdgeTangentLine(context, { "edge" : ${at(5, 0, 10)}, "parameter" : 0, "face" : ${at(5, 0, 5, "FACE")} });
      setVariable(context, "topDirection", top.direction);
      setVariable(context, "topOrigin", top.origin / millimeter);
      setVariable(context, "frontDirection", front.direction);
      setVariable(context, "frontOrigin", front.origin / millimeter);`);
    expectVector(vector(run, "topDirection"), [1, 0, 0]);
    expectVector(vector(run, "topOrigin"), [0, 0, 10]);
    expectVector(vector(run, "frontDirection"), [-1, 0, 0]);
    expectVector(vector(run, "frontOrigin"), [10, 0, 10]);
  });
});

describe("evFaceTangentPlanesAtEdge", () => {
  it("returns the face's tangent plane along the edge, x along the edge", () => {
    const run = evaluate(`${cube}
      const top = evFaceTangentPlanesAtEdge(context, { "edge" : ${at(5, 0, 10)}, "face" : ${at(5, 5, 10, "FACE")}, "parameters" : [0, 0.5, 1], "usingFaceOrientation" : true });
      const front = evFaceTangentPlanesAtEdge(context, { "edge" : ${at(5, 0, 10)}, "face" : ${at(5, 0, 5, "FACE")}, "parameters" : [0.25], "usingFaceOrientation" : true });
      setVariable(context, "topOrigins", mapArray(top, plane => plane.origin / millimeter));
      setVariable(context, "topNormal", top[1].normal);
      setVariable(context, "topX", top[1].x);
      setVariable(context, "frontOrigin", front[0].origin / millimeter);
      setVariable(context, "frontNormal", front[0].normal);
      setVariable(context, "frontX", front[0].x);
      const plain = evFaceTangentPlaneAtEdge(context, { "edge" : ${at(5, 0, 10)}, "face" : ${at(5, 0, 5, "FACE")}, "parameter" : 0.5 });
      setVariable(context, "plainNormal", plain.normal);
      setVariable(context, "plainXAbs", abs(plain.x[0]));`);
    const origins = (untag(variable(run, "topOrigins")) as readonly unknown[]).map((v) =>
      (untag(v as never) as readonly unknown[]).map((x) => untag(x as never) as number),
    );
    expectVector(origins[0]!, [0, 0, 10]);
    expectVector(origins[1]!, [5, 0, 10]);
    expectVector(origins[2]!, [10, 0, 10]);
    expectVector(vector(run, "topNormal"), [0, 0, 1]);
    expectVector(vector(run, "topX"), [1, 0, 0]);
    // Walking -X from x = 10, a quarter of the way is x = 7.5.
    expectVector(vector(run, "frontOrigin"), [7.5, 0, 10]);
    expectVector(vector(run, "frontNormal"), [0, -1, 0]);
    expectVector(vector(run, "frontX"), [-1, 0, 0]);
    expectVector(vector(run, "plainNormal"), [0, -1, 0]);
    expect(numberVariable(run, "plainXAbs")).toBe(1);
  });

  it("takes a curved face's normal", () => {
    const run = evaluate(`
      fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
      const rim = qGeometry(${at(0, 5, 10)}, GeometryType.CIRCLE);
      const planes = evFaceTangentPlanesAtEdge(context, { "edge" : rim, "face" : qGeometry(qCreatedBy(id, EntityType.FACE), GeometryType.CYLINDER), "parameters" : [0, 0.3, 0.7] });
      setVariable(context, "radial", mapArray(planes, plane => dot(plane.normal, normalize(vector(plane.origin[0], plane.origin[1], 0 * meter)))));
      setVariable(context, "radius", mapArray(planes, plane => sqrt(plane.origin[0] ^ 2 + plane.origin[1] ^ 2) / millimeter));
      setVariable(context, "xAlongRim", mapArray(planes, plane => abs(dot(plane.x, normalize(vector(-plane.origin[1], plane.origin[0], 0 * meter))))));
      setVariable(context, "z", mapArray(planes, plane => plane.origin[2] / millimeter));`);
    for (const name of ["radial", "xAlongRim"])
      for (const value of untag(variable(run, name)) as number[]) expect(value).toBeCloseTo(1, 12);
    for (const value of untag(variable(run, "radius")) as number[]) expect(value).toBeCloseTo(5, 9);
    for (const value of untag(variable(run, "z")) as number[]) expect(value).toBeCloseTo(10, 9);
  });
});

describe("evEdgeConvexity", () => {
  it("classifies a cube's edges as convex, an L's inner edge as concave and a fillet's edges as smooth", () => {
    const run = evaluate(`
      fCuboid(context, id + "base", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });
      fCuboid(context, id + "riser", { "corner1" : vector(0, 0, 10) * millimeter, "corner2" : vector(10, 10, 20) * millimeter });
      opBoolean(context, id + "union", { "tools" : qCreatedBy(id, EntityType.BODY), "operationType" : BooleanOperationType.UNION });
      setVariable(context, "outer", evEdgeConvexity(context, { "edge" : ${at(20, 5, 10)} }));
      setVariable(context, "inner", evEdgeConvexity(context, { "edge" : ${at(10, 5, 10)} }));
      fillet(context, id + "fillet", { "entities" : ${at(20, 5, 0)}, "radius" : 2 * millimeter });
      const filletFace = qGeometry(qCreatedBy(id + "fillet", EntityType.FACE), GeometryType.CYLINDER);
      setVariable(context, "smooth", mapArray(evaluateQuery(context, qAdjacent(filletFace, AdjacencyType.EDGE, EntityType.EDGE)->qGeometry(GeometryType.LINE)), edge => evEdgeConvexity(context, { "edge" : edge })));
      var caught;
      try silent { evEdgeConvexity(context, { "edge" : qCreatedBy(id, EntityType.EDGE) }); }
      catch (error) { caught = error.message; }
      setVariable(context, "many", caught);`);
    expect(String(untag(variable(run, "outer")))).toBe("CONVEX");
    expect(String(untag(variable(run, "inner")))).toBe("CONCAVE");
    expect((untag(variable(run, "smooth")) as unknown[]).map((v) => untag(v as never))).toEqual([
      "SMOOTH",
      "SMOOTH",
    ]);
    expect(String(untag(variable(run, "many")))).toBe("TOO_MANY_ENTITIES_SELECTED");
  });
});

describe("planar edges", () => {
  it("finds the plane of a circle and of a face's loop, and refuses edges that share none", () => {
    const run = evaluate(`
      fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
      const rim = evPlanarEdge(context, { "edge" : qGeometry(${at(0, 5, 10)}, GeometryType.CIRCLE) });
      setVariable(context, "rimOrigin", rim.origin / millimeter);
      setVariable(context, "rimNormalZ", abs(rim.normal[2]));
      ${cube.replace('"cube"', '"cube"').replace("vector(0, 0, 0)", "vector(20, 0, 0)").replace("vector(10, 10, 10)", "vector(30, 10, 10)")}
      const loop = evPlanarEdges(context, { "edges" : qAdjacent(${at(25, 5, 10, "FACE")}, AdjacencyType.EDGE, EntityType.EDGE) });
      setVariable(context, "loopZ", loop.origin[2] / millimeter);
      setVariable(context, "loopNormalZ", abs(loop.normal[2]));
      setVariable(context, "loopXz", loop.x[2]);
      var caught;
      try silent { evPlanarEdges(context, { "edges" : qUnion([${at(25, 0, 10)}, ${at(20, 5, 0)}, ${at(30, 0, 5)}]) }); }
      catch (error) { caught = error.message; }
      setVariable(context, "skew", caught);`);
    expectVector(vector(run, "rimOrigin"), [0, 0, 10]);
    expect(numberVariable(run, "rimNormalZ")).toBe(1);
    expect(numberVariable(run, "loopZ")).toBeCloseTo(10, 9);
    expect(numberVariable(run, "loopNormalZ")).toBeCloseTo(1, 12);
    expect(numberVariable(run, "loopXz")).toBeCloseTo(0, 12);
    expect(String(untag(variable(run, "skew")))).toBe("CANNOT_RESOLVE_PLANE");
  });
});

describe("evCornerType", () => {
  it("finds no sheet metal corner at a solid's vertex, and needs exactly one vertex", () => {
    const run = evaluate(`${cube}
      const corner = evCornerType(context, { "vertex" : ${at(10, 10, 10, "VERTEX")} });
      setVariable(context, "type", corner.cornerType);
      setVariable(context, "primary", size(evaluateQuery(context, qIntersection([corner.primaryVertex, ${at(10, 10, 10, "VERTEX")}]))));
      var caught;
      try silent { evCornerType(context, { "vertex" : ${at(5, 0, 10)} }); }
      catch (error) { caught = error.message; }
      setVariable(context, "edge", caught);`);
    expect(String(untag(variable(run, "type")))).toBe("NOT_A_CORNER");
    expect(numberVariable(run, "primary")).toBe(1);
    expect(String(untag(variable(run, "edge")))).toBe("BAD_GEOMETRY");
  });
});
