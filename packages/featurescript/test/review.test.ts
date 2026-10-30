import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { loadOcct, subShapes, type Oc, type Shape } from "../src/geometry/occt.ts";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, solidVolumes, variable } from "./partStudio.ts";

/**
 * Findings from the first adversarial review of the evaluators stream, each reproduced first.
 *
 * Ways these failed:
 * 1. lastOperationId and lastModifyingOperationId returned markers, so std's
 *    `qCreatedBy(lastModifyingOperationId(...))` (importDerived.fs) found nothing.
 * 2. Aborting a feature with an open child left the child's held-back version active.
 * 3. Arc length came from 64 uniform spans, so a long wiggly spline put t = 0.1 at 12.7%.
 * 4. Planarity was checked on 17 samples, so a spline zigzagging between them passed.
 * 5. Tracking that follows splits returned one body after the body was split.
 * 6. evCornerType returned a map where std held back before V488 expects the type itself.
 * 7. svd's absolute convergence threshold skipped tiny matrices.
 *
 * Round 2:
 * 8. qCoincidentFilter and qCoincidesWithPlane compared a few sample points: a zigzag spline
 *    passed as coincident with a flat one and as lying in a plane, and a disk cap compared with
 *    itself failed because rectangular UV samples fell outside the trimmed disk.
 * 9. Fillet radii came from the opFillet definition, so they went stale after a scale.
 * 10. An operation that failed on a later body left its earlier bodies changed.
 * 11. Tracking that follows splits faulted on splits made before tracking began.
 *
 * Round 3:
 * 12. Spline poles got the edge's placement twice (BRepAdaptor_Curve already applies it), so a
 *     placed assembly instance's splines missed their own plane and matched one 5 mm away.
 * 13. Full circles that start at different points never coincided, and faces compared seam
 *     edges, so a copy turned about its own axis matched nothing.
 *
 * Round 4:
 * 14. evMateConnectorCoordSystem read secondaryOriginQuery even when std omits it, so std's Decal
 *     (decal.fs passes only originQuery, CENTROID and requireOwnerPart) failed.
 * 15. Faces matched boundaries edge by edge, so the same face with its boundary cut at different
 *     points (a split sketch line, or a seam left inside a kept arc) never coincided.
 * 16. evBox3d's tight box came out 1e-7 m too big around spline geometry (BRepBndLib.AddOptimal).
 * 17. Areas, volumes and centroids used fixed-order integration, 0.17% off on a rational cylinder.
 *
 * Round 5:
 * 18. Extremes along a direction (evBox3d, qFarthestAlong, qInFrontOfPlane, qIntersectsPlane) came
 *     from BRepExtrema's distance to a far plane, which can miss a maximum inside a curved face
 *     without saying so: a turned sphere's box cut into it, a turned spline sheet's by 2 mm.
 * 19. Adaptive integration ran on every face, 5x to 26x slower than fixed order on analytic faces
 *     where fixed order is already exact, and qCoincidentFilter measured the same face per pair.
 * 20. Extremes stopped the run on surfaces of revolution, Bezier surfaces, and hyperbola and
 *     parabola edges, so std features that box a part turned from a spline (transform's rotate
 *     manipulator, among others) stopped too.
 * 21. evBox3d's `tight : false` took the exact path, so it could stop the run where std only asks
 *     for a box at least as big.
 * 22. Whether a sphere's or torus's peak (or a search's) lies on its trimmed face came from
 *     BRepExtrema, which puts points millimeters off a turned face; a wrong "off" lowers the box.
 * 23. Edge lengths, centroids and length comparisons used fixed-order integration, 4.5e-4 short
 *     on a quadratic spline bent 90 degrees and 3.9e-4 on an ellipse arc.
 * 24. evDistance gave every side the parameter 0, so std's fillet passed 0 to evFaceTangentPlane
 *     as a face parameter, failed its precondition and took a fallback.
 *
 * Round 6:
 * 25. evDistance gave a sheet body stored as one face that face's parameters; bodies get 0.
 * 26. evRaycast crashed the whole run when a ray hit a face exactly on its edge or corner: it read
 *     the face parameter from BRepExtrema, which throws when the closest support isn't the face.
 * 27. evDistance ignored extendSide0 and extendSide1, so a measured Variable to a construction
 *     plane and cPlane's curve point measured to the bounded entities.
 * 28. Two unbounded extended sides stopped the run, and Line and Plane values weren't sides at all,
 *     so std's move face up to a plane and Variable's extendEntities stopped.
 *
 * Round 7:
 * 29. An extended cone face took in the mirror half through its apex; Parasolid's (and so
 *     Onshape's) cone is the half on the face's side.
 * 30. cPlane's curve point stopped on spline edges (its evDistance extends the edge), even with
 *     the vertex on the edge, where the extension can't change anything.
 * 31. Parallel lines along everyday directions such as (1, 1, 0) missed the parallel test (it
 *     read 1 - k^2, which rounds above 0) and took the skew formula, not the documented tie.
 * 32. An extended arc's parameter followed "the turn after the edge's start" only on edges along
 *     their curve; a reversed edge got the turn before it.
 * 33. Planar faces got real evDistance parameters; std documents zeros for planes (and meshes)
 *     unless useFaceParameter asks for them.
 *
 * Round 8:
 * 34. Those zeros stacked curve pattern instances: std sweeps a thin strip along the path and
 *     places each instance at the strip's tangent plane at evDistance's parameter, and along a
 *     straight edge the strip is a plane here. Planes get real parameters again.
 * 35. Nearly parallel lines and planes divided by 1 - k^2, which rounds to 0 (NaN) or far off
 *     (5.0000554 for 5 mm at 1e-7 rad).
 * 36. evFaceTangentPlanes ignored returnUndefinedOutsideFace: a disk's corner of its parameter
 *     box gave a plane off the face.
 *
 * Round 9:
 * 37. returnUndefinedOutsideFace classified periodic parameters without wrapping them, so a full
 *     cylinder's (-0.1, 0.5) was off the face though (0.9, 0.5) is the same point.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const ok = (run: ReturnType<typeof studio.run>) =>
  run.features.map((feature) =>
    feature.fault ? `fault: ${feature.fault.message}` : feature.status,
  );
const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
const face = (x: number, y: number, z: number) =>
  `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;

describe("1. operation ids", () => {
  it("are the operations' own ids, so qCreatedBy finds what they created", () => {
    const run = studio.run([
      {
        body: `${cube}
        setVariable(context, "last", (@lastOperationId(context) as Id) == id + "cube" + "deleteSketch");
        const created = lastModifyingOperationId(context, ${face(5, 5, 10)});
        setVariable(context, "createdIsExtrude", created == id + "cube" + "extrude");
        setVariable(context, "roundTrip", size(evaluateQuery(context, qIntersection([qCreatedBy(created, EntityType.FACE), ${face(5, 5, 10)}]))));
        fillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(id, EntityType.EDGE), vector(5, 0, 10) * millimeter), "radius" : 1 * millimeter });
        const modified = lastModifyingOperationId(context, ${face(5, 5, 10)});
        setVariable(context, "modifiedByFillet", size(modified) >= 2 && modified[1] == "fillet");
        // std: "Entities modified, but not created, by an operation are not returned" by qCreatedBy.
        setVariable(context, "modifiedNotCreated", size(evaluateQuery(context, qIntersection([qCreatedBy(modified, EntityType.FACE), ${face(5, 5, 10)}]))));
        setVariable(context, "backUntouched", lastModifyingOperationId(context, ${face(5, 10, 5)}) == id + "cube" + "extrude");
        opMateConnector(context, id + "mc", { "coordSystem" : coordSystem(vector(0, 0, 0) * meter, X_DIRECTION, Z_DIRECTION) });
        const connector = lastModifyingOperationId(context, qCreatedBy(id + "mc", EntityType.BODY));
        setVariable(context, "connector", size(evaluateQuery(context, qCreatedBy(connector, EntityType.BODY))));`,
      },
      {
        body: `
        opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(makeId("Feature1"), EntityType.BODY) });
        throw regenError("undo");`,
      },
      {
        body: 'setVariable(context, "lastAfterRollback", (@lastOperationId(context) as Id) == makeId("Feature1") + "mc");',
      },
    ]);
    expect(ok(run)).toEqual(["OK", "ERROR", "OK"]);
    expect(variable(run, "last", 0)).toBe(true);
    expect(variable(run, "createdIsExtrude", 0)).toBe(true);
    expect(numberVariable(run, "roundTrip", 0)).toBe(1);
    expect(variable(run, "modifiedByFillet", 0)).toBe(true);
    expect(numberVariable(run, "modifiedNotCreated", 0)).toBe(0);
    expect(variable(run, "backUntouched", 0)).toBe(true);
    expect(numberVariable(run, "connector", 0)).toBe(1);
    expect(variable(run, "lastAfterRollback")).toBe(true);
  });

  it("stop the run where no operation has run yet", () => {
    // A Part Studio's default features are operations (std's addDefaultFeatures ends with the
    // Right plane's opPlane), so only a fresh context has run none.
    const run = studio.run([
      {
        body: 'setVariable(context, "first", (@lastOperationId(context) as Id) == makeId("Right"));',
      },
      { body: "@lastOperationId(newContext());" },
    ]);
    expect(variable(run, "first", 0)).toBe(true);
    expect(run.features[1]!.fault?.message).toMatch(/no operation/);
  });
});

describe("2. held-back versions", () => {
  const V681 = "FeatureScriptVersionNumber.V681_ANGLE_BOUNDS_CHANGE";
  const check =
    'setVariable(context, "current", isAtVersionOrLater(context, FeatureScriptVersionNumber.V694_FILL_GUIDE_CURVES_FS));';
  it("end with the feature that aborts, even with a child still open", () => {
    const thrown = studio.run([
      {
        body: `startFeature(context, id + "child", { "asVersion" : ${V681} });\nthrow regenError("failed child");`,
      },
      { body: check },
    ]);
    expect(ok(thrown)).toEqual(["ERROR", "OK"]);
    expect(variable(thrown, "current")).toBe(true);
    const explicit = studio.run([
      {
        body: `
        startFeature(context, id + "outer", {});
        startFeature(context, id + "outer" + "inner", { "asVersion" : ${V681} });
        abortFeature(context, id + "outer");
        ${check}`,
      },
    ]);
    expect(ok(explicit)).toEqual(["OK"]);
    expect(variable(explicit, "current")).toBe(true);
    const ended = studio.run([
      {
        body: `
        startFeature(context, id + "outer", {});
        startFeature(context, id + "outer" + "inner", { "asVersion" : ${V681} });
        endFeature(context, id + "outer");
        ${check}`,
      },
    ]);
    expect(variable(ended, "current")).toBe(true);
  });
});

describe("3. arc length on a long wiggly spline", () => {
  it("lands parameters at their share of the length", () => {
    // 1025 points 0.1 mm apart in x, zigzagging 1 mm in z over the first half.
    const points = Array.from(
      { length: 1025 },
      (_, i) => `vector(${(0.1 * i).toFixed(1)}, 0, ${i < 512 ? i % 2 : 0}) * millimeter`,
    );
    const run = studio.run([
      {
        body: `
        opFitSpline(context, id + "spline", { "points" : [${points.join(", ")}] });
        const lines = evEdgeTangentLines(context, { "edge" : qCreatedBy(id + "spline", EntityType.EDGE), "parameters" : [0.1, 0.5, 0.9] });
        setVariable(context, "points", mapArray(lines, line => line.origin / meter));`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // Reference: a 400 000-segment polyline in the curve's own parameter.
    const oc = run.oc!;
    const [edge] = ordered(
      run.geometry!,
      (entity) => entity.type === "EDGE" && !entity.construction,
    );
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge!.shape));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    const n = 400_000;
    const xs = new Float64Array(n + 1);
    const ys = new Float64Array(n + 1);
    const zs = new Float64Array(n + 1);
    const cumulative = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const p = curve.EvalD0(a + ((b - a) * i) / n);
      [xs[i], ys[i], zs[i]] = [p.X(), p.Y(), p.Z()];
      if (i > 0)
        cumulative[i] =
          cumulative[i - 1]! +
          Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!, zs[i]! - zs[i - 1]!);
    }
    const total = cumulative[n]!;
    const fractionAt = (p: readonly number[]) => {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i <= n; i++) {
        const d = Math.hypot(xs[i]! - p[0]!, ys[i]! - p[1]!, zs[i]! - p[2]!);
        if (d < bestDistance) [best, bestDistance] = [i, d];
      }
      return cumulative[best]! / total;
    };
    const found = (untag(variable(run, "points")) as readonly FsValue[]).map((p) =>
      (untag(p) as readonly FsValue[]).map((c) => untag(c) as number),
    );
    [0.1, 0.5, 0.9].forEach((t, i) => expect(fractionAt(found[i]!), `t = ${t}`).toBeCloseTo(t, 4));
  });
});

describe("4. planar edges", () => {
  it("refuse a spline that zigzags off every plane, and keep a planar one", () => {
    const points = (z: (i: number) => number) =>
      Array.from(
        { length: 33 },
        (_, i) =>
          `vector(${10 * Math.cos((i * Math.PI) / 32)}, ${10 * Math.sin((i * Math.PI) / 32)}, ${z(i)}) * millimeter`,
      ).join(", ");
    const run = studio.run([
      {
        body: `
        opFitSpline(context, id + "zigzag", { "points" : [${points((i) => i % 2)}] });
        opFitSpline(context, id + "flat", { "points" : [${points(() => 0)}] });
        var caught;
        try silent { evPlanarEdge(context, { "edge" : qCreatedBy(id + "zigzag", EntityType.EDGE) }); }
        catch (error) { caught = error.message; }
        setVariable(context, "zigzag", caught);
        setVariable(context, "flatNormalZ", abs(evPlanarEdge(context, { "edge" : qCreatedBy(id + "flat", EntityType.EDGE) }).normal[2]));`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect(String(untag(variable(run, "zigzag")))).toBe("CANNOT_RESOLVE_PLANE");
    expect(numberVariable(run, "flatNormalZ")).toBeCloseTo(1, 12);
  });
});

describe("5. tracking through splits", () => {
  const trackBody = {
    std: "queryVariable.fs",
    feature: "queryVariable",
    parameters: {
      name: '"part"',
      selectionType: "SelectionType.SELECTION",
      selectionQuery: 'qCreatedBy(makeId("Feature1"), EntityType.BODY)',
    },
  };
  const read = {
    body: 'setVariable(context, "count", size(evaluateQuery(context, getQueryVariable(context, "part"))));',
  };
  it("stops the run when a tracked body may have been split", () => {
    const run = studio.run([
      { body: cube },
      trackBody,
      {
        body: 'opSplitPart(context, id + "split", { "targets" : qCreatedBy(makeId("Feature1"), EntityType.BODY), "tool" : plane(vector(5, 0, 0) * millimeter, X_DIRECTION) });',
      },
      read,
    ]);
    expect(ok(run).slice(0, 3)).toEqual(["OK", "OK", "OK"]);
    expect(run.features[3]!.fault?.message).toMatch(/split, merged or consumed/);
  });
  it("still follows a body that was only modified", () => {
    const run = studio.run([
      { body: cube },
      trackBody,
      {
        body: 'fillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.EDGE), vector(5, 0, 10) * millimeter), "radius" : 1 * millimeter });',
      },
      read,
    ]);
    expect(ok(run)).toEqual(["OK", "OK", "OK", "OK"]);
    expect(numberVariable(run, "count")).toBe(1);
  });
});

describe("6. evCornerType before V488", () => {
  it("returns the corner type itself, as std's older wrapper expects", () => {
    const run = studio.run([
      {
        parameters: { asVersion: "FeatureScriptVersionNumber.V487_IMPORT_FILTER_POINT_BODIES" },
        body: `${cube}
        const corner = evCornerType(context, { "vertex" : qContainsPoint(qCreatedBy(id, EntityType.VERTEX), vector(10, 10, 10) * millimeter) });
        setVariable(context, "type", corner.cornerType == SMCornerType.NOT_A_CORNER);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect(variable(run, "type")).toBe(true);
  });
});

describe("7. svd at any scale", () => {
  it("reconstructs tiny, ordinary and huge matrices", () => {
    const run = studio.run([
      {
        body: `
        setVariable(context, "errors", mapArray([1e-80, 1, 1e80], function(scale) {
            const m = matrix([[1, 1], [0, 1]]) * scale;
            const result = svd(m);
            return squaredNorm(result.u * result.s * transpose(result.v) - m) / squaredNorm(m);
        }));`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    for (const error of (untag(variable(run, "errors")) as readonly FsValue[]).map(untag))
      expect(error as number).toBeLessThan(1e-28);
  });
});

describe("8. exact coincidence", () => {
  const splines = `
    var zigzag = [];
    var flat = [];
    for (var i = 0; i <= 32; i += 1)
    {
        zigzag = append(zigzag, vector(10 * cos(i * PI / 32 * radian), 10 * sin(i * PI / 32 * radian), i % 2) * millimeter);
        flat = append(flat, vector(10 * cos(i * PI / 32 * radian), 10 * sin(i * PI / 32 * radian), 0) * millimeter);
    }
    opFitSpline(context, id + "zigzag", { "points" : zigzag });
    opFitSpline(context, id + "flat", { "points" : flat });
    fCylinder(context, id + "pin", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 10) * millimeter, "radius" : 5 * millimeter });
    fCylinder(context, id + "twin", { "bottomCenter" : vector(30, 0, 10) * millimeter, "topCenter" : vector(30, 0, 20) * millimeter, "radius" : 5 * millimeter });
    fCuboid(context, id + "a", { "corner1" : vector(50, 0, 0) * millimeter, "corner2" : vector(60, 10, 10) * millimeter });
    fCuboid(context, id + "b", { "corner1" : vector(60, 0, 0) * millimeter, "corner2" : vector(70, 10, 10) * millimeter });`;
  const count = (query: string) => `size(evaluateQuery(context, ${query}))`;
  it("tells a zigzag from a flat spline, and finds a trimmed disk and shared edges and faces", () => {
    const zigzag = 'qCreatedBy(id + "zigzag", EntityType.EDGE)';
    const flat = 'qCreatedBy(id + "flat", EntityType.EDGE)';
    const cap =
      'qContainsPoint(qCreatedBy(id + "pin", EntityType.FACE), vector(30, 0, 10) * millimeter)';
    const twinCap =
      'qContainsPoint(qCreatedBy(id + "twin", EntityType.FACE), vector(30, 0, 10) * millimeter)';
    const run = studio.run([
      {
        body: `${splines}
        setVariable(context, "counts", [
            ${count(`qCoincidentFilter(${zigzag}, ${flat})`)},
            ${count(`qCoincidesWithPlane(${zigzag}, XY_PLANE)`)},
            ${count(`qCoincidesWithPlane(${flat}, XY_PLANE)`)},
            ${count(`qCoincidentFilter(${cap}, ${cap})`)},
            ${count(`qCoincidentFilter(${cap}, ${twinCap})`)},
            ${count('qCoincidentFilter(qContainsPoint(qCreatedBy(id + "a", EntityType.FACE), vector(60, 5, 5) * millimeter), qContainsPoint(qCreatedBy(id + "b", EntityType.FACE), vector(60, 5, 5) * millimeter))')},
            ${count('qCoincidentFilter(qCreatedBy(id + "a", EntityType.EDGE), qContainsPoint(qCreatedBy(id + "b", EntityType.EDGE), vector(60, 5, 0) * millimeter))')},
            ${count(`qCoincidesWithPlane(${cap}, plane(vector(0, 0, 10) * millimeter, Z_DIRECTION))`)},
            ${count('qCoincidesWithPlane(qCreatedBy(id + "pin", EntityType.FACE), plane(vector(0, 0, 10) * millimeter, Z_DIRECTION))')}]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // zigzag vs flat, zigzag in XY, flat in XY, cap vs itself, cap vs the twin's touching bottom
    // cap, the two boxes' touching faces, their shared edge, the cap in its plane, the pin's
    // faces in that plane (just the cap).
    expect((untag(variable(run, "counts")) as readonly FsValue[]).map(untag)).toEqual([
      0, 0, 1, 1, 1, 1, 1, 1, 1,
    ]);
  });
});

describe("9. fillet radii follow the geometry", () => {
  it("reads a scaled fillet's radius from its surface", () => {
    const run = studio.run([
      {
        body: `${cube}
        opFillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(id + "cube", EntityType.EDGE), vector(5, 0, 10) * millimeter), "radius" : 1 * millimeter });
        opTransform(context, id + "scale", { "bodies" : qCreatedBy(id + "cube", EntityType.BODY), "transform" : scaleUniformly(2) });
        opFillet(context, id + "second", { "entities" : qContainsPoint(qOwnedByBody(qCreatedBy(id + "cube", EntityType.BODY), EntityType.EDGE), vector(10, 20, 20) * millimeter), "radius" : 2 * millimeter });
        const first = qCreatedBy(id + "fillet", EntityType.FACE);
        setVariable(context, "radius", evFilletRadius(context, { "face" : first }) / millimeter);
        setVariable(context, "equal", size(evaluateQuery(context, qFilletFaces(first, CompareType.EQUAL))));`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect(numberVariable(run, "radius")).toBeCloseTo(2, 9);
    expect(numberVariable(run, "equal")).toBe(2);
  });
});

describe("10. atomic operations", () => {
  const tiny =
    'fCuboid(context, id + "tiny", { "corner1" : vector(20, 0, 0) * millimeter, "corner2" : vector(20.1, 0.1, 0.1) * millimeter });';
  const edges =
    'qUnion([qContainsPoint(qCreatedBy(id + "cube", EntityType.EDGE), vector(5, 0, 10) * millimeter), qContainsPoint(qCreatedBy(id + "tiny", EntityType.EDGE), vector(20.05, 0, 0.1) * millimeter)])';
  const after = `
    setVariable(context, "caught", caught);
    setVariable(context, "faces", size(evaluateQuery(context, qOwnedByBody(qCreatedBy(id + "cube", EntityType.BODY), EntityType.FACE))));
    setVariable(context, "last", lastModifyingOperationId(context, qContainsPoint(qCreatedBy(id + "cube", EntityType.FACE), vector(5, 5, 10) * millimeter)) == id + "cube" + "extrude");`;
  for (const [name, operation] of [
    [
      "opFillet",
      `opFillet(context, id + "bad", { "entities" : ${edges}, "radius" : 1 * millimeter });`,
    ],
    [
      "opChamfer",
      `opChamfer(context, id + "bad", { "entities" : ${edges}, "chamferType" : ChamferType.EQUAL_OFFSETS, "width" : 1 * millimeter });`,
    ],
  ] as const)
    it(`leaves nothing behind when ${name} fails on a later body`, () => {
      const run = studio.run([
        {
          body: `${cube}${tiny}
          var caught = false;
          try silent { ${operation} }
          catch { caught = true; }
          ${after}`,
        },
      ]);
      expect(ok(run)).toEqual(["OK"]);
      expect(variable(run, "caught")).toBe(true);
      expect(numberVariable(run, "faces")).toBe(6);
      expect(variable(run, "last")).toBe(true);
    });
});

describe("11. tracking after an earlier split", () => {
  it("follows a body split before tracking began", () => {
    const run = studio.run([
      {
        body: `${cube}
        opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "cube", EntityType.BODY), "tool" : plane(vector(5, 0, 0) * millimeter, X_DIRECTION) });
        const body = qNthElement(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), 0);
        const robust = makeRobustQueriesBatched(context, body, true)[0];
        setVariable(context, "count", size(evaluateQuery(context, robust)));`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect(numberVariable(run, "count")).toBe(1);
  });
});

/**
 * A STEP assembly: one lens-shaped part (two planar splines, one bulging up and one down, 2 mm
 * thick, bottom at z = 0) used twice, the second instance placed 5 mm up, so its edges carry a
 * placement. Two spline edges lie in each of z = 0, 2, 5 and 7 mm.
 */
function assembly(oc: Oc): Uint8Array {
  const spline = (points: readonly (readonly [number, number])[]) => {
    const array = new oc.NCollection_Array1_gp_Pnt(1, points.length);
    points.forEach((p, i) => array.SetValue(i + 1, new oc.gp_Pnt(p[0], p[1], 0)));
    const fit = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(array), false, 1e-9);
    fit.Perform();
    return new oc.BRepBuilderAPI_MakeEdge(fit.Curve()).Edge();
  };
  const top = spline([
    [0, 0],
    [0.01, 0.005],
    [0.02, 0.004],
    [0.03, 0],
  ]);
  const bottom = spline([
    [0.03, 0],
    [0.02, -0.005],
    [0.01, -0.004],
    [0, 0],
  ]);
  const face = new oc.BRepBuilderAPI_MakeFace(
    new oc.BRepBuilderAPI_MakeWire(top, bottom).Wire(),
    true,
  ).Face();
  const solid = new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(0, 0, 0.002), false, true).Shape();
  const up = new oc.gp_Trsf();
  up.SetTranslation(new oc.gp_Vec(0, 0, 0.005));
  const compound = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(compound);
  builder.Add(compound, solid);
  builder.Add(compound, solid.Moved(new oc.TopLoc_Location(up), false));
  const writer = new oc.STEPControl_Writer();
  oc.Interface_Static.SetCVal("xstep.cascade.unit", "M");
  // Written in millimeters: OpenCascade's own meter files read back with 5.8 mm tolerances, which
  // no body may have.
  oc.Interface_Static.SetCVal("write.step.unit", "MM");
  writer.Transfer(
    compound,
    oc.STEPControl_StepModelType.STEPControl_AsIs,
    true,
    new oc.Message_ProgressRange(),
  );
  writer.Write("/review-assembly.step");
  const bytes = oc.FS.readFile("/review-assembly.step");
  oc.FS.unlink("/review-assembly.step");
  return bytes;
}

describe("12. placed spline edges", () => {
  it("lie in their own planes, for qCoincidesWithPlane and evPlanarEdge", async () => {
    const bytes = assembly(await loadOcct());
    const splines =
      'qGeometry(qCreatedBy(makeId("Base"), EntityType.EDGE), GeometryType.OTHER_CURVE)';
    const at = (z: number) =>
      `size(evaluateQuery(context, qCoincidesWithPlane(${splines}, plane(vector(0, 0, ${z}) * millimeter, Z_DIRECTION))))`;
    const run = studio.runtime.runFeatures(
      [
        {
          module: studio.runtime.load(
            "test/reviewAssembly.fs",
            `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "counts", [${[0, 2, 5, 7, 10, 12].map(at).join(", ")}]);
        setVariable(context, "offsets", mapArray(evaluateQuery(context, ${splines}), e =>
            abs(evPlanarEdge(context, { "edge" : e }).origin[2] - evEdgeTangentLine(context, { "edge" : e, "parameter" : 0 }).origin[2]) / millimeter));
    });
`,
          ),
          feature: "test",
        },
      ],
      { base: bytes },
    );
    expect(ok(run)).toEqual(["OK"]);
    // Two splines in each of z = 0, 2, 5 and 7 mm, none in z = 10 or 12 mm.
    expect((untag(variable(run, "counts")) as readonly FsValue[]).map(untag)).toEqual([
      2, 2, 2, 2, 0, 0,
    ]);
    const offsets = (untag(variable(run, "offsets")) as readonly FsValue[]).map(
      (o) => untag(o) as number,
    );
    expect(offsets).toHaveLength(8);
    for (const offset of offsets) expect(offset).toBeCloseTo(0, 9);
  });
});

describe("13. turned copies", () => {
  it("coincide face for face and edge for edge with the original", () => {
    const turned = (body: string, angle: number, name: string) =>
      `opPattern(context, id + "${name}", { "entities" : qCreatedBy(id + "${body}", EntityType.BODY), "transforms" : [rotationAround(line(vector(0, 0, 0) * meter, Z_DIRECTION), ${angle} * degree)], "instanceNames" : ["1"] });`;
    const faces = (name: string) =>
      `qOwnedByBody(qCreatedBy(id + "${name}", EntityType.BODY), EntityType.FACE)`;
    const edges = (name: string) =>
      `qOwnedByBody(qCreatedBy(id + "${name}", EntityType.BODY), EntityType.EDGE)`;
    const count = (query: string) => `size(evaluateQuery(context, ${query}))`;
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        ${turned("pin", 0, "pinSame")}
        ${turned("pin", 90, "pinTurned")}
        fCuboid(context, id + "plate", { "corner1" : vector(-10, -10, 20) * millimeter, "corner2" : vector(10, 10, 22) * millimeter });
        fCylinder(context, id + "drill", { "bottomCenter" : vector(0, 0, 19) * millimeter, "topCenter" : vector(0, 0, 23) * millimeter, "radius" : 3 * millimeter });
        opBoolean(context, id + "hole", { "tools" : qCreatedBy(id + "drill", EntityType.BODY), "targets" : qCreatedBy(id + "plate", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        ${turned("plate", 90, "plateTurned")}
        setVariable(context, "counts", [
            ${count(`qCoincidentFilter(${faces("pinSame")}, ${faces("pin")})`)},
            ${count(`qCoincidentFilter(${edges("pinSame")}, ${edges("pin")})`)},
            ${count(`qCoincidentFilter(${faces("pinTurned")}, ${faces("pin")})`)},
            ${count(`qCoincidentFilter(${edges("pinTurned")}, ${edges("pin")})`)},
            ${count(faces("plateTurned"))},
            ${count(`qCoincidentFilter(${faces("plateTurned")}, ${faces("plate")})`)}]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // Pin: 3 faces and 2 rims, untouched or turned 90 degrees; the drilled plate's 7 faces turned.
    expect((untag(variable(run, "counts")) as readonly FsValue[]).map(untag)).toEqual([
      3, 2, 3, 2, 7, 7,
    ]);
  });
});

describe("14. optional mate connector inputs", () => {
  it("lets std's Decal place itself on a face with its default placement", () => {
    const run = studio.run([
      { body: cube },
      {
        std: "decal.fs",
        feature: "decal",
        parameters: {
          image:
            '{ "imageWidth" : 100, "imageHeight" : 50, "mediaType" : "image/png" } as ImageData',
          face: face(5, 5, 10),
        },
      },
      {
        body: `setVariable(context, "origin", @evMateConnectorCoordSystem(context, { "originQuery" : ${face(5, 5, 10)}, "entityInferenceType" : EntityInferenceType.CENTROID, "requireOwnerPart" : false }).origin / millimeter);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK", "OK", "OK"]);
    const origin = (untag(variable(run, "origin")) as readonly FsValue[]).map(
      (c) => untag(c) as number,
    );
    [5, 5, 10].forEach((value, i) => expect(origin[i]).toBeCloseTo(value, 9));
  });
});

describe("15. boundaries cut differently", () => {
  const count = (query: string) => `size(evaluateQuery(context, ${query}))`;
  const faces = (name: string) =>
    `qOwnedByBody(qCreatedBy(id + "${name}", EntityType.BODY), EntityType.FACE)`;
  it("the same plate sketched with its bottom side split at x = 3 and at x = 7", () => {
    const plate = (name: string, split: number) => `
      {
          const sketch = newSketchOnPlane(context, id + "${name}Sketch", { "sketchPlane" : XY_PLANE });
          const points = [vector(0, 0) * millimeter, vector(${split}, 0) * millimeter, vector(10, 0) * millimeter, vector(10, 10) * millimeter, vector(0, 10) * millimeter];
          for (var i = 0; i < 5; i += 1)
              skLineSegment(sketch, "line" ~ i, { "start" : points[i], "end" : points[(i + 1) % 5] });
          skSolve(sketch);
          opExtrude(context, id + "${name}", { "entities" : qSketchRegion(id + "${name}Sketch"), "direction" : Z_DIRECTION, "endBound" : BoundingType.BLIND, "endDepth" : 5 * millimeter });
      }`;
    const at = (name: string, z: number) =>
      `qContainsPoint(${faces(name)}, vector(5, 5, ${z}) * millimeter)`;
    const run = studio.run([
      {
        body: `${plate("a", 3)}${plate("b", 7)}
        setVariable(context, "counts", [${count(`qCoincidentFilter(${at("a", 5)}, ${at("b", 5)})`)}, ${count(`qCoincidentFilter(${at("a", 0)}, ${at("b", 0)})`)}, ${count(`qCoincidentFilter(${at("a", 5)}, ${at("b", 0)})`)}]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // Tops match, bottoms match, a top doesn't match the other bottom.
    expect((untag(variable(run, "counts")) as readonly FsValue[]).map(untag)).toEqual([1, 1, 0]);
  });

  it("D-bosses cut from cylinders whose seams sit at 180 and 120 degrees", () => {
    const turned = (angle: number, name: string) =>
      `opPattern(context, id + "${name}", { "entities" : qCreatedBy(id + "pin", EntityType.BODY), "transforms" : [rotationAround(line(vector(0, 0, 0) * meter, Z_DIRECTION), ${angle} * degree)], "instanceNames" : ["1"] });`;
    const cut = (name: string) => `
      fCuboid(context, id + "${name}Box", { "corner1" : vector(3, -10, -1) * millimeter, "corner2" : vector(10, 10, 11) * millimeter });
      opBoolean(context, id + "${name}Cut", { "tools" : qCreatedBy(id + "${name}Box", EntityType.BODY), "targets" : qCreatedBy(id + "${name}", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`;
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        ${turned(180, "a")}${turned(120, "b")}${cut("a")}${cut("b")}
        setVariable(context, "counts", [${count(`qGeometry(${faces("a")}, GeometryType.PLANE)`)}, ${count(`qCoincidentFilter(qGeometry(${faces("a")}, GeometryType.PLANE), ${faces("b")})`)}]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // The top and bottom D (arcs cut at different points by the seams) and the flat cut face
    // match their twins. (Locally the cut also splits the curved wall at its seam, unlike
    // Onshape, so the walls are different faces and aren't compared here.)
    expect((untag(variable(run, "counts")) as readonly FsValue[]).map(untag)).toEqual([3, 3]);
  });
});

describe("16. tight boxes", () => {
  it("fit spline geometry exactly", async () => {
    const oc = await loadOcct();
    const run = studio.runtime.runFeatures(
      [
        {
          module: studio.runtime.load(
            "test/reviewBox.fs",
            `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        const box = evBox3d(context, { "topology" : qCreatedBy(makeId("Base"), EntityType.BODY) });
        setVariable(context, "box", [box.minCorner / meter, box.maxCorner / meter]);
    });
`,
          ),
          feature: "test",
        },
      ],
      { base: assembly(oc) },
    );
    expect(ok(run)).toEqual(["OK"]);
    const [min, max] = (untag(variable(run, "box")) as readonly FsValue[]).map((corner) =>
      (untag(corner) as readonly FsValue[]).map((c) => untag(c) as number),
    );
    // x and z extremes are vertices: 0 to 30 mm, and the two 2 mm thick instances 5 mm apart.
    expect(min![0]).toBeCloseTo(0, 12);
    expect(max![0]).toBeCloseTo(0.03, 12);
    expect(min![2]).toBeCloseTo(0, 12);
    expect(max![2]).toBeCloseTo(0.007, 12);
    // y extremes are inside the splines: refine each one's own extrema from a fine sampling.
    const curves = ordered(
      run.geometry!,
      (entity) =>
        entity.type === "EDGE" &&
        String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape)).GetType()) ===
          "GeomAbs_BSplineCurve",
    ).map((edge) => new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge.shape)));
    const extremeOf = (curve: (typeof curves)[number], sign: number) => {
      const y = (u: number) => curve.EvalD0(u).Y();
      const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
      let best = a;
      for (let i = 0; i <= 10_000; i++) {
        const u = a + ((b - a) * i) / 10_000;
        if (sign * y(u) > sign * y(best)) best = u;
      }
      // Golden-section refinement around the best sample.
      let [lo, hi] = [Math.max(a, best - (b - a) / 10_000), Math.min(b, best + (b - a) / 10_000)];
      for (let i = 0; i < 200; i++) {
        const [m1, m2] = [hi - (hi - lo) * 0.618, lo + (hi - lo) * 0.618];
        if (sign * y(m1) > sign * y(m2)) hi = m2;
        else lo = m1;
      }
      return y((lo + hi) / 2);
    };
    const extreme = (sign: number) =>
      sign * Math.max(...curves.map((curve) => sign * extremeOf(curve, sign)));
    expect(Math.abs(min![1]! - extreme(-1))).toBeLessThan(1e-9);
    expect(Math.abs(max![1]! - extreme(1))).toBeLessThan(1e-9);
  });
});

describe("17. measuring rational geometry", () => {
  /**
   * Exact rational B-spline surfaces of revolution about Z, radius 10 mm: a degree 2 circle in u
   * (nine poles, corner weights sqrt(2) / 2) times a profile in v.
   */
  const revolved = (
    oc: Oc,
    profile: readonly (readonly [number, number, number])[],
    vDegree: number,
    vKnots: readonly number[],
    vMults: readonly number[],
  ) => {
    const w = Math.SQRT1_2;
    const circle: readonly (readonly [number, number, number])[] = [
      [1, 0, 1],
      [1, 1, w],
      [0, 1, 1],
      [-1, 1, w],
      [-1, 0, 1],
      [-1, -1, w],
      [0, -1, 1],
      [1, -1, w],
      [1, 0, 1],
    ];
    const poles = new oc.NCollection_Array2_gp_Pnt(1, circle.length, 1, profile.length);
    const weights = new oc.NCollection_Array2_double(1, circle.length, 1, profile.length);
    circle.forEach(([cx, cy, cw], i) =>
      profile.forEach(([radius, z, pw], j) => {
        poles.SetValue(i + 1, j + 1, new oc.gp_Pnt(cx * radius, cy * radius, z));
        weights.SetValue(i + 1, j + 1, cw * pw);
      }),
    );
    const array = <T extends number>(
      values: readonly T[],
      make: (n: number) => { SetValue(i: number, v: T): void },
    ) => {
      const result = make(values.length);
      values.forEach((value, i) => result.SetValue(i + 1, value));
      return result;
    };
    const surface = new oc.Geom_BSplineSurface(
      poles,
      weights,
      array([0, 0.25, 0.5, 0.75, 1], (n) => new oc.NCollection_Array1_double(1, n)) as InstanceType<
        Oc["NCollection_Array1_double"]
      >,
      array(vKnots, (n) => new oc.NCollection_Array1_double(1, n)) as InstanceType<
        Oc["NCollection_Array1_double"]
      >,
      array([3, 2, 2, 2, 3], (n) => new oc.NCollection_Array1_int(1, n)) as InstanceType<
        Oc["NCollection_Array1_int"]
      >,
      array(vMults, (n) => new oc.NCollection_Array1_int(1, n)) as InstanceType<
        Oc["NCollection_Array1_int"]
      >,
      2,
      vDegree,
    );
    return surface;
  };

  it("matches hand values for a rational cylinder sheet and sphere", async () => {
    const oc = await loadOcct();
    const r = 0.01;
    const w = Math.SQRT1_2;
    const cylinder = new oc.BRepBuilderAPI_MakeFace(
      revolved(
        oc,
        [
          [r, 0, 1],
          [r, 0.01, 1],
        ],
        1,
        [0, 1],
        [2, 2],
      ),
      1e-9,
    ).Face();
    const sphereSurface = revolved(
      oc,
      [
        [0, -r, 1],
        [r, -r, w],
        [r, 0, 1],
        [r, r, w],
        [0, r, 1],
      ],
      2,
      [0, 0.5, 1],
      [3, 2, 3],
    );
    // Sewn so the shell's faces share edges and the ball stays a closed solid through STEP.
    const sewing = new oc.BRepBuilderAPI_Sewing(1e-7, true, true, true, false);
    sewing.Add(new oc.BRepBuilderAPI_MakeShell(sphereSurface, false).Shell());
    sewing.Perform(new oc.Message_ProgressRange());
    const ball = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(sewing.SewedShape())).Solid();
    const moved = new oc.gp_Trsf();
    moved.SetTranslation(new oc.gp_Vec(0.05, 0, 0));
    const placedBall = new oc.BRepBuilderAPI_Transform(ball, moved, true, false).Shape();
    const { writeStep } = await import("../src/geometry/Step.ts");
    const base = writeStep(oc, [cylinder, placedBall]);
    const run = studio.runtime.runFeatures(
      [
        {
          module: studio.runtime.load(
            "test/reviewRational.fs",
            `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        const sheet = qBodyType(qCreatedBy(makeId("Base"), EntityType.BODY), BodyType.SHEET);
        const ball = qBodyType(qCreatedBy(makeId("Base"), EntityType.BODY), BodyType.SOLID);
        setVariable(context, "values", [
            evArea(context, { "entities" : qOwnedByBody(sheet, EntityType.FACE) }) / millimeter ^ 2,
            evArea(context, { "entities" : qOwnedByBody(ball, EntityType.FACE) }) / millimeter ^ 2,
            evVolume(context, { "entities" : ball }) / millimeter ^ 3]);
        setVariable(context, "centroid", evApproximateCentroid(context, { "entities" : ball }) / millimeter);
    });
`,
          ),
          feature: "test",
        },
      ],
      { base },
    );
    expect(ok(run), JSON.stringify(run.features[0]!.exceptions.map((e) => e.message))).toEqual([
      "OK",
    ]);
    const [cylinderArea, sphereArea, volume] = (
      untag(variable(run, "values")) as readonly FsValue[]
    ).map((v) => untag(v) as number);
    // 2 PI r h, 4 PI r^2 and 4/3 PI r^3 with r = h = 10 mm.
    expect(cylinderArea).toBeCloseTo(200 * Math.PI, 6);
    expect(sphereArea).toBeCloseTo(400 * Math.PI, 6);
    expect(Math.abs(volume!)).toBeCloseTo((4000 * Math.PI) / 3, 6);
    const centroid = (untag(variable(run, "centroid")) as readonly FsValue[]).map(
      (c) => untag(c) as number,
    );
    [50, 0, 0].forEach((value, i) => expect(centroid[i]).toBeCloseTo(value, 6));
  });
});

/** Runs `body` in a feature on top of a STEP base. */
let baseModules = 0;
const onBase = (base: Uint8Array, body: string) =>
  studio.runtime.runFeatures(
    [
      {
        module: studio.runtime.load(
          `test/reviewBase${baseModules++}.fs`,
          `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });
`,
        ),
        feature: "test",
      },
    ],
    { base },
  );
const dotOf = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, c, i) => sum + c * b[i]!, 0);
const numbersOf = (value: FsValue): number[] =>
  (untag(value) as readonly FsValue[]).flatMap((x) => {
    const v = untag(x);
    return Array.isArray(v) ? numbersOf(x) : [v as number];
  });

/** A bicubic bulge over 30 x 30 mm, its middle poles 10 mm up, turned 0.3 rad about (1, 2, 3). */
const bulgeSheet = (oc: Oc) => {
  const poles = new oc.NCollection_Array2_gp_Pnt(1, 4, 1, 4);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      poles.SetValue(
        i + 1,
        j + 1,
        new oc.gp_Pnt(0.01 * i, 0.01 * j, i > 0 && i < 3 && j > 0 && j < 3 ? 0.01 : 0),
      );
  const knots = new oc.NCollection_Array1_double(1, 2);
  knots.SetValue(1, 0);
  knots.SetValue(2, 1);
  const mults = new oc.NCollection_Array1_int(1, 2);
  mults.SetValue(1, 4);
  mults.SetValue(2, 4);
  const surface = new oc.Geom_BSplineSurface(poles, knots, knots, mults, mults, 3, 3);
  const turn = new oc.gp_Trsf();
  turn.SetRotation(new oc.gp_Ax1(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(1, 2, 3)), 0.3);
  return new oc.BRepBuilderAPI_Transform(
    new oc.BRepBuilderAPI_MakeFace(surface, 1e-9).Face(),
    turn,
    true,
    false,
  ).Shape();
};

/** The bulge sheet with a 4 mm hole through its peak, so the surface's top is off the face. */
const holedBulgeSheet = (oc: Oc) => {
  const hole = new oc.BRepPrimAPI_MakeCylinder(
    new oc.gp_Ax2(new oc.gp_Pnt(0, 0, -0.1), new oc.gp_Dir(0, 0, 1)),
    0.004,
    0.2,
  ).Shape();
  const turn = new oc.gp_Trsf();
  turn.SetRotation(new oc.gp_Ax1(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(1, 2, 3)), 0.3);
  const peak = new oc.gp_Trsf();
  peak.SetTranslation(new oc.gp_Vec(0.015, 0.015, 0));
  const placed = new oc.BRepBuilderAPI_Transform(hole, turn.Multiplied(peak), true, false).Shape();
  const holed = new oc.BRepAlgoAPI_Cut(bulgeSheet(oc), placed).Shape();
  expect(subShapes(oc, holed, "FACE")).toHaveLength(1);
  return holed;
};

describe("18. exact extremes", () => {
  const rotations = [
    [1, 0, 0, 0.3],
    [0, 1, 0, 0.7],
    [0, 0, 1, 1.1],
    [1, 1, 0, 0.5],
    [1, 0, 1, 2.0],
    [0, 1, 1, -0.9],
    [1, 2, 3, 0.3],
    [3, 2, 1, 1.3],
    [-1, 2, 1, 2.6],
    [1, -1, 1, 0.1],
    [2, 1, -1, -2.2],
    [1, 1, 1, Math.PI / 3],
  ] as const;
  const rotate = (name: string, [x, y, z, angle]: readonly number[]) =>
    `opTransform(context, id + "${name}Turn", { "bodies" : qCreatedBy(id + "${name}", EntityType.BODY), "transform" : rotationAround(line(vector(0, 0, 0) * meter, vector(${x}, ${y}, ${z})), ${angle} * radian) });`;
  const box = (name: string) =>
    `evBox3d(context, { "topology" : qCreatedBy(id + "${name}", EntityType.BODY) })`;

  it("box a sphere turned every which way to its center plus and minus its radius", () => {
    const run = studio.run([
      {
        body: `
        var boxes = [];
        ${rotations
          .map(
            (rotation, i) => `
        opSphere(context, id + "ball${i}", { "center" : vector(0, 0, 0) * meter, "radius" : 10 * millimeter });
        ${rotate(`ball${i}`, rotation)}
        boxes = append(boxes, [${box(`ball${i}`)}.minCorner / millimeter, ${box(`ball${i}`)}.maxCorner / millimeter]);`,
          )
          .join("")}
        setVariable(context, "boxes", boxes);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const values = numbersOf(variable(run, "boxes"));
    expect(values).toHaveLength(72);
    values.forEach((value, i) => expect(Math.abs(value), `value ${i}`).toBeCloseTo(10, 9));
    values.forEach((value, i) => expect(Math.sign(value), `value ${i}`).toBe(i % 6 < 3 ? -1 : 1));
  });

  it("box a turned torus to its closed form", () => {
    // Major radius 10 mm, tube 2 mm, about Z, then turned 0.7 rad about (1, 2, 3). Along each
    // world axis e, the torus reaches R sqrt(1 - (a . e)^2) + r from its center.
    const [ax, ay, az, angle] = [1, 2, 3, 0.7];
    const run = studio.run([
      {
        body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * meter, -Y_DIRECTION, X_DIRECTION) });
        skCircle(sketch, "tube", { "center" : vector(10, 0) * millimeter, "radius" : 2 * millimeter });
        skSolve(sketch);
        opRevolve(context, id + "ring", { "entities" : qSketchRegion(id + "sketch"), "axis" : line(vector(0, 0, 0) * meter, Z_DIRECTION), "angleForward" : 2 * PI });
        ${rotate("ring", [ax, ay, az, angle])}
        const b = ${box("ring")};
        setVariable(context, "box", [b.minCorner / millimeter, b.maxCorner / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    // The turned axis: Z rotated by Rodrigues' formula about the unit (1, 2, 3).
    const n = Math.hypot(ax, ay, az);
    const k = [ax / n, ay / n, az / n];
    const z = [0, 0, 1];
    const kxz = [
      k[1]! * z[2]! - k[2]! * z[1]!,
      k[2]! * z[0]! - k[0]! * z[2]!,
      k[0]! * z[1]! - k[1]! * z[0]!,
    ];
    const kz = k[2]!;
    const axis = z.map(
      (c, i) =>
        c * Math.cos(angle) + kxz[i]! * Math.sin(angle) + k[i]! * kz * (1 - Math.cos(angle)),
    );
    const reach = axis.map((a) => 10 * Math.sqrt(1 - a * a) + 2);
    const values = numbersOf(variable(run, "box"));
    values.forEach((value, i) =>
      expect(value, `value ${i}`).toBeCloseTo((i < 3 ? -1 : 1) * reach[i % 3]!, 9),
    );
  });

  it("find a turned spline sheet's top, and judge planes against it", async () => {
    const oc = await loadOcct();
    const sheet = bulgeSheet(oc);
    const { writeStep } = await import("../src/geometry/Step.ts");
    const base = writeStep(oc, [sheet]);
    // Reference: the top of the turned surface by dense sampling, then alternating golden sections.
    const turned = new oc.BRepAdaptor_Surface(
      oc.TopoDS.Face(subShapes(oc, sheet, "FACE")[0]!),
      true,
    );
    const height = (u: number, v: number) => turned.EvalD0(u, v).Z();
    let [bu, bv] = [0, 0];
    for (let i = 0; i <= 200; i++)
      for (let j = 0; j <= 200; j++)
        if (height(i / 200, j / 200) > height(bu, bv)) [bu, bv] = [i / 200, j / 200];
    const golden = (f: (t: number) => number, lo: number, hi: number) => {
      for (let i = 0; i < 100; i++) {
        const [m1, m2] = [hi - (hi - lo) * 0.618, lo + (hi - lo) * 0.618];
        if (f(m1) > f(m2)) hi = m2;
        else lo = m1;
      }
      return (lo + hi) / 2;
    };
    for (let pass = 0; pass < 60; pass++) {
      bu = golden((u) => height(u, bv), Math.max(0, bu - 0.01), Math.min(1, bu + 0.01));
      bv = golden((v) => height(bu, v), Math.max(0, bv - 0.01), Math.min(1, bv + 0.01));
    }
    const top = height(bu, bv) * 1000;
    const sheetFaces = 'qCreatedBy(makeId("Base"), EntityType.FACE)';
    const below = `plane(vector(0, 0, ${top - 1}) * millimeter, vector(0, 0, 1))`;
    const run = onBase(
      base,
      `
        setVariable(context, "top", evBox3d(context, { "topology" : qCreatedBy(makeId("Base"), EntityType.BODY) }).maxCorner[2] / millimeter);
        setVariable(context, "crossing", size(evaluateQuery(context, qIntersectsPlane(${sheetFaces}, ${below}))));
        setVariable(context, "belowFlipped", size(evaluateQuery(context, qInFrontOfPlane(${sheetFaces}, plane(vector(0, 0, ${top - 1}) * millimeter, vector(0, 0, -1))))));
        setVariable(context, "highest", size(evaluateQuery(context, qFarthestAlong(${sheetFaces}, vector(0, 0, 1)))));`,
    );
    expect(ok(run)).toEqual(["OK"]);
    expect(Math.abs(numberVariable(run, "top") - top)).toBeLessThan(1e-9);
    // The sheet reaches 1 mm above the plane, so it crosses it and isn't wholly below it.
    expect(numberVariable(run, "crossing")).toBe(1);
    expect(numberVariable(run, "belowFlipped")).toBe(0);
    expect(numberVariable(run, "highest")).toBe(1);
  });

  it("fault when a spline face's peak was cut away", async () => {
    const oc = await loadOcct();
    // A hole through the sheet's peak: the surface's top is off the face, so its top is unknown.
    const holed = holedBulgeSheet(oc);
    const { writeStep } = await import("../src/geometry/Step.ts");
    const run = onBase(
      writeStep(oc, [holed]),
      `
        evBox3d(context, { "topology" : qCreatedBy(makeId("Base"), EntityType.BODY) });`,
    );
    expect(ok(run)).toEqual([
      "fault: A trimmed BSplineSurface face's extreme along a direction can't be pinned down locally.",
    ]);
  });
});

describe("19. measuring at fixed-order speed", () => {
  /** Adaptive (or fixed-order) area and volume straight from OpenCascade, the references. */
  const integrate = (oc: Oc, shape: Shape, dimension: 2 | 3, adaptive: boolean) => {
    const props = new oc.GProp_GProps();
    if (dimension === 3)
      if (adaptive) oc.BRepGProp.VolumeProperties(shape, props, 1e-12, false, false);
      else oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
    else if (adaptive) oc.BRepGProp.SurfaceProperties(shape, props, 1e-12, false);
    else oc.BRepGProp.SurfaceProperties(shape, props, false, false);
    return props.Mass();
  };

  it("integrate elementary faces with spline boundaries adaptively", () => {
    // A slanted, off-center hole through a ball: sphere and cylinder faces bounded by spline
    // intersection curves, where fixed-order integration is off.
    const run = studio.run([
      {
        body: `
        opSphere(context, id + "ball", { "center" : vector(0, 0, 0) * millimeter, "radius" : 10 * millimeter });
        fCylinder(context, id + "hole", { "bottomCenter" : vector(3, 0, -20) * millimeter, "topCenter" : vector(6, 2, 20) * millimeter, "radius" : 4 * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "hole", EntityType.BODY), "targets" : qCreatedBy(id + "ball", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        const ball = qCreatedBy(id + "ball", EntityType.BODY);
        setVariable(context, "area", evArea(context, { "entities" : qOwnedByBody(ball, EntityType.FACE) }) / meter ^ 2);
        setVariable(context, "volume", evVolume(context, { "entities" : ball }) / meter ^ 3);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const oc = run.oc!;
    const [body] = ordered(run.geometry!, (e) => e.type === "BODY" && e.bodyType === "SOLID");
    const faces = subShapes(oc, body!.shape, "FACE");
    const area = (adaptive: boolean) =>
      faces.reduce((sum, face) => sum + integrate(oc, face, 2, adaptive), 0);
    const [adaptiveArea, fixedArea] = [area(true), area(false)];
    const adaptiveVolume = integrate(oc, body!.shape, 3, true);
    const fixedVolume = integrate(oc, body!.shape, 3, false);
    // Fixed order is measurably off here, and the runtime matches the adaptive values.
    expect(Math.abs(fixedArea / adaptiveArea - 1)).toBeGreaterThan(1e-10);
    expect(Math.abs(fixedVolume / adaptiveVolume - 1)).toBeGreaterThan(1e-10);
    expect(Math.abs(numberVariable(run, "area") / adaptiveArea - 1)).toBeLessThan(1e-13);
    expect(Math.abs(numberVariable(run, "volume") / adaptiveVolume - 1)).toBeLessThan(1e-13);
  });

  it("see a face's new size after an operation changes it", () => {
    // The bottom and top tie for largest until a pocket takes area from the top.
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 10, 5) * millimeter });
        const faces = qOwnedByBody(qCreatedBy(id + "block", EntityType.BODY), EntityType.FACE);
        const before = size(evaluateQuery(context, qLargest(faces)));
        fCuboid(context, id + "pocket", { "corner1" : vector(5, 2, 3) * millimeter, "corner2" : vector(15, 8, 6) * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "pocket", EntityType.BODY), "targets" : qCreatedBy(id + "block", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        setVariable(context, "largest", [before, size(evaluateQuery(context, qLargest(faces)))]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect(numbersOf(variable(run, "largest"))).toEqual([2, 1]);
  });

  it("measure a 206-face plate within 10x of fixed-order integration", () => {
    // The 100 filleted holes give planes, cylinders and tori, all exact at fixed order. A copy
    // 100 mm up gives qCoincidentFilter 206 faces to compare the top against, none coincident.
    const build = `
        fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(110, 110, 8) * millimeter });
        var tools = [];
        for (var i = 0; i < 10; i += 1)
            for (var j = 0; j < 10; j += 1)
            {
                fCylinder(context, id + ("h" ~ i ~ "_" ~ j), { "bottomCenter" : vector(10 + 10 * i, 10 + 10 * j, -1) * millimeter, "topCenter" : vector(10 + 10 * i, 10 + 10 * j, 9) * millimeter, "radius" : 3 * millimeter });
                tools = append(tools, qCreatedBy(id + ("h" ~ i ~ "_" ~ j), EntityType.BODY));
            }
        opBoolean(context, id + "cut", { "tools" : qUnion(tools), "targets" : qCreatedBy(id + "plate", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        fillet(context, id + "fillet", { "entities" : qGeometry(qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.EDGE), GeometryType.CIRCLE)->qCoincidesWithPlane(plane(vector(0, 0, 8) * millimeter, Z_DIRECTION)), "radius" : 1 * millimeter });
        opPattern(context, id + "copy", { "entities" : qCreatedBy(id + "plate", EntityType.BODY), "transforms" : [transform(vector(0, 0, 100) * millimeter)], "instanceNames" : ["1"] });`;
    const plate = 'qCreatedBy(makeId("Feature1") + "plate", EntityType.BODY)';
    const measures = `
        const faces = qOwnedByBody(${plate}, EntityType.FACE);
        const top = qContainsPoint(faces, vector(5, 5, 8) * millimeter);
        const copyFaces = qOwnedByBody(qCreatedBy(makeId("Feature1") + "copy", EntityType.BODY), EntityType.FACE);
        setVariable(context, "results", [
            evVolume(context, { "entities" : ${plate} }) / millimeter ^ 3,
            evArea(context, { "entities" : faces }) / millimeter ^ 2,
            size(evaluateQuery(context, qLargest(faces))),
            size(evaluateQuery(context, qCoincidentFilter(top, copyFaces)))
        ]);`;
    const fastest = (work: () => void) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        work();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const built = studio.run([{ body: build }]);
    expect(ok(built)).toEqual(["OK"]);
    const oc = built.oc!;
    const [body] = ordered(built.geometry!, (e) => e.type === "BODY" && e.bodyType === "SOLID");
    const faces = subShapes(oc, body!.shape, "FACE");
    expect(faces).toHaveLength(206);
    // The reference: OpenCascade's fixed-order volume and per-face areas of the plate.
    const fixedMs = fastest(() => {
      integrate(oc, body!.shape, 3, false);
      for (const face of faces) integrate(oc, face, 2, false);
    });
    let measured = built;
    const buildMs = fastest(() => studio.run([{ body: build }]));
    const totalMs = fastest(() => {
      measured = studio.run([{ body: build }, { body: measures }]);
    });
    expect(ok(measured)).toEqual(["OK", "OK"]);
    const [volume, area, largest, coincident] = numbersOf(variable(measured, "results"));
    expect(volume).toBeCloseTo(integrate(oc, body!.shape, 3, true) * 1e9, 6);
    expect(area).toBeCloseTo(
      faces.reduce((sum, face) => sum + integrate(oc, face, 2, true), 0) * 1e6,
      6,
    );
    expect([largest, coincident]).toEqual([1, 0]);
    // Adaptive integration of these faces costs 5x to 26x fixed order, and measuring the top face
    // once per candidate in qCoincidentFilter about 100x.
    expect(totalMs - buildMs, `fixed order ${fixedMs.toFixed(1)} ms`).toBeLessThan(10 * fixedMs);
  });
});

/**
 * The largest p . d over a shape's edges and non-planar faces (edges only, without `faces`), for
 * references: dense samples, then golden sections around the best one (alternating u and v on
 * faces). Faces are sampled over their whole parameter box, so they must be untrimmed there;
 * planar faces peak on their edges.
 */
const refinedReach = (oc: Oc, shape: Shape, d: readonly number[], faces = true) => {
  const dot = (p: { X(): number; Y(): number; Z(): number }) =>
    p.X() * d[0]! + p.Y() * d[1]! + p.Z() * d[2]!;
  const golden = (f: (t: number) => number, lo: number, hi: number) => {
    for (let i = 0; i < 120; i++) {
      const [m1, m2] = [hi - (hi - lo) * 0.618, lo + (hi - lo) * 0.618];
      if (f(m1) > f(m2)) hi = m2;
      else lo = m1;
    }
    return (lo + hi) / 2;
  };
  let best = Number.NEGATIVE_INFINITY;
  for (const edge of subShapes(oc, shape, "EDGE")) {
    if (oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge))) continue;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    const f = (t: number) => dot(curve.EvalD0(t));
    const n = 400;
    let at = a;
    for (let i = 0; i <= n; i++) if (f(a + ((b - a) * i) / n) > f(at)) at = a + ((b - a) * i) / n;
    const step = (b - a) / n;
    best = Math.max(best, f(golden(f, Math.max(a, at - step), Math.min(b, at + step))));
  }
  for (const face of faces ? subShapes(oc, shape, "FACE") : []) {
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
    if (String(surface.GetType()) === "GeomAbs_Plane") continue;
    const box = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
    const f = (u: number, v: number) => dot(surface.EvalD0(u, v));
    const n = 120;
    const [du, dv] = [(box.UMax - box.UMin) / n, (box.VMax - box.VMin) / n];
    let [bu, bv] = [box.UMin, box.VMin];
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        if (f(box.UMin + i * du, box.VMin + j * dv) > f(bu, bv))
          [bu, bv] = [box.UMin + i * du, box.VMin + j * dv];
    for (let pass = 0; pass < 40; pass++) {
      bu = golden((u) => f(u, bv), Math.max(box.UMin, bu - du), Math.min(box.UMax, bu + du));
      bv = golden((v) => f(bu, v), Math.max(box.VMin, bv - dv), Math.min(box.VMax, bv + dv));
    }
    best = Math.max(best, f(bu, bv));
  }
  return best;
};
/** The kinds of a shape's faces and edges, as OpenCascade names them. */
const kindsOf = (oc: Oc, shape: Shape) => [
  ...subShapes(oc, shape, "FACE").map((face) =>
    String(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true).GetType()),
  ),
  ...subShapes(oc, shape, "EDGE").map((edge) =>
    String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)).GetType()),
  ),
];

/**
 * A STEP base holding one planar face: a spline fit (by opFitSpline) through four points in the XZ
 * plane, closed by three lines.
 */
const fitSplineProfile = async (oc: Oc) => {
  const fit = studio.run([
    {
      body: `opFitSpline(context, id + "spline", { "points" : [vector(10, 0, 0) * millimeter, vector(20, 0, 10) * millimeter, vector(12, 0, 20) * millimeter, vector(18, 0, 30) * millimeter] });`,
    },
  ]);
  expect(ok(fit)).toEqual(["OK"]);
  const [spline] = ordered(fit.geometry!, (e) => e.type === "EDGE" && !e.construction);
  const point = (x: number, z: number) => new oc.gp_Pnt(x / 1000, 0, z / 1000);
  const wire = new oc.BRepBuilderAPI_MakeWire();
  wire.Add(oc.TopoDS.Edge(spline!.shape));
  for (const [from, to] of [
    [point(18, 30), point(4, 30)],
    [point(4, 30), point(4, 0)],
    [point(4, 0), point(10, 0)],
  ] as const)
    wire.Add(new oc.BRepBuilderAPI_MakeEdge(from, to).Edge());
  const { writeStep } = await import("../src/geometry/Step.ts");
  return writeStep(oc, [new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face()]);
};
/** Turns `fitSplineProfile`'s face 250 degrees about Z with std's revolve into body `id + "turn"`,
 * then 40 degrees about a slanted axis with std's transform. */
const turnFitSpline = `
        const sketch = newSketchOnPlane(context, id + "axes", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });
        skLineSegment(sketch, "axis", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 30) * millimeter, "construction" : true });
        skLineSegment(sketch, "tilt", { "start" : vector(0, 0) * millimeter, "end" : vector(10, 25) * millimeter, "construction" : true });
        skSolve(sketch);
        revolve(context, id + "turn", { "entities" : qCreatedBy(makeId("Base"), EntityType.FACE), "axis" : sketchEntityQuery(id + "axes", EntityType.EDGE, "axis"), "fullRevolve" : false, "endBound" : RevolveBoundingType.BLIND, "angle" : 250 * degree });
        transform(context, id + "tilt", { "transformType" : TransformType.ROTATION, "entities" : qCreatedBy(id + "turn", EntityType.BODY), "transformAxis" : sketchEntityQuery(id + "axes", EntityType.EDGE, "tilt"), "angle" : 40 * degree, "oppositeDirection" : false, "makeCopy" : false });`;

describe("20. turned splines and conic edges", () => {
  it("box a part turned from a fit spline exactly, after std's revolve and transform", async () => {
    const oc = await loadOcct();
    // Revolved 250 degrees about Z, then std's transform turns it 40 degrees about a slanted
    // axis (it boxes the part to place its manipulator), and the part is boxed exactly.
    const run = onBase(
      await fitSplineProfile(oc),
      `${turnFitSpline}
        const box = evBox3d(context, { "topology" : qCreatedBy(id + "turn", EntityType.BODY) });
        setVariable(context, "box", [box.minCorner / millimeter, box.maxCorner / millimeter]);`,
    );
    expect(ok(run)).toEqual(["OK"]);
    const [part] = ordered(run.geometry!, (e) => e.type === "BODY" && e.bodyType === "SOLID");
    expect(kindsOf(run.oc!, part!.shape)).toContain("GeomAbs_SurfaceOfRevolution");
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const reference = [
      ...axes.map(
        (a) =>
          -refinedReach(
            run.oc!,
            part!.shape,
            a.map((c) => -c),
          ) * 1000,
      ),
      ...axes.map((a) => refinedReach(run.oc!, part!.shape, a) * 1000),
    ];
    numbersOf(variable(run, "box")).forEach((value, i) =>
      expect(Math.abs(value - reference[i]!), `value ${i}`).toBeLessThan(1e-8),
    );
  });

  it("box hyperbola and parabola edges exactly", () => {
    // Cones cut parallel to their axis (a hyperbola) and to a side line (a parabola), boxed in
    // a turned coordinate system so the curves' own extremes count.
    const x = [1, 2, 0.5].map((c) => c / Math.hypot(1, 2, 0.5));
    const t = [0.3, -1, 2];
    const zRaw = [
      x[1]! * t[2]! - x[2]! * t[1]!,
      x[2]! * t[0]! - x[0]! * t[2]!,
      x[0]! * t[1]! - x[1]! * t[0]!,
    ];
    const z = zRaw.map((c) => c / Math.hypot(...zRaw));
    const y = [
      z[1]! * x[2]! - z[2]! * x[1]!,
      z[2]! * x[0]! - z[0]! * x[2]!,
      z[0]! * x[1]! - z[1]! * x[0]!,
    ];
    const cSys = `coordSystem(vector(0, 0, 0) * millimeter, vector(${x.join(", ")}), vector(${z.join(", ")}))`;
    const cone = (name: string, at: number) =>
      `fCone(context, id + "${name}", { "bottomCenter" : vector(0, ${at}, 0) * millimeter, "topCenter" : vector(0, ${at}, 20) * millimeter, "bottomRadius" : 10 * millimeter, "topRadius" : 0.5 * millimeter });`;
    const cut = (name: string, cutter: string) =>
      `opBoolean(context, id + "${name}Cut", { "tools" : qCreatedBy(id + "${cutter}", EntityType.BODY), "targets" : qCreatedBy(id + "${name}", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`;
    const flat = (name: string, origin: string, normal: string) =>
      `qCoincidesWithPlane(qOwnedByBody(qCreatedBy(id + "${name}", EntityType.BODY), EntityType.FACE), plane(${origin}, ${normal}))`;
    const box = (face: string) => `evBox3d(context, { "topology" : ${face}, "cSys" : ${cSys} })`;
    const run = studio.run([
      {
        body: `
        ${cone("hyperbolic", 0)}
        fCuboid(context, id + "wall", { "corner1" : vector(3, -20, -5) * millimeter, "corner2" : vector(30, 20, 30) * millimeter });
        ${cut("hyperbolic", "wall")}
        ${cone("parabolic", 40)}
        // A side line runs (10, 0, 0) to (0.5, 0, 20): slope 0.475 in x per z.
        fCuboid(context, id + "slab", { "corner1" : vector(5, 20, -30) * millimeter, "corner2" : vector(40, 60, 50) * millimeter });
        opTransform(context, id + "tilt", { "bodies" : qCreatedBy(id + "slab", EntityType.BODY), "transform" : rotationAround(line(vector(5, 40, 0) * millimeter, vector(0, 1, 0)), -atan(0.475)) });
        ${cut("parabolic", "slab")}
        const hyperbolic = ${box(flat("hyperbolic", "vector(3, 0, 0) * millimeter", "vector(1, 0, 0)"))};
        const parabolic = ${box(flat("parabolic", "vector(5, 40, 0) * millimeter", "vector(1, 0, 0.475)"))};
        setVariable(context, "boxes", [hyperbolic.minCorner / millimeter, hyperbolic.maxCorner / millimeter, parabolic.minCorner / millimeter, parabolic.maxCorner / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const oc = run.oc!;
    // The planar cut faces, found by their conic edges.
    const faceWith = (kind: string) =>
      ordered(run.geometry!, (e) => e.type === "FACE").find(
        (face) =>
          String(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), true).GetType()) ===
            "GeomAbs_Plane" &&
          subShapes(oc, face.shape, "EDGE").some(
            (edge) => String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)).GetType()) === kind,
          ),
      )!;
    const reference = ["GeomAbs_Hyperbola", "GeomAbs_Parabola"].flatMap((kind) => {
      const face = faceWith(kind).shape;
      return [
        ...[x, y, z].map(
          (a) =>
            -refinedReach(
              oc,
              face,
              a.map((c) => -c),
            ) * 1000,
        ),
        ...[x, y, z].map((a) => refinedReach(oc, face, a) * 1000),
      ];
    });
    numbersOf(variable(run, "boxes")).forEach((value, i) =>
      expect(Math.abs(value - reference[i]!), `value ${i}`).toBeLessThan(1e-8),
    );
  });

  it("reach surfaces turned from line, circle and ellipse profiles", async () => {
    // Profiles that don't meet the axis's plane, so OpenCascade keeps a surface of revolution
    // (a skew line makes a hyperboloid), turned 3.5 rad about a slanted axis.
    const oc = await loadOcct();
    const point = (x: number, y: number, z: number) => new oc.gp_Pnt(x / 1000, y / 1000, z / 1000);
    const profiles = [
      new oc.BRepBuilderAPI_MakeEdge(point(10, 0, 0), point(10, 10, 20)).Edge(),
      new oc.BRepBuilderAPI_MakeEdge(
        new oc.gp_Circ(new oc.gp_Ax2(point(15, 0, 5), new oc.gp_Dir(1, 0.2, 0)), 0.003),
      ).Edge(),
      new oc.BRepBuilderAPI_MakeEdge(
        new oc.gp_Elips(new oc.gp_Ax2(point(15, 2, 5), new oc.gp_Dir(1, 0.2, 0.1)), 0.004, 0.002),
        0.3,
        4.0,
      ).Edge(),
    ];
    const stop = (message: string): never => {
      throw new Error(message);
    };
    const { reach } = await import("../src/geometry/Query.ts");
    for (const profile of profiles) {
      const sheet = new oc.BRepPrimAPI_MakeRevol(
        profile,
        new oc.gp_Ax1(point(0, 0, 0), new oc.gp_Dir(0, 0.1, 1)),
        3.5,
        false,
      ).Shape();
      expect(kindsOf(oc, sheet)).toContain("GeomAbs_SurfaceOfRevolution");
      for (const d of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [0.48, -0.6, 0.64],
      ])
        expect(
          Math.abs(
            reach(oc, sheet, d as [number, number, number], stop) - refinedReach(oc, sheet, d),
          ),
        ).toBeLessThan(1e-11);
    }
  });

  it("reach a Bezier face as the B-spline it is", async () => {
    // No STEP file or operation makes a Bezier face locally (STEP converts them to B-splines), so
    // this rewrites the bulge sheet's binary B-rep record from a one-span B-spline to the same
    // Bezier surface, and calls reach directly.
    const oc = await loadOcct();
    const sheet = subShapes(oc, bulgeSheet(oc), "FACE")[0]!;
    oc.BinTools.Write(sheet, "/bulge.bin", new oc.Message_ProgressRange());
    const bytes = oc.FS.readFile("/bulge.bin") as Uint8Array;
    // BSPLINE (9), four flags, degrees 3 and 3, 4 x 4 poles, 2 and 2 knots; then 16 poles of 24
    // bytes, then two knots of 12 bytes each way. A Bezier record (8) keeps two flags, the
    // degrees and the poles.
    const header = [9, 0, 0, 0, 0, 3, 0, 3, 0, 4, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
    const at = bytes.findIndex((_, i) => header.every((byte, j) => bytes[i + j] === byte));
    expect(at).toBeGreaterThan(0);
    const poles = bytes.slice(at + header.length, at + header.length + 16 * 24);
    oc.FS.writeFile(
      "/bezier.bin",
      new Uint8Array([
        ...bytes.slice(0, at),
        8, // BEZIER, two flags, degrees 3 and 3
        0,
        0,
        3,
        0,
        3,
        0,
        ...poles,
        ...bytes.slice(at + header.length + 16 * 24 + 4 * 12),
      ]),
    );
    const read = new oc.TopoDS_Shape();
    expect(oc.BinTools.Read(read, "/bezier.bin", new oc.Message_ProgressRange())).toBe(true);
    const bezier = subShapes(oc, read, "FACE")[0]!;
    expect(kindsOf(oc, bezier)).toContain("GeomAbs_BezierSurface");
    const stop = (message: string): never => {
      throw new Error(message);
    };
    const { reach } = await import("../src/geometry/Query.ts");
    for (const d of [
      [0, 0, 1],
      [0, 0, -1],
      [0.3, 0.2, 0.9327379053088815],
      [-0.6, 0.48, 0.64],
    ])
      expect(
        Math.abs(
          reach(oc, bezier, d as [number, number, number], stop) - refinedReach(oc, sheet, d),
        ),
      ).toBeLessThan(1e-11);
  });
});

describe("21. loose boxes", () => {
  /** `topology`'s exact and loose boxes in millimeters: [min, max, loose min, loose max]. */
  const boxes = (topology: string) => `
        const exact = evBox3d(context, { "topology" : ${topology} });
        const loose = evBox3d(context, { "topology" : ${topology}, "tight" : false });
        setVariable(context, "boxes", [exact.minCorner / millimeter, exact.maxCorner / millimeter, loose.minCorner / millimeter, loose.maxCorner / millimeter]);`;
  const turn = (name: string) =>
    `opTransform(context, id + "${name}Turn", { "bodies" : qCreatedBy(id + "${name}", EntityType.BODY), "transform" : rotationAround(line(vector(0, 0, 0) * meter, vector(1, 2, 3)), 0.7 * radian) });`;
  /** The loose box holds the exact one on every side. */
  const contains = (run: ReturnType<typeof studio.run>) => {
    expect(ok(run)).toEqual(Array(run.features.length).fill("OK"));
    const [min, max, looseMin, looseMax] = [0, 3, 6, 9].map((i) =>
      numbersOf(variable(run, "boxes")).slice(i, i + 3),
    );
    min!.forEach((value, i) => expect(looseMin![i]!, `min ${i}`).toBeLessThanOrEqual(value));
    max!.forEach((value, i) => expect(looseMax![i]!, `max ${i}`).toBeGreaterThanOrEqual(value));
  };

  it("hold a turned sphere and torus", () => {
    contains(
      studio.run([
        {
          body: `
        opSphere(context, id + "ball", { "center" : vector(3, 1, 2) * millimeter, "radius" : 10 * millimeter });
        ${turn("ball")}
        ${boxes('qCreatedBy(id + "ball", EntityType.BODY)')}`,
        },
      ]),
    );
    contains(
      studio.run([
        {
          body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * meter, -Y_DIRECTION, X_DIRECTION) });
        skCircle(sketch, "tube", { "center" : vector(10, 0) * millimeter, "radius" : 2 * millimeter });
        skSolve(sketch);
        opRevolve(context, id + "ring", { "entities" : qSketchRegion(id + "sketch"), "axis" : line(vector(0, 0, 0) * meter, Z_DIRECTION), "angleForward" : 2 * PI });
        ${turn("ring")}
        ${boxes('qCreatedBy(id + "ring", EntityType.BODY)')}`,
        },
      ]),
    );
  });

  it("hold a part turned from a fit spline, and a spline sheet", async () => {
    const oc = await loadOcct();
    contains(
      onBase(
        await fitSplineProfile(oc),
        `${turnFitSpline}
        ${boxes('qCreatedBy(id + "turn", EntityType.BODY)')}`,
      ),
    );
    const { writeStep } = await import("../src/geometry/Step.ts");
    contains(
      onBase(writeStep(oc, [bulgeSheet(oc)]), boxes('qCreatedBy(makeId("Base"), EntityType.BODY)')),
    );
  });

  it("box a sheet whose exact box stops the run", async () => {
    // The holed sheet's exact top is unknown locally; the loose box still holds its edges.
    const oc = await loadOcct();
    const holed = holedBulgeSheet(oc);
    const { writeStep } = await import("../src/geometry/Step.ts");
    const run = onBase(
      writeStep(oc, [holed]),
      `
        const loose = evBox3d(context, { "topology" : qCreatedBy(makeId("Base"), EntityType.BODY), "tight" : false });
        setVariable(context, "box", [loose.minCorner / millimeter, loose.maxCorner / millimeter]);`,
    );
    expect(ok(run)).toEqual(["OK"]);
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const [min, max] = [0, 3].map((i) => numbersOf(variable(run, "box")).slice(i, i + 3));
    // The sheet as read back from STEP, which rounds coordinates.
    const [read] = ordered(run.geometry!, (e) => e.type === "BODY" && !e.construction);
    axes.forEach((a, i) => {
      expect(min![i]!).toBeLessThanOrEqual(
        -refinedReach(
          oc,
          read!.shape,
          a.map((c) => -c),
          false,
        ) * 1000,
      );
      expect(max![i]!).toBeGreaterThanOrEqual(refinedReach(oc, read!.shape, a, false) * 1000);
    });
  });
});

describe("22. peaks near a face's boundary", () => {
  /** Unit vectors: d, and two more square to it and each other. */
  const frame = (d: readonly number[]) => {
    const z = d.map((c) => c / Math.hypot(...d));
    const seed = Math.abs(z[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross = (a: readonly number[], b: readonly number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    const xRaw = cross(seed, z);
    const x = xRaw.map((c) => c / Math.hypot(...xRaw));
    return { x, y: cross(z, x), z };
  };
  const vector = (p: readonly number[]) => `vector(${p.join(", ")}) * millimeter`;
  /** The box of `body` in a coordinate system whose z is `d`, in millimeters. */
  const boxAlong = (body: string, d: readonly number[]) => {
    const { x, z } = frame(d);
    return `
        const box = evBox3d(context, { "topology" : qCreatedBy(id + "${body}", EntityType.BODY), "cSys" : coordSystem(vector(0, 0, 0) * millimeter, vector(${x.join(", ")}), vector(${z.join(", ")})) });
        setVariable(context, "box", [box.minCorner / millimeter, box.maxCorner / millimeter]);`;
  };
  /** A hole of `radius` along d through `through` + `offset` along the frame's y. */
  const hole = (
    d: readonly number[],
    through: readonly number[],
    offset: number,
    radius: number,
    from: number,
    to: number,
  ) => {
    const { y, z } = frame(d);
    const axis = through.map((c, i) => c + offset * y[i]!);
    return `
        fCylinder(context, id + "hole", { "bottomCenter" : ${vector(axis.map((c, i) => c + from * z[i]!))}, "topCenter" : ${vector(axis.map((c, i) => c + to * z[i]!))}, "radius" : ${radius} * millimeter });`;
  };
  const cut = (body: string) =>
    `opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "hole", EntityType.BODY), "targets" : qCreatedBy(id + "${body}", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`;

  it("count a sphere's peak only when the hole beside it misses it", () => {
    // Radius 10 mm. A 2 mm hole parallel to d passes 0.01 mm beside the peaks at +-10 d (they
    // stay, the box is +-10), or 0.01 mm over them (they go; the rim peaks at
    // sqrt(10^2 - 0.01^2)).
    // (std's fCylinder along (1, 2, 2) builds a 1.6e8 mm^3 body here, so d avoids it.)
    const d = [0, 1, 1];
    for (const [offset, top] of [
      [2.01, 10],
      [1.99, Math.sqrt(100 - 0.01 ** 2)],
    ] as const) {
      const run = studio.run([
        {
          body: `
        opSphere(context, id + "ball", { "center" : vector(0, 0, 0) * millimeter, "radius" : 10 * millimeter });
        ${hole(d, [0, 0, 0], offset, 2, -20, 20)}
        ${cut("ball")}
        ${boxAlong("ball", d)}`,
        },
      ]);
      expect(ok(run)).toEqual(["OK"]);
      const box = numbersOf(variable(run, "box"));
      expect(Math.abs(box[5]! - top), `top, hole ${offset} mm off`).toBeLessThan(1e-8);
      expect(Math.abs(box[2]! + top), `bottom, hole ${offset} mm off`).toBeLessThan(1e-8);
    }
  });

  it("count a torus's peak only when the hole beside it misses it", () => {
    // Major radius 10 mm, tube 2 mm, about Z. Along d = (1, 0, 1) / sqrt 2 the peak is at
    // (10 + sqrt 2, 0, sqrt 2), reaching 10 / sqrt 2 + 2. A 0.5 mm blind hole along d passes
    // 0.01 mm beside it, or over it (then the hole's rim peaks lower).
    const d = [1, 0, 1];
    const peak = [10 + Math.SQRT2, 0, Math.SQRT2];
    const top = 10 / Math.SQRT2 + 2;
    for (const offset of [0.51, 0.49]) {
      const run = studio.run([
        {
          body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * meter, -Y_DIRECTION, X_DIRECTION) });
        skCircle(sketch, "tube", { "center" : vector(10, 0) * millimeter, "radius" : 2 * millimeter });
        skSolve(sketch);
        opRevolve(context, id + "ring", { "entities" : qSketchRegion(id + "sketch"), "axis" : line(vector(0, 0, 0) * meter, Z_DIRECTION), "angleForward" : 2 * PI });
        ${hole(d, peak, offset, 0.5, -1, 3)}
        ${cut("ring")}
        ${boxAlong("ring", d)}`,
        },
      ]);
      expect(ok(run)).toEqual(["OK"]);
      const reached = numbersOf(variable(run, "box"))[5]!;
      if (offset > 0.5) expect(Math.abs(reached - top)).toBeLessThan(1e-8);
      else {
        // The rim's top, from its edges.
        const [ring] = ordered(run.geometry!, (e) => e.type === "BODY" && e.bodyType === "SOLID");
        const { z } = frame(d);
        const rim = refinedReach(run.oc!, ring!.shape, z, false) * 1000;
        expect(rim).toBeLessThan(top - 1e-6);
        expect(Math.abs(reached - rim)).toBeLessThan(1e-8);
      }
    }
  });
});

describe("23. measuring edges", () => {
  /**
   * An edge's length and centroid by brute force: 5-point Gauss-Legendre on 20000 equal pieces of
   * its parameter range.
   */
  const integrated = (oc: Oc, edge: Shape) => {
    const nodes = [
      0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664,
    ];
    const weights = [
      0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908,
      0.23692688505618908,
    ];
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    const pieces = 20000;
    let length = 0;
    const moment = [0, 0, 0];
    for (let k = 0; k < pieces; k++) {
      const [p, q] = [a + ((b - a) * k) / pieces, a + ((b - a) * (k + 1)) / pieces];
      nodes.forEach((x, i) => {
        const at = curve.EvalD1((p + q) / 2 + ((q - p) / 2) * x);
        const step = Math.hypot(at.D1.X(), at.D1.Y(), at.D1.Z()) * weights[i]! * ((q - p) / 2);
        length += step;
        [at.Point.X(), at.Point.Y(), at.Point.Z()].forEach((c, j) => (moment[j]! += c * step));
      });
    }
    return { length, centroid: moment.map((c) => c / length) };
  };
  /** OpenCascade's fixed-order length, which the runtime used before. */
  const fixedLength = (oc: Oc, edge: Shape) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    return props.Mass();
  };
  // A quadratic spline through three points, bent 90 degrees.
  const bend = `opFitSpline(context, id + "bend", { "points" : [vector(0, 0, 0) * millimeter, vector(40, 0, 0) * millimeter, vector(40, 40, 0) * millimeter] });`;

  it("measure a bent spline's length and centroid, and compare it by length", async () => {
    const oc = await loadOcct();
    const run = studio.run([
      {
        body: `${bend}
        const edge = qCreatedBy(id + "bend", EntityType.EDGE);
        setVariable(context, "length", evLength(context, { "entities" : edge }) / millimeter);
        setVariable(context, "centroid", evApproximateCentroid(context, { "entities" : edge }) / millimeter);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [edge] = ordered(run.geometry!, (e) => e.type === "EDGE" && !e.construction);
    const reference = integrated(oc, edge!.shape);
    // The fixed-order length is measurably short here.
    expect(1 - fixedLength(oc, edge!.shape) / reference.length).toBeGreaterThan(1e-4);
    expect(Math.abs(numberVariable(run, "length") / (reference.length * 1000) - 1)).toBeLessThan(
      1e-12,
    );
    numbersOf(variable(run, "centroid")).forEach((c, i) =>
      expect(Math.abs(c - reference.centroid[i]! * 1000), `centroid ${i}`).toBeLessThan(1e-9),
    );
    // A line between the fixed-order and true lengths: the spline is the longer.
    const between = ((fixedLength(oc, edge!.shape) + reference.length) / 2) * 1000;
    const compared = studio.run([
      {
        body: `${bend}
        opFitSpline(context, id + "line", { "points" : [vector(0, 0, 10) * millimeter, vector(${between}, 0, 10) * millimeter] });
        const longest = qLargest(qUnion([qCreatedBy(id + "bend", EntityType.EDGE), qCreatedBy(id + "line", EntityType.EDGE)]));
        setVariable(context, "longest", evaluateQuery(context, longest) == evaluateQuery(context, qCreatedBy(id + "bend", EntityType.EDGE)));`,
      },
    ]);
    expect(ok(compared)).toEqual(["OK"]);
    expect(untag(variable(compared, "longest"))).toBe(true);
  });

  it("measure a helix and an ellipse arc", async () => {
    // A STEP base can only hold bodies, so the curves bound sheets: a strip 1 mm wide on a
    // cylinder between two helices (three turns of radius 10 mm and pitch 5 mm, their 3D curves
    // fit to 1e-10 m), and a flat face between an ellipse arc and its chord.
    const oc = await loadOcct();
    const [r, pitch, width] = [0.01, 0.005, 0.001];
    const rise = pitch / (2 * Math.PI);
    const cylinder = new oc.Geom_CylindricalSurface(
      new oc.gp_Ax3(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1)),
      r,
    );
    const onCylinder = (u: number, v: number, du: number, dv: number, length: number) =>
      new oc.BRepBuilderAPI_MakeEdge(
        new oc.Geom2d_Line(new oc.gp_Pnt2d(u, v), new oc.gp_Dir2d(new oc.gp_XY(du, dv))),
        cylinder,
        0,
        length,
      ).Edge();
    const turns = 6 * Math.PI;
    const strip = new oc.BRepBuilderAPI_MakeWire();
    strip.Add(onCylinder(0, 0, 1, rise, turns * Math.hypot(1, rise)));
    strip.Add(onCylinder(turns, turns * rise, 0, 1, width));
    strip.Add(onCylinder(turns, turns * rise + width, -1, -rise, turns * Math.hypot(1, rise)));
    strip.Add(onCylinder(0, width, 0, -1, width));
    const helical = new oc.BRepBuilderAPI_MakeFace(cylinder, strip.Wire(), true).Face();
    oc.BRepLib.BuildCurves3d(helical, 1e-10, oc.GeomAbs_Shape.GeomAbs_C2, 14, 400);
    const arc = new oc.BRepBuilderAPI_MakeEdge(
      new oc.gp_Elips(
        new oc.gp_Ax2(new oc.gp_Pnt(0.05, 0, 0), new oc.gp_Dir(0, 0.3, 1)),
        0.02,
        0.005,
      ),
      0.3,
      4,
    ).Edge();
    const ends = [0.3, 4].map((t) => new oc.BRepAdaptor_Curve(arc).Value(t));
    const chord = new oc.BRepBuilderAPI_MakeWire();
    chord.Add(arc);
    chord.Add(new oc.BRepBuilderAPI_MakeEdge(ends[1]!, ends[0]!).Edge());
    const flat = new oc.BRepBuilderAPI_MakeFace(chord.Wire(), true).Face();
    const { writeStep } = await import("../src/geometry/Step.ts");
    const run = onBase(
      writeStep(oc, [helical, flat]),
      `
        var lengths = [];
        for (var edge in evaluateQuery(context, qCreatedBy(makeId("Base"), EntityType.EDGE)))
            lengths = append(lengths, evLength(context, { "entities" : edge }) / millimeter);
        setVariable(context, "lengths", lengths);`,
    );
    expect(ok(run)).toEqual(["OK"]);
    const edges = ordered(run.geometry!, (e) => e.type === "EDGE" && !e.construction).map(
      (e) => e.shape,
    );
    const kinds = edges.map((e) => String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)).GetType()));
    // BuildCurves3d fits every edge on the cylinder, the helices among them.
    expect(kinds.filter((kind) => kind === "GeomAbs_BSplineCurve")).toHaveLength(4);
    expect(kinds).toContain("GeomAbs_Ellipse");
    // Each length, smallest first, against each edge's brute-force length.
    const lengths = numbersOf(variable(run, "lengths")).toSorted((x, y) => x - y);
    const references = edges
      .map((edge) => integrated(oc, edge).length * 1000)
      .toSorted((x, y) => x - y);
    expect(lengths).toHaveLength(references.length);
    references.forEach((reference, i) =>
      expect(Math.abs(lengths[i]! / reference - 1), `edge ${i}`).toBeLessThan(1e-12),
    );
    // The two helices against their closed form, to their 3D curves' fit.
    const helix = 3 * Math.hypot(2 * Math.PI * 10, 5);
    expect(lengths.filter((length) => Math.abs(length / helix - 1) < 1e-9)).toHaveLength(2);
  });
});

describe("24. evDistance parameters", () => {
  it("lets std's fillet find the faces' normals without a caught failure", () => {
    const run = studio.run([
      { body: cube },
      {
        std: "fillet.fs",
        feature: "fillet",
        parameters: {
          entities: `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.EDGE), vector(5, 0, 10) * millimeter)`,
          radius: "1 * millimeter",
        },
      },
    ]);
    expect(ok(run)).toEqual(["OK", "OK"]);
    expect(run.features[1]!.exceptions.map((e) => e.message)).toEqual([]);
  });

  it("place faces' and edges' parameters where the closest points are", () => {
    // Each parameter, fed back to the face or edge evaluator, gives the closest point again.
    const run = studio.run([
      {
        body: `${cube}
        fCylinder(context, id + "rod", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 20) * millimeter, "radius" : 4 * millimeter });
        const faces = [${face(5, 5, 10)}, qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER)];
        const targets = [vector(3, 4, 15) * millimeter, vector(40, 7, 12) * millimeter];
        var found = [];
        for (var i = 0; i < 2; i += 1)
        {
            const side = evDistance(context, { "side0" : faces[i], "side1" : targets[i] }).sides[0];
            const plane = evFaceTangentPlane(context, { "face" : faces[i], "parameter" : side.parameter });
            found = append(found, [side.parameter is Vector && size(side.parameter) == 2 && side.parameter[0] is number && side.parameter[1] is number, (plane.origin - side.point) / millimeter]);
        }
        const edge = qContainsPoint(qCreatedBy(id + "cube", EntityType.EDGE), vector(5, 0, 10) * millimeter);
        const side = evDistance(context, { "side0" : edge, "side1" : vector(3, -5, 12) * millimeter }).sides[0];
        const line = evEdgeTangentLine(context, { "edge" : edge, "parameter" : side.parameter });
        found = append(found, [side.parameter is number, (line.origin - side.point) / millimeter, side.point / millimeter]);
        const hit = evRaycast(context, { "entities" : ${face(5, 5, 10)}, "ray" : line(vector(3, 4, 15) * millimeter, -Z_DIRECTION) })[0];
        const hitPlane = evFaceTangentPlane(context, { "face" : ${face(5, 5, 10)}, "parameter" : hit.parameter });
        found = append(found, [hit.parameter is Vector, (hitPlane.origin - hit.intersection) / millimeter]);
        const body = evDistance(context, { "side0" : qCreatedBy(id + "cube", EntityType.BODY), "side1" : vector(3, 4, 15) * millimeter });
        found = append(found, [body.sides[0].parameter == 0, body.sides[1].parameter == 0]);
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const found = untag(variable(run, "found")) as FsValue[];
    for (const i of [0, 1]) {
      const [isVector, offset] = untag(found[i]!) as FsValue[];
      expect(untag(isVector!), `face ${i}`).toBe(true);
      numbersOf(offset!).forEach((c) => expect(Math.abs(c), `face ${i}`).toBeLessThan(1e-9));
    }
    const [isNumber, offset, point] = untag(found[2]!) as FsValue[];
    expect(untag(isNumber!)).toBe(true);
    numbersOf(offset!).forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
    numbersOf(point!).forEach((c, i) => expect(c).toBeCloseTo([3, 0, 10][i]!, 9));
    // evRaycast's face parameter is the same kind of Vector.
    const [hitIsVector, hitOffset] = untag(found[3]!) as FsValue[];
    expect(untag(hitIsVector!)).toBe(true);
    numbersOf(hitOffset!).forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
    expect((untag(found[4]!) as FsValue[]).map(untag)).toEqual([true, true]);
  });
});

describe("25. evDistance sides by what the query asked for", () => {
  it("give bodies 0 even when a body is one face or edge", () => {
    const run = studio.run([
      {
        body: `
        opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "width" : 20 * millimeter, "height" : 20 * millimeter });
        opFitSpline(context, id + "s", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(20, 0, 0) * millimeter] });
        const sheet = evDistance(context, { "side0" : qCreatedBy(id + "plane", EntityType.BODY), "side1" : vector(3, 4, 5) * millimeter });
        const wire = evDistance(context, { "side0" : qCreatedBy(id + "s", EntityType.BODY), "side1" : vector(10, 20, 0) * millimeter });
        const face = evDistance(context, { "side0" : qCreatedBy(id + "plane", EntityType.FACE), "side1" : vector(3, 4, 5) * millimeter });
        setVariable(context, "kinds", [sheet.sides[0].parameter == 0, wire.sides[0].parameter == 0, face.sides[0].parameter is Vector]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    expect((untag(variable(run, "kinds")) as FsValue[]).map(untag)).toEqual([true, true, true]);
  });
});

describe("26. rays onto a face's boundary", () => {
  it("hit a face on its edge and at its corner, with parameters on the face", () => {
    // Rays onto the cube's top face: one meets its edge at (0, 5, 10), one its corner at
    // (0, 0, 10), one its middle.
    const rays: [string, string, number[]][] = [
      ["vector(-5, 5, 15)", "vector(1, 0, -1)", [0, 5, 10]],
      ["vector(-5, -5, 15)", "vector(1, 1, -1)", [0, 0, 10]],
      ["vector(3, 5, 15)", "vector(0, 0, -1)", [3, 5, 10]],
    ];
    const run = studio.run([
      {
        body: `${cube}
        const top = ${face(5, 5, 10)};
        var found = [];
        ${rays
          .map(
            ([origin, direction]) => `
        {
            const hit = evRaycast(context, { "entities" : top, "ray" : line(${origin} * millimeter, ${direction}) })[0];
            const plane = evFaceTangentPlane(context, { "face" : top, "parameter" : hit.parameter });
            found = append(found, [hit.intersection / millimeter, (plane.origin - hit.intersection) / millimeter]);
        }`,
          )
          .join("")}
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const found = untag(variable(run, "found")) as FsValue[];
    rays.forEach(([, , at], i) => {
      const [point, offset] = untag(found[i]!) as FsValue[];
      numbersOf(point!).forEach((c, k) => expect(c, `ray ${i}`).toBeCloseTo(at[k]!, 9));
      numbersOf(offset!).forEach((c) => expect(Math.abs(c), `ray ${i}`).toBeLessThan(1e-9));
    });
  });
});

describe("27. extended evDistance sides", () => {
  it("measure a Variable from a construction plane extended to infinity", () => {
    // A 20 mm square plane at z = 0 and a point at (100, 0, 5): 5 mm off the plane's extension.
    const run = studio.run([
      {
        body: `
        opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "width" : 20 * millimeter, "height" : 20 * millimeter });
        opPoint(context, id + "pt", { "point" : vector(100, 0, 5) * millimeter });`,
      },
      {
        std: "variable.fs",
        feature: "assignVariable",
        parameters: {
          name: '"gap"',
          mode: "VariableMode.MEASURED",
          measurementMode: "VariableMeasurementMode.DISTANCE",
          entityCouple: `qUnion([qCreatedBy(makeId("Feature1") + "plane", EntityType.FACE), qCreatedBy(makeId("Feature1") + "pt", EntityType.VERTEX)])`,
        },
      },
      { body: 'setVariable(context, "gapMm", getVariable(context, "gap") / millimeter);' },
    ]);
    expect(ok(run)).toEqual(["OK", "OK", "OK"]);
    expect(numberVariable(run, "gapMm")).toBeCloseTo(5, 9);
  });

  it("put cPlane's curve point plane at a vertex on the edge's extension", () => {
    // Cube A's edge runs (0, 0, 0) to (10, 0, 0); cube B's vertex (20, 0, 0) is on its line.
    const edge = `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.EDGE), vector(5, 0, 0) * millimeter)`;
    const vertex = `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.VERTEX), vector(20, 0, 0) * millimeter)`;
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(20, 0, 0) * millimeter, "corner2" : vector(30, 10, 10) * millimeter });`,
      },
      {
        std: "cplane.fs",
        feature: "cPlane",
        parameters: {
          entities: `qUnion([${edge}, ${vertex}])`,
          cplaneType: "CPlaneType.CURVE_POINT",
        },
      },
      {
        body: `
        const p = evPlane(context, { "face" : qCreatedBy(makeId("Feature2"), EntityType.FACE) });
        setVariable(context, "plane", [p.origin / millimeter, p.normal]);
        const d = evDistance(context, { "side0" : ${vertex}, "side1" : ${edge}, "extendSide1" : true, "arcLengthParameterization" : false });
        setVariable(context, "distance", [d.distance / millimeter, d.sides[1].parameter, d.sides[1].point / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK", "OK", "OK"]);
    const [origin, normal] = (untag(variable(run, "plane")) as FsValue[]).map(numbersOf);
    origin!.forEach((c, i) => expect(c).toBeCloseTo([20, 0, 0][i]!, 9));
    expect(Math.abs(normal![0]!)).toBeCloseTo(1, 12);
    const [gap, parameter, point] = untag(variable(run, "distance")) as FsValue[];
    expect(untag(gap!)).toBeCloseTo(0, 9);
    // Past the edge's end: 2, or -1 walking the edge the other way.
    expect([2, -1].some((p) => Math.abs((untag(parameter!) as number) - p) < 1e-12)).toBe(true);
    numbersOf(point!).forEach((c, i) => expect(c).toBeCloseTo([20, 0, 0][i]!, 9));
  });

  it("extend an arc to its circle and a cylinder face past its ends", () => {
    // A 4 mm rod along z from 0 to 20 mm at (30, 0). Its top circle, cut to an arc by a box,
    // extends to the whole circle; its side extends past z = 20.
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "rod", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 20) * millimeter, "radius" : 4 * millimeter });
        fCuboid(context, id + "cutter", { "corner1" : vector(20, -10, -5) * millimeter, "corner2" : vector(30, 10, 25) * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "cutter", EntityType.BODY), "targets" : qCreatedBy(id + "rod", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        const rod = qCreatedBy(id + "rod", EntityType.BODY);
        const arc = qGeometry(qCoincidesWithPlane(qOwnedByBody(rod, EntityType.EDGE), plane(vector(0, 0, 20) * millimeter, Z_DIRECTION)), GeometryType.ARC);
        const side = qGeometry(qOwnedByBody(rod, EntityType.FACE), GeometryType.CYLINDER);
        // (24, 0, 20) is on the circle's far, cut-away side, 2 mm outside it.
        const toArc = evDistance(context, { "side0" : vector(24, 0, 20) * millimeter, "side1" : arc, "extendSide1" : true });
        const line = evEdgeTangentLine(context, { "edge" : arc, "parameter" : toArc.sides[1].parameter });
        // (30, 7, 40): 3 mm off the side's extension, 20 mm above its top.
        const toSide = evDistance(context, { "side0" : side, "side1" : vector(30, 7, 40) * millimeter, "extendSide0" : true });
        const plane = evFaceTangentPlane(context, { "face" : side, "parameter" : toSide.sides[0].parameter });
        setVariable(context, "found", [toArc.distance / millimeter, toArc.sides[1].point / millimeter, (line.origin - toArc.sides[1].point) / millimeter, toSide.distance / millimeter, toSide.sides[0].point / millimeter, (plane.origin - toSide.sides[0].point) / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [arcGap, arcPoint, arcOffset, sideGap, sidePoint, sideOffset] = (
      untag(variable(run, "found")) as FsValue[]
    ).map((v) => (Array.isArray(untag(v)) ? numbersOf(v) : [untag(v) as number]));
    expect(arcGap![0]).toBeCloseTo(2, 9);
    arcPoint!.forEach((c, i) => expect(c).toBeCloseTo([26, 0, 20][i]!, 9));
    arcOffset!.forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
    expect(sideGap![0]).toBeCloseTo(3, 9);
    sidePoint!.forEach((c, i) => expect(c).toBeCloseTo([30, 4, 40][i]!, 9));
    sideOffset!.forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
  });

  it("stop where the extension isn't defined locally", () => {
    // A spline edge's extension isn't documented, and an extended cylinder against an
    // extended plane has no box to bound the search and no closed form here.
    for (const [body, message] of [
      [
        `opFitSpline(context, id + "s", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(20, 0, 0) * millimeter] });
        evDistance(context, { "side0" : qCreatedBy(id + "s", EntityType.EDGE), "side1" : vector(30, 0, 0) * millimeter, "extendSide0" : true });`,
        "extends only",
      ],
      [
        `fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 4 * millimeter });
        opPlane(context, id + "b", { "plane" : plane(vector(0, 0, 50) * millimeter, vector(0, 1, 1)) });
        evDistance(context, { "side0" : qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER), "side1" : qCreatedBy(id + "b", EntityType.FACE), "extendSide0" : true, "extendSide1" : true });`,
        "cylinder or cone",
      ],
    ] as const) {
      const run = studio.run([{ body }]);
      expect(ok(run)[0]).toContain("fault:");
      expect(ok(run)[0]).toContain(message);
    }
  });
});

describe("28. lines and planes on both sides", () => {
  const cubes = `
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(50, 30, 17) * millimeter, "corner2" : vector(60, 40, 27) * millimeter });`;
  const at = (x: number, y: number, z: number, type = "FACE") =>
    `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.${type}), vector(${x}, ${y}, ${z}) * millimeter)`;
  /** std's measured Variable between two entities, with extendEntities, in millimeters. */
  const measured = (first: string, second: string) =>
    studio.run([
      { body: cubes },
      {
        std: "variable.fs",
        feature: "assignVariable",
        parameters: {
          name: '"gap"',
          mode: "VariableMode.MEASURED",
          measurementMode: "VariableMeasurementMode.DISTANCE",
          entityCouple: `qUnion([${first}, ${second}])`,
          extendEntities: "true",
        },
      },
      { body: 'setVariable(context, "gapMm", getVariable(context, "gap") / millimeter);' },
    ]);

  it("move a face up to a parallel construction plane", () => {
    // Cube A's top (z = 10) up to a construction plane at z = 17: 7 mm, both sides extended
    // to planes. Move face offsets with opOffsetFace, which isn't local here, so the run gets
    // that far or finishes; the same distance call moveFace makes gives the 7 mm.
    const limit = `opPlane(context, id + "limit", { "plane" : plane(vector(100, 100, 17) * millimeter, vector(0, 0, 1)), "width" : 5 * millimeter, "height" : 5 * millimeter });`;
    const run = studio.run([
      { body: `${cubes}\n${limit}` },
      {
        std: "moveFace.fs",
        feature: "moveFace",
        parameters: {
          moveFaces: at(5, 5, 10),
          moveFaceType: "MoveFaceType.OFFSET",
          limitType: "MoveFaceBoundingType.UP_TO_ENTITY",
          limitQuery: 'qCreatedBy(makeId("Feature1") + "limit", EntityType.FACE)',
        },
      },
    ]);
    const moved = ok(run)[1]!;
    if (moved === "OK") expect(solidVolumes(run)[0]).toBeCloseTo(1700, 6);
    else expect(moved).toContain("opOffsetFace");
    const direct = studio.run([
      {
        body: `${cubes}\n${limit}
        const face = qContainsPoint(qCreatedBy(id + "a", EntityType.FACE), vector(5, 5, 10) * millimeter);
        const d = evDistance(context, { "side0" : face, "side1" : qCreatedBy(id + "limit", EntityType.FACE), "extendSide0" : true, "extendSide1" : true, "arcLengthParameterization" : false });
        const tangent = evFaceTangentPlane(context, { "face" : face, "parameter" : d.sides[0].parameter });
        setVariable(context, "offset", [d.distance / millimeter, dot(tangent.normal, d.sides[1].point - d.sides[0].point) / millimeter, d.sides[0].point / millimeter]);`,
      },
    ]);
    expect(ok(direct)).toEqual(["OK"]);
    const [distance, offset, facePoint] = (untag(variable(direct, "offset")) as FsValue[]).map(
      (v) => (Array.isArray(untag(v)) ? numbersOf(v) : [untag(v) as number]),
    );
    expect(distance![0]).toBeCloseTo(7, 9);
    expect(offset![0]).toBeCloseTo(7, 9);
    // Parallel planes tie everywhere; side0's point is its face's parametric middle.
    facePoint!.forEach((c, i) => expect(c).toBeCloseTo([5, 5, 10][i]!, 9));
  });

  it("measure Variables between extended planes and between extended lines", () => {
    // A's top (z = 10) and B's bottom (z = 17) are 7 mm apart as planes.
    const planes = measured(at(5, 5, 10), at(55, 35, 17));
    expect(ok(planes)).toEqual(["OK", "OK", "OK"]);
    expect(numberVariable(planes, "gapMm")).toBeCloseTo(7, 9);
    // A's edge on the x axis and B's edge along y at x = 50, z = 17: skew, 17 mm apart.
    const skew = measured(at(5, 0, 0, "EDGE"), at(50, 35, 17, "EDGE"));
    expect(ok(skew)).toEqual(["OK", "OK", "OK"]);
    expect(numberVariable(skew, "gapMm")).toBeCloseTo(17, 9);
    // A's edge on the x axis and B's along x at y = 30, z = 17: parallel, hypot(30, 17) apart.
    const parallel = measured(at(5, 0, 0, "EDGE"), at(55, 30, 17, "EDGE"));
    expect(ok(parallel)).toEqual(["OK", "OK", "OK"]);
    expect(numberVariable(parallel, "gapMm")).toBeCloseTo(Math.hypot(30, 17), 9);
  });

  it("take Line and Plane values as sides", () => {
    const run = studio.run([
      {
        body: `${cubes}
        const top = qContainsPoint(qCreatedBy(id + "a", EntityType.FACE), vector(5, 5, 10) * millimeter);
        // A line 5 mm under the top's plane, and one that meets it at (10, 0, 10).
        const flat = evDistance(context, { "side0" : line(vector(0, 0, 5) * millimeter, vector(1, 0, 0)), "side1" : top, "extendSide1" : true });
        const steep = evDistance(context, { "side0" : line(vector(0, 0, 20) * millimeter, vector(1, 0, -1)), "side1" : top, "extendSide1" : true });
        // A plane at z = 3 and a point 6 mm above it.
        const level = evDistance(context, { "side0" : plane(vector(0, 0, 3) * millimeter, vector(0, 0, 1), vector(1, 0, 0)), "side1" : vector(4, 5, 9) * millimeter });
        setVariable(context, "found", [flat.distance / millimeter, steep.distance / millimeter, steep.sides[0].point / millimeter, steep.sides[0].parameter / millimeter, level.distance / millimeter, level.sides[0].parameter / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [flat, steep, steepPoint, steepAlong, level, levelAt] = (
      untag(variable(run, "found")) as FsValue[]
    ).map((v) => (Array.isArray(untag(v)) ? numbersOf(v) : [untag(v) as number]));
    expect(flat![0]).toBeCloseTo(5, 9);
    expect(steep![0]).toBeCloseTo(0, 9);
    steepPoint!.forEach((c, i) => expect(c).toBeCloseTo([10, 0, 10][i]!, 9));
    // A Line's parameter is the length along it from its origin.
    expect(steepAlong![0]).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(level![0]).toBeCloseTo(6, 9);
    // A Plane's is the point's 2D position in its x and y.
    levelAt!.forEach((c, i) => expect(c).toBeCloseTo([4, 5][i]!, 9));
  });
});

describe("29. extended cones", () => {
  it("extend a cone face only on its own side of the apex", () => {
    // Radius 10 at z = 0 to 5 at z = 10: apex at z = 20, the face's half below it. Points above
    // the apex are nearest the apex itself.
    const run = studio.run([
      {
        body: `
        fCone(context, id + "cone", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "bottomRadius" : 10 * millimeter, "topRadius" : 5 * millimeter });
        const side = qGeometry(qCreatedBy(id + "cone", EntityType.FACE), GeometryType.CONE);
        var found = [];
        for (var point in [vector(0, 0, 30) * millimeter, vector(6, 0, 34) * millimeter])
        {
            const d = evDistance(context, { "side0" : side, "side1" : point, "extendSide0" : true });
            found = append(found, [d.distance / millimeter, d.sides[0].point / millimeter]);
        }
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const found = (untag(variable(run, "found")) as FsValue[]).map(
      (pair) => untag(pair) as FsValue[],
    );
    [10, Math.sqrt(6 ** 2 + 14 ** 2)].forEach((expected, i) => {
      expect(untag(found[i]![0]!) as number, `point ${i}`).toBeCloseTo(expected, 9);
      numbersOf(found[i]![1]!).forEach((c, k) => expect(c).toBeCloseTo([0, 0, 20][k]!, 9));
    });
  });
});

describe("30. curve points on splines", () => {
  it("place cPlane's curve point plane on a spline, inside and at its end", () => {
    // A spline through (0, 0, 0), (10, 5, 0) and (20, 0, 0), and points on it: its middle
    // (an opPoint) and its end vertex. Each plane sits there, square to the spline.
    const spline = `qCreatedBy(makeId("Feature1") + "s", EntityType.EDGE)`;
    for (const [vertex, at, parameter] of [
      [`qCreatedBy(makeId("Feature1") + "p", EntityType.VERTEX)`, [10, 5, 0], 0.5],
      [
        `qContainsPoint(qCreatedBy(makeId("Feature1") + "s", EntityType.VERTEX), vector(20, 0, 0) * millimeter)`,
        [20, 0, 0],
        1,
      ],
    ] as const) {
      const run = studio.run([
        {
          body: `
        opFitSpline(context, id + "s", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(20, 0, 0) * millimeter] });
        opPoint(context, id + "p", { "point" : vector(10, 5, 0) * millimeter });`,
        },
        {
          std: "cplane.fs",
          feature: "cPlane",
          parameters: {
            entities: `qUnion([${spline}, ${vertex}])`,
            cplaneType: "CPlaneType.CURVE_POINT",
          },
        },
        {
          body: `
        const p = evPlane(context, { "face" : qCreatedBy(makeId("Feature2"), EntityType.FACE) });
        const tangent = evEdgeTangentLine(context, { "edge" : ${spline}, "parameter" : ${parameter}, "arcLengthParameterization" : false });
        setVariable(context, "plane", [p.origin / millimeter, p.normal, tangent.direction]);`,
        },
      ]);
      expect(ok(run), `at ${at}`).toEqual(["OK", "OK", "OK"]);
      const [origin, normal, direction] = (untag(variable(run, "plane")) as FsValue[]).map(
        numbersOf,
      );
      origin!.forEach((c, i) => expect(c, `at ${at}`).toBeCloseTo(at[i]!, 9));
      expect(Math.abs(dotOf(normal!, direction!)), `at ${at}`).toBeCloseTo(1, 9);
    }
  });

  it("still stop when the vertex is off the spline", () => {
    const run = studio.run([
      {
        body: `
        opFitSpline(context, id + "s", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(20, 0, 0) * millimeter] });
        evDistance(context, { "side0" : vector(30, 0, 0) * millimeter, "side1" : qCreatedBy(id + "s", EntityType.EDGE), "extendSide1" : true });`,
      },
    ]);
    expect(ok(run)[0]).toContain("extends only line and circle edges");
  });
});

describe("31. parallel lines", () => {
  it("start the tie from side0's reference along a diagonal direction", () => {
    // Two lines along (1, 1, 0): side0's point is its origin, side1's that point's foot on it.
    const run = studio.run([
      {
        body: `
        const d = evDistance(context, { "side0" : line(vector(0, 0, 0) * millimeter, vector(1, 1, 0)), "side1" : line(vector(3, 0, 5) * millimeter, vector(1, 1, 0)) });
        setVariable(context, "found", [d.distance / millimeter, d.sides[0].point / millimeter, d.sides[1].point / millimeter]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [distance, first, second] = untag(variable(run, "found")) as FsValue[];
    expect(untag(distance!) as number).toBeCloseTo(Math.hypot(1.5, 1.5, 5), 9);
    numbersOf(first!).forEach((c, i) => expect(c).toBeCloseTo([0, 0, 0][i]!, 9));
    numbersOf(second!).forEach((c, i) => expect(c).toBeCloseTo([1.5, -1.5, 5][i]!, 9));
  });
});

describe("32. extended arc parameters", () => {
  it("measure the turn after the arc's start, whichever way the edge runs", () => {
    // An arc of the rod's top, cut to x >= 30 (center (30, 0, 20), radius 4). Points nearest the
    // circle at 180 and 135 degrees: each parameter is the turn from the edge's start, walking
    // its way, over the arc's own turn.
    const targets = [
      [24, 0, 20],
      [30 + 6 * Math.cos((3 * Math.PI) / 4), 6 * Math.sin((3 * Math.PI) / 4), 20],
    ];
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "rod", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 20) * millimeter, "radius" : 4 * millimeter });
        fCuboid(context, id + "cutter", { "corner1" : vector(20, -10, -5) * millimeter, "corner2" : vector(30, 10, 25) * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "cutter", EntityType.BODY), "targets" : qCreatedBy(id + "rod", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        const arc = qGeometry(qCoincidesWithPlane(qOwnedByBody(qCreatedBy(id + "rod", EntityType.BODY), EntityType.EDGE), plane(vector(0, 0, 20) * millimeter, Z_DIRECTION)), GeometryType.ARC);
        const start = evEdgeTangentLine(context, { "edge" : arc, "parameter" : 0 });
        const end = evEdgeTangentLine(context, { "edge" : arc, "parameter" : 1 });
        var found = [start.origin / millimeter, start.direction, end.origin / millimeter];
        for (var target in [${targets.map((t) => `vector(${t.join(", ")}) * millimeter`).join(", ")}])
        {
            const side = evDistance(context, { "side0" : target, "side1" : arc, "extendSide1" : true }).sides[1];
            const back = evEdgeTangentLine(context, { "edge" : arc, "parameter" : side.parameter });
            found = append(found, [side.parameter, (back.origin - side.point) / millimeter]);
        }
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [start, direction, end, ...results] = untag(variable(run, "found")) as FsValue[];
    const [sx, sy] = numbersOf(start!);
    const [dx, dy] = numbersOf(direction!);
    const [ex, ey] = numbersOf(end!);
    // Walking counterclockwise (seen from +z) when the start tangent turns left of the radius;
    // the turn to a point, from the start that way.
    const way = Math.sign((sx! - 30) * dy! - sy! * dx!);
    const startAngle = Math.atan2(sy!, sx! - 30);
    const turnTo = (x: number, y: number) =>
      (((way * (Math.atan2(y, x - 30) - startAngle)) % (2 * Math.PI)) + 2 * Math.PI) %
      (2 * Math.PI);
    const arcTurn = turnTo(ex!, ey!);
    targets.forEach(([x, y], i) => {
      const [parameter, offset] = untag(results[i]!) as FsValue[];
      expect(untag(parameter!) as number, `target ${i}`).toBeCloseTo(turnTo(x!, y!) / arcTurn, 9);
      numbersOf(offset!).forEach((c) => expect(Math.abs(c), `target ${i}`).toBeLessThan(1e-9));
    });
  });
});

describe("33. planar face parameters", () => {
  it("give planes their real parameters, asked for or not (see 34)", () => {
    const run = studio.run([
      {
        body: `${cube}
        const top = ${face(5, 5, 10)};
        var found = [];
        for (var asked in [false, true])
        {
            const side = evDistance(context, { "side0" : top, "side1" : vector(3, 4, 15) * millimeter, "useFaceParameter" : asked }).sides[0];
            const plane = evFaceTangentPlane(context, { "face" : top, "parameter" : side.parameter });
            found = append(found, (plane.origin - side.point) / millimeter);
        }
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    (untag(variable(run, "found")) as FsValue[]).forEach((offset) =>
      numbersOf(offset).forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9)),
    );
  });
});

describe("34. curve patterns along straight edges", () => {
  it("space four instances along a straight sketch line, tangent to it", () => {
    // A 10 mm cube patterned 4 times along a 30 mm line from (5, 5) to (5, 35), default
    // orientation: the cubes' centers 10 mm apart.
    const run = studio.run([
      { body: cube },
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
          entities: `qBodyType(qCreatedBy(makeId("Feature1"), EntityType.BODY), BodyType.SOLID)`,
          edges: `qCreatedBy(makeId("Feature2"), EntityType.EDGE)`,
          instanceCount: "4",
          spacingType: "CurvePatternSpacingType.EQUAL",
        },
      },
    ]);
    expect(ok(run)[2]).toBe("OK");
    const oc = run.oc!;
    const centers = ordered(run.geometry!, (e) => e.type === "BODY" && e.bodyType === "SOLID")
      .map((body) => {
        const props = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
        const c = props.CentreOfMass();
        return [c.X(), c.Y(), c.Z()].map((v) => v * 1000);
      })
      .toSorted((p, q) => p[1]! - q[1]!);
    expect(centers).toHaveLength(4);
    centers.forEach((center, i) =>
      center.forEach((c, k) => expect(c, `instance ${i}`).toBeCloseTo([5, 5 + 10 * i, 5][k]!, 6)),
    );
  });
});

describe("35. nearly parallel lines and planes", () => {
  it("measure nearly parallel lines and planes, with each point on its line or plane", () => {
    // Lines: along x through the origin, and through (10, 0, 5) mm turned by a small angle a
    // about z. Skew, with the closest pair (10, 0, 0) and (10, 0, 5) at every angle, away from
    // both origins. Planes: z = 0, and through (0, 2, 5) mm with normal (0, -sin a, cos a); they
    // cross (far away), so 0 with one point on both planes.
    const angles = [1e-10, 1e-9, 1e-8, 3e-8, 1e-7, 1e-6, 1e-4];
    const run = studio.run([
      {
        body: `
        var found = [];
        for (var a in [${angles.join(", ")}])
        {
            const lines = evDistance(context, { "side0" : line(vector(0, 0, 0) * millimeter, vector(1, 0, 0)), "side1" : line(vector(10, 0, 5) * millimeter, vector(cos(a * radian), sin(a * radian), 0)) });
            const planes = evDistance(context, { "side0" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)), "side1" : plane(vector(0, 2, 5) * millimeter, vector(0, -sin(a * radian), cos(a * radian)), vector(1, 0, 0)) });
            found = append(found, [lines.distance / millimeter, lines.sides[0].point / millimeter, lines.sides[1].point / millimeter, planes.distance / millimeter, planes.sides[0].point / millimeter, planes.sides[1].point / millimeter]);
        }
        setVariable(context, "found", found);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    (untag(variable(run, "found")) as FsValue[]).forEach((entry, i) => {
      const a = angles[i]!;
      const [lines, onFirst, onSecond, planes, onA, onB] = (untag(entry) as FsValue[]).map((v) =>
        Array.isArray(untag(v)) ? numbersOf(v) : [untag(v) as number],
      );
      expect(lines![0], `angle ${a}`).toBeCloseTo(5, 9);
      onFirst!.forEach((c, k) => expect(c, `angle ${a}`).toBeCloseTo([10, 0, 0][k]!, 9));
      onSecond!.forEach((c, k) => expect(c, `angle ${a}`).toBeCloseTo([10, 0, 5][k]!, 9));
      expect(planes![0], `angle ${a}`).toBeCloseTo(0, 9);
      // Each plane point on both planes: z = 0, and (p - (0, 2, 5)) . (0, -sin a, cos a) = 0.
      for (const p of [onA!, onB!]) {
        expect(Math.abs(p[2]!), `angle ${a}`).toBeLessThan(1e-9);
        expect(
          Math.abs(-Math.sin(a) * (p[1]! - 2) + Math.cos(a) * (p[2]! - 5)),
          `angle ${a}`,
        ).toBeLessThan(1e-9);
      }
    });
  });
});

describe("36. tangent planes outside a face", () => {
  it("give undefined outside the face when asked, and planes inside", () => {
    // A 5 mm rod's top disk at z = 10: its parameter box's corner (0, 0) is off the disk, its
    // middle on it. Without the flag both give planes.
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        const top = qContainsPoint(qCreatedBy(id + "rod", EntityType.FACE), vector(0, 0, 10) * millimeter);
        const asked = evFaceTangentPlanes(context, { "face" : top, "parameters" : [vector(0, 0), vector(0.5, 0.5)], "returnUndefinedOutsideFace" : true });
        const plain = evFaceTangentPlanes(context, { "face" : top, "parameters" : [vector(0, 0), vector(0.5, 0.5)] });
        setVariable(context, "found", [asked[0] == undefined, asked[1].origin / millimeter, plain[0] is Plane]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [outside, inside, plain] = untag(variable(run, "found")) as FsValue[];
    expect(untag(outside!)).toBe(true);
    numbersOf(inside!).forEach((c, i) => expect(c).toBeCloseTo([0, 0, 10][i]!, 9));
    expect(untag(plain!)).toBe(true);
  });
});

describe("37. periodic parameters outside the box", () => {
  it("wrap periodic parameters by whole turns before deciding they're off the face", () => {
    // A full rod's side: (-0.1, 0.5) and (1.1, 0.5) are (0.9, 0.5) and (0.1, 0.5). Cut to the
    // half at x >= 30, its side spans half a turn, so 1.5 turns past its end, off the face.
    const run = studio.run([
      {
        body: `
        fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        fCylinder(context, id + "half", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 10) * millimeter, "radius" : 5 * millimeter });
        fCuboid(context, id + "cutter", { "corner1" : vector(20, -10, -5) * millimeter, "corner2" : vector(30, 10, 15) * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "cutter", EntityType.BODY), "targets" : qCreatedBy(id + "half", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        const side = qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER);
        const halfSide = qGeometry(qOwnedByBody(qCreatedBy(id + "half", EntityType.BODY), EntityType.FACE), GeometryType.CYLINDER);
        const full = evFaceTangentPlanes(context, { "face" : side, "parameters" : [vector(-0.1, 0.5), vector(0.9, 0.5), vector(1.1, 0.5), vector(0.1, 0.5)], "returnUndefinedOutsideFace" : true });
        const half = evFaceTangentPlanes(context, { "face" : halfSide, "parameters" : [vector(1.5, 0.5), vector(0.5, 0.5)], "returnUndefinedOutsideFace" : true });
        setVariable(context, "found", [(full[0].origin - full[1].origin) / millimeter, (full[2].origin - full[3].origin) / millimeter, half[0] == undefined, half[1] is Plane]);`,
      },
    ]);
    expect(ok(run)).toEqual(["OK"]);
    const [wrapped, wrappedUp, past, inside] = untag(variable(run, "found")) as FsValue[];
    for (const offset of [wrapped!, wrappedUp!])
      numbersOf(offset).forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
    expect(untag(past!)).toBe(true);
    expect(untag(inside!)).toBe(true);
  });
});
