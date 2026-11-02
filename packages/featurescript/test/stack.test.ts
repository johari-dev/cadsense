import { beforeAll, describe, expect, it } from "vite-plus/test";
import { IMPLEMENTED, UNSUPPORTED } from "../src/builtins/index.ts";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, solidVolumes, variable } from "./partStudio.ts";

/**
 * Behaviour that crosses builtins from different areas (from the integrated review).
 *
 * Ways it goes wrong:
 * - Two builtin tables define one name, so spread order silently picks one, or a name is both
 *   implemented and listed as unsupported.
 * - opHole's face and profile names belong to exact kernel shapes, so a later operation that
 *   rebuilds the body (even a translation) drops them and qOpHoleFace finds nothing.
 * - opSplitEdges converts its arc-length parameter differently from the evaluators, so the split
 *   lands away from evEdgeTangentLine's point at the same parameter.
 * - A boolean intersection of three bodies computes A and (B or C), not what all three share.
 * - Split part treats a sheet or wire target like a solid, finds no solid pieces, and deletes it.
 * - A body pattern copies the body's attributes but not its faces', edges' or vertices'.
 * - qCreatedBy keeps one creator per entity, so split pieces drop the split (or the original's
 *   creator) and merged entities drop every creator but one, against std's qCreatedBy contract.
 * - Bodies that coincide entirely (two identical cubes united) share every image, so the creator
 *   rule finds no source and drops both cubes' and the union's creators.
 * - A multi-body intersection or union consumes its tools even with keepTools.
 * - A merged face or body keeps only its primary source's attributes.
 * - A face pattern copies its faces' attributes but not their boundary edges'.
 * - setProperty drops face properties (std allows APPEARANCE and NAME on faces).
 * - std Mirror fails: matrixMultiply rejects std's number * Matrix.
 * - std extrude with a draft stops at qDependency, which it needs only for the profile's plane.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

describe("builtin tables", () => {
  it("define each name once, and never as both implemented and unsupported", () => {
    expect(IMPLEMENTED.filter((name, i) => IMPLEMENTED.indexOf(name) !== i)).toEqual([]);
    const unsupported: readonly string[] = UNSUPPORTED;
    expect(IMPLEMENTED.filter((name) => unsupported.includes(name))).toEqual([]);
  });
});

describe("hole names", () => {
  it("follow the hole's faces and profiles through a translation", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 40, 20) * millimeter });
        opHole(context, id + "hole", { "holeDefinition" : holeDefinition([
            holeProfileBeforeReference(HolePositionReference.TARGET_START, 0 * millimeter, 5 * millimeter),
            holeProfile(HolePositionReference.TARGET_START, 8 * millimeter, 5 * millimeter),
            holeProfile(HolePositionReference.TARGET_START, 8 * millimeter, 0 * millimeter)
          ]), "axes" : [line(vector(20, 20, 25) * millimeter, vector(0, 0, -1))], "targets" : qCreatedBy(id + "plate", EntityType.BODY) });
        setVariable(context, "facesBefore", size(evaluateQuery(context, qOpHoleFace(id + "hole"))));
        setVariable(context, "profilesBefore", size(evaluateQuery(context, qOpHoleProfile(id + "hole"))));
        opTransform(context, id + "move", { "bodies" : qCreatedBy(id + "plate", EntityType.BODY), "transform" : transform(vector(10, 0, 0) * millimeter) });
        setVariable(context, "facesAfter", size(evaluateQuery(context, qOpHoleFace(id + "hole"))));
        setVariable(context, "profilesAfter", size(evaluateQuery(context, qOpHoleProfile(id + "hole"))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "facesBefore")).toBe(2);
    expect(numberVariable(run, "profilesBefore")).toBe(2);
    expect(numberVariable(run, "facesAfter")).toBe(2);
    expect(numberVariable(run, "profilesAfter")).toBe(2);
  });
});

describe("opSplitEdges", () => {
  it("splits at the same arc-length parameter the evaluators use", () => {
    // 1025 points 0.1 mm apart in x, zig-zagging 1 mm in z over the first half: the speed varies
    // so much that coarse arc-length integration puts 10% of the length 0.03 mm off.
    const points = Array.from(
      { length: 1025 },
      (_, i) => `vector(${(0.1 * i).toFixed(1)}, 0, ${i < 512 ? i % 2 : 0}) * millimeter`,
    ).join(", ");
    const run = studio.run([
      {
        body: `
        opFitSpline(context, id + "spline", { "points" : [${points}] });
        const edges = qCreatedBy(id + "spline", EntityType.EDGE);
        const at = evEdgeTangentLine(context, { "edge" : edges, "parameter" : 0.1 }).origin;
        opSplitEdges(context, id + "split", { "edges" : edges, "parameters" : [[0.1]] });
        setVariable(context, "gap", evDistance(context, { "side0" : at, "side1" : qCreatedBy(id + "split", EntityType.VERTEX) }).distance / millimeter);`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "gap")).toBeLessThan(1e-6);
  });
});

describe("opBoolean intersection", () => {
  it("keeps only what every body shares", () => {
    // x spans [0, 30], [0, 20] and [10, 30] mm, all 10 x 10 in y and z: they share [10, 20].
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(30, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });
        fCuboid(context, id + "c", { "corner1" : vector(10, 0, 0) * millimeter, "corner2" : vector(30, 10, 10) * millimeter });
        opBoolean(context, id + "common", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY), qCreatedBy(id + "c", EntityType.BODY)]), "operationType" : BooleanOperationType.INTERSECTION });
        const solids = qBodyType(qEverything(EntityType.BODY), BodyType.SOLID);
        setVariable(context, "solids", size(evaluateQuery(context, solids)));
        setVariable(context, "volume", evVolume(context, { "entities" : solids }) / millimeter ^ 3);`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "solids")).toBe(1);
    expect(numberVariable(run, "volume")).toBeCloseTo(1000, 6);
  });
});

describe("opSplitPart on sheets and wires", () => {
  const sheet =
    'opCreateBSplineSurface(context, id + "seed", { "bSplineSurface" : bSplineSurface({ "uDegree" : 1, "vDegree" : 1, "isUPeriodic" : false, "isVPeriodic" : false, "controlPoints" : controlPointMatrix([[vector(-10, -10, 0) * millimeter, vector(-10, 10, 0) * millimeter], [vector(10, -10, 0) * millimeter, vector(10, 10, 0) * millimeter]]) }) });';
  const wire =
    'opFitSpline(context, id + "seed", { "points" : [vector(-10, 0, 0) * millimeter, vector(10, 0, 0) * millimeter] });';
  /** Splits the seed at x = 0 and counts the bodies left, with their area (sheet) or length (wire). */
  const split = (seed: string, keep: string, measure: string) =>
    studio.run([
      {
        body: `${seed}
        opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "seed", EntityType.BODY), "tool" : plane(vector(0, 0, 0) * millimeter, vector(1, 0, 0)), "keepType" : SplitOperationKeepType.${keep} });
        const left = qSubtraction(qEverything(EntityType.BODY), qConstructionFilter(qEverything(EntityType.BODY), ConstructionObject.YES));
        setVariable(context, "bodies", size(evaluateQuery(context, left)));
        setVariable(context, "measure", ${measure});`,
      },
    ]);
  const area =
    'evArea(context, { "entities" : qOwnedByBody(left, EntityType.FACE) }) / millimeter ^ 2';
  const length =
    'evLength(context, { "entities" : qOwnedByBody(left, EntityType.EDGE) }) / millimeter';

  it.each([
    ["sheet", sheet, area, 400, 200],
    ["wire", wire, length, 20, 10],
  ])("splits a %s into two pieces, or keeps the front one", (_, seed, measure, whole, half) => {
    const all = split(seed, "KEEP_ALL", measure);
    expect(all.features[0]!.status).toBe("OK");
    expect(numberVariable(all, "bodies")).toBe(2);
    expect(numberVariable(all, "measure")).toBeCloseTo(whole, 6);
    const front = split(seed, "KEEP_FRONT", measure);
    expect(front.features[0]!.status).toBe("OK");
    expect(numberVariable(front, "bodies")).toBe(1);
    expect(numberVariable(front, "measure")).toBeCloseTo(half, 6);
  });
});

describe("opPattern attributes", () => {
  it("copies every attribute of a patterned body, its faces, edges and vertices too", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        for (var kind in [EntityType.BODY, EntityType.FACE, EntityType.EDGE, EntityType.VERTEX])
            setAttribute(context, { "entities" : qCreatedBy(id + "box", kind), "name" : "tag", "attribute" : 17 });
        opPattern(context, id + "pattern", { "entities" : qCreatedBy(id + "box", EntityType.BODY), "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["copy"] });
        setVariable(context, "tagged", mapArray([EntityType.BODY, EntityType.FACE, EntityType.EDGE, EntityType.VERTEX], function(kind) {
            return size(evaluateQuery(context, qHasAttribute(qCreatedBy(id + "pattern", kind), "tag")));
        }));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    const tagged = (untag(variable(run, "tagged")) as readonly FsValue[]).map(untag);
    expect(tagged).toEqual([1, 6, 12, 8]);
  });
});

describe("qCreatedBy after splits and merges", () => {
  const counts = (body: string, names: readonly string[]) => {
    const run = studio.run([
      {
        body: `${body}
        setVariable(context, "counts", mapArray(${JSON.stringify(names)}, function(name) {
            return [size(evaluateQuery(context, qCreatedBy(id + name, EntityType.BODY))), size(evaluateQuery(context, qCreatedBy(id + name, EntityType.FACE)))];
        }));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    return (untag(variable(run, "counts")) as readonly FsValue[]).map((pair) =>
      (untag(pair) as readonly FsValue[]).map(untag),
    );
  };

  it("counts split pieces as created by the original's creator and the split", () => {
    // A 10 mm cube cut at z = 5: both pieces belong to both. Top and bottom stay whole (the cube's
    // only); the four sides split into eight pieces (both); the cut makes two new faces (split's).
    expect(
      counts(
        `fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        opSplitPart(context, id + "cut", { "targets" : qCreatedBy(id + "a", EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, Z_DIRECTION) });`,
        ["a", "cut"],
      ),
    ).toEqual([
      [2, 10],
      [2, 10],
    ]);
  });

  it("counts merged entities as created by every creator and the merge", () => {
    // Two 10 mm cubes touching at x = 10, united: their top, bottom, front and back merge into four
    // faces created by both cubes and the union; each cube keeps its outer end.
    expect(
      counts(
        `fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(10, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });
        opBoolean(context, id + "join", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });`,
        ["a", "b", "join"],
      ),
    ).toEqual([
      [1, 5],
      [1, 5],
      [1, 4],
    ]);
  });
});

describe("round 3 fixes", () => {
  const box = (name: string, a = "0, 0, 0", b = "10, 10, 10") =>
    `fCuboid(context, id + "${name}", { "corner1" : vector(${a}) * millimeter, "corner2" : vector(${b}) * millimeter });`;
  const three =
    box("a", "0, 0, 0", "30, 30, 30") +
    box("b", "5, 0, 0", "35, 30, 30") +
    box("c", "0, 5, 0", "30, 35, 30");
  const tools = `qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY), qCreatedBy(id + "c", EntityType.BODY)])`;
  const solids = "qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)";

  it("counts a union of identical cubes as created by both cubes and the union", () => {
    const run = studio.run([
      {
        body: `${box("a")}${box("b")}
        opBoolean(context, id + "merge", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });
        setVariable(context, "faces", mapArray(["a", "b", "merge"], function(name) { return size(evaluateQuery(context, qCreatedBy(id + name, EntityType.FACE))); }));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect((untag(variable(run, "faces")) as readonly FsValue[]).map(untag)).toEqual([6, 6, 6]);
  });

  it("keeps the tools of an intersection with keepTools", () => {
    // The three cubes share [5, 30] x [5, 30] x [0, 30]: 18750 mm3, next to the three kept cubes.
    const run = studio.run([
      {
        body: `${three}
        opBoolean(context, id + "common", { "tools" : ${tools}, "operationType" : BooleanOperationType.INTERSECTION, "keepTools" : true });
        setVariable(context, "bodies", size(evaluateQuery(context, ${solids})));
        setVariable(context, "made", evVolume(context, { "entities" : qCreatedBy(id + "common", EntityType.BODY) }) / millimeter ^ 3);`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "bodies")).toBe(4);
    expect(numberVariable(run, "made")).toBeCloseTo(18750, 6);
  });

  it("keeps every merged source's attributes", () => {
    // B's faces at x = 35 and C's at y = 35 are cut away; B's other four faces survive, three of
    // them merged with A's.
    const run = studio.run([
      {
        body: `${three}
        setAttribute(context, { "entities" : qCreatedBy(id + "b", EntityType.FACE), "name" : "b", "attribute" : 2 });
        opBoolean(context, id + "common", { "tools" : ${tools}, "operationType" : BooleanOperationType.INTERSECTION });
        setVariable(context, "tagged", size(evaluateQuery(context, qHasAttribute(qCreatedBy(id + "b", EntityType.FACE), "b"))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "tagged")).toBe(4);
  });

  it("copies a patterned face's edge attributes", () => {
    const run = studio.run([
      {
        body: `${box("plate", "0, 0, 0", "100, 60, 10")}
        fCylinder(context, id + "pin", { "bottomCenter" : vector(50, 30, -1) * millimeter, "topCenter" : vector(50, 30, 11) * millimeter, "radius" : 5 * millimeter });
        opBoolean(context, id + "cut", { "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qCreatedBy(id + "pin", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
        const wall = qGeometry(qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.FACE), GeometryType.CYLINDER);
        setAttribute(context, { "entities" : qAdjacent(wall, AdjacencyType.EDGE, EntityType.EDGE), "name" : "edge", "attribute" : 18 });
        opPattern(context, id + "pattern", { "entities" : wall, "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["one"] });
        setVariable(context, "tagged", size(evaluateQuery(context, qHasAttribute(qCreatedBy(id + "pattern", EntityType.EDGE), "edge"))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "tagged")).toBe(2);
  });

  it("stores face appearance, and a pattern copies it", () => {
    const run = studio.run([
      {
        body: `${box("a")}
        setProperty(context, { "entities" : qCreatedBy(id + "a", EntityType.FACE), "propertyType" : PropertyType.APPEARANCE, "value" : color(1, 0, 0) });
        opPattern(context, id + "pattern", { "entities" : qCreatedBy(id + "a", EntityType.BODY), "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["one"] });`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    const faces = [...run.geometry!.entities.values()].filter(
      (entity) => entity.type === "FACE" && !entity.construction,
    );
    expect(faces.filter((face) => face.properties.has("APPEARANCE"))).toHaveLength(12);
  });

  it("mirrors a cube across the Right plane with std's Mirror", () => {
    const run = studio.run([
      { body: box("cube") },
      {
        std: "mirror.fs",
        feature: "mirror",
        parameters: {
          entities: 'qCreatedBy(makeId("Feature1"), EntityType.BODY)',
          mirrorPlane: 'qCreatedBy(makeId("Right"), EntityType.FACE)',
        },
      },
    ]);
    expect(run.features.map((f) => [f.status, f.fault?.message ?? null])).toEqual([
      ["OK", null],
      ["OK", null],
    ]);
    const boxes = [...run.geometry!.entities.values()]
      .filter((entity) => entity.type === "BODY" && entity.bodyType === "SOLID")
      .map((body) => {
        const box = new run.oc!.Bnd_Box();
        run.oc!.BRepBndLib.Add(body.shape, box, false);
        return Math.round(box.CornerMin().X() * 1000) + 0;
      })
      .sort((a, b) => a - b);
    expect(boxes).toEqual([-10, 0]);
  });

  it("drafts a std extrude outward", () => {
    // A 30 x 40 mm rectangle extruded 10 mm with a 5 degree outward draft: each side moves out by
    // z tan 5, so the volume is ab h + (a + b) t h^2 + 4/3 t^2 h^3.
    const t = Math.tan((5 * Math.PI) / 180);
    const run = studio.run([
      {
        body: `const sketch = newSketch(context, id + "sketch", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
        skRectangle(sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(30, 40) * millimeter });
        skSolve(sketch);`,
      },
      {
        std: "extrude.fs",
        feature: "extrude",
        parameters: {
          entities: 'qSketchRegion(makeId("Feature1") + "sketch")',
          depth: "10 * millimeter",
          hasDraft: "true",
          draftAngle: "5 * degree",
        },
      },
    ]);
    expect(run.features.map((f) => [f.status, f.fault?.message ?? null])).toEqual([
      ["OK", null],
      ["OK", null],
    ]);
    const [volume] = solidVolumes(run);
    expect(volume!).toBeCloseTo(12000 + 70 * t * 100 + (4 / 3) * t * t * 1000, 3);
  });
});

describe("per-PR review round 1 (#173)", () => {
  const box = (name: string, a: string, b: string) =>
    `fCuboid(context, id + "${name}", { "corner1" : vector(${a}) * millimeter, "corner2" : vector(${b}) * millimeter });`;
  const count = (query: string) => `size(evaluateQuery(context, ${query}))`;

  it("keeps every creator when coincident bodies merge with a neighbor", () => {
    // Identical cubes A and B with C beside them, united: one body made by all three and the
    // union. B's faces: its four sides merged with C's and A's end at x = 0 (its own x = 10 end is
    // gone inside the union).
    const run = studio.run([
      {
        body: `${box("a", "0, 0, 0", "10, 10, 10")}${box("b", "0, 0, 0", "10, 10, 10")}${box("c", "10, 0, 0", "20, 10, 10")}
        opBoolean(context, id + "merge", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY), qCreatedBy(id + "c", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });
        setVariable(context, "bodies", mapArray(["a", "b", "c", "merge"], function(name) { return ${count("qCreatedBy(id + name, EntityType.BODY)")}; }));
        setVariable(context, "bFaces", ${count('qCreatedBy(id + "b", EntityType.FACE)')});`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect((untag(variable(run, "bodies")) as readonly FsValue[]).map(untag)).toEqual([1, 1, 1, 1]);
    expect(numberVariable(run, "bFaces")).toBe(5);
  });

  it("keeps the primary entity's value for an attribute both merged entities name", () => {
    const run = studio.run([
      {
        body: `${box("a", "0, 0, 0", "10, 10, 10")}${box("b", "10, 0, 0", "20, 10, 10")}
        setAttribute(context, { "entities" : qCreatedBy(id + "a", EntityType.BODY), "name" : "tag", "attribute" : 1 });
        setAttribute(context, { "entities" : qCreatedBy(id + "b", EntityType.BODY), "name" : "tag", "attribute" : 2 });
        opBoolean(context, id + "merge", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });
        const solids = qBodyType(qEverything(EntityType.BODY), BodyType.SOLID);
        setVariable(context, "values", [${count('qHasAttributeWithValue(solids, "tag", 1)')}, ${count('qHasAttributeWithValue(solids, "tag", 2)')}]);`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect((untag(variable(run, "values")) as readonly FsValue[]).map(untag)).toEqual([1, 0]);
  });

  it("finds an extrude's dependency among what its profile query found when it ran", () => {
    // The profile query names every sketch face; a rectangle sketched after the extrude isn't one.
    const sketch = (name: string, x: number) =>
      `const ${name} = newSketch(context, id + "${name}", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
        skRectangle(${name}, "r", { "firstCorner" : vector(${x}, 0) * millimeter, "secondCorner" : vector(${x + 10}, 10) * millimeter });
        skSolve(${name});`;
    const run = studio.run([
      {
        body: `${sketch("s1", 0)}
        opExtrude(context, id + "extrude", { "entities" : qSketchFilter(qEverything(EntityType.FACE), SketchObject.YES), "direction" : vector(0, 0, 1), "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
        ${sketch("s2", 20)}
        setVariable(context, "dependencies", ${count('qDependency(qCreatedBy(id + "extrude", EntityType.BODY))')});`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "dependencies")).toBe(1);
  });
});

describe("per-PR review round 2 (#173)", () => {
  const box = (name: string, a = "0, 0, 0", b = "10, 10, 10") =>
    `fCuboid(context, id + "${name}", { "corner1" : vector(${a}) * millimeter, "corner2" : vector(${b}) * millimeter });`;
  const body = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
  const tools = (names: readonly string[]) => `qUnion([${names.map(body).join(", ")}])`;
  /** A value with its arrays and tags unwrapped, for comparing with plain numbers. */
  const unwrap = (value: FsValue): unknown => {
    const inner = untag(value);
    return Array.isArray(inner) ? inner.map(unwrap) : inner;
  };
  const plain = (run: ReturnType<typeof studio.run>, name: string) => unwrap(variable(run, name));

  it("keeps both creators on every piece when coincident targets split", () => {
    // Identical cubes A and B cut through by a slab: two pieces, each made from both and the cut.
    const run = studio.run([
      {
        body: `${box("a")}${box("b")}${box("c", "4, -1, -1", "6, 11, 11")}
        opBoolean(context, id + "cut", { "targets" : ${tools(["a", "b"])}, "tools" : ${body("c")}, "operationType" : BooleanOperationType.SUBTRACTION });
        setVariable(context, "counts", mapArray(["a", "b", "cut"], function(name) { return size(evaluateQuery(context, qCreatedBy(id + name, EntityType.BODY))); }));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(plain(run, "counts")).toEqual([2, 2, 2]);
  });

  it("never merges two unnamed attributes of one type onto an entity", () => {
    // attributes.fs: legacy unnamed attributes are identified by type, one of each per entity.
    const run = studio.run([
      {
        body: `${box("a")}${box("b", "10, 0, 0", "20, 10, 10")}
        setAttribute(context, { "entities" : ${body("a")}, "attribute" : { "tag" : 1 } });
        setAttribute(context, { "entities" : ${body("b")}, "attribute" : { "tag" : 2 } });
        opBoolean(context, id + "merge", { "tools" : ${tools(["a", "b"])}, "operationType" : BooleanOperationType.UNION });
        setVariable(context, "count", size(getAttributes(context, { "entities" : ${body("merge")}, "attributePattern" : {} })));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "count")).toBe(1);
  });

  it("finds no dependency once the profile is deleted", () => {
    const run = studio.run([
      {
        body: `const sketch = newSketch(context, id + "sk", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
        skRectangle(sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 10) * millimeter });
        skSolve(sketch);
        opExtrude(context, id + "ex", { "entities" : qSketchRegion(id + "sk"), "direction" : Z_DIRECTION, "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
        opDeleteBodies(context, id + "delete", { "entities" : ${body("sk")} });
        setVariable(context, "count", size(evaluateQuery(context, qDependency(${body("ex")}))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "count")).toBe(0);
  });

  it("gives merged faces the primary tool's value for a named attribute", () => {
    // Tools ordered B then A: B is primary, so the body and its four merged faces keep B's 2; A's
    // own end face keeps A's 1.
    const run = studio.run([
      {
        body: `${box("a")}${box("b", "10, 0, 0", "20, 10, 10")}
        setAttribute(context, { "entities" : qCreatedBy(id + "a"), "name" : "tag", "attribute" : 1 });
        setAttribute(context, { "entities" : qCreatedBy(id + "b"), "name" : "tag", "attribute" : 2 });
        opBoolean(context, id + "merge", { "tools" : ${tools(["b", "a"])}, "operationType" : BooleanOperationType.UNION });
        setVariable(context, "counts", mapArray([EntityType.BODY, EntityType.FACE], function(kind) {
            return [size(evaluateQuery(context, qHasAttributeWithValue(qEverything(kind), "tag", 1))), size(evaluateQuery(context, qHasAttributeWithValue(qEverything(kind), "tag", 2)))];
        }));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(plain(run, "counts")).toEqual([
      [0, 1],
      [1, 5],
    ]);
  });
});

describe("per-PR review round 3 (#173)", () => {
  // attributes.fs: a split entity's pieces each carry its attributes.
  it("gives both pieces of a split body its attributes", () => {
    const run = studio.run([
      {
        body: `fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        setAttribute(context, { "entities" : qCreatedBy(id + "a", EntityType.BODY), "name" : "tag", "attribute" : 7 });
        opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "a", EntityType.BODY), "tool" : plane(vector(5, 0, 0) * millimeter, vector(1, 0, 0)), "keepType" : SplitOperationKeepType.KEEP_ALL });
        setVariable(context, "tagged", size(evaluateQuery(context, qHasAttribute(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), "tag"))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "tagged")).toBe(2);
  });

  // A profile split since the extrude continues as its pieces: they're the dependency now.
  it("follows a split profile to its pieces", () => {
    const run = studio.run([
      {
        body: `const sketch = newSketch(context, id + "sk", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
        skRectangle(sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 10) * millimeter });
        skSolve(sketch);
        opExtrude(context, id + "ex", { "entities" : qSketchRegion(id + "sk"), "direction" : Z_DIRECTION, "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
        opSplitPart(context, id + "split", { "targets" : qBodyType(qCreatedBy(id + "sk", EntityType.BODY), BodyType.SHEET), "tool" : plane(vector(5, 0, 0) * millimeter, vector(1, 0, 0)) });
        setVariable(context, "count", size(evaluateQuery(context, qDependency(qCreatedBy(id + "ex", EntityType.BODY)))));`,
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(numberVariable(run, "count")).toBe(2);
  });
});
