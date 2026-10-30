import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { partStudio, variable } from "./partStudio.ts";

/**
 * Query types that std builds and Query.ts evaluates, each through std's own q* wrapper, with
 * counts worked out by hand from the geometry.
 *
 * Ways these can fail:
 * - Attribute filters: a named filter matches unnamed (legacy) attributes or the reverse; an exact
 *   value or a pattern is ignored; the filter without a subquery misses entities.
 * - Largest/smallest: mixed dimensions compared together; ties within tolerance dropped.
 * - Farthest along: measured at a centroid rather than the entity's farthest point, so a side
 *   face that reaches the top loses the tie with the top face.
 * - Unique vertices: coincident vertices of two bodies both kept, or the later one kept.
 * - Coincident filter: an edge that only touches the target, or lies along part of it, passes.
 * - Geometric filters: a face's surface normal used instead of its outward normal (so
 *   antiparallel planes swap); an axis compared without its position; "in front of" a plane
 *   judged by one point of an entity that straddles it; a line or ball tested against a bounding
 *   box instead of the geometry.
 * - Convexity filter: classified from the wrong side of the edge.
 * - Topology: an edge's start and end swapped against evEdgeTangentLine; flood fills that cross
 *   an edge without the property along its whole length, or step into a bounding face; loop
 *   edges that keep the edge two seed faces share.
 * - Fillets: a face counted as a fillet because it's cylindrical, or radii compared the wrong way.
 * - History: pattern instances matched by a name prefix ("1" finding "10"); queries that need
 *   operation provenance (dependencies, historical queries, qMatching) answered without it.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const box = (name: string, from: readonly number[], to: readonly number[]) =>
  `fCuboid(context, id + "${name}", { "corner1" : vector(${from.join(", ")}) * millimeter, "corner2" : vector(${to.join(", ")}) * millimeter });`;
const point = (x: number, y: number, z: number) => `vector(${x}, ${y}, ${z}) * millimeter`;
const at = (type: string, x: number, y: number, z: number, feature = "a") =>
  `qContainsPoint(qCreatedBy(id + "${feature}", EntityType.${type}), ${point(x, y, z)})`;

/** Runs `setup`, then counts what each named query resolves to. */
const counts = (setup: string, queries: Record<string, string>) => {
  const run = studio.run([
    {
      body: `${setup}
      setVariable(context, "counts", [${Object.values(queries)
        .map((query) => `size(evaluateQuery(context, ${query}))`)
        .join(", ")}]);`,
    },
  ]);
  const feature = run.features[0]!;
  if (feature.fault || feature.status !== "OK")
    throw new Error(
      `${feature.fault?.message ?? feature.status}: ${feature.exceptions.map((e) => e.message).join("; ")}`,
    );
  const values = (untag(variable(run, "counts")) as readonly FsValue[]).map((c) => untag(c));
  return Object.fromEntries(Object.keys(queries).map((name, i) => [name, values[i]]));
};

describe("attribute filters", () => {
  it("match named attributes by name, exact value or pattern, and legacy ones by type and pattern", () => {
    const setup = `${box("a", [0, 0, 0], [10, 10, 10])}
      setAttribute(context, { "entities" : ${at("FACE", 5, 5, 10)}, "name" : "tag", "attribute" : { "kind" : "hole", "size" : 5 } });
      setAttribute(context, { "entities" : ${at("FACE", 5, 5, 0)}, "name" : "tag", "attribute" : "x" });
      setAttribute(context, { "entities" : ${at("FACE", 5, 0, 5)}, "attribute" : { "odd" : true } });
      setAttribute(context, { "entities" : ${at("FACE", 0, 5, 5)}, "attribute" : "legacy string" });`;
    expect(
      counts(setup, {
        named: 'qHasAttribute("tag")',
        namedInTop: `qHasAttribute(${at("FACE", 5, 5, 10)}, "tag")`,
        exact: 'qHasAttributeWithValue("tag", "x")',
        exactMiss: 'qHasAttributeWithValue("tag", "y")',
        pattern: 'qHasAttributeWithValueMatching("tag", { "kind" : "hole" })',
        patternMiss: 'qHasAttributeWithValueMatching("tag", { "kind" : "slot" })',
        legacyMap: 'qAttributeQuery({ "odd" : true })',
        legacyAnyMap: 'qAttributeFilter(qCreatedBy(id + "a", EntityType.FACE), {})',
        legacyString: 'qAttributeQuery("anything")',
        unnamedIsNotNamed: 'qHasAttribute("odd")',
      }),
    ).toEqual({
      named: 2,
      namedInTop: 1,
      exact: 1,
      exactMiss: 0,
      pattern: 1,
      patternMiss: 0,
      legacyMap: 1,
      legacyAnyMap: 1,
      legacyString: 1,
      unnamedIsNotNamed: 0,
    });
  });
});

describe("selection by size and position", () => {
  it("picks the largest and smallest of the highest dimension, with ties", () => {
    const setup = `${box("a", [0, 0, 0], [1, 1, 1])}${box("b", [5, 0, 0], [7, 2, 2])}${box("c", [10, 0, 0], [13, 3, 3])}
      ${box("slab", [20, 0, 0], [22, 2, 4])}`;
    const bodies = "qBodyType(qCreatedBy(id, EntityType.BODY), BodyType.SOLID)";
    const slabFaces = 'qCreatedBy(id + "slab", EntityType.FACE)';
    expect(
      counts(setup, {
        largestBody: `qLargest(${bodies})`,
        largestIsC: `qIntersection([qLargest(${bodies}), qCreatedBy(id + "c", EntityType.BODY)])`,
        smallestIsA: `qIntersection([qSmallest(${bodies}), qCreatedBy(id + "a", EntityType.BODY)])`,
        // The 2 x 2 x 4 slab's four 2 x 4 sides tie.
        largestFaces: `qLargest(${slabFaces})`,
        smallestFaces: `qSmallest(${slabFaces})`,
        // Bodies outrank faces.
        mixed: `qLargest(qUnion([${slabFaces}, qCreatedBy(id + "a", EntityType.BODY)]))`,
      }),
    ).toEqual({
      largestBody: 1,
      largestIsC: 1,
      smallestIsA: 1,
      largestFaces: 4,
      smallestFaces: 2,
      mixed: 1,
    });
  });

  it("picks what reaches farthest along a direction, with ties", () => {
    const setup = box("a", [0, 0, 0], [10, 10, 10]);
    expect(
      counts(setup, {
        corner: 'qFarthestAlong(qCreatedBy(id + "a", EntityType.VERTEX), vector(1, 1, 1))',
        cornerIsFar: `qIntersection([qFarthestAlong(qCreatedBy(id + "a", EntityType.VERTEX), vector(1, 1, 1)), ${at("VERTEX", 10, 10, 10)}])`,
        rightVertices: 'qFarthestAlong(qCreatedBy(id + "a", EntityType.VERTEX), vector(1, 0, 0))',
        // The top face and the four sides all reach z = 10.
        topFaces: 'qFarthestAlong(qCreatedBy(id + "a", EntityType.FACE), vector(0, 0, 1))',
      }),
    ).toEqual({ corner: 1, cornerIsFar: 1, rightVertices: 4, topFaces: 5 });
  });

  it("keeps one of each set of coincident vertices, and finds coincident edges", () => {
    const setup = box("a", [0, 0, 0], [10, 10, 10]) + box("b", [10, 0, 0], [20, 10, 10]);
    const vertices =
      'qUnion([qCreatedBy(id + "a", EntityType.VERTEX), qCreatedBy(id + "b", EntityType.VERTEX)])';
    const shared = at("EDGE", 10, 0, 5, "b");
    expect(
      counts(setup, {
        all: `${vertices}`,
        unique: `qUniqueVertices(${vertices})`,
        // The kept copy is the earlier body's.
        uniqueFromA: `qIntersection([qUniqueVertices(${vertices}), qCreatedBy(id + "a", EntityType.VERTEX)])`,
        coincident: `qCoincidentFilter(qCreatedBy(id + "a", EntityType.EDGE), ${shared})`,
        coincidentIsShared: `qIntersection([qCoincidentFilter(qCreatedBy(id + "a", EntityType.EDGE), ${shared}), ${at("EDGE", 10, 0, 5)}])`,
      }),
    ).toEqual({ all: 16, unique: 12, uniqueFromA: 8, coincident: 1, coincidentIsShared: 1 });
  });
});

describe("geometric filters", () => {
  const solids = `${box("a", [0, 0, 0], [10, 10, 10])}
    fCylinder(context, id + "pin", { "bottomCenter" : vector(30, 0, 0) * millimeter, "topCenter" : vector(30, 0, 10) * millimeter, "radius" : 2 * millimeter });
    opMateConnector(context, id + "mc", { "coordSystem" : coordSystem(vector(30, 0, 5) * millimeter, X_DIRECTION, Z_DIRECTION) });`;
  const faces = 'qCreatedBy(id + "a", EntityType.FACE)';
  const vertices = 'qCreatedBy(id + "a", EntityType.VERTEX)';
  const edges = 'qCreatedBy(id + "a", EntityType.EDGE)';
  const z = (height: number) => `plane(vector(0, 0, ${height}) * millimeter, Z_DIRECTION)`;

  it("pick planes by normal and faces by direction", () => {
    expect(
      counts(solids, {
        parallel: `qParallelPlanes(${faces}, vector(0, 0, 1))`,
        sameWay: `qParallelPlanes(${faces}, ${z(0)}, false)`,
        topIsSameWay: `qIntersection([qParallelPlanes(${faces}, ${z(0)}, false), ${at("FACE", 5, 5, 10)}])`,
        // Planes whose normal is square to Z: the four sides.
        planesAlongZ: `qPlanesParallelToDirection(${faces}, vector(0, 0, 1))`,
        // The four sides and the pin's wall.
        facesAlongZ:
          'qFacesParallelToDirection(qUnion([qCreatedBy(id + "a", EntityType.FACE), qCreatedBy(id + "pin", EntityType.FACE)]), vector(0, 0, 1))',
      }),
    ).toEqual({ parallel: 2, sameWay: 1, topIsSameWay: 1, planesAlongZ: 4, facesAlongZ: 5 });
  });

  it("pick what shares an axis, either way along it", () => {
    const pinParts =
      'qUnion([qCreatedBy(id + "pin", EntityType.FACE), qCreatedBy(id + "pin", EntityType.EDGE), qCreatedBy(id + "mc", EntityType.BODY)])';
    expect(
      counts(solids, {
        // The wall, both rims and the mate connector.
        onAxis: `qAxis(${pinParts}, line(vector(30, 0, 0) * millimeter, vector(0, 0, -1)))`,
        offAxis: `qAxis(${pinParts}, line(vector(31, 0, 0) * millimeter, vector(0, 0, 1)))`,
      }),
    ).toEqual({ onAxis: 4, offAxis: 0 });
  });

  it("pick what lies in front of or crosses a plane", () => {
    expect(
      counts(solids, {
        verticesAbove: `qInFrontOfPlane(${vertices}, ${z(5)})`,
        // Coincident counts as in front: everything from z = 0 up.
        facesFromBottom: `qInFrontOfPlane(${faces}, ${z(0)})`,
        facesAboveMiddle: `qInFrontOfPlane(${faces}, ${z(5)})`,
        crossingMiddle: `qIntersectsPlane(${faces}, ${z(5)})`,
        touchingTop: `qIntersectsPlane(${faces}, ${z(10)})`,
      }),
    ).toEqual({
      verticesAbove: 4,
      facesFromBottom: 6,
      facesAboveMiddle: 1,
      crossingMiddle: 4,
      touchingTop: 5,
    });
  });

  it("pick what a line or a ball touches", () => {
    const line = "line(vector(5, 0, 0) * millimeter, vector(0, 0, 1))";
    expect(
      counts(solids, {
        // The front face holds the line; the bottom and top faces meet it at their front edges.
        facesOnLine: `qIntersectsLine(${faces}, ${line})`,
        edgesOnLine: `qIntersectsLine(${edges}, ${line})`,
        // Within 10.5 mm of a corner: it and its three neighbors (the far ones are 14.1+ mm away).
        nearCorner: `qWithinRadius(${vertices}, vector(0, 0, 0) * millimeter, 10.5 * millimeter)`,
        // A solid counts when the ball reaches inside it.
        bodyFromInside:
          'qWithinRadius(qCreatedBy(id + "a", EntityType.BODY), vector(5, 5, 5) * millimeter, 1 * millimeter)',
      }),
    ).toEqual({ facesOnLine: 3, edgesOnLine: 2, nearCorner: 4, bodyFromInside: 1 });
  });

  it("filter edges by convexity", () => {
    // A 20 x 20 x 10 block with a 10 x 10 x 5 pocket: its rim is convex, its floor and inside
    // corners concave. (A union would leave coplanar faces unmerged here, unlike Onshape.)
    const setup = `${box("a", [0, 0, 0], [20, 20, 10])}${box("tool", [5, 5, 5], [15, 15, 15])}
      opBoolean(context, id + "pocket", { "tools" : qCreatedBy(id + "tool", EntityType.BODY), "targets" : qCreatedBy(id + "a", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`;
    const blockEdges = 'qOwnedByBody(qCreatedBy(id + "a", EntityType.BODY), EntityType.EDGE)';
    expect(
      counts(setup, {
        all: blockEdges,
        concave: `qEdgeConvexityTypeFilter(${blockEdges}, EdgeConvexityType.CONCAVE)`,
        convex: `qEdgeConvexityTypeFilter(${blockEdges}, EdgeConvexityType.CONVEX)`,
      }),
    ).toEqual({ all: 24, concave: 8, convex: 16 });
  });
});

describe("topology queries", () => {
  const filleted = `${box("a", [0, 0, 0], [20, 20, 10])}
    fillet(context, id + "fillet", { "entities" : qParallelEdges(qCreatedBy(id + "a", EntityType.EDGE), Z_DIRECTION), "radius" : 3 * millimeter });`;
  const pocketed = `${box("a", [0, 0, 0], [20, 20, 10])}${box("tool", [5, 5, 5], [15, 15, 15])}
    opBoolean(context, id + "pocket", { "tools" : qCreatedBy(id + "tool", EntityType.BODY), "targets" : qCreatedBy(id + "a", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`;
  const owned = (type: string) =>
    `qOwnedByBody(qCreatedBy(id + "a", EntityType.BODY), EntityType.${type})`;
  const faceAt = (x: number, y: number, z: number) =>
    `qContainsPoint(${owned("FACE")}, vector(${x}, ${y}, ${z}) * millimeter)`;
  const edgeAt = (x: number, y: number, z: number) =>
    `qContainsPoint(${owned("EDGE")}, vector(${x}, ${y}, ${z}) * millimeter)`;

  it("find an edge's start and end the way evEdgeTangentLine walks it", () => {
    const run = studio.run([
      {
        body: `${box("a", [0, 0, 0], [10, 10, 10])}
        const edge = ${edgeAt(5, 0, 0)};
        setVariable(context, "start", evVertexPoint(context, { "vertex" : qEdgeVertex(edge, true) }) == evEdgeTangentLine(context, { "edge" : edge, "parameter" : 0 }).origin);
        setVariable(context, "end", evVertexPoint(context, { "vertex" : qEdgeVertex(edge, false) }) == evEdgeTangentLine(context, { "edge" : edge, "parameter" : 1 }).origin);
        setVariable(context, "both", size(evaluateQuery(context, qUnion([qEdgeVertex(edge, true), qEdgeVertex(edge, false)]))));`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    expect([variable(run, "start"), variable(run, "end"), untag(variable(run, "both"))]).toEqual([
      true,
      true,
      2,
    ]);
  });

  it("flood faces across tangent, convex and concave edges", () => {
    expect(
      counts(filleted, {
        // The four sides and four fillets, but not the top or bottom.
        tangent: `qTangentConnectedFaces(${faceAt(10, 0, 5)})`,
        // Exterior fillets' edges count as convex, so the whole box.
        convex: `qConvexConnectedFaces(${faceAt(10, 10, 10)})`,
      }),
    ).toEqual({ tangent: 8, convex: 10 });
    expect(
      counts(pocketed, {
        // Top, four sides, bottom, and the pocket's four walls over the convex rim; not the floor.
        convex: `qConvexConnectedFaces(${faceAt(2, 2, 10)})`,
        // The floor and the four walls.
        concave: `qConcaveConnectedFaces(${faceAt(10, 10, 5)})`,
      }),
    ).toEqual({ convex: 10, concave: 5 });
  });

  it("find loops and the faces they bound", () => {
    const cube = box("a", [0, 0, 0], [10, 10, 10]);
    expect(
      counts(cube, {
        topLoop: `qLoopEdges(${faceAt(5, 5, 10)})`,
        // Top and front together: their 8 edges less the one they share.
        joined: `qLoopEdges(qUnion([${faceAt(5, 5, 10)}, ${faceAt(5, 0, 5)}]))`,
        // From the front, up to the top and bottom: the four sides.
        betweenFaces: `qFaceOrEdgeBoundedFaces(qUnion([${faceAt(5, 0, 5)}, ${faceAt(5, 5, 10)}, ${faceAt(5, 5, 0)}]))`,
        // Fenced in by its own edges: the front alone.
        betweenEdges: `qFaceOrEdgeBoundedFaces(qUnion([${faceAt(5, 0, 5)}, ${edgeAt(5, 0, 0)}, ${edgeAt(5, 0, 10)}, ${edgeAt(0, 0, 5)}, ${edgeAt(10, 0, 5)}]))`,
      }),
    ).toEqual({ topLoop: 4, joined: 6, betweenFaces: 4, betweenEdges: 1 });
    expect(
      counts(pocketed, {
        // The face around the pocket and one rim edge: the pocket's walls and floor.
        pocket: `qLoopBoundedFaces(qUnion([${faceAt(2, 2, 10)}, ${edgeAt(10, 5, 10)}]))`,
      }),
    ).toEqual({ pocket: 5 });
    const sketch = `
      const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : XY_PLANE });
      skRectangle(sketch, "box", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 5) * millimeter });
      skSolve(sketch);`;
    expect(
      counts(sketch, {
        // One edge of the region sheet's laminar boundary brings the whole loop.
        laminarLoop:
          'qLoopEdges(qContainsPoint(qBodyType(qCreatedBy(id + "sketch", EntityType.EDGE), BodyType.SHEET), vector(5, 0, 0) * millimeter))',
      }),
    ).toEqual({ laminarLoop: 4 });
  });
});

describe("fillet faces", () => {
  // Two fillets of radius 2 mm (one feature) and two of 4 mm (another) on a box's vertical edges.
  const setup = `${box("a", [0, 0, 0], [20, 20, 10])}
    fillet(context, id + "small", { "entities" : qUnion([${at("EDGE", 0, 0, 5)}, ${at("EDGE", 20, 0, 5)}]), "radius" : 2 * millimeter });
    // Through the body: after a fillet, Model.ts gives the body's untouched edges new creators.
    const edgeOf = function(x, y) { return qContainsPoint(qOwnedByBody(qCreatedBy(id + "a", EntityType.BODY), EntityType.EDGE), vector(x, y, 5) * millimeter); };
    fillet(context, id + "large", { "entities" : qUnion([edgeOf(0, 20), edgeOf(20, 20)]), "radius" : 4 * millimeter });
    fCylinder(context, id + "pin", { "bottomCenter" : vector(40, 0, 0) * millimeter, "topCenter" : vector(40, 0, 10) * millimeter, "radius" : 2 * millimeter });`;
  const small = 'qNthElement(qCreatedBy(id + "small", EntityType.FACE), 0)';
  const large = 'qNthElement(qCreatedBy(id + "large", EntityType.FACE), 0)';
  it("match a body's fillets by radius against the seed's", () => {
    expect(
      counts(setup, {
        equalSmall: `qFilletFaces(${small}, CompareType.EQUAL)`,
        atMostSmall: `qFilletFaces(${small}, CompareType.LESS_EQUAL)`,
        atLeastSmall: `qFilletFaces(${small}, CompareType.GREATER_EQUAL)`,
        atMostLarge: `qFilletFaces(${large}, CompareType.LESS_EQUAL)`,
        // A planar face, and a cylinder no fillet made, aren't fillets.
        fromPlane:
          'qFilletFaces(qContainsPoint(qOwnedByBody(qCreatedBy(id + "a", EntityType.BODY), EntityType.FACE), vector(10, 10, 10) * millimeter), CompareType.EQUAL)',
        fromPin:
          'qFilletFaces(qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.CYLINDER), CompareType.EQUAL)',
      }),
    ).toEqual({
      equalSmall: 2,
      atMostSmall: 2,
      atLeastSmall: 4,
      atMostLarge: 4,
      fromPlane: 0,
      fromPin: 0,
    });
  });
  it("evFilletRadius reads a fillet's radius and refuses other faces", () => {
    const run = studio.run([
      {
        body: `${setup}
        setVariable(context, "radius", evFilletRadius(context, { "face" : ${large} }) / millimeter);
        var caught;
        try silent { evFilletRadius(context, { "face" : qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.CYLINDER) }); }
        catch (error) { caught = error.message; }
        setVariable(context, "pin", caught);`,
      },
    ]);
    expect(run.features[0]?.fault?.message ?? run.features[0]?.status).toBe("OK");
    expect(untag(variable(run, "radius"))).toBeCloseTo(4, 12);
    expect(String(untag(variable(run, "pin")))).toBe("BAD_GEOMETRY");
  });
});

describe("history queries", () => {
  const patterned = `${box("a", [0, 0, 0], [10, 10, 10])}
    opPattern(context, id + "pattern", { "entities" : qCreatedBy(id + "a", EntityType.BODY),
        "transforms" : [transform(vector(20, 0, 0) * millimeter), transform(vector(40, 0, 0) * millimeter), transform(vector(60, 0, 0) * millimeter)],
        "instanceNames" : ["1", "2", "10"] });`;
  it("find a pattern's instances by name, and nothing is consumed without composite parts", () => {
    expect(
      counts(patterned, {
        one: 'qPatternInstances(id + "pattern", "1", EntityType.BODY)',
        oneIsFirst: `qIntersection([qPatternInstances(id + "pattern", "1", EntityType.BODY), qContainsPoint(qEverything(EntityType.BODY), vector(25, 5, 5) * millimeter)])`,
        twoFaces: 'qPatternInstances(id + "pattern", ["2"], EntityType.FACE)',
        both: 'qPatternInstances(id + "pattern", ["1", "10"], EntityType.BODY)',
        notConsumed: 'qConsumed(qCreatedBy(id + "a", EntityType.FACE), Consumed.NO)',
        consumed: 'qConsumed(qCreatedBy(id + "a", EntityType.FACE), Consumed.YES)',
      }),
    ).toEqual({ one: 1, oneIsFirst: 1, twoFaces: 6, both: 2, notConsumed: 6, consumed: 0 });
  });

  it("stop the run where they'd need operation provenance", () => {
    for (const [query, message] of [
      ['qDependency(qCreatedBy(id + "a", EntityType.BODY))', /qDependency/],
      ['qLaminarDependency(qCreatedBy(id + "a", EntityType.EDGE))', /qLaminarDependency/],
      ['qMatching(qNthElement(qCreatedBy(id + "a", EntityType.FACE), 0))', /qMatching/],
    ] as const) {
      const run = studio.run([
        {
          body: `${patterned}
evaluateQuery(context, ${query});`,
        },
      ]);
      expect(run.features[0]!.fault?.message, query).toMatch(message);
    }
  });
});
