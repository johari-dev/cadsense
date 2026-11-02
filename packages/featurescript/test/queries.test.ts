import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, solidVolumes, variable } from "./partStudio.ts";

/**
 * Query evaluation details that std's docs settle.
 *
 * `qContainsPoint` (std: "all entities ... containing a specified point"). Onshape's FeatureScript
 * lead on the forum: a body query matches "if the point is inside (or on the boundary of) the
 * body". Faces, edges and vertices match only points on them. Ways it can fail:
 * - A solid's interior point misses the body, or matches its faces.
 * - A point on an edge or at a vertex misses some of the faces or edges that meet there.
 * - A point just outside matches.
 *
 * Ids. Onshape treats an `Id` as its components joined by dots, so std writes the same operation
 * as `sketchId + "wireOp"` and `id + "sketch.wireOp"`. Ways it can fail:
 * - `qCreatedBy` or `sketchEntityQuery` compares components, so one spelling finds nothing (std's
 *   fCone evaluates its axis this way and then can't revolve).
 * - A sketch entity query on the sketch's wire operation misses the wire, or also matches the
 *   region sheet's copy of the edge.
 *
 * Order. std: "The order of entities returned by [evaluateQuery] is arbitrary ... except in the
 * case of a `qUnion` query", which "is guaranteed to preserve order". Ways it can fail:
 * - qUnion sorts its results (by creation) instead of keeping its subqueries' order.
 * - An entity in two subqueries appears twice, or at its later position.
 *
 * `qEdgeTopologyFilter` keeps edges by how many faces they join (std's EdgeTopology: WIRE none,
 * ONE_SIDED one, TWO_SIDED two; LAMINAR is internal, taken here as one face). Ways it can fail:
 * - A sheet's boundary edges count as two-sided, or a sketch's wire edges as one-sided.
 * - Faces of another body sharing the edge's position are counted.
 *
 * `qTangentConnectedEdges` grows a seed through vertices where edges continue tangentially. Ways
 * it can fail:
 * - The chain stops at the first tangent vertex, or crosses a sharp one.
 * - Edges that only touch the chain at a corner join it.
 *
 * `qSketchRegion(id, true)` drops regions fully inside another region. Ways it can fail:
 * - The flag is ignored, or it drops regions that only sit beside others.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

describe("qContainsPoint", () => {
  const points = {
    interior: [5, 5, 5],
    face: [5, 5, 10],
    edge: [5, 0, 10],
    vertex: [10, 10, 10],
    outside: [5, 5, 10.001],
  } as const;
  const types = ["BODY", "FACE", "EDGE", "VERTEX"] as const;

  it("matches a solid's interior and boundary, and faces, edges and vertices only on them", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        setVariable(context, "counts", [${Object.values(points)
          .map(
            (p) =>
              `[${types.map((type) => `size(evaluateQuery(context, qContainsPoint(qCreatedBy(id, EntityType.${type}), vector(${p.join(", ")}) * millimeter)))`).join(", ")}]`,
          )
          .join(", ")}]);`,
      },
    ]);
    expect(run.features[0]?.status).toBe("OK");
    const counts = (untag(variable(run, "counts")) as readonly FsValue[]).map((row) =>
      (untag(row) as readonly FsValue[]).map((count) => untag(count)),
    );
    const byPoint = Object.fromEntries(Object.keys(points).map((name, i) => [name, counts[i]]));
    // [bodies, faces, edges, vertices]
    expect(byPoint).toEqual({
      interior: [1, 0, 0, 0],
      face: [1, 1, 0, 0],
      edge: [1, 2, 1, 0],
      vertex: [1, 3, 3, 1],
      outside: [0, 0, 0, 0],
    });
  });
});

describe("ids compare as dot-joined strings", () => {
  it("lets std's fCone find its sketch's axis line and revolve", () => {
    const run = studio.run([
      {
        body: 'fCone(context, id + "cone", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "bottomRadius" : 5 * millimeter, "topRadius" : 2 * millimeter });',
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    // A frustum: PI h / 3 (R^2 + R r + r^2) = PI 10 / 3 (25 + 10 + 4) = 130 PI.
    expect(solidVolumes(run)).toHaveLength(1);
    expect(solidVolumes(run)[0]).toBeCloseTo(130 * Math.PI, 6);
  });

  it("matches qCreatedBy with either spelling of an id", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "a.b", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(1, 1, 1) * millimeter });
        fCuboid(context, id + "c" + "d", { "corner1" : vector(5, 0, 0) * millimeter, "corner2" : vector(6, 1, 1) * millimeter });
        setVariable(context, "split", size(evaluateQuery(context, qCreatedBy(id + "a" + "b", EntityType.BODY))));
        setVariable(context, "joined", size(evaluateQuery(context, qCreatedBy(id + "c.d", EntityType.BODY))));
        setVariable(context, "partial", size(evaluateQuery(context, qCreatedBy(id + "c.", EntityType.BODY))));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    expect(numberVariable(run, "split")).toBe(1);
    expect(numberVariable(run, "joined")).toBe(1);
    // "c." is not a whole component of "c.d".
    expect(numberVariable(run, "partial")).toBe(0);
  });

  it("finds a sketch entity by the sketch id or its wire operation, once", () => {
    const run = studio.run([
      {
        body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : XY_PLANE });
        skRectangle(sketch, "box", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 5) * millimeter });
        skSolve(sketch);
        setVariable(context, "plain", size(evaluateQuery(context, sketchEntityQuery(id + "sketch", EntityType.EDGE, "box.bottom"))));
        setVariable(context, "wireOp", size(evaluateQuery(context, sketchEntityQuery(id + "sketch" + "wireOp", EntityType.EDGE, "box.bottom"))));
        setVariable(context, "dotted", size(evaluateQuery(context, sketchEntityQuery(id + "sketch.wireOp", EntityType.EDGE, "box.bottom"))));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    expect(numberVariable(run, "plain")).toBe(1);
    expect(numberVariable(run, "wireOp")).toBe(1);
    expect(numberVariable(run, "dotted")).toBe(1);
  });
});

describe("qSketchRegion", () => {
  it("drops regions inside another region when filtering inner loops", () => {
    const run = studio.run([
      {
        body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : XY_PLANE });
        skRectangle(sketch, "outer", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(20, 20) * millimeter });
        skCircle(sketch, "hole", { "center" : vector(10, 10) * millimeter, "radius" : 3 * millimeter });
        skRectangle(sketch, "beside", { "firstCorner" : vector(30, 0) * millimeter, "secondCorner" : vector(40, 10) * millimeter });
        skSolve(sketch);
        setVariable(context, "all", size(evaluateQuery(context, qSketchRegion(id + "sketch"))));
        const outer = qSketchRegion(id + "sketch", true);
        setVariable(context, "outer", size(evaluateQuery(context, outer)));
        setVariable(context, "outerAreaMm2", evArea(context, { "entities" : outer }) / millimeter ^ 2);`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    expect(numberVariable(run, "all")).toBe(3);
    expect(numberVariable(run, "outer")).toBe(2);
    // The ring around the hole (400 - 9 PI) and the separate 10 x 10 square.
    expect(numberVariable(run, "outerAreaMm2")).toBeCloseTo(400 - 9 * Math.PI + 100, 6);
  });
});

describe("qUnion", () => {
  it("keeps its subqueries' order, each entity once at its first place", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        const face = function(z) { return qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 5, z) * millimeter); };
        const zOf = function(query) { return mapArray(evaluateQuery(context, query), f => evPlane(context, { "face" : f }).origin[2] / millimeter); };
        setVariable(context, "topFirst", zOf(qUnion([face(10), face(0)])));
        setVariable(context, "bottomFirst", zOf(qUnion([face(0), face(10)])));
        setVariable(context, "repeated", zOf(qUnion([face(10), face(0), face(10)])));
        setVariable(context, "nested", zOf(qUnion([qUnion([face(10)]), face(0)])));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    const zs = (name: string) =>
      (untag(variable(run, name)) as readonly FsValue[]).map((z) => Math.round(untag(z) as number));
    expect(zs("topFirst")).toEqual([10, 0]);
    expect(zs("bottomFirst")).toEqual([0, 10]);
    expect(zs("repeated")).toEqual([10, 0]);
    expect(zs("nested")).toEqual([10, 0]);
  });
});

describe("qEdgeTopologyFilter", () => {
  it("sorts edges by how many faces they join", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 20) * millimeter, Z_DIRECTION) });
        skRectangle(sketch, "box", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 5) * millimeter });
        skSolve(sketch);
        const count = function(query, topology) { return size(evaluateQuery(context, qEdgeTopologyFilter(query, topology))); };
        const cubeEdges = qCreatedBy(id + "cube", EntityType.EDGE);
        const sketchEntities = qCreatedBy(id + "sketch");
        setVariable(context, "cube", mapArray([EdgeTopology.WIRE, EdgeTopology.ONE_SIDED, EdgeTopology.TWO_SIDED, EdgeTopology.LAMINAR], t => count(cubeEdges, t)));
        setVariable(context, "sketch", mapArray([EdgeTopology.WIRE, EdgeTopology.ONE_SIDED, EdgeTopology.TWO_SIDED, EdgeTopology.LAMINAR], t => count(sketchEntities, t)));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    const counts = (name: string) =>
      (untag(variable(run, name)) as readonly FsValue[]).map((c) => untag(c));
    // [WIRE, ONE_SIDED, TWO_SIDED, LAMINAR]
    expect(counts("cube")).toEqual([0, 0, 12, 0]);
    // The sketch's wire has 4 edges; its region sheet's 4 boundary edges have one face each, and
    // the sketch's faces and bodies are filtered out.
    expect(counts("sketch")).toEqual([4, 4, 0, 4]);
  });
});

describe("qTangentConnectedEdges", () => {
  it("follows a filleted box's top loop around its rounded corners", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 10) * millimeter });
        fillet(context, id + "fillet", { "entities" : qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), Z_DIRECTION), "radius" : 3 * millimeter });
        const edges = qOwnedByBody(qCreatedBy(id + "box", EntityType.BODY), EntityType.EDGE);
        const chain = qTangentConnectedEdges(qContainsPoint(edges, vector(10, 0, 10) * millimeter));
        setVariable(context, "count", size(evaluateQuery(context, chain)));
        setVariable(context, "lengthMm", evLength(context, { "entities" : chain }) / millimeter);
        setVariable(context, "allTop", size(evaluateQuery(context, qCoincidesWithPlane(chain, plane(vector(0, 0, 10) * millimeter, Z_DIRECTION)))));
        fCuboid(context, id + "cube", { "corner1" : vector(40, 0, 0) * millimeter, "corner2" : vector(50, 10, 10) * millimeter });
        setVariable(context, "sharp", size(evaluateQuery(context, qTangentConnectedEdges(qContainsPoint(qCreatedBy(id + "cube", EntityType.EDGE), vector(45, 0, 10) * millimeter)))));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    // Four 14 mm sides and four quarter circles of radius 3 mm.
    expect(numberVariable(run, "count")).toBe(8);
    expect(numberVariable(run, "lengthMm")).toBeCloseTo(56 + 6 * Math.PI, 6);
    expect(numberVariable(run, "allTop")).toBe(8);
    // A sharp cube edge chains to nothing else.
    expect(numberVariable(run, "sharp")).toBe(1);
  });
});
