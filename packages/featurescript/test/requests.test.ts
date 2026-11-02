import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, variable } from "./partStudio.ts";

/**
 * Requests from other streams for this stream's files.
 *
 * Ways these fail:
 * - qOwnedByBody(query, body) ignores `query` and returns every entity of the body.
 * - evAxis rejects a mate connector, which std's Hole and Helix pass as an axis.
 * - evBox3d with a `cSys` measures in world coordinates.
 * - evSurfaceDefinition can't describe a cone, or puts its frame anywhere but the apex.
 * - getParameterToleranceInfo makes std's getToleranceInfo answer differently from the path std
 *   takes when the builtin throws.
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
const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';

describe("requests", () => {
  it("qOwnedByBody with a query keeps only that query's entities of the body", () => {
    const run = evaluate(`${cube}
      fCuboid(context, id + "other", { "corner1" : vector(20, 0, 0) * millimeter, "corner2" : vector(30, 10, 10) * millimeter });
      const body = qCreatedBy(id + "cube", EntityType.BODY);
      setVariable(context, "all", size(evaluateQuery(context, qOwnedByBody(body, EntityType.FACE))));
      setVariable(context, "filtered", size(evaluateQuery(context, qOwnedByBody(qGeometry(qCreatedBy(id, EntityType.FACE), GeometryType.PLANE)->qContainsPoint(vector(5, 5, 10) * millimeter), body))));
      setVariable(context, "otherBody", size(evaluateQuery(context, qOwnedByBody(qCreatedBy(id + "other", EntityType.FACE), body))));`);
    expect(numberVariable(run, "all")).toBe(6);
    expect(numberVariable(run, "filtered")).toBe(1);
    expect(numberVariable(run, "otherBody")).toBe(0);
  });

  it("evAxis takes a mate connector's origin and Z axis", () => {
    const run = evaluate(`
      opMateConnector(context, id + "mc", { "coordSystem" : coordSystem(vector(1, 2, 3) * millimeter, X_DIRECTION, Y_DIRECTION) });
      const axis = evAxis(context, { "axis" : qCreatedBy(id + "mc", EntityType.BODY) });
      setVariable(context, "origin", axis.origin / millimeter);
      setVariable(context, "direction", axis.direction);`);
    near(numbers(run, "origin"), [1, 2, 3]);
    near(numbers(run, "direction"), [0, 1, 0]);
  });

  it("evBox3d measures in a given coordinate system", () => {
    // Local x is world +Y, local z world +Z, so local y = z x x is world -X.
    const run = evaluate(`
      fCuboid(context, id + "block", { "corner1" : vector(1, 3, 6) * millimeter, "corner2" : vector(2, 5, 9) * millimeter });
      const box = evBox3d(context, { "topology" : qCreatedBy(id + "block", EntityType.BODY), "cSys" : coordSystem(vector(0, 0, 0) * meter, Y_DIRECTION, Z_DIRECTION) });
      setVariable(context, "min", box.minCorner / millimeter);
      setVariable(context, "max", box.maxCorner / millimeter);`);
    near(numbers(run, "min"), [3, -2, 6], 6);
    near(numbers(run, "max"), [5, -1, 9], 6);
  });

  it("evSurfaceDefinition describes a cone from its apex", () => {
    // Radius 5 at z = 0 to 2 at z = 10: the apex is 2 * 10 / 3 above the top, and the cone opens
    // downward with tan(half angle) = 3 / 10.
    const run = evaluate(`
      fCone(context, id + "cone", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "bottomRadius" : 5 * millimeter, "topRadius" : 2 * millimeter });
      const cone = evSurfaceDefinition(context, { "face" : qGeometry(qCreatedBy(id, EntityType.FACE), GeometryType.CONE) });
      setVariable(context, "isCone", cone is Cone);
      setVariable(context, "apex", cone.coordSystem.origin / millimeter);
      setVariable(context, "z", cone.coordSystem.zAxis);
      setVariable(context, "halfAngle", cone.halfAngle / radian);`);
    expect(variable(run, "isCone")).toBe(true);
    near(numbers(run, "apex"), [0, 0, 10 + 20 / 3], 6);
    near(numbers(run, "z"), [0, 0, -1]);
    expect(numberVariable(run, "halfAngle")).toBeCloseTo(Math.atan(3 / 10), 9);
  });

  it("getToleranceInfo answers as when the builtin throws: no tolerance", () => {
    const run = evaluate(`
      setVariable(context, "same", getToleranceInfo(context, id, {}, "depth", false) ==
          ({ "toleranceType" : ToleranceType.NONE, "usePrecisionOverride" : false } as ToleranceInfo));`);
    expect(variable(run, "same")).toBe(true);
  });
});
