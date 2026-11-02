import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, variable } from "./partStudio.ts";

/**
 * Curvature, periodicity, raycasts, point deviation and SVD, end to end through std's wrappers.
 *
 * Ways these can fail:
 * - Curvature with the wrong sign convention. std: a face's curvature is positive where the
 *   radius of curvature points away from the normal, so a ball is positive and a bore negative.
 * - A Frenet frame whose normal points away from the center, or a curvature without 1/length units.
 * - The third arc-length derivative scaled by the curve's own parameter speed.
 * - Periodicity of the surface reported where std asks for the trimmed face's.
 * - Raycast hits out of order, behind the origin when not asked for, or more than one when
 *   `closest` (the default).
 * - Deviation measured to the wrong entity, or the maximum not picked.
 * - SVD factors that don't multiply back, or singular values out of order.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const evaluate = (body: string) => {
  const run = studio.run([{ body }]);
  const feature = run.features[0]!;
  if (feature.fault || feature.status !== "OK")
    throw new Error(
      `${feature.fault?.message ?? feature.status}: ${feature.exceptions.map((e) => e.message).join("; ")}`,
    );
  return run;
};
const numbers = (run: ReturnType<typeof evaluate>, name: string): number[] =>
  (untag(variable(run, name)) as readonly FsValue[]).map((x) => untag(x) as number);
const near = (actual: readonly number[], expected: readonly number[], digits = 9) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i], `component ${i}`).toBeCloseTo(value, digits));
};
const pin = `fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });`;
const rim = `qGeometry(qContainsPoint(qCreatedBy(id + "pin", EntityType.EDGE), vector(5, 0, 10) * millimeter), GeometryType.CIRCLE)`;
const wall = `qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.CYLINDER)`;

describe("edge curvature", () => {
  it("gives a circle 1/r, a Frenet frame pointing at the center, and its third derivative", () => {
    const run = evaluate(`${pin}
      const result = evEdgeCurvature(context, { "edge" : ${rim}, "parameter" : 0.25 });
      setVariable(context, "curvature", result.curvature * meter);
      setVariable(context, "unitOk", result.curvature.unit == ({ "meter" : -1 } as UnitSpec));
      setVariable(context, "toCenter", result.frame.origin / millimeter + 5 * result.frame.xAxis);
      setVariable(context, "tangentZ", result.frame.zAxis[2]);
      setVariable(context, "binormalZ", abs(yAxis(result.frame)[2]));
      const derivative = evEdgeCurvatureDerivative(context, { "edge" : ${rim}, "parameter" : 0.25 });
      setVariable(context, "derivative", norm(derivative) * meter ^ 2);
      setVariable(context, "alongTangent", dot(normalize(derivative), result.frame.zAxis));
      const line = evEdgeCurvature(context, { "edge" : qContainsPoint(qCreatedBy(id + "pin", EntityType.EDGE), vector(5, 0, 10) * millimeter)->qGeometry(GeometryType.CIRCLE), "parameter" : 0.25, "arcLengthParameterization" : false });
      setVariable(context, "sameBothWays", abs(line.curvature * meter - 200) < 1e-9);`);
    expect(numberVariable(run, "curvature")).toBeCloseTo(200, 9);
    expect(variable(run, "unitOk")).toBe(true);
    near(numbers(run, "toCenter"), [0, 0, 10]);
    expect(numberVariable(run, "tangentZ")).toBeCloseTo(0, 12);
    expect(numberVariable(run, "binormalZ")).toBeCloseTo(1, 12);
    // d3C/ds3 = d(kN)/ds = -k^2 T for constant curvature k: 200^2 against the tangent.
    expect(numberVariable(run, "derivative")).toBeCloseTo(40000, 3);
    expect(numberVariable(run, "alongTangent")).toBeCloseTo(-1, 9);
    expect(variable(run, "sameBothWays")).toBe(true);
  });

  it("gives a straight spline zero curvature even where its speed changes", () => {
    const run = evaluate(`
      opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 0, 0) * millimeter],
          "startDerivative" : vector(2, 0, 0) * millimeter, "endDerivative" : vector(18, 0, 0) * millimeter });
      const results = evEdgeCurvatures(context, { "edge" : qCreatedBy(id + "spline", EntityType.EDGE), "parameters" : [0.2, 0.7] });
      setVariable(context, "curvatures", mapArray(results, r => r.curvature * meter));
      setVariable(context, "derivative", norm(evEdgeCurvatureDerivative(context, { "edge" : qCreatedBy(id + "spline", EntityType.EDGE), "parameter" : 0.5 })) * meter ^ 2);`);
    for (const k of numbers(run, "curvatures")) expect(k).toBeCloseTo(0, 6);
    expect(numberVariable(run, "derivative")).toBeCloseTo(0, 3);
  });
});

describe("face curvature", () => {
  it("is positive on a ball, zero along a pin's axis and negative around a bore", () => {
    const run = evaluate(`${pin}
      opSphere(context, id + "ball", { "center" : vector(30, 0, 0) * millimeter, "radius" : 5 * millimeter });
      fCuboid(context, id + "block", { "corner1" : vector(50, -10, 0) * millimeter, "corner2" : vector(70, 10, 10) * millimeter });
      fCylinder(context, id + "tool", { "bottomCenter" : vector(60, 0, -1) * millimeter, "topCenter" : vector(60, 0, 11) * millimeter, "radius" : 5 * millimeter });
      opBoolean(context, id + "bore", { "tools" : qCreatedBy(id + "tool", EntityType.BODY), "targets" : qCreatedBy(id + "block", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
      const ball = evFaceCurvature(context, { "face" : qCreatedBy(id + "ball", EntityType.FACE), "parameter" : vector(0.3, 0.6) });
      setVariable(context, "ball", [ball.minCurvature * meter, ball.maxCurvature * meter]);
      const side = evFaceCurvature(context, { "face" : ${wall}, "parameter" : vector(0.3, 0.6) });
      setVariable(context, "pin", [side.minCurvature * meter, side.maxCurvature * meter]);
      setVariable(context, "pinMinAlongAxis", abs(side.minDirection[2]));
      setVariable(context, "pinMaxAcross", abs(side.maxDirection[2]));
      const bore = evFaceCurvature(context, { "face" : qGeometry(qOwnedByBody(qCreatedBy(id + "block", EntityType.BODY), EntityType.FACE), GeometryType.CYLINDER), "parameter" : vector(0.3, 0.6) });
      setVariable(context, "bore", [bore.minCurvature * meter, bore.maxCurvature * meter]);
      setVariable(context, "boreMinAcross", abs(bore.minDirection[2]));
      const top = evFaceCurvature(context, { "face" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(52, 8, 10) * millimeter), "parameter" : vector(0.5, 0.5) });
      setVariable(context, "plane", [top.minCurvature * meter, top.maxCurvature * meter]);`);
    near(numbers(run, "ball"), [200, 200], 6);
    near(numbers(run, "pin"), [0, 200], 6);
    expect(numberVariable(run, "pinMinAlongAxis")).toBeCloseTo(1, 9);
    expect(numberVariable(run, "pinMaxAcross")).toBeCloseTo(0, 9);
    near(numbers(run, "bore"), [-200, 0], 6);
    expect(numberVariable(run, "boreMinAcross")).toBeCloseTo(0, 9);
    near(numbers(run, "plane"), [0, 0], 9);
  });
});

describe("evFacePeriodicity", () => {
  it("reports a full cylinder periodic around, and a half one only untrimmed", () => {
    const run = evaluate(`${pin}
      setVariable(context, "full", evFacePeriodicity(context, { "face" : ${wall} }));
      setVariable(context, "plane", evFacePeriodicity(context, { "face" : qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.PLANE) }));
      opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "pin", EntityType.BODY), "tool" : plane(vector(0, 0, 0) * meter, X_DIRECTION), "keepType" : SplitOperationKeepType.KEEP_FRONT });
      const half = qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.CYLINDER);
      setVariable(context, "half", evFacePeriodicity(context, { "face" : half }));
      setVariable(context, "halfSurface", evFacePeriodicity(context, { "face" : half, "trimmed" : false }));`);
    const flags = (name: string) => (untag(variable(run, name)) as readonly FsValue[]).map(untag);
    expect(flags("full")).toEqual([true, false]);
    expect(flags("plane")).toEqual([false, false]);
    expect(flags("half")).toEqual([false, false]);
    expect(flags("halfSurface")).toEqual([true, false]);
  });
});

describe("evRaycast", () => {
  const cube = `fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });`;
  it("finds faces along a ray, closest first, behind the origin only when asked", () => {
    const run = evaluate(`${cube}
      const up = line(vector(5, 4, -10) * millimeter, vector(0, 0, 1));
      const closest = evRaycast(context, { "entities" : qCreatedBy(id, EntityType.BODY), "ray" : up });
      setVariable(context, "closest", mapArray(closest, hit => hit.distance / millimeter));
      setVariable(context, "closestPoint", closest[0].intersection / millimeter);
      setVariable(context, "closestIsFace", closest[0].entityType == EntityType.FACE && size(evaluateQuery(context, qIntersection([closest[0].entity, qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 4, 0) * millimeter)]))) == 1);
      setVariable(context, "closestParameter", closest[0].parameter);
      const all = evRaycast(context, { "entities" : qCreatedBy(id, EntityType.BODY), "ray" : up, "closest" : false });
      setVariable(context, "all", mapArray(all, hit => hit.distance / millimeter));
      const inside = evRaycast(context, { "entities" : qCreatedBy(id, EntityType.BODY), "ray" : line(vector(5, 4, 3) * millimeter, vector(0, 0, 1)), "closest" : false, "includeIntersectionsBehind" : true });
      setVariable(context, "inside", mapArray(inside, hit => hit.distance / millimeter));
      setVariable(context, "miss", size(evRaycast(context, { "entities" : qCreatedBy(id, EntityType.BODY), "ray" : line(vector(20, 4, -10) * millimeter, vector(0, 0, 1)) })));`);
    near(numbers(run, "closest"), [10]);
    near(numbers(run, "closestPoint"), [5, 4, 0]);
    expect(variable(run, "closestIsFace")).toBe(true);
    const [u, v] = numbers(run, "closestParameter");
    expect(u! >= 0 && u! <= 1 && v! >= 0 && v! <= 1).toBe(true);
    near(numbers(run, "all"), [10, 20]);
    // From z = 3: the bottom 3 mm behind, the top 7 mm ahead, in order along the ray.
    near(numbers(run, "inside"), [-3, 7]);
    expect(numberVariable(run, "miss")).toBe(0);
  });
});

describe("evRaycast on a body and its faces", () => {
  // Each face the ray crosses is one intersection, even when the query names it twice (directly and
  // through its body): through a 10 mm cube, two hits, not four.
  it("reports each face once", () => {
    const run = studio.run([
      {
        body: `fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        const both = qUnion([qCreatedBy(id + "cube", EntityType.BODY), qCreatedBy(id + "cube", EntityType.FACE)]);
        setVariable(context, "hits", size(evRaycast(context, { "entities" : both, "ray" : line(vector(5, 4, -10) * millimeter, Z_DIRECTION), "closest" : false })));`,
      },
    ]);
    expect(numberVariable(run, "hits")).toBe(2);
  });
});

describe("evPointsDeviation", () => {
  it("measures each point to the closest topology, or just the largest", () => {
    const run =
      evaluate(`fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
      const points = [vector(5, 5, 15) * millimeter, vector(12, 5, 5) * millimeter];
      const each = evPointsDeviation(context, { "points" : points, "topologies" : qCreatedBy(id, EntityType.FACE), "allDeviations" : true });
      setVariable(context, "each", mapArray(each, d => d.deviation / millimeter));
      setVariable(context, "closestPoint", each[0].topologyPoint / millimeter);
      const largest = evPointsDeviation(context, { "points" : points, "topologies" : qCreatedBy(id, EntityType.FACE) });
      setVariable(context, "largest", mapArray(largest, d => d.deviation / millimeter));
      setVariable(context, "largestPoint", largest[0].pointPoint / millimeter);`);
    near(numbers(run, "each"), [5, 2]);
    near(numbers(run, "closestPoint"), [5, 5, 10]);
    near(numbers(run, "largest"), [5]);
    near(numbers(run, "largestPoint"), [5, 5, 15]);
  });
});

describe("svd", () => {
  it("factors a matrix into u s v^T with singular values in decreasing order", () => {
    const run = evaluate(`
      for (var m in [matrix([[3, 0], [4, 5]]), matrix([[1, 2], [3, 4], [5, 6]])])
      {
          const result = svd(m);
          setVariable(context, "product" ~ size(m), squaredNorm(result.u * result.s * transpose(result.v) - m));
          setVariable(context, "uOrthogonal" ~ size(m), squaredNorm(transpose(result.u) * result.u - identityMatrix(size(m))));
          setVariable(context, "vOrthogonal" ~ size(m), squaredNorm(transpose(result.v) * result.v - identityMatrix(2)));
          setVariable(context, "sizes" ~ size(m), [matrixSize(result.u), matrixSize(result.s), matrixSize(result.v)]);
          setVariable(context, "singular" ~ size(m), [result.s[0][0], result.s[1][1]]);
      }`);
    for (const n of [2, 3]) {
      expect(numberVariable(run, `product${n}`)).toBeLessThan(1e-20);
      expect(numberVariable(run, `uOrthogonal${n}`)).toBeLessThan(1e-20);
      expect(numberVariable(run, `vOrthogonal${n}`)).toBeLessThan(1e-20);
    }
    // [[3, 0], [4, 5]]^T times itself is [[25, 20], [20, 25]]: eigenvalues 45 and 5.
    near(numbers(run, "singular2"), [3 * Math.sqrt(5), Math.sqrt(5)], 12);
    const sizes = (untag(variable(run, "sizes3")) as readonly FsValue[]).map((s) =>
      (untag(s) as readonly FsValue[]).map(untag),
    );
    expect(sizes).toEqual([
      [3, 3],
      [3, 2],
      [2, 2],
    ]);
  });
});

describe("tolerances and meshes", () => {
  it("finds no tolerance on a parameter and no mesh points", () => {
    const run = evaluate(`
      const info = getParameterToleranceInfo(context, id, { "parameterId" : "depth" });
      setVariable(context, "type", info.toleranceType as string);
      setVariable(context, "override", info.usePrecisionOverride);
      setVariable(context, "points", size(evMeshPoints(context, { "meshes" : qNothing() })));`);
    expect(variable(run, "type")).toBe("NONE");
    expect(variable(run, "override")).toBe(false);
    expect(numberVariable(run, "points")).toBe(0);
  });
});
