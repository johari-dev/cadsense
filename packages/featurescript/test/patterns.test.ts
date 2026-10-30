import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { partStudio, solidVolumes, variable } from "./partStudio.ts";

/**
 * Pattern transforms (`@computeLinearPatternTransforms`, `@computeCircularPatternTransforms`,
 * `@computeCurvePatternTransforms`) and std's Linear, Circular and Curve pattern features on parts.
 * std keeps its pre-builtin code for held-back features, which fixes the expected transforms and
 * instance names exactly.
 *
 * Ways this can fail:
 * - Instance names that differ from std's ("i" or "i_j"; negative when centered), which later
 *   features use to find instances.
 * - Offsets accumulated in the wrong grid order, or the seed (0, 0) included.
 * - Circular instances rotated the wrong way, or by the wrong multiple of the angle.
 * - Curve instances composed in the wrong order.
 * - Skipped instances still made, or the wrong ones skipped.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const cube = (from = [0, 0, 0], size = 10) =>
  `fCuboid(context, id + "cube", { "corner1" : vector(${from.join(", ")}) * millimeter, "corner2" : vector(${from.map((c) => c + size).join(", ")}) * millimeter });`;
const at = (type: string, x: number, y: number, z: number, feature = "Feature1") =>
  `qContainsPoint(qCreatedBy(makeId("${feature}"), EntityType.${type}), vector(${x}, ${y}, ${z}) * millimeter)`;
const solids = `qBodyType(qCreatedBy(makeId("Feature1"), EntityType.BODY), BodyType.SOLID)`;

/** Runs a builtin with `definition` inside a feature; returns names and translations in mm. */
const transforms = (builtin: string, definition: string) => {
  const run = studio.run([
    {
      body: `
      const result = @${builtin}(context, ${definition});
      setVariable(context, "names", result.instanceNames);
      setVariable(context, "translations", mapArray(result.transforms, t => t.translation / millimeter));
      setVariable(context, "allTransforms", size(filter(result.transforms, t => t is Transform)) == size(result.transforms));`,
    },
  ]);
  const feature = run.features[0]!;
  if (feature.fault || feature.status !== "OK")
    throw new Error(feature.fault?.message ?? feature.exceptions.map((e) => e.message).join("; "));
  expect(variable(run, "allTransforms")).toBe(true);
  const names = (untag(variable(run, "names")) as readonly FsValue[]).map((name) => untag(name));
  const translations = (untag(variable(run, "translations")) as readonly FsValue[]).map((t) =>
    (untag(t) as readonly FsValue[]).map((c) => Math.round((untag(c) as number) * 1e6) / 1e6 + 0),
  );
  return { names, translations };
};

/** Each solid's centroid in mm, in creation order. */
const centroids = (run: ReturnType<typeof studio.run>) =>
  ordered(run.geometry!, (entity) => entity.type === "BODY" && entity.bodyType === "SOLID").map(
    (body) => {
      const oc = run.oc!;
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
      const c = props.CentreOfMass();
      return [c.X(), c.Y(), c.Z()].map((v) => Math.round(v * 1e9) / 1e6 + 0);
    },
  );
const sorted = (points: number[][]) =>
  points.toSorted((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);

describe("linear pattern transforms", () => {
  const offsets =
    '"offset1" : vector(20, 0, 0) * millimeter, "offset2" : vector(0, 15, 0) * millimeter';
  it("names instances i or i_j and offsets them on the grid, without the seed", () => {
    expect(
      transforms(
        "computeLinearPatternTransforms",
        `{ ${offsets}, "instanceCount" : 3, "instanceCountTwo" : 2, "isCentered" : false, "isCenteredTwo" : false, "skipInstances" : false }`,
      ),
    ).toEqual({
      names: ["1", "2", "0_1", "1_1", "2_1"],
      translations: [
        [20, 0, 0],
        [40, 0, 0],
        [0, 15, 0],
        [20, 15, 0],
        [40, 15, 0],
      ],
    });
  });
  it("centers on the seed, and skips listed instances", () => {
    expect(
      transforms(
        "computeLinearPatternTransforms",
        `{ ${offsets}, "instanceCount" : 2, "instanceCountTwo" : 1, "isCentered" : true, "isCenteredTwo" : false,
           "skipInstances" : true, "skippedInstances" : [{ "index1" : 1, "index2" : 0 }] }`,
      ),
    ).toEqual({ names: ["-1"], translations: [[-20, 0, 0]] });
  });
});

describe("circular pattern transforms", () => {
  it("turns instance i by i times the angle about the axis", () => {
    const result = transforms(
      "computeCircularPatternTransforms",
      `{ "axis" : line(vector(10, 0, 0) * millimeter, vector(0, 0, 1)), "angle" : 90 * degree, "instanceCount" : 3, "isCentered" : false, "skipInstances" : false }`,
    );
    expect(result.names).toEqual(["1", "2"]);
    // About (10, 0): the origin goes to (10, -10) after 90 degrees and (20, 0) after 180.
    expect(result.translations).toEqual([
      [10, -10, 0],
      [20, 0, 0],
    ]);
  });
  it("names centered instances by signed index and skips listed ones", () => {
    const result = transforms(
      "computeCircularPatternTransforms",
      `{ "axis" : line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "angle" : 30 * degree, "instanceCount" : 3, "isCentered" : true,
         "skipInstances" : true, "skippedInstances" : [{ "index" : -1 }] }`,
    );
    expect(result.names).toEqual(["-2", "1", "2"]);
  });
});

describe("curve pattern transforms", () => {
  it("composes each step's transform onto the previous instance's", () => {
    const result = transforms(
      "computeCurvePatternTransforms",
      `{ "instanceCount" : 3, "skipInstances" : false, "tangents" : [
          line(vector(0, 0, 0) * millimeter, vector(1, 0, 0)),
          line(vector(10, 0, 0) * millimeter, vector(0, 1, 0)),
          line(vector(10, 10, 0) * millimeter, vector(-1, 0, 0)) ] }`,
    );
    expect(result.names).toEqual(["1", "2"]);
    // A translation is where an instance takes the origin. Step 1 turns +X to +Y and lands at
    // (10, 0). Step 2 turns +Y to -X about the origin, then moves (10, 0) onto (10, 10), so it
    // takes (10, 0) to (10, 10): instance 2 = step 2 after instance 1.
    expect(result.translations[0]).toEqual([10, 0, 0]);
    expect(result.translations[1]).toEqual([10, 10, 0]);
  });
});

describe("std pattern features on parts", () => {
  it("Linear pattern makes the grid", () => {
    const run = studio.run([
      { body: cube() },
      {
        std: "linearPattern.fs",
        feature: "linearPattern",
        parameters: {
          entities: solids,
          // Face normals: an edge's own direction is arbitrary in either kernel.
          directionOne: at("FACE", 10, 5, 5),
          distance: "20 * millimeter",
          instanceCount: "3",
          hasSecondDir: "true",
          directionTwo: at("FACE", 5, 10, 5),
          distanceTwo: "15 * millimeter",
          instanceCountTwo: "2",
        },
      },
    ]);
    expect(run.features.map((f) => f.fault?.message ?? f.status)).toEqual(["OK", "OK"]);
    expect(solidVolumes(run).map((v) => Math.round(v))).toEqual(Array(6).fill(1000));
    expect(sorted(centroids(run))).toEqual(
      sorted([0, 20, 40].flatMap((x) => [0, 15].map((y) => [x + 5, y + 5, 5]))),
    );
  });

  it("Circular pattern spaces instances around the axis", () => {
    const run = studio.run([
      {
        body: `${cube([20, -5, 0])}
        fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 2 * millimeter });`,
      },
      {
        std: "circularPattern.fs",
        feature: "circularPattern",
        parameters: {
          entities: at("BODY", 30, 0, 5),
          axis: `qGeometry(qCreatedBy(makeId("Feature1"), EntityType.FACE), GeometryType.CYLINDER)`,
          angle: "360 * degree",
          instanceCount: "4",
          equalSpace: "true",
        },
      },
    ]);
    expect(run.features.map((f) => f.fault?.message ?? f.status)).toEqual(["OK", "OK"]);
    const cubes = centroids(run).filter((c) => Math.hypot(c[0]!, c[1]!) > 1);
    expect(sorted(cubes)).toEqual(
      sorted([
        [25, 0, 5],
        [0, 25, 5],
        [-25, 0, 5],
        [0, -25, 5],
      ]),
    );
  });

  it("Curve pattern with locked orientation spaces instances along the path", () => {
    const run = studio.run([
      { body: cube() },
      {
        body: `
        const sketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : XY_PLANE });
        skLineSegment(sketch, "line", { "start" : vector(5, 5) * millimeter, "end" : vector(5, 35) * millimeter });
        skSolve(sketch);`,
      },
      {
        std: "curvePattern.fs",
        feature: "curvePattern",
        parameters: {
          entities: solids,
          edges: `qCreatedBy(makeId("Feature2"), EntityType.EDGE)`,
          instanceCount: "4",
          spacingType: "CurvePatternSpacingType.EQUAL",
          orientationType: "CurvePatternOrientationType.KEEP_ORIENTATION",
        },
      },
    ]);
    expect(run.features.map((f) => f.fault?.message ?? f.status)).toEqual(["OK", "OK", "OK"]);
    expect(sorted(centroids(run))).toEqual(sorted([0, 10, 20, 30].map((y) => [5, y + 5, 5])));
  });
});
