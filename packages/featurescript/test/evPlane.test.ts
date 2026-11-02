import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { loadOcct, type Oc } from "../src/geometry/occt.ts";
import type { PartStudioRun } from "../src/Runtime.ts";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { partStudio, variable } from "./partStudio.ts";

/**
 * `evPlane` on planar faces with curved boundaries, and on mate connectors.
 *
 * Ways this goes wrong:
 * 1. The origin (the face's centroid) comes from fixed-order integration, which is exact only on
 *    lines, circles and ellipses: a 150 degree sector bounded by a rational arc lands 1.5e-4 mm
 *    off, so planes disagree with evArea and evApproximateCentroid.
 * 2. STEP turns the rational arc back into a circle, so the test never reaches the adaptive path.
 * 3. A mate connector, which std documents evPlane accepts (`QueryFilterCompound.ALLOWS_PLANE`,
 *    cPlane's offset and point planes), fails with CANNOT_RESOLVE_PLANE.
 * 4. A mate connector's plane takes the wrong axes (its x as the normal) or the world origin.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const numbers = (value: FsValue): number[] =>
  (untag(value) as readonly FsValue[]).flatMap((item) => {
    const inner = untag(item);
    return Array.isArray(inner) ? numbers(inner) : [inner as number];
  });
const statuses = (run: PartStudioRun) =>
  run.features.map((feature) =>
    feature.fault ? `fault: ${feature.fault.message}` : feature.status,
  );
const expectClose = (actual: readonly number[], expected: readonly number[], tolerance: number) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) =>
    expect(Math.abs(value - expected[i]!), `[${i}] ${value}`).toBeLessThan(tolerance),
  );
};
const PLANE_VALUES = `[p.origin / millimeter, p.normal, p.x]`;

/**
 * A planar sector of radius `r` m and `angle` radians in the XY plane, centered on the origin
 * with its bisector along +X, whose arc is one rational quadratic B-spline span (weights 1,
 * cos(angle / 2), 1), as STEP files from other systems often carry circles.
 */
const rationalSector = (oc: Oc, r: number, angle: number) => {
  const half = angle / 2;
  const ends = [-1, 1].map(
    (side) => new oc.gp_Pnt(r * Math.cos(half), side * r * Math.sin(half), 0),
  );
  const poles = new oc.NCollection_Array1_gp_Pnt(1, 3);
  poles.SetValue(1, ends[0]!);
  poles.SetValue(2, new oc.gp_Pnt(r / Math.cos(half), 0, 0));
  poles.SetValue(3, ends[1]!);
  const weights = new oc.NCollection_Array1_double(1, 3);
  [1, Math.cos(half), 1].forEach((weight, i) => weights.SetValue(i + 1, weight));
  const knots = new oc.NCollection_Array1_double(1, 2);
  knots.SetValue(1, 0);
  knots.SetValue(2, 1);
  const multiplicities = new oc.NCollection_Array1_int(1, 2);
  multiplicities.SetValue(1, 3);
  multiplicities.SetValue(2, 3);
  const arc = new oc.Geom_BSplineCurve(poles, weights, knots, multiplicities, 2, false, true);
  const center = new oc.gp_Pnt(0, 0, 0);
  const wire = new oc.BRepBuilderAPI_MakeWire();
  wire.Add(new oc.BRepBuilderAPI_MakeEdge(arc).Edge());
  wire.Add(new oc.BRepBuilderAPI_MakeEdge(ends[1]!, center).Edge());
  wire.Add(new oc.BRepBuilderAPI_MakeEdge(center, ends[0]!).Edge());
  return new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face();
};

describe("evPlane", () => {
  it("puts a rational planar face's origin at its exact centroid", async () => {
    const oc = await loadOcct();
    const [r, angle] = [0.01, (150 * Math.PI) / 180];
    const { writeStep } = await import("../src/geometry/Step.ts");
    const run = studio.runtime.runFeatures(
      [
        {
          module: studio.runtime.load(
            "test/evPlaneRational.fs",
            `FeatureScript 3095;
import(path : "onshape/std/geometry.fs", version : "3095.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        const p = evPlane(context, { "face" : qCreatedBy(makeId("Base"), EntityType.FACE) });
        setVariable(context, "plane", ${PLANE_VALUES});
    });
`,
          ),
          feature: "test",
        },
      ],
      { base: writeStep(oc, [rationalSector(oc, r, angle)]) },
    );
    expect(statuses(run)).toEqual(["OK"]);
    // The arc is still one rational B-spline after the STEP round trip.
    const arcs = ordered(run.geometry!, (e) => e.type === "EDGE" && !e.construction).filter(
      (edge) => {
        const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge.shape));
        return String(curve.GetType()) === "GeomAbs_BSplineCurve" && curve.IsRational();
      },
    );
    expect(arcs).toHaveLength(1);
    // A sector's centroid is 2 r sin(a) / (3 a) from its center along the bisector, a = angle / 2.
    const half = angle / 2;
    const centroid = ((2 * r * Math.sin(half)) / (3 * half)) * 1000;
    expectClose(numbers(variable(run, "plane")), [centroid, 0, 0, 0, 0, 1, 1, 0, 0], 1e-9);
  });

  const connector =
    'opMateConnector(context, id + "mc", { "coordSystem" : coordSystem(vector(10, 20, 30) * millimeter, vector(0, 0, 1), normalize(vector(1, 1, 0))) });';

  it("gives a mate connector's XY plane", () => {
    const run = studio.run([
      {
        body: `${connector}
        const p = evPlane(context, { "face" : qCreatedBy(id + "mc", EntityType.BODY) });
        setVariable(context, "plane", ${PLANE_VALUES});`,
      },
    ]);
    expect(statuses(run)).toEqual(["OK"]);
    const s = Math.SQRT1_2;
    expectClose(numbers(variable(run, "plane")), [10, 20, 30, s, s, 0, 0, 0, 1], 1e-12);
  });

  it("lets std's Plane feature offset from a mate connector", () => {
    const run = studio.run([
      { body: connector },
      {
        std: "cplane.fs",
        feature: "cPlane",
        parameters: {
          entities: 'qCreatedBy(makeId("Feature1") + "mc", EntityType.BODY)',
          cplaneType: "CPlaneType.OFFSET",
          offset: "5 * millimeter",
        },
      },
      {
        body: `const p = evPlane(context, { "face" : qCreatedBy(makeId("Feature2"), EntityType.FACE) });
        setVariable(context, "plane", ${PLANE_VALUES});`,
      },
    ]);
    expect(statuses(run)).toEqual(["OK", "OK", "OK"]);
    // 5 mm along the connector's z, (1, 1, 0) / sqrt(2), from (10, 20, 30) mm.
    const s = Math.SQRT1_2;
    expectClose(
      numbers(variable(run, "plane")),
      [10 + 5 * s, 20 + 5 * s, 30, s, s, 0, 0, 0, 1],
      1e-9,
    );
  });
});
