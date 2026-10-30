import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered, type Entity, type GeometryState } from "../src/geometry/Model.ts";
import type { Oc } from "../src/geometry/occt.ts";
import { FeatureScriptRuntime, type PartStudioRun } from "../src/Runtime.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * Face and body operations (direct editing) through std's own features and the ops they call.
 * Every expected volume and count is a hand calculation, written next to the assertion. Counts follow
 * Parasolid's conventions (no seam edges, no vertices on closed circles).
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const feature = (body: string) =>
  runtime.load(
    `test/faceOps${counter++}.fs`,
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

interface BodySummary {
  readonly type: string;
  readonly volume: number;
  readonly area: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
}

/** Solids and non-sketch sheets after the run, in creation order, in millimeters. */
function bodies(oc: Oc, geometry: GeometryState): BodySummary[] {
  const owned = (body: Entity, type: string) =>
    ordered(geometry, (entity) => entity.body === body.id && entity.type === type);
  return ordered(
    geometry,
    (entity) =>
      entity.type === "BODY" &&
      !entity.construction &&
      (entity.bodyType === "SOLID" ||
        (entity.bodyType === "SHEET" &&
          owned(entity, "FACE").some((face) => face.sketch === null))),
  ).map((body) => {
    const volume = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(body.shape, volume, false, false, false);
    const area = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(body.shape, area, false, false);
    return {
      type: body.bodyType,
      volume: body.bodyType === "SOLID" ? volume.Mass() * 1e9 : 0,
      area: area.Mass() * 1e6,
      faces: owned(body, "FACE").length,
      edges: owned(body, "EDGE").length,
      vertices: owned(body, "VERTEX").length,
    };
  });
}

function run(body: string) {
  const result: PartStudioRun = runtime.runFeatures([{ module: feature(body), feature: "test" }]);
  const first = result.features[0]!;
  return {
    status: first.status,
    statusEnum: first.statusEnum,
    fault: first.fault?.message ?? null,
    /** Why it failed, for assertion messages. */
    why: JSON.stringify([first.fault?.message, first.exceptions.map((e) => e.message)]),
    get: (name: string) => {
      const value = untag(first.variables.getField(name)!);
      return typeof value === "number" ? value : value;
    },
    bodies: () => bodies(result.oc!, result.geometry!),
  };
}

const close = (actual: number, expected: number, digits = 3) =>
  expect(actual).toBeCloseTo(expected, digits);

const record = (name: string, expression: string) =>
  `setVariable(context, "${name}", ${expression});`;

// A 100 x 60 x 10 mm plate with a 5 mm radius hole through it at (50, 30).
const plateWithHole = [
  'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
  'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
  'skCircle(sketch, "hole", { "center" : vector(50, 30) * millimeter, "radius" : 5 * millimeter });',
  "skSolve(sketch);",
  'extrude(context, id + "cut", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.THROUGH_ALL, "oppositeDirection" : true, "operationType" : NewBodyOperationType.REMOVE, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "plate", EntityType.BODY) });',
].join("\n");
const holeFace = 'qGeometry(qCreatedBy(id + "cut", EntityType.FACE), GeometryType.CYLINDER)';
const plateTop =
  'qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(10, 10, 10) * millimeter)';
const PLATE = 100 * 60 * 10;

// Delete face. Ways it goes wrong: healing fills the wrong side (adds a protrusion's volume instead
// of removing it); the neighbors keep their seams with the filled region (extra faces); the body or
// its kept faces get new ids, so later features lose them; a heal that can't close the gap returns a
// body anyway (an open shell drawn as a solid, or the whole body removed with the faces it was
// meant to keep); leave-open leaves a solid instead of a sheet; cap doesn't fall back when healing
// fails; adjacent fillets aren't picked up with includeFillet; heal on a sheet silently does
// something else.
describe("opDeleteFace", () => {
  it("heals a through hole: the plate keeps its id and its top face, and the hole is gone", () => {
    const r = run(
      [
        plateWithHole,
        `const top = evaluateQuery(context, ${plateTop})[0];`,
        `deleteFace(context, id + "delete", { "deleteFaces" : ${holeFace}, "healType" : DeleteFaceType.HEAL });`,
        record("plates", 'size(evaluateQuery(context, qCreatedBy(id + "plate", EntityType.BODY)))'),
        record("topArea", 'evArea(context, { "entities" : top }) / millimeter ^ 2'),
        record(
          "deleteFaces",
          'size(evaluateQuery(context, qCreatedBy(id + "delete", EntityType.FACE)))',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // 100 x 60 x 10 with the hole filled back in.
    expect(r.bodies()).toHaveLength(1);
    close(r.bodies()[0]!.volume, PLATE);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    expect(r.get("plates")).toBe(1);
    // The top face is the same face, now without the hole: 100 x 60.
    close(r.get("topArea") as number, 6000);
    expect(r.get("deleteFaces")).toBe(0);
  });

  it("heals a boss away by cutting it, and fails when only its side face would be removed", () => {
    const boss = [
      'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 40, 10) * millimeter });',
      'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
      'skCircle(sketch, "boss", { "center" : vector(20, 20) * millimeter, "radius" : 5 * millimeter });',
      "skSolve(sketch);",
      'extrude(context, id + "boss", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 10 * millimeter, "operationType" : NewBodyOperationType.ADD, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "block", EntityType.BODY) });',
    ].join("\n");
    const both = run(
      `${boss}\ndeleteFace(context, id + "delete", { "deleteFaces" : qCreatedBy(id + "boss", EntityType.FACE), "healType" : DeleteFaceType.HEAL });`,
    );
    expect(both.status, both.why).toBe("OK");
    // 40 x 40 x 10, the boss gone.
    close(both.bodies()[0]!.volume, 16000);
    expect(both.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });

    // The boss's top and the block's top are parallel; nothing closes the gap without the top.
    const side = run(
      `${boss}\ndeleteFace(context, id + "delete", { "deleteFaces" : qGeometry(qCreatedBy(id + "boss", EntityType.FACE), GeometryType.CYLINDER), "healType" : DeleteFaceType.HEAL });`,
    );
    expect(side.status).toBe("ERROR");
    expect(side.fault).toBeNull();
    expect(side.statusEnum).toBe("DIRECT_EDIT_DELETE_FACE_FAILED");
  });

  it("removes a fillet back to the sharp edge, and takes adjacent fillets with includeFillet", () => {
    const filleted = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'fillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "radius" : 2 * millimeter });',
        'deleteFace(context, id + "delete", { "deleteFaces" : qCreatedBy(id + "fillet", EntityType.FACE), "healType" : DeleteFaceType.HEAL });',
      ].join("\n"),
    );
    expect(filleted.status, filleted.why).toBe("OK");
    close(filleted.bodies()[0]!.volume, 1000);
    expect(filleted.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });

    // A hole with a 1 mm fillet round its top edge. Deleting the hole's wall with the default
    // includeFillet takes the (toroidal) fillet too, and the plate closes up completely.
    const withFillet = run(
      [
        plateWithHole,
        `fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "cut", EntityType.EDGE), vector(55, 30, 10) * millimeter), "radius" : 1 * millimeter });`,
        `deleteFace(context, id + "delete", { "deleteFaces" : ${holeFace}, "healType" : DeleteFaceType.HEAL });`,
      ].join("\n"),
    );
    expect(withFillet.status, withFillet.why).toBe("OK");
    close(withFillet.bodies()[0]!.volume, PLATE);
    expect(withFillet.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });

  it("leaves the void open, turning the solid into a sheet that keeps its faces", () => {
    const r = run(
      [
        plateWithHole,
        `const top = evaluateQuery(context, ${plateTop})[0];`,
        `deleteFace(context, id + "delete", { "deleteFaces" : ${holeFace}, "healType" : DeleteFaceType.VOID });`,
        record(
          "sheets",
          'size(evaluateQuery(context, qBodyType(qCreatedBy(id + "plate", EntityType.BODY), BodyType.SHEET)))',
        ),
        record("topFound", "size(evaluateQuery(context, top))"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // The plate's six faces (top and bottom still holed); edges: 12 box edges and 2 circles.
    expect(r.bodies()).toEqual([
      expect.objectContaining({ type: "SHEET", faces: 6, edges: 14, vertices: 8 }),
    ]);
    // 2 * (100 * 60 - 25 pi) + 2 * 100 * 10 + 2 * 60 * 10
    close(r.bodies()[0]!.area, 2 * (6000 - 25 * Math.PI) + 2000 + 1200);
    expect(r.get("sheets")).toBe(1);
    expect(r.get("topFound")).toBe(1);
  });

  it("caps the void with a plane when the neighbors can't close it", () => {
    // A capsule: a 5 mm radius, 20 mm cylinder with a hemisphere on top. The wall can't be
    // extended to close the dome's gap, so CAP puts a flat disc where the dome met the wall.
    const capsule = [
      'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 5 * millimeter });',
      'opSphere(context, id + "ball", { "center" : vector(0, 0, 20) * millimeter, "radius" : 5 * millimeter });',
      'opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "rod", EntityType.BODY), qCreatedBy(id + "ball", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });',
    ].join("\n");
    const dome = "qGeometry(qEverything(EntityType.FACE), GeometryType.SPHERE)";
    const healed = run(
      `${capsule}\ndeleteFace(context, id + "delete", { "deleteFaces" : ${dome}, "healType" : DeleteFaceType.HEAL });`,
    );
    expect(healed.status).toBe("ERROR");
    expect(healed.statusEnum).toBe("DIRECT_EDIT_DELETE_FACE_FAILED");

    const capped = run(
      `${capsule}\ndeleteFace(context, id + "delete", { "deleteFaces" : ${dome}, "healType" : DeleteFaceType.CAP });`,
    );
    expect(capped.status, capped.why).toBe("OK");
    // pi * 5^2 * 20; wall, bottom and cap; two circles.
    close(capped.bodies()[0]!.volume, Math.PI * 25 * 20);
    expect(capped.bodies()[0]).toMatchObject({ faces: 3, edges: 2, vertices: 0 });
  });

  it("reports what it can't do", () => {
    const top = run(
      `fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });\ndeleteFace(context, id + "delete", { "deleteFaces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 10) * millimeter), "healType" : DeleteFaceType.HEAL });`,
    );
    // The four walls never meet above the cube.
    expect(top.statusEnum).toBe("DIRECT_EDIT_DELETE_FACE_FAILED");
    const all = run(
      `fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });\ndeleteFace(context, id + "delete", { "deleteFaces" : qCreatedBy(id + "block", EntityType.FACE), "healType" : DeleteFaceType.VOID });`,
    );
    expect(all.statusEnum).toBe("DIRECT_EDIT_DELETE_FACE_ALL_FACES");
  });
});

// Offset face (std's Move face, offset type). Ways it goes wrong: the face moves the wrong way
// (into the material for a positive offset, or a hole grows instead of shrinking); the neighbors
// don't follow, leaving a gap or a step; sloped neighbors are extended along the wrong plane; the
// moved face gets a new id, so a query for it from before the move finds nothing; a zero-size
// result (offsetting a hole wider than its plate) comes back as a body.
describe("opOffsetFace", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(50, 30, 10) * millimeter)';

  it("moves a top face out and in, keeping its id", () => {
    for (const [opposite, height] of [
      [false, 15],
      [true, 5],
    ] as const) {
      const r = run(
        [
          block,
          `const top = evaluateQuery(context, ${top})[0];`,
          `moveFace(context, id + "offset", { "moveFaces" : top, "moveFaceType" : MoveFaceType.OFFSET, "offsetDistance" : 5 * millimeter, "oppositeDirection" : ${opposite} });`,
          record("height", 'evPlane(context, { "face" : top }).origin[2] / millimeter'),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      close(r.bodies()[0]!.volume, 100 * 60 * height);
      expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
      close(r.get("height") as number, height);
    }
  });

  it("shrinks a hole when its wall is offset away from the material", () => {
    const r = run(
      `${plateWithHole}\nmoveFace(context, id + "offset", { "moveFaces" : ${holeFace}, "moveFaceType" : MoveFaceType.OFFSET, "offsetDistance" : 1 * millimeter });`,
    );
    expect(r.status, r.why).toBe("OK");
    // The hole's radius goes from 5 to 4.
    close(r.bodies()[0]!.volume, PLATE - Math.PI * 16 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 14, vertices: 8 });
  });

  it("extends a sloped neighbor along its own plane", () => {
    // A 10 mm cube with a 2 mm chamfer on the edge at x = 10, z = 10: the chamfer lies on
    // x + z = 18. Raising the top to z = 13 extends the chamfer up to (5, 13). Section in xz:
    // 10 * 13 minus the corner triangle (10, 8), (10, 13), (5, 13) of area 12.5, times 10 in y.
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'chamfer(context, id + "chamfer", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "width" : 2 * millimeter });',
        'moveFace(context, id + "offset", { "moveFaces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(2, 5, 10) * millimeter), "moveFaceType" : MoveFaceType.OFFSET, "offsetDistance" : 3 * millimeter });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, (130 - 12.5) * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
  });

  it("fails rather than offsetting a face through the body", () => {
    const r = run(
      `${block}\nopOffsetFace(context, id + "offset", { "moveFaces" : ${top}, "offsetDistance" : -12 * millimeter });`,
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault).toBeNull();
    expect(r.statusEnum).toBe("DIRECT_EDIT_OFFSET_FACE_FAILED");
  });
});

// Extract surface (std's Offset surface). Ways it goes wrong: the source body changes or loses
// faces; the copy shares topology with its source, so a later operation on one moves the other;
// connected faces come out as separate bodies (or separate faces as one); the offset goes against
// the face normal (a hole wall offset grows the radius); tangent propagation misses the fillet or
// takes faces that only meet at a sharp edge.
describe("opExtractSurface", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const blockFace = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;

  it("copies a face, and offsets the copy along the face normal", () => {
    for (const offset of [0, 5]) {
      const r = run(
        [
          block,
          `offsetSurface(context, id + "surface", { "surfacesAndFaces" : ${blockFace(50, 30, 10)}, "offset" : ${offset} * millimeter });`,
          record(
            "found",
            `size(evaluateQuery(context, qContainsPoint(qCreatedBy(id + "surface", EntityType.FACE), vector(50, 30, ${10 + offset}) * millimeter)))`,
          ),
          record(
            "blockFaces",
            'size(evaluateQuery(context, qCreatedBy(id + "block", EntityType.FACE)))',
          ),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.bodies().map((b) => b.type)).toEqual(["SOLID", "SHEET"]);
      close(r.bodies()[0]!.volume, PLATE);
      expect(r.bodies()[1]).toMatchObject({ faces: 1, edges: 4, vertices: 4 });
      close(r.bodies()[1]!.area, 6000);
      expect(r.get("found")).toBe(1);
      expect(r.get("blockFaces")).toBe(6);
    }
  });

  it("offsets a hole wall toward its axis", () => {
    // The wall's normal points into the hole: radius 5 - 2 = 3, height 10.
    const r = run(
      `${plateWithHole}\noffsetSurface(context, id + "surface", { "surfacesAndFaces" : ${holeFace}, "offset" : 2 * millimeter });`,
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[1]!.area, 2 * Math.PI * 3 * 10);
    expect(r.bodies()[1]).toMatchObject({ faces: 1, edges: 2, vertices: 0 });
  });

  it("keeps connected faces in one sheet and separate ones apart", () => {
    const connected = run(
      `${block}\nopExtractSurface(context, id + "surface", { "faces" : qUnion([${blockFace(50, 30, 10)}, ${blockFace(100, 30, 5)}]) });`,
    );
    expect(connected.status, connected.why).toBe("OK");
    // Top and the x = 100 side share one edge: 4 + 4 - 1 edges, 4 + 4 - 2 vertices.
    expect(connected.bodies().slice(1)).toEqual([
      expect.objectContaining({ type: "SHEET", faces: 2, edges: 7, vertices: 6 }),
    ]);
    const apart = run(
      `${block}\nopExtractSurface(context, id + "surface", { "faces" : qUnion([${blockFace(50, 30, 10)}, ${blockFace(50, 30, 0)}]) });`,
    );
    expect(
      apart
        .bodies()
        .slice(1)
        .map((b) => b.faces),
    ).toEqual([1, 1]);
  });

  it("propagates across tangent edges only", () => {
    // A 10 mm cube with a 2 mm fillet on the top edge at x = 10. From the top face, tangency
    // reaches the fillet (tangent) and then the x = 10 side (tangent to the fillet), not the rest.
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'fillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "radius" : 2 * millimeter });',
        'opExtractSurface(context, id + "surface", { "faces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 10) * millimeter), "tangentPropagation" : true });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // Top 8 x 10, fillet pi * 2 / 2 * 10, side 8 x 10.
    expect(r.bodies()[1]).toMatchObject({ faces: 3 });
    close(r.bodies()[1]!.area, 80 + Math.PI * 10 + 80);
  });

  it("fails on an empty selection", () => {
    const r = run(`${block}\nopExtractSurface(context, id + "surface", { "faces" : qNothing() });`);
    expect(r.statusEnum).toBe("EXTRACT_SURFACE_NO_FACES");
  });
});

// Create outline. Ways it goes wrong: the outline lands off the target plane; it's the tool's whole
// silhouette area counted twice (top and bottom faces both projected); a curved target is
// approximated silently.
describe("opCreateOutline", () => {
  it("projects a tool through a plate onto the plate's top plane", () => {
    const r = run(
      [
        'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
        'fCylinder(context, id + "tool", { "bottomCenter" : vector(50, 30, -5) * millimeter, "topCenter" : vector(50, 30, 15) * millimeter, "radius" : 5 * millimeter });',
        'opCreateOutline(context, id + "outline", { "tools" : qCreatedBy(id + "tool", EntityType.BODY), "target" : qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(10, 10, 10) * millimeter) });',
        record(
          "area",
          'evArea(context, { "entities" : qCreatedBy(id + "outline", EntityType.FACE) }) / millimeter ^ 2',
        ),
        record(
          "onTop",
          'size(evaluateQuery(context, qContainsPoint(qCreatedBy(id + "outline", EntityType.FACE), vector(50, 30, 10) * millimeter)))',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.get("area") as number, Math.PI * 25);
    expect(r.get("onTop")).toBe(1);
  });
});

// Move face. Ways it goes wrong: the transform applies to the face's normal but not its position (or
// the other way round); a rotated face's neighbors don't follow the tilt; a move within the face's
// own surface (sliding a plane along itself, spinning a hole about its axis) is treated as a change
// and fails or rebuilds the body; a hole moved sideways leaves its old wall behind.
describe("opMoveFace", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const blockFace = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;

  it("translates a top face up along an edge's direction, keeping its id", () => {
    const r = run(
      [
        block,
        `const top = evaluateQuery(context, ${blockFace(50, 30, 10)})[0];`,
        `moveFace(context, id + "move", { "moveFaces" : top, "moveFaceType" : MoveFaceType.TRANSLATE, "direction" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(0, 0, 5) * millimeter), "translationDistance" : 5 * millimeter });`,
        record("height", 'evPlane(context, { "face" : top }).origin[2] / millimeter'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // The edge at the origin may run either way along z; either way the top ends at 15 or 5.
    const height = r.get("height") as number;
    expect([5, 15].some((h) => Math.abs(h - height) < 1e-6)).toBe(true);
    close(r.bodies()[0]!.volume, 6000 * height);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });

  it("moves a hole sideways", () => {
    const r = run(
      [
        plateWithHole,
        `opMoveFace(context, id + "move", { "moveFaces" : ${holeFace}, "transform" : transform(vector(10, 0, 0) * millimeter) });`,
        record(
          "moved",
          "size(evaluateQuery(context, qGeometry(qContainsPoint(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), vector(65, 30, 5) * millimeter), GeometryType.CYLINDER)))",
        ),
        record(
          "old",
          "size(evaluateQuery(context, qContainsPoint(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), vector(45, 30, 5) * millimeter)))",
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, PLATE - Math.PI * 25 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 14, vertices: 8 });
    expect(r.get("moved")).toBe(1);
    expect(r.get("old")).toBe(0);
  });

  it("tilts a side face about its bottom edge, and the top follows", () => {
    // Turning the x = 100 face 45 degrees about the y axis through (100, 0, 0) puts it on
    // x - 100 = z, so the top grows to x = 110: a 10 x 10 / 2 triangle more, times 60 in y.
    const r = run(
      `${block}\nopMoveFace(context, id + "move", { "moveFaces" : ${blockFace(100, 30, 5)}, "transform" : rotationAround(line(vector(100, 0, 0) * millimeter, vector(0, 1, 0)), 45 * degree) });`,
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, 60000 + 50 * 60);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });

  it("leaves the body alone when the face moves within its own surface", () => {
    const r = run(
      [
        plateWithHole,
        `opMoveFace(context, id + "slide", { "moveFaces" : ${plateTop}, "transform" : transform(vector(7, 0, 0) * millimeter) });`,
        `opMoveFace(context, id + "spin", { "moveFaces" : ${holeFace}, "transform" : rotationAround(line(vector(50, 30, 0) * millimeter, vector(0, 0, 1)), 30 * degree) });`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, PLATE - Math.PI * 25 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 14, vertices: 8 });
  });
});

// Replace face. Ways it goes wrong: the offset goes against the template's normal; the template is
// used at its own size instead of as an unbounded surface, so a small template can't replace a
// large face; the template body is consumed; a curved template is approximated.
describe("opReplaceFace", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(50, 30, 10) * millimeter)';
  // A small cube's bottom face at z = 20, its outward normal pointing down.
  const template = [
    'fCuboid(context, id + "small", { "corner1" : vector(0, 0, 20) * millimeter, "corner2" : vector(10, 10, 30) * millimeter });',
    'const template = qContainsPoint(qCreatedBy(id + "small", EntityType.FACE), vector(5, 5, 20) * millimeter);',
  ].join("\n");

  it("raises a top face to a small template's plane, with and without an offset", () => {
    for (const [offset, height] of [
      [0, 20],
      [5, 15],
    ] as const) {
      const r = run(
        `${block}\n${template}\nreplaceFace(context, id + "replace", { "replaceFaces" : ${top}, "templateFace" : template, "oppositeSense" : true, "offset" : ${offset} * millimeter });`,
      );
      expect(r.status, r.why).toBe("OK");
      // The block grows to the template's plane, less the offset along the template's normal.
      close(r.bodies()[0]!.volume, 6000 * height);
      expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
      expect(r.bodies()).toHaveLength(2);
    }
  });

  it("replaces a flat top with a cylinder", () => {
    // A 500 mm radius cylinder along y through (50, y, -490): z(x) = -490 + sqrt(500^2 - (x - 50)^2).
    // The section's area is -49000 + 50 sqrt(247500) + 250000 asin(0.1); times 60 in y.
    const section = -49000 + 50 * Math.sqrt(247500) + 250000 * Math.asin(0.1);
    const r = run(
      [
        block,
        'fCylinder(context, id + "drum", { "bottomCenter" : vector(50, -10, -490) * millimeter, "topCenter" : vector(50, 70, -490) * millimeter, "radius" : 500 * millimeter });',
        `opReplaceFace(context, id + "replace", { "replaceFaces" : ${top}, "templateFace" : qGeometry(qCreatedBy(id + "drum", EntityType.FACE), GeometryType.CYLINDER) });`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, section * 60, 2);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });
});

// Flip orientation. Ways it goes wrong: solids are flipped (inside out); the faces get new ids; the
// normal doesn't actually reverse.
describe("opFlipOrientation", () => {
  it("reverses a sheet's normal and keeps its faces", () => {
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'opExtractSurface(context, id + "sheet", { "faces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 10) * millimeter) });',
        'const face = evaluateQuery(context, qCreatedBy(id + "sheet", EntityType.FACE))[0];',
        record(
          "before",
          'evFaceTangentPlane(context, { "face" : face, "parameter" : vector(0.5, 0.5) }).normal[2]',
        ),
        'opFlipOrientation(context, id + "flip", { "bodies" : qCreatedBy(id + "sheet", EntityType.BODY) });',
        record(
          "after",
          'evFaceTangentPlane(context, { "face" : face, "parameter" : vector(0.5, 0.5) }).normal[2]',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.get("before") as number, 1);
    close(r.get("after") as number, -1);
  });
});

// Extract wires (std's Composite curve). Ways it goes wrong: connected edges come out as separate
// wires; disjoint ones are joined; three edges meeting at a corner are accepted; the source body
// changes; the copies share topology with their source.
describe("opExtractWires", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const edge = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(${x}, ${y}, ${z}) * millimeter)`;
  const wires = 'qBodyType(qCreatedBy(id + "curve", EntityType.BODY), BodyType.WIRE)';

  it("joins connected edges into one wire and keeps disjoint ones apart", () => {
    const loop = run(
      [
        block,
        `compositeCurve(context, id + "curve", { "edges" : qUnion([${edge(50, 0, 10)}, ${edge(100, 30, 10)}, ${edge(50, 60, 10)}, ${edge(0, 30, 10)}]) });`,
        record("wires", `size(evaluateQuery(context, ${wires}))`),
        record("edges", `size(evaluateQuery(context, qOwnedByBody(${wires}, EntityType.EDGE)))`),
        record(
          "length",
          `evLength(context, { "entities" : qOwnedByBody(${wires}, EntityType.EDGE) }) / millimeter`,
        ),
        record(
          "blockEdges",
          'size(evaluateQuery(context, qCreatedBy(id + "block", EntityType.EDGE)))',
        ),
      ].join("\n"),
    );
    expect(loop.status, loop.why).toBe("OK");
    expect(loop.get("wires")).toBe(1);
    expect(loop.get("edges")).toBe(4);
    close(loop.get("length") as number, 320);
    expect(loop.get("blockEdges")).toBe(12);

    const apart = run(
      [
        block,
        `compositeCurve(context, id + "curve", { "edges" : qUnion([${edge(50, 0, 10)}, ${edge(50, 60, 0)}]) });`,
        record("wires", `size(evaluateQuery(context, ${wires}))`),
      ].join("\n"),
    );
    expect(apart.get("wires")).toBe(2);
  });

  it("refuses edges that cross or partly overlap", () => {
    // std: "If the edges overlap or cross ... the function will fail." Two lines in separate
    // sketches meet nowhere at their ends: one crossing pair, one pair sharing [5, 10] mm.
    const lines = (a: string, b: string) =>
      run(
        [
          `const one = newSketchOnPlane(context, id + "one", { "sketchPlane" : XY_PLANE });\nskLineSegment(one, "l", ${a});\nskSolve(one);`,
          `const two = newSketchOnPlane(context, id + "two", { "sketchPlane" : XY_PLANE });\nskLineSegment(two, "l", ${b});\nskSolve(two);`,
          'opExtractWires(context, id + "curve", { "edges" : qUnion([qCreatedBy(id + "one", EntityType.EDGE), qCreatedBy(id + "two", EntityType.EDGE)]) });',
        ].join("\n"),
      );
    const segment = (x0: number, y0: number, x1: number, y1: number) =>
      `{ "start" : vector(${x0}, ${y0}) * millimeter, "end" : vector(${x1}, ${y1}) * millimeter }`;
    const crossing = lines(segment(0, 0, 10, 0), segment(5, -5, 5, 5));
    // std's ErrorStringEnum: crossing edges are OVERLAPPING; NON_MANIFOLD is three ends at a point.
    expect(crossing.statusEnum).toBe("EXTRACT_WIRES_OVERLAPPING_EDGES");
    const overlapping = lines(segment(0, 0, 10, 0), segment(5, 0, 15, 0));
    expect(overlapping.statusEnum).toBe("EXTRACT_WIRES_OVERLAPPING_EDGES");
  });

  it("refuses three edges meeting at a point, and an empty selection", () => {
    const corner = run(
      `${block}\nopExtractWires(context, id + "curve", { "edges" : qUnion([${edge(50, 0, 0)}, ${edge(0, 30, 0)}, ${edge(0, 0, 5)}]) });`,
    );
    expect(corner.statusEnum).toBe("EXTRACT_WIRES_NON_MANIFOLD");
    const none = run(`${block}\nopExtractWires(context, id + "curve", { "edges" : qNothing() });`);
    expect(none.statusEnum).toBe("EXTRACT_WIRES_NEEDS_EDGES");
  });
});

// Split edges. Ways it goes wrong: a parameter is taken along the curve's own parameter instead of
// its length, so a spline splits off-center; the split vertex lands on the wrong end of an edge;
// splitting changes the body's volume or faces; a plane splits edges it doesn't cross; bad
// parameter lists are accepted.
describe("opSplitEdges", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const edge = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(${x}, ${y}, ${z}) * millimeter)`;

  it("splits an edge at its middle, adding a vertex there", () => {
    const r = run(
      [
        block,
        `opSplitEdges(context, id + "split", { "edges" : ${edge(50, 0, 0)}, "parameters" : [[0.5]] });`,
        record(
          "vertex",
          `size(evaluateQuery(context, qContainsPoint(qConstructionFilter(qEverything(EntityType.VERTEX), ConstructionObject.NO), vector(50, 0, 0) * millimeter)))`,
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, PLATE);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 13, vertices: 9 });
    expect(r.get("vertex")).toBe(1);
  });

  it("measures parameters along a spline's length", () => {
    // Three points bunched toward one end: the curve's own parameter isn't its length.
    const spline = 'qCreatedBy(id + "spline", EntityType.EDGE)';
    const r = run(
      [
        'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(100, 0, 0) * millimeter] });',
        `const total = evLength(context, { "entities" : ${spline} });`,
        `opSplitEdges(context, id + "split", { "edges" : ${spline}, "parameters" : [[0.25]] });`,
        `const pieces = evaluateQuery(context, qOwnedByBody(qCreatedBy(id + "spline", EntityType.BODY), EntityType.EDGE));`,
        record("pieces", "size(pieces)"),
        record(
          "shares",
          '[evLength(context, { "entities" : pieces[0] }) / total, evLength(context, { "entities" : pieces[1] }) / total]',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.get("pieces")).toBe(2);
    const shares = (r.get("shares") as unknown as number[]).map(Number).sort();
    close(shares[0]!, 0.25, 6);
    close(shares[1]!, 0.75, 6);
  });

  it("splits only the edges a plane crosses", () => {
    const r = run(
      `${block}\nopSplitEdges(context, id + "split", { "edges" : qCreatedBy(id + "block", EntityType.EDGE), "splittingSurface" : plane(vector(30, 0, 0) * millimeter, vector(1, 0, 0)) });`,
    );
    expect(r.status, r.why).toBe("OK");
    // The four edges along x each gain a vertex at x = 30.
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 16, vertices: 12 });
  });

  it("checks its parameters", () => {
    const mismatch = run(
      `${block}\nopSplitEdges(context, id + "split", { "edges" : qUnion([${edge(50, 0, 0)}, ${edge(50, 60, 0)}]), "parameters" : [[0.5]] });`,
    );
    expect(mismatch.statusEnum).toBe("SPLIT_EDGE_SIZES_MISMATCH");
    const outside = run(
      `${block}\nopSplitEdges(context, id + "split", { "edges" : ${edge(50, 0, 0)}, "parameters" : [[1.5]] });`,
    );
    expect(outside.statusEnum).toBe("SPLIT_EDGE_PARAMETER_BOUND");
    const none = run(
      `${block}\nopSplitEdges(context, id + "split", { "edges" : qNothing(), "parameters" : [] });`,
    );
    expect(none.statusEnum).toBe("SPLIT_EDGE_SELECT_EDGES");
  });
});

// Split face. Ways it goes wrong: the body is cut in two instead of its face being split; faces
// that aren't targets get split; an edge tool off the face isn't projected onto it; a construction
// plane is used at its drawn size instead of as an unbounded plane; the splitting edges aren't
// returned; tool surfaces are consumed (or kept) against keepToolSurfaces.
describe("opSplitFace", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(10, 10, 10) * millimeter)';
  const sketch = (z: number, entity: string) =>
    [
      `const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, ${z}) * millimeter, vector(0, 0, 1)) });`,
      entity,
      "skSolve(sketch);",
    ].join("\n");

  it("splits a top face along a sketch line and returns the splitting edge", () => {
    const r = run(
      [
        block,
        sketch(
          10,
          'skLineSegment(sketch, "line", { "start" : vector(50, -10) * millimeter, "end" : vector(50, 70) * millimeter });',
        ),
        `const result = opSplitFace(context, id + "split", { "faceTargets" : ${top}, "edgeTools" : qCreatedBy(id + "sketch", EntityType.EDGE) });`,
        record("splitting", "size(result.splittingEdges)"),
        record(
          "along",
          "size(evaluateQuery(context, qContainsPoint(qUnion(result.splittingEdges), vector(50, 30, 10) * millimeter)))",
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, PLATE);
    // The top in two; the line and the two halves of each long top edge.
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
    expect(r.get("splitting")).toBe(1);
    expect(r.get("along")).toBe(1);
  });

  it("projects a circle from a parallel sketch onto the face", () => {
    const r = run(
      [
        block,
        sketch(
          25,
          'skCircle(sketch, "circle", { "center" : vector(50, 30) * millimeter, "radius" : 5 * millimeter });',
        ),
        `opSplitFace(context, id + "split", { "faceTargets" : ${top}, "edgeTools" : qCreatedBy(id + "sketch", EntityType.EDGE) });`,
        record(
          "disc",
          'evArea(context, { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(50, 30, 10) * millimeter) }) / millimeter ^ 2',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 13, vertices: 8 });
    close(r.get("disc") as number, 25 * Math.PI);
  });

  it("treats a construction plane as unbounded, through std's split", () => {
    const r = run(
      [
        block,
        'opPlane(context, id + "plane", { "plane" : plane(vector(30, 30, 50) * millimeter, vector(1, 0, 0)), "width" : 5 * millimeter, "height" : 5 * millimeter });',
        `splitPart(context, id + "split", { "splitType" : SplitType.FACE, "faceTargets" : ${top}, "faceTools" : qCreatedBy(id + "plane", EntityType.FACE) });`,
        record("planes", 'size(evaluateQuery(context, qCreatedBy(id + "plane", EntityType.BODY)))'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // Only the top face splits, at x = 30; the side faces' edges gain the cut's ends.
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
    expect(r.get("planes")).toBe(1);
  });

  it("splits with a sheet and consumes it unless asked to keep it", () => {
    for (const keep of [true, false]) {
      const r = run(
        [
          block,
          'fCuboid(context, id + "cutter", { "corner1" : vector(70, -10, 0) * millimeter, "corner2" : vector(80, 70, 20) * millimeter });',
          'opExtractSurface(context, id + "sheet", { "faces" : qContainsPoint(qCreatedBy(id + "cutter", EntityType.FACE), vector(70, 30, 10) * millimeter) });',
          'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(id + "cutter", EntityType.BODY) });',
          `opSplitFace(context, id + "split", { "faceTargets" : ${top}, "bodyTools" : qCreatedBy(id + "sheet", EntityType.BODY), "keepToolSurfaces" : ${keep} });`,
          record(
            "sheets",
            'size(evaluateQuery(context, qCreatedBy(id + "sheet", EntityType.BODY)))',
          ),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
      expect(r.get("sheets")).toBe(keep ? 1 : 0);
    }
  });
});

// Extend sheet body and edge change. Ways it goes wrong: the edge moves along the surface the wrong
// way (a positive distance trims); neighbors of the moved edge don't follow, leaving a notch; the
// corners between two extended edges aren't filled; a disc grows as a polygon; the sheet gets a new
// id or becomes a solid; curved sheets are extended along a guessed direction.
describe("opExtendSheetBody and opEdgeChange", () => {
  // A 100 x 60 sheet at z = 10, copied from a block's top.
  const sheet = [
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
    'opExtractSurface(context, id + "sheet", { "faces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(50, 30, 10) * millimeter) });',
    'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(id + "block", EntityType.BODY) });',
    'const sheetBody = qCreatedBy(id + "sheet", EntityType.BODY);',
  ].join("\n");
  const sheetEdge = (x: number, y: number) =>
    `qContainsPoint(qCreatedBy(id + "sheet", EntityType.EDGE), vector(${x}, ${y}, 10) * millimeter)`;
  const area = record(
    "area",
    'evArea(context, { "entities" : qCreatedBy(id + "sheet", EntityType.FACE) }) / millimeter ^ 2',
  );

  it("extends one edge, or every edge of the body, along the sheet's plane", () => {
    const one = run(
      `${sheet}\nopExtendSheetBody(context, id + "extend", { "entities" : ${sheetEdge(100, 30)}, "endCondition" : ExtendEndType.EXTEND_BLIND, "extendDistance" : 10 * millimeter });\n${area}`,
    );
    expect(one.status, one.why).toBe("OK");
    // 110 x 60, still one sheet with one face.
    close(one.get("area") as number, 6600);
    expect(one.bodies()).toEqual([
      expect.objectContaining({ type: "SHEET", faces: 1, edges: 4, vertices: 4 }),
    ]);
    const all = run(
      `${sheet}\nopExtendSheetBody(context, id + "extend", { "entities" : sheetBody, "endCondition" : ExtendEndType.EXTEND_BLIND, "extendDistance" : 10 * millimeter });\n${area}`,
    );
    expect(all.status, all.why).toBe("OK");
    // 120 x 80: the corners fill in too.
    close(all.get("area") as number, 9600);
  });

  it("grows a disc as a disc", () => {
    const r = run(
      [
        'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
        'opExtractSurface(context, id + "sheet", { "faces" : qContainsPoint(qCreatedBy(id + "rod", EntityType.FACE), vector(0, 0, 10) * millimeter) });',
        'opExtendSheetBody(context, id + "extend", { "entities" : qCreatedBy(id + "sheet", EntityType.BODY), "endCondition" : ExtendEndType.EXTEND_BLIND, "extendDistance" : 2 * millimeter });',
        area,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.get("area") as number, 49 * Math.PI);
  });

  it("trims an edge back with a negative edge change offset", () => {
    const r = run(
      `${sheet}\nopEdgeChange(context, id + "trim", { "edgeChangeOptions" : [{ "edge" : ${sheetEdge(100, 30)}, "face" : qCreatedBy(id + "sheet", EntityType.FACE), "offset" : -10 * millimeter }] });\n${area}`,
    );
    expect(r.status, r.why).toBe("OK");
    close(r.get("area") as number, 5400);
  });

  it("stops on what it can't extend", () => {
    const curved = run(
      [
        'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
        'opExtractSurface(context, id + "sheet", { "faces" : qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER) });',
        'opExtendSheetBody(context, id + "extend", { "entities" : qCreatedBy(id + "sheet", EntityType.BODY), "endCondition" : ExtendEndType.EXTEND_BLIND, "extendDistance" : 2 * millimeter });',
      ].join("\n"),
    );
    expect(curved.fault).toMatch(/not supported locally/);
    const target = run(
      `${sheet}\nopExtendSheetBody(context, id + "extend", { "entities" : sheetBody, "endCondition" : ExtendEndType.EXTEND_TO_TARGET, "target" : sheetBody });`,
    );
    expect(target.fault).toMatch(/not supported locally/);
  });
});

// Lineage (Model.GeometryState.lineage), for tracking entities through splits and merges. Ways it
// goes wrong: a split face's pieces (which both get new ids) don't name the face they came from;
// an entity that keeps its id lists itself; a failed feature's lineage survives its rollback;
// a union's merged faces lose the ids that merged into them.
describe("lineage", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const side =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(10, 5, 5) * millimeter)';

  it("names the face a split face's pieces came from", () => {
    const steps = [
      `${block}\nsetVariable(context, "side", transientQueriesToStrings(evaluateQuery(context, ${side})[0]));`,
      `opSplitPart(context, id + "split", { "targets" : qEverything(EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });`,
    ];
    const result = runtime.runFeatures(
      steps.map((body) => ({ module: feature(body), feature: "test" })),
    );
    expect(result.features.map((f) => f.status)).toEqual(["OK", "OK"]);
    const source = String(result.features[0]!.variables.getField("side"));
    const geometry = result.geometry!;
    expect(geometry.entities.has(source)).toBe(false);
    // Both pieces name the face, and so do the edges the cut made across it (one per new body),
    // which OpenCascade reports as generated from it.
    const named = [...geometry.lineage]
      .filter(([, from]) => from.includes(source))
      .map(([id]) => geometry.entities.get(id)?.type);
    expect(named.filter((type) => type === "FACE")).toHaveLength(2);
    expect(named.filter((type) => type === "EDGE")).toHaveLength(2);
    // A face that kept its id through the split (the top) has no lineage of its own.
    for (const [id, from] of geometry.lineage) expect(from).not.toContain(id);
  });

  it("names the seed each copy of a body pattern copies", () => {
    const result = runtime.runFeatures([
      {
        module: feature(
          [
            block,
            `setVariable(context, "seed", transientQueriesToStrings(evaluateQuery(context, ${side})[0]));`,
            'opPattern(context, id + "copies", { "entities" : qCreatedBy(id + "block", EntityType.BODY), "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["1"] });',
            'setVariable(context, "copy", transientQueriesToStrings(evaluateQuery(context, qContainsPoint(qCreatedBy(id + "copies", EntityType.FACE), vector(30, 5, 5) * millimeter))[0]));',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    const variables = result.features[0]!.variables;
    expect(result.geometry!.lineage.get(String(variables.getField("copy")))).toEqual([
      String(variables.getField("seed")),
    ]);
  });

  it("drops a failed feature's lineage with its geometry", () => {
    const result = runtime.runFeatures([
      { module: feature(block), feature: "test" },
      {
        module: feature(
          'opSplitPart(context, id + "split", { "targets" : qEverything(EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });\nthrow regenError("undo");',
        ),
        feature: "test",
      },
    ]);
    expect(result.features.map((f) => f.status)).toEqual(["OK", "ERROR"]);
    expect(result.geometry!.lineage.size).toBe(0);
  });

  it("keeps the ids merged into one face", () => {
    // The plate's top split in two along x = 30, then both halves offset up together: with
    // mergeFaces (the default) they become one top, which keeps one half's id and lists the
    // other's.
    const half = (x: number, z: number) =>
      `transientQueriesToStrings(evaluateQuery(context, qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(${x}, 10, ${z}) * millimeter))[0])`;
    const result = runtime.runFeatures([
      {
        module: feature(
          [
            plateWithHole,
            'opPlane(context, id + "cut", { "plane" : plane(vector(30, 30, 50) * millimeter, vector(1, 0, 0)) });',
            `opSplitFace(context, id + "split", { "faceTargets" : ${plateTop}, "planeTools" : qCreatedBy(id + "cut", EntityType.FACE) });`,
            `setVariable(context, "halves", [${half(10, 10)}, ${half(90, 10)}]);`,
            `opOffsetFace(context, id + "raise", { "moveFaces" : qUnion([qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(10, 10, 10) * millimeter), qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(90, 10, 10) * millimeter)]), "offsetDistance" : 1 * millimeter });`,
            `setVariable(context, "top", ${half(10, 11)});`,
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    const run = result.features[0]!;
    expect(run.status, JSON.stringify(run.exceptions)).toBe("OK");
    const halves = untag(run.variables.getField("halves")!);
    if (!Array.isArray(halves)) throw new Error("halves is not an array");
    const [left, right] = halves.map((half) => String(untag(half)));
    const top = String(run.variables.getField("top"));
    expect([left, right]).toContain(top);
    expect(result.geometry!.lineage.get(top)).toContain(top === left ? right : left);
  });
});

// Ids through operations (Model.replaceBodies). Ways it goes wrong: an operation that keeps an
// entity's id drops what the entity is (a construction plane moved by opTransform starts drawing
// as a surface and passing ConstructionObject.NO filters); a pattern's copies of a construction
// plane come out as ordinary sheets. Std's Boolean takes no construction bodies, so booleans can't
// meet one.
describe("construction entities through operations", () => {
  it("stay construction when transformed or patterned", () => {
    const construction = (feature: string, type: string) =>
      `size(evaluateQuery(context, qConstructionFilter(qCreatedBy(id + "${feature}", EntityType.${type}), ConstructionObject.YES)))`;
    const r = run(
      [
        'opPlane(context, id + "plane", { "plane" : XY_PLANE });',
        'opTransform(context, id + "move", { "bodies" : qCreatedBy(id + "plane", EntityType.BODY), "transform" : transform(vector(0, 0, 10) * millimeter) });',
        'opPattern(context, id + "copies", { "entities" : qCreatedBy(id + "plane", EntityType.BODY), "transforms" : [transform(vector(0, 0, 20) * millimeter)], "instanceNames" : ["one"] });',
        record("bodies", construction("plane", "BODY")),
        record("faces", construction("plane", "FACE")),
        record("edges", construction("plane", "EDGE")),
        record("copies", construction("copies", "BODY")),
        record("copyFaces", construction("copies", "FACE")),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect([r.get("bodies"), r.get("faces"), r.get("edges")]).toEqual([1, 1, 4]);
    expect([r.get("copies"), r.get("copyFaces")]).toEqual([1, 1]);
    expect(r.bodies()).toEqual([]);
  });
});

// Draft. Ways it goes wrong: faces tilt the wrong way (std's angular manipulator turns the face's
// center by +angle about cross(face normal, neutral normal) through the face's line on the neutral
// plane, so with the top as neutral plane the part widens below it); the neutral line moves; the
// pull direction flag is ignored; a cylinder doesn't become a cone; the drafted face gets a new id;
// a parting-line draft whose references Onshape infers runs on guessed conventions.
describe("opDraft", () => {
  const cube =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 10) * millimeter)';
  const sides = `qSubtraction(qCreatedBy(id + "block", EntityType.FACE), qUnion([${top}, qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 0) * millimeter)]))`;
  const t = Math.tan((5 * Math.PI) / 180);
  const frustum = (bottom: number) => (10 / 3) * (100 + bottom * bottom + 10 * bottom);

  it("tapers a cube's sides about its top, widening below it, or narrowing with pullDirection", () => {
    for (const [pull, bottom] of [
      [false, 10 + 20 * t],
      [true, 10 - 20 * t],
    ] as const) {
      const r = run(
        [
          cube,
          `const side = evaluateQuery(context, qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(10, 5, 5) * millimeter))[0];`,
          `draft(context, id + "draft", { "neutralPlane" : ${top}, "draftFaces" : ${sides}, "angle" : 5 * degree, "pullDirection" : ${pull} });`,
          record("kept", "size(evaluateQuery(context, side))"),
          record("topArea", `evArea(context, { "entities" : ${top} }) / millimeter ^ 2`),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      // A frustum: the 10 x 10 top stays, the bottom is 10 +- 2 * 10 tan 5 square.
      close(r.bodies()[0]!.volume, frustum(bottom));
      expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
      expect(r.get("kept")).toBe(1);
      close(r.get("topArea") as number, 100);
    }
  });

  it("turns a cylinder's wall into a cone", () => {
    const r = run(
      [
        'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
        'draft(context, id + "draft", { "neutralPlane" : qContainsPoint(qCreatedBy(id + "rod", EntityType.FACE), vector(0, 0, 10) * millimeter), "draftFaces" : qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER), "angle" : 5 * degree });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // A cone frustum of height 10 from radius 5 at the top to 5 + 10 tan 5 at the bottom.
    const bottom = 5 + 10 * t;
    close(r.bodies()[0]!.volume, (Math.PI * 10 * (25 + bottom * bottom + 5 * bottom)) / 3);
    expect(r.bodies()[0]).toMatchObject({ faces: 3, edges: 2, vertices: 0 });
  });

  it("drafts a face about an explicit reference edge", () => {
    // The x = 10 side about its bottom edge, pulling up: the top edge comes in by 10 tan 5.
    const r = run(
      [
        cube,
        'opDraft(context, id + "draft", { "draftType" : DraftType.REFERENCE_ENTITY, "pullVec" : vector(0, 0, 1), "angle" : 5 * degree, "referenceEntityDraftOptions" : [{ "face" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(10, 5, 5) * millimeter), "references" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 0) * millimeter) }] });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, 1000 - 0.5 * 10 * 10 * t * 10);
  });

  it("stops on a parting-line draft whose references it would have to infer", () => {
    const r = run(
      `${cube}\ndraft(context, id + "draft", { "draftFeatureType" : DraftFeatureType.PARTING_LINE, "pullDirectionEntity" : ${top}, "partingEdges" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 0) * millimeter), "partingLineSides" : PartingLineSides.ONE_SIDED, "alongPull" : true, "angle" : 5 * degree });`,
    );
    expect(r.fault).toMatch(/not supported locally/);
  });
});

// Fillet and chamfer options. Ways they go wrong: options OpenCascade can't match (variable
// radii, whose profile differs: for a radius growing 1 to 3 mm along a 10 mm cube edge it takes off
// 9.476 mm^3 where the rolling ball's envelope takes 9.179; asymmetric and width-controlled fillets;
// detached surfaces; which face takes which chamfer distance) are silently dropped, giving a plain
// fillet or chamfer that looks plausible; modifying a fillet's radius leaves the old fillet's edges
// or gives the fillet a new id.
describe("fillet and chamfer options", () => {
  const cube =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const topEdge =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(5, 0, 10) * millimeter)';
  const vertex = (x: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.VERTEX), vector(${x}, 0, 10) * millimeter)`;
  const filletArea = (r: number) => (1 - Math.PI / 4) * r * r;

  it("stops on fillet and chamfer options it can't honor", () => {
    const options = [
      `fillet(context, id + "f", { "entities" : ${topEdge}, "radius" : 2 * millimeter, "isVariable" : true, "vertexSettings" : [{ "vertex" : ${vertex(0)}, "vertexRadius" : 1 * millimeter }, { "vertex" : ${vertex(10)}, "vertexRadius" : 3 * millimeter }] });`,
      `opFillet(context, id + "f", { "entities" : ${topEdge}, "radius" : 2 * millimeter, "isAsymmetric" : true, "otherRadius" : 1 * millimeter });`,
      `opFillet(context, id + "f", { "entities" : ${topEdge}, "radius" : 2 * millimeter, "blendControlType" : BlendControlType.WIDTH });`,
      `opFillet(context, id + "f", { "entities" : ${topEdge}, "radius" : 2 * millimeter, "createDetachedSurface" : true });`,
      `opChamfer(context, id + "c", { "entities" : ${topEdge}, "chamferType" : ChamferType.TWO_OFFSETS, "width1" : 1 * millimeter, "width2" : 2 * millimeter });`,
      `opChamfer(context, id + "c", { "entities" : ${topEdge}, "chamferType" : ChamferType.OFFSET_ANGLE, "width" : 1 * millimeter, "angle" : 30 * degree });`,
      `opChamfer(context, id + "c", { "entities" : ${topEdge}, "chamferType" : ChamferType.EQUAL_OFFSETS, "width" : 1 * millimeter, "chamferMethod" : ChamferMethod.APEX_RANGE });`,
    ];
    for (const option of options) {
      const r = run(`${cube}\n${option}`);
      expect(r.fault, option).toMatch(/not supported locally/);
    }
  });

  it("follows tangent edges only when asked to", () => {
    // A cube whose vertical edge at (10, 10) is rounded: the top edge along y = 10 continues
    // tangentially through the round into the edge along x = 10. OpenCascade always fillets the
    // whole tangent chain, so without tangentPropagation it would round more than Onshape.
    const rounded = `${cube}\nfillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 10, 5) * millimeter), "radius" : 2 * millimeter });`;
    const edge =
      'qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(5, 10, 10) * millimeter)';
    const alone = run(
      `${rounded}\nfillet(context, id + "f", { "entities" : ${edge}, "radius" : 1 * millimeter });`,
    );
    expect(alone.fault).toMatch(/not supported locally/);
    const chain = run(
      `${rounded}\nfillet(context, id + "f", { "entities" : ${edge}, "radius" : 1 * millimeter, "tangentPropagation" : true });`,
    );
    expect(chain.status, chain.why).toBe("OK");
  });

  it("chamfers two equal distances like equal offsets", () => {
    const r = run(
      `${cube}\nopChamfer(context, id + "c", { "entities" : ${topEdge}, "chamferType" : ChamferType.TWO_OFFSETS, "width1" : 2 * millimeter, "width2" : 2 * millimeter });`,
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, 1000 - 0.5 * 2 * 2 * 10);
  });

  it("changes a fillet's radius, keeping its id, or removes it", () => {
    const filleted = `${cube}\nfillet(context, id + "fillet", { "entities" : ${topEdge}, "radius" : 2 * millimeter });\nconst face = evaluateQuery(context, qCreatedBy(id + "fillet", EntityType.FACE))[0];`;
    const changed = run(
      `${filleted}\nmodifyFillet(context, id + "modify", { "faces" : face, "modifyFilletType" : ModifyFilletType.CHANGE_RADIUS, "radius" : 3 * millimeter });\n${record("kept", "size(evaluateQuery(context, face))")}`,
    );
    expect(changed.status, changed.why).toBe("OK");
    close(changed.bodies()[0]!.volume, 1000 - filletArea(3) * 10);
    expect(changed.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
    expect(changed.get("kept")).toBe(1);
    const removed = run(
      `${filleted}\nmodifyFillet(context, id + "modify", { "faces" : face, "modifyFilletType" : ModifyFilletType.REMOVE_FILLET });`,
    );
    expect(removed.status, removed.why).toBe("OK");
    close(removed.bodies()[0]!.volume, 1000);
    expect(removed.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });
});

// Face patterns. Ways they go wrong: the copies land but the body isn't cut or filled (the copied
// faces float as a separate sheet); a hole's copy fills instead of cuts (or a boss's copy cuts);
// the copies don't get ids created by their instance, so qCreatedBy(pattern) finds nothing; a copy
// landing where the body's surfaces differ from the seed's (off the edge of the part) is quietly
// left with a floor or gap that Parasolid would have extended away.
describe("face patterns", () => {
  it("copies a hole twice along x", () => {
    const r = run(
      [
        plateWithHole,
        `opPattern(context, id + "pattern", { "entities" : ${holeFace}, "transforms" : [transform(vector(20, 0, 0) * millimeter), transform(vector(-20, 0, 0) * millimeter)], "instanceNames" : ["1", "2"] });`,
        record(
          "created",
          'size(evaluateQuery(context, qGeometry(qCreatedBy(id + "pattern", EntityType.FACE), GeometryType.CYLINDER)))',
        ),
        record(
          "second",
          'size(evaluateQuery(context, qCreatedBy(id + "pattern" + "2", EntityType.FACE)))',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // Three 5 mm holes through 10 mm; six box faces and three walls.
    close(r.bodies()[0]!.volume, PLATE - 3 * Math.PI * 25 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 9, edges: 18, vertices: 8 });
    expect(r.get("created")).toBe(2);
    expect(r.get("second")).toBe(1);
  });

  const boss = [
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 40, 10) * millimeter });',
    'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
    'skCircle(sketch, "boss", { "center" : vector(20, 20) * millimeter, "radius" : 5 * millimeter });',
    "skSolve(sketch);",
    'extrude(context, id + "boss", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 10 * millimeter, "operationType" : NewBodyOperationType.ADD, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "block", EntityType.BODY) });',
  ].join("\n");

  it("copies a boss by adding its volume", () => {
    // std's linear and circular patterns compute their transforms with builtins that aren't
    // supported locally yet, so this calls opPattern the way they do.
    const r = run(
      `${boss}\nopPattern(context, id + "pattern", { "entities" : qCreatedBy(id + "boss", EntityType.FACE), "transforms" : [transform(vector(-12, 0, 0) * millimeter)], "instanceNames" : ["1"] });`,
    );
    expect(r.status, r.why).toBe("OK");
    // 40 x 40 x 10 plus two bosses of pi 5^2 10.
    close(r.bodies()[0]!.volume, 16000 + 2 * Math.PI * 25 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 10, edges: 16, vertices: 8 });
  });

  it("stops when a copy lands off the part", () => {
    const r = run(
      `${boss}\nopPattern(context, id + "pattern", { "entities" : qCreatedBy(id + "boss", EntityType.FACE), "transforms" : [transform(vector(100, 0, 0) * millimeter)], "instanceNames" : ["1"] });`,
    );
    expect(r.fault).toMatch(/not supported locally/);
  });
});

// std's features end to end. Ways they go wrong: a branch (midplane, opposite direction, keep
// tools, the boolean step, the boolean feature's offset of a tool copy) reaches a builtin or query
// that isn't supported, or one that quietly does the wrong thing; volumes and counts are checked
// against hand calculations.
describe("std features end to end", () => {
  const block =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(50, 30, 10) * millimeter)';
  const blockScope = 'qCreatedBy(id + "block", EntityType.BODY)';

  it("thickens a top face as a new body, both ways, about its midplane, and the opposite way", () => {
    const cases = [
      // [definition fields, volume of the new body]. A script passes thickness2; the dialog
      // defaults it to 0.
      ['"thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter', 30000],
      ['"thickness1" : 5 * millimeter, "thickness2" : 2 * millimeter', 42000],
      ['"midplane" : true, "thickness" : 4 * millimeter', 24000],
      [
        '"thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter, "oppositeDirection" : true',
        30000,
      ],
    ] as const;
    for (const [fields, volume] of cases) {
      const r = run(
        `${block}\nthicken(context, id + "thicken", { "entities" : ${top}, ${fields} });\n${record("z", 'evBox3d(context, { "topology" : qCreatedBy(id + "thicken", EntityType.BODY) }).maxCorner[2] / millimeter')}`,
      );
      expect(r.status, `${fields} ${r.why}`).toBe("OK");
      expect(r.bodies()).toHaveLength(2);
      close(r.bodies()[1]!.volume, volume);
      expect(r.bodies()[1]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    }
  });

  // INTERSECT isn't here: std runs it as opBoolean's SUBTRACT_COMPLEMENT, not supported locally yet.
  it("thickens into the block, adding and removing", () => {
    const cases = [
      // Adding a 5 mm slab on top: 100 x 60 x 15.
      [
        '"thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter, "operationType" : NewBodyOperationType.ADD',
        90000,
      ],
      // Removing a 5 mm slab under the top: 100 x 60 x 5.
      [
        '"thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter, "oppositeDirection" : true, "operationType" : NewBodyOperationType.REMOVE',
        30000,
      ],
    ] as const;
    for (const [fields, volume] of cases) {
      const r = run(
        `${block}\nthicken(context, id + "thicken", { "entities" : ${top}, ${fields}, "defaultScope" : false, "booleanScope" : ${blockScope} });`,
      );
      expect(r.status, `${fields} ${r.why}`).toBe("OK");
      expect(r.bodies()).toHaveLength(1);
      close(r.bodies()[0]!.volume, volume);
    }
  });

  it("thickens a curved sheet and drops it unless keepTools", () => {
    for (const keep of [true, false]) {
      const r = run(
        [
          'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
          'opExtractSurface(context, id + "wall", { "faces" : qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER) });',
          'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(id + "rod", EntityType.BODY) });',
          `thicken(context, id + "thicken", { "entities" : qCreatedBy(id + "wall", EntityType.BODY), "thickness1" : 1 * millimeter, "thickness2" : 0 * millimeter, "keepTools" : ${keep} });`,
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      // A tube from radius 5 to 6, 10 tall: pi (36 - 25) 10.
      const solids = r.bodies().filter((b) => b.type === "SOLID");
      expect(solids).toHaveLength(1);
      close(solids[0]!.volume, Math.PI * 11 * 10);
      expect(r.bodies().filter((b) => b.type === "SHEET")).toHaveLength(keep ? 1 : 0);
    }
  });

  it("subtracts a tool grown by an offset, the way std's boolean does", () => {
    // std's boolean tracks the tool's faces with startTracking, which needs lastOperationId (not
    // supported locally yet); before tracking it ran these steps: copy the tool, offset every
    // face of the copy, subtract the copy, delete the tool. A 5 mm rod through the plate with
    // its faces 1 mm out cuts a 6 mm hole.
    const r = run(
      [
        block,
        'fCylinder(context, id + "tool", { "bottomCenter" : vector(50, 30, -5) * millimeter, "topCenter" : vector(50, 30, 15) * millimeter, "radius" : 5 * millimeter });',
        'opPattern(context, id + "copy", { "entities" : qCreatedBy(id + "tool", EntityType.BODY), "transforms" : [identityTransform()], "instanceNames" : ["1"] });',
        'opOffsetFace(context, id + "offset", { "moveFaces" : qCreatedBy(id + "copy", EntityType.FACE), "offsetDistance" : 1 * millimeter });',
        `opBoolean(context, id + "subtract", { "operationType" : BooleanOperationType.SUBTRACTION, "tools" : qCreatedBy(id + "copy", EntityType.BODY), "targets" : ${blockScope} });`,
        'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(id + "tool", EntityType.BODY) });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.bodies()).toHaveLength(1);
    close(r.bodies()[0]!.volume, PLATE - Math.PI * 36 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 14, vertices: 8 });
  });

  it("rotates a face through std's move face", () => {
    // The x = 100 face turned 45 degrees about the bottom edge it meets: the edge's direction
    // decides the sense, so the top ends at x = 110 (adding 50 x 60) or x = 90 (removing it).
    const r = run(
      `${block}\nmoveFace(context, id + "turn", { "moveFaces" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(100, 30, 5) * millimeter), "moveFaceType" : MoveFaceType.ROTATE, "axis" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(100, 30, 0) * millimeter), "angle" : 45 * degree });`,
    );
    expect(r.status, r.why).toBe("OK");
    const volume = r.bodies()[0]!.volume;
    expect(
      [63000, 57000].some((v) => Math.abs(volume - v) < 1e-3),
      String(volume),
    ).toBe(true);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  });
});

// Full round fillet. Ways it goes wrong: the round's radius isn't half the gap, so it leaves a
// step on a side or overhangs; the round sits at the wrong depth (not touching the center face's
// plane); sides that aren't parallel planes get a constant radius where Parasolid would vary it.
describe("opFullRoundFillet", () => {
  const rib =
    'fCuboid(context, id + "rib", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 40, 20) * millimeter });';
  const face = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "rib", EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;

  it("rounds a rib's top between its parallel sides, through std's fillet", () => {
    const r = run(
      `${rib}\nfillet(context, id + "round", { "filletType" : FilletType.FULL_ROUND, "side1Face" : ${face(0, 20, 10)}, "side2Face" : ${face(10, 20, 10)}, "centerFaces" : ${face(5, 20, 20)} });\n${record("apex", `size(evaluateQuery(context, qContainsPoint(qCreatedBy(id + "round", EntityType.FACE), vector(5, 20, 20) * millimeter)))`)}`,
    );
    expect(r.status, r.why).toBe("OK");
    // A 10 mm gap rounds with radius 5: each 40 mm of length loses 10 x 5 - pi 5^2 / 2.
    close(r.bodies()[0]!.volume, 8000 - (50 - (Math.PI * 25) / 2) * 40);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    expect(r.get("apex")).toBe(1);
  });

  it("stops when the sides aren't parallel planes", () => {
    const r = run(
      `${rib}\nopFullRoundFillet(context, id + "round", { "side1Face" : ${face(0, 20, 10)}, "side2Face" : ${face(5, 0, 10)}, "centerFaces" : ${face(5, 20, 20)} });`,
    );
    expect(r.fault).toMatch(/not supported locally/);
  });
});

// Review round 1. Ways these went wrong: an edit merged every coplanar pair in the body, so a
// face split on purpose (or a split kept by mergeFaces: false) came back whole; several edge
// offsets on one sheet rebuilt from stale edges; ownExistingImprints was ignored; "unbounded"
// planes were a kilometer patch around the plane's origin, missing a part 2 km away; a draft took
// reference edges that aren't on the drafted face; face pattern copies had no lineage; booleans
// left a union's coplanar faces split and didn't run SUBTRACT_COMPLEMENT.
describe("review round 1", () => {
  const cube =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const blockFace = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;
  const splitAt = (target: string, origin: string, normal: string) =>
    [
      `opPlane(context, id + "cut", { "plane" : plane(vector(${origin}) * millimeter, vector(${normal})) });`,
      `opSplitFace(context, id + "split", { "faceTargets" : ${target}, "planeTools" : qCreatedBy(id + "cut", EntityType.FACE) });`,
    ].join("\n");

  it("keeps a split between moved faces with mergeFaces false, and merges it by default", () => {
    for (const [merge, faces, edges, vertices] of [
      [false, 7, 15, 10],
      [true, 6, 12, 8],
    ] as const) {
      const r = run(
        [
          cube,
          splitAt(blockFace(5, 5, 10), "5, 0, 0", "1, 0, 0"),
          `opOffsetFace(context, id + "raise", { "moveFaces" : qUnion([${blockFace(2, 5, 10)}, ${blockFace(8, 5, 10)}]), "offsetDistance" : 1 * millimeter, "mergeFaces" : ${merge} });`,
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      // 10 x 10 x 11 either way; the split line stays only without merging.
      close(r.bodies()[0]!.volume, 1100);
      expect(r.bodies()[0]).toMatchObject({ faces, edges, vertices });
    }
  });

  it("keeps a face split elsewhere through a heal, a face pattern and a union", () => {
    // The plate's top split at x = 30: one more face, the split line, the halves of two top edges.
    const heal = run(
      `${plateWithHole}\n${splitAt(plateTop, "30, 30, 50", "1, 0, 0")}\nopDeleteFace(context, id + "heal", { "deleteFaces" : ${holeFace} });`,
    );
    expect(heal.status, heal.why).toBe("OK");
    close(heal.bodies()[0]!.volume, PLATE);
    expect(heal.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });

    // The bottom split at x = 10, then the hole copied 20 mm along x: two holes, split intact.
    const bottom =
      'qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(5, 30, 0) * millimeter)';
    const pattern = run(
      `${plateWithHole}\n${splitAt(bottom, "10, 30, 50", "1, 0, 0")}\nopPattern(context, id + "pattern", { "entities" : ${holeFace}, "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["1"] });`,
    );
    expect(pattern.status, pattern.why).toBe("OK");
    close(pattern.bodies()[0]!.volume, PLATE - 2 * Math.PI * 25 * 10);
    expect(pattern.bodies()[0]).toMatchObject({ faces: 9, edges: 19, vertices: 10 });

    // The front split at z = 5, then a slab added on top: the union merges the slab's sides
    // into the block's, but the front keeps its split.
    const union = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
        splitAt(blockFace(50, 0, 5), "50, 0, 5", "0, 0, 1"),
        `thicken(context, id + "thicken", { "entities" : ${blockFace(50, 30, 10)}, "thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter, "operationType" : NewBodyOperationType.ADD, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "block", EntityType.BODY) });`,
      ].join("\n"),
    );
    expect(union.status, union.why).toBe("OK");
    close(union.bodies()[0]!.volume, 90000);
    expect(union.bodies()[0]).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
  });

  it("merges a union's coplanar faces, as Parasolid does", () => {
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
        `const side = evaluateQuery(context, ${blockFace(100, 30, 5)})[0];`,
        `thicken(context, id + "thicken", { "entities" : ${blockFace(50, 30, 10)}, "thickness1" : 5 * millimeter, "thickness2" : 0 * millimeter, "operationType" : NewBodyOperationType.ADD, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "block", EntityType.BODY) });`,
        record("side", "size(evaluateQuery(context, side))"),
        record("sideArea", 'evArea(context, { "entities" : side }) / millimeter ^ 2'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // 100 x 60 x 15 as one box; the block's side keeps its id and now spans 60 x 15.
    close(r.bodies()[0]!.volume, 90000);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    expect(r.get("side")).toBe(1);
    close(r.get("sideArea") as number, 900);
  });

  it("intersects through std's thicken (SUBTRACT_COMPLEMENT)", () => {
    // A 4 mm midplane slab around the top, intersected with the block: the 2 mm inside it.
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
        `thicken(context, id + "thicken", { "entities" : ${blockFace(50, 30, 10)}, "midplane" : true, "thickness" : 4 * millimeter, "operationType" : NewBodyOperationType.INTERSECT, "defaultScope" : false, "booleanScope" : qCreatedBy(id + "block", EntityType.BODY) });`,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.bodies()).toHaveLength(1);
    close(r.bodies()[0]!.volume, 12000);
    expect(r.bodies()[0]).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    // Each target keeps only what's inside the tools' union, and keeps its id.
    const direct = run(
      [
        cube,
        'fCylinder(context, id + "tool", { "bottomCenter" : vector(5, 5, -1) * millimeter, "topCenter" : vector(5, 5, 11) * millimeter, "radius" : 3 * millimeter });',
        'opBoolean(context, id + "keep", { "operationType" : BooleanOperationType.SUBTRACT_COMPLEMENT, "targets" : qCreatedBy(id + "block", EntityType.BODY), "tools" : qCreatedBy(id + "tool", EntityType.BODY) });',
        record("blocks", 'size(evaluateQuery(context, qCreatedBy(id + "block", EntityType.BODY)))'),
      ].join("\n"),
    );
    expect(direct.status, direct.why).toBe("OK");
    expect(direct.bodies()).toHaveLength(1);
    close(direct.bodies()[0]!.volume, Math.PI * 9 * 10);
    expect(direct.get("blocks")).toBe(1);
  });

  it("moves several sheet edges by different offsets in one edge change", () => {
    const r = run(
      [
        cube,
        `opExtractSurface(context, id + "sheet", { "faces" : ${blockFace(5, 5, 10)} });`,
        'const edge = function(x, y) { return qContainsPoint(qCreatedBy(id + "sheet", EntityType.EDGE), vector(x, y, 10) * millimeter); };',
        'opEdgeChange(context, id + "grow", { "edgeChangeOptions" : [{ "edge" : edge(10, 5), "face" : qCreatedBy(id + "sheet", EntityType.FACE), "offset" : 1 * millimeter }, { "edge" : edge(5, 10), "face" : qCreatedBy(id + "sheet", EntityType.FACE), "offset" : 2 * millimeter }] });',
        record(
          "area",
          'evArea(context, { "entities" : qCreatedBy(id + "sheet", EntityType.FACE) }) / millimeter ^ 2',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // 11 x 12, corner filled.
    close(r.get("area") as number, 132);
  });

  it("owns existing edges where the faces split only with ownExistingImprints", () => {
    for (const [own, owned] of [
      [false, 0],
      [true, 1],
    ] as const) {
      const r = run(
        [
          cube,
          'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
          'skLineSegment(sketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(10, 0) * millimeter });',
          "skSolve(sketch);",
          `const result = opSplitFace(context, id + "split", { "faceTargets" : ${blockFace(5, 5, 10)}, "edgeTools" : qCreatedBy(id + "sketch", EntityType.EDGE), "ownExistingImprints" : ${own} });`,
          record("splitting", "size(result.splittingEdges)"),
          record(
            "owned",
            'size(evaluateQuery(context, qCreatedBy(id + "split", EntityType.EDGE)))',
          ),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      // The line lies on the top's existing y = 0 edge.
      expect(r.get("splitting")).toBe(1);
      expect(r.get("owned")).toBe(owned);
    }
  });

  it("treats planes as unbounded for a part 2 km from the plane's origin", () => {
    const far = (y: number) =>
      `fCuboid(context, id + "block", { "corner1" : vector(0, ${y}, 0) * millimeter, "corner2" : vector(10, ${y + 10}, 10) * millimeter });`;
    const y = 2e6;
    const face = run(`${far(y)}\n${splitAt(blockFace(5, y + 5, 10), "5, 0, 0", "1, 0, 0")}`);
    expect(face.status, face.why).toBe("OK");
    expect(face.bodies()[0]).toMatchObject({ faces: 7 });
    const part = run(
      `${far(y)}\nopSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "block", EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });`,
    );
    expect(part.status, part.why).toBe("OK");
    expect(part.bodies().map((b) => Math.round(b.volume))).toEqual([500, 500]);
    const edges = run(
      `${far(y)}\nopSplitEdges(context, id + "split", { "edges" : qCreatedBy(id + "block", EntityType.EDGE), "splittingSurface" : plane(vector(5, 0, 0) * millimeter, vector(1, 0, 0)) });`,
    );
    expect(edges.status, edges.why).toBe("OK");
    // The four edges along x each gain a vertex.
    expect(edges.bodies()[0]).toMatchObject({ edges: 16, vertices: 12 });
  });

  it("requires a draft's reference edges to be on the drafted face", () => {
    const r = run(
      `${cube}\nopDraft(context, id + "draft", { "draftType" : DraftType.REFERENCE_ENTITY, "pullVec" : vector(0, 0, 1), "angle" : 5 * degree, "referenceEntityDraftOptions" : [{ "face" : ${blockFace(10, 5, 5)}, "references" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(0, 5, 0) * millimeter) }] });`,
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault).toBeNull();
    expect(r.statusEnum).toBe("DRAFT_SELECT_PARTING_EDGES");
  });

  it("names the seed face of each face pattern copy", () => {
    const result = runtime.runFeatures([
      {
        module: feature(
          [
            plateWithHole,
            `setVariable(context, "seed", transientQueriesToStrings(evaluateQuery(context, ${holeFace})[0]));`,
            `opPattern(context, id + "pattern", { "entities" : ${holeFace}, "transforms" : [transform(vector(20, 0, 0) * millimeter)], "instanceNames" : ["1"] });`,
            'setVariable(context, "copy", transientQueriesToStrings(evaluateQuery(context, qCreatedBy(id + "pattern", EntityType.FACE))[0]));',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    const variables = result.features[0]!.variables;
    expect(result.features[0]!.status).toBe("OK");
    expect(result.geometry!.lineage.get(String(variables.getField("copy")))).toEqual([
      String(variables.getField("seed")),
    ]);
  });
});

// Invalid shapes (Model.addBodies and replaceBodies). Ways it goes wrong: an operation reports OK
// on a shape the kernel's own check rejects (a sweep folding over itself at a sharp corner); the
// guard is a catchable error, so std's `try` hides it; the fault doesn't name the operation; an
// open or inside-out solid passes because its faces are each fine.
describe("invalid shapes", () => {
  it("stops a run whose operation made an invalid body", () => {
    // A 4 x 2 mm rectangle swept round a sharp corner: OpenCascade folds it into an invalid solid.
    // The sweep may raise its own error first; it must never report OK.
    const r = run(
      [
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1)) });',
        'skRectangle(profile, "r", { "firstCorner" : vector(-2, -1) * millimeter, "secondCorner" : vector(2, 1) * millimeter });',
        "skSolve(profile);",
        'const path = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
        'skLineSegment(path, "a", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 10) * millimeter });',
        'skLineSegment(path, "b", { "start" : vector(0, 10) * millimeter, "end" : vector(10, 10) * millimeter });',
        "skSolve(path);",
        'try silent { opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : qCreatedBy(id + "path", EntityType.EDGE) }); }',
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    if (r.fault) expect(r.fault).toMatch(/Feature1\.sweep produced an invalid solid body/);
    expect(r.bodies()).toEqual([]);
  });

  it("refuses open and inside-out solids", async () => {
    const { addBodies, emptyGeometry } = await import("../src/geometry/Model.ts");
    const { FsFault } = await import("../src/runtime/Errors.ts");
    const { shellOf } = await import("../src/builtins/faceEdit.ts");
    const { subShapes } = await import("../src/geometry/occt.ts");
    const oc = runtime.runFeatures([]).oc!;
    const box = new oc.BRepPrimAPI_MakeBox(0.01, 0.01, 0.01).Shape();
    const open = new oc.BRepBuilderAPI_MakeSolid(
      oc.TopoDS.Shell(shellOf(oc, subShapes(oc, box, "FACE").slice(1))),
    ).Solid();
    for (const [shape, why] of [
      [open, /Feature1\.bad produced an invalid solid body .*(isn't closed|OpenCascade's check)/],
      [box.Reversed(), /Feature1\.bad produced an invalid solid body .*no positive volume/],
    ] as const) {
      const add = () =>
        addBodies(oc, emptyGeometry, [
          { shape, bodyType: "SOLID", createdBy: ["Feature1", "bad"] },
        ]);
      expect(add).toThrow(FsFault);
      expect(add).toThrow(why);
    }
    // A sound box passes.
    expect(
      addBodies(oc, emptyGeometry, [{ shape: box, bodyType: "SOLID", createdBy: ["ok"] }]).ids,
    ).toHaveLength(1);
  });
});

// Ids of what an operation doesn't touch. Ways it goes wrong: OpenCascade's fillet and chamfer
// report untouched edges as deleted though the same edges are still in the result, so they get
// new ids made by the fillet and qCreatedBy(the cube) loses them.
describe("untouched entities keep their ids", () => {
  const cube =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  // The seven edges a fillet on the x = 10, z = 10 edge doesn't reach.
  const untouched = [
    [0, 0, 5],
    [0, 5, 10],
    [0, 10, 5],
    [0, 5, 0],
    [10, 5, 0],
    [5, 0, 0],
    [5, 10, 0],
  ];
  for (const op of ["fillet", "chamfer"]) {
    it(`through a ${op}`, () => {
      const edge = (p: number[]) =>
        `qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(${p.join(", ")}) * millimeter)`;
      const blend =
        op === "fillet"
          ? `fillet(context, id + "blend", { "entities" : ${edge([10, 5, 10])}, "radius" : 2 * millimeter });`
          : `chamfer(context, id + "blend", { "entities" : ${edge([10, 5, 10])}, "width" : 2 * millimeter });`;
      const r = run(
        [
          cube,
          `const before = mapArray([${untouched.map(edge).join(", ")}], function(q) { return transientQueriesToStrings(evaluateQuery(context, q)[0]); });`,
          blend,
          `setVariable(context, "kept", size(evaluateQuery(context, qUnion(mapArray(before, function(s) { return qTransient(s); })))));`,
          record(
            "fromCube",
            'size(evaluateQuery(context, qCreatedBy(id + "block", EntityType.EDGE)))',
          ),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.get("kept")).toBe(7);
      // The seven untouched and the four the blend trimmed; the blended edge is gone.
      expect(r.get("fromCube")).toBe(11);
    });
  }

  it("and an L-shaped union has Onshape's 8 faces, 18 edges and 12 vertices", () => {
    const r = run(
      [
        'fCuboid(context, id + "long", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });',
        'fCuboid(context, id + "tall", { "corner1" : vector(0, 0, 10) * millimeter, "corner2" : vector(10, 10, 20) * millimeter });',
        'opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "long", EntityType.BODY), qCreatedBy(id + "tall", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, 3000);
    expect(r.bodies()[0]).toMatchObject({ faces: 8, edges: 18, vertices: 12 });
  });
});

// Review round 2. Each block lists how it went wrong.
describe("review round 2", () => {
  const cube =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const blockFace = (x: number, y: number, z: number) =>
    `qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;
  const splitAt = (target: string, origin: string, normal: string) =>
    [
      `opPlane(context, id + "cut", { "plane" : plane(vector(${origin}) * millimeter, vector(${normal})) });`,
      `opSplitFace(context, id + "split", { "faceTargets" : ${target}, "planeTools" : qCreatedBy(id + "cut", EntityType.FACE) });`,
    ].join("\n");

  // A face the boolean splits and the tidy step merges back was listed twice in the chained
  // history, which looks like a split, so it lost its id; only when the body had an unrelated
  // split face (which sends the tidy step down the geometric path).
  it("keeps a face's id through a union, with or without a split elsewhere", () => {
    for (const split of [false, true]) {
      const r = run(
        [
          cube,
          'fCuboid(context, id + "other", { "corner1" : vector(5, 0, 0) * millimeter, "corner2" : vector(15, 10, 10) * millimeter });',
          split ? splitAt(blockFace(0, 5, 5), "0, 0, 5", "0, 0, 1") : "",
          `const front = evaluateQuery(context, ${blockFace(2, 0, 5)});`,
          `const top = evaluateQuery(context, ${blockFace(2, 5, 10)});`,
          'opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "block", EntityType.BODY), qCreatedBy(id + "other", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });',
          record("front", "size(evaluateQuery(context, qUnion(front)))"),
          record("top", "size(evaluateQuery(context, qUnion(top)))"),
          record("frontArea", 'evArea(context, { "entities" : qUnion(front) }) / millimeter ^ 2'),
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      close(r.bodies()[0]!.volume, 1500);
      expect([r.get("front"), r.get("top")], `split elsewhere ${split}`).toEqual([1, 1]);
      // The front now spans the whole 15 x 10.
      close(r.get("frontArea") as number, 150);
    }
  });
  // mergeFaces false walled the moved halves apart with a ruled face from the old split edge to
  // the new one, which didn't divide the swept region when the move slid the edge along itself or
  // turned it about an axis crossing it: the top came back as one face with internal edges.
  it("keeps the split between moved halves for slides and turns", () => {
    const t = Math.tan((5 * Math.PI) / 180);
    for (const [move, volume] of [
      ["transform(vector(0, 3, 2) * millimeter)", 1200],
      ["rotationAround(line(vector(0, 5, 10) * millimeter, vector(1, 0, 0)), 5 * degree)", 1000],
      // About the front top edge: the top rises toward y = 10 by 10 tan 5.
      [
        "rotationAround(line(vector(0, 0, 10) * millimeter, vector(1, 0, 0)), 5 * degree)",
        1000 + 0.5 * 10 * 10 * t * 10,
      ],
    ] as const) {
      const r = run(
        [
          cube,
          splitAt(blockFace(5, 5, 10), "5, 0, 0", "1, 0, 0"),
          `opMoveFace(context, id + "move", { "moveFaces" : qUnion([${blockFace(2, 5, 10)}, ${blockFace(8, 5, 10)}]), "transform" : ${move}, "mergeFaces" : false });`,
        ].join("\n"),
      );
      expect(r.status, `${move} ${r.why}`).toBe("OK");
      close(r.bodies()[0]!.volume, volume);
      expect(r.bodies()[0], move).toMatchObject({ faces: 7, edges: 15, vertices: 10 });
    }
  });

  // mergeFaces false only kept moved faces apart from each other, not from an unmoved face the
  // move made coplanar. std: "true to remove redundant edges from moveFaces".
  it("keeps a moved face apart from an unmoved one it lands flush with", () => {
    const chamfered = [
      cube,
      'opChamfer(context, id + "chamfer", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "width" : 2 * millimeter });',
    ].join("\n");
    const step = [
      'fCuboid(context, id + "high", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
      'fCuboid(context, id + "low", { "corner1" : vector(10, 0, 0) * millimeter, "corner2" : vector(20, 10, 8) * millimeter });',
      'opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "high", EntityType.BODY), qCreatedBy(id + "low", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });',
    ].join("\n");
    for (const merge of [true, false]) {
      // The chamfer turned flat about its top edge: the cube again, its top split at x = 8.
      const flat = run(
        `${chamfered}\nopMoveFace(context, id + "move", { "moveFaces" : qCreatedBy(id + "chamfer", EntityType.FACE), "transform" : rotationAround(line(vector(8, 0, 10) * millimeter, vector(0, 1, 0)), -45 * degree), "mergeFaces" : ${merge} });`,
      );
      expect(flat.status, flat.why).toBe("OK");
      close(flat.bodies()[0]!.volume, 1000);
      expect(flat.bodies()[0]).toMatchObject(
        merge ? { faces: 6, edges: 12, vertices: 8 } : { faces: 7, edges: 15, vertices: 10 },
      );
      // The lower step raised flush: a 20 x 10 x 10 box, its top split at x = 10.
      const raised = run(
        `${step}\nopOffsetFace(context, id + "raise", { "moveFaces" : qContainsPoint(qCreatedBy(id + "low", EntityType.FACE), vector(15, 5, 8) * millimeter), "offsetDistance" : 2 * millimeter, "mergeFaces" : ${merge} });`,
      );
      expect(raised.status, raised.why).toBe("OK");
      close(raised.bodies()[0]!.volume, 2000);
      expect(raised.bodies()[0]).toMatchObject(
        merge ? { faces: 6, edges: 12, vertices: 8 } : { faces: 7, edges: 15, vertices: 10 },
      );
    }
  });
  // CAP made one cap per boundary loop, so a hole's rim inside the outer rim on one plane gave two
  // overlapping caps (a rectangle and a disc).
  it("caps nested loops on one plane with one face and a hole in it", () => {
    const r = run(
      `${plateWithHole}\ndeleteFace(context, id + "delete", { "deleteFaces" : ${plateTop}, "healType" : DeleteFaceType.CAP });\n${record("atHole", "size(evaluateQuery(context, qContainsPoint(qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO), vector(50, 30, 10) * millimeter)))")}`,
    );
    expect(r.status, r.why).toBe("OK");
    // The plate again: its top a new face with the hole through it.
    close(r.bodies()[0]!.volume, PLATE - Math.PI * 25 * 10);
    expect(r.bodies()[0]).toMatchObject({ faces: 7, edges: 14, vertices: 8 });
    expect(r.get("atHole")).toBe(0);
  });
  // An offset deeper than a curved face's radius on its concave side has no geometry; OpenCascade
  // returned a tube on the wrong side (thicken) or a shell through the axis, and both reported OK.
  it("fails thickens, shells and offsets deeper than a face's radius", () => {
    const rod =
      'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });';
    const wall = 'qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER)';
    const thicken = (depth: number) =>
      run(
        `${rod}\nthicken(context, id + "thicken", { "entities" : ${wall}, "thickness1" : ${depth} * millimeter, "thickness2" : 0 * millimeter, "oppositeDirection" : true });`,
      );
    // Inward 4: a tube from radius 1 to 5.
    const inward = thicken(4);
    expect(inward.status, inward.why).toBe("OK");
    close(inward.bodies()[1]!.volume, Math.PI * (25 - 1) * 10);
    for (const depth of [8, 12]) {
      const r = thicken(depth);
      expect(r.fault, `thicken ${depth}`).toBeNull();
      expect(r.statusEnum, `thicken ${depth}`).toBe("THICKEN_FAILED");
    }

    const shell = (thickness: number) =>
      run(
        `${rod}\nopShell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "rod", EntityType.FACE), vector(0, 0, 10) * millimeter), "thickness" : ${-thickness} * millimeter });`,
      );
    // Inward 2, open top: the rod less a cavity of radius 3 and depth 8.
    const thin = shell(2);
    expect(thin.status, thin.why).toBe("OK");
    close(thin.bodies()[0]!.volume, Math.PI * 25 * 10 - Math.PI * 9 * 8);
    const thick = shell(6);
    expect(thick.fault).toBeNull();
    expect(thick.statusEnum).toBe("SHELL_FAILED");

    // The rod's wall offset 6 inward, past its axis.
    const offset = run(
      `${rod}\nopOffsetFace(context, id + "offset", { "moveFaces" : ${wall}, "offsetDistance" : -6 * millimeter });`,
    );
    expect(offset.fault).toBeNull();
    expect(offset.statusEnum).toBe("DIRECT_EDIT_OFFSET_FACE_FAILED");
  });
  // Mapping faces through UnifySameDomain by a point inside each one: the coarse mesh's largest
  // triangle on a 0.5 mm ring reaches across its inner rim (its chord cuts into the hole), so the
  // ring's point fell off the ring and it lost its id and creator.
  it("tracks a thin ring through a union that merges the faces around it", () => {
    const ring =
      'qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(249.75, 150, 10) * millimeter)';
    const r = run(
      [
        'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(300, 300, 10) * millimeter });',
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
        'skCircle(sketch, "outer", { "center" : vector(150, 150) * millimeter, "radius" : 100 * millimeter });',
        'skCircle(sketch, "inner", { "center" : vector(150, 150) * millimeter, "radius" : 99.5 * millimeter });',
        "skSolve(sketch);",
        'opSplitFace(context, id + "split", { "faceTargets" : qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(1, 1, 10) * millimeter), "edgeTools" : qCreatedBy(id + "sketch", EntityType.EDGE) });',
        'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "sketch", EntityType.BODY) });',
        `const before = evaluateQuery(context, ${ring});`,
        'fCuboid(context, id + "more", { "corner1" : vector(150, 0, 0) * millimeter, "corner2" : vector(400, 300, 10) * millimeter });',
        'opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "plate", EntityType.BODY), qCreatedBy(id + "more", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });',
        record("before", "size(before)"),
        record(
          "kept",
          "size(evaluateQuery(context, qIntersection([qUnion(before), " + ring + "])))",
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    close(r.bodies()[0]!.volume, 400 * 300 * 10);
    expect(r.get("before")).toBe(1);
    // The same ring face, still made by the plate.
    expect(r.get("kept")).toBe(1);
  });
  // Revolving a profile that crosses its axis made OpenCascade throw a WebAssembly exception out
  // of the run instead of failing the feature.
  it("fails a revolve whose profile crosses the axis", () => {
    const revolve = (from: number) =>
      run(
        [
          'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
          `skRectangle(sketch, "r", { "firstCorner" : vector(${from}, 0) * millimeter, "secondCorner" : vector(5, 5) * millimeter });`,
          "skSolve(sketch);",
          'opRevolve(context, id + "turn", { "entities" : qSketchRegion(id + "sketch"), "axis" : line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "angleForward" : 360 * degree });',
        ].join("\n"),
      );
    const crossing = revolve(-2);
    expect(crossing.fault).toBeNull();
    expect(crossing.statusEnum).toBe("REVOLVE_FAILED");
    // A circle across the axis has no vertices to give it away.
    const circle = run(
      [
        'const disc = newSketchOnPlane(context, id + "disc", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
        'skCircle(disc, "c", { "center" : vector(1, 5) * millimeter, "radius" : 2 * millimeter });',
        "skSolve(disc);",
        'opRevolve(context, id + "turn", { "entities" : qSketchRegion(id + "disc"), "axis" : line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "angleForward" : 360 * degree });',
      ].join("\n"),
    );
    expect(circle.fault).toBeNull();
    expect(circle.statusEnum).toBe("REVOLVE_FAILED");
    // Touching the axis is fine: a 5 mm radius, 5 mm tall cylinder.
    const touching = revolve(0);
    expect(touching.status, touching.why).toBe("OK");
    close(touching.bodies()[0]!.volume, Math.PI * 25 * 5);
  });
  // Two touching targets cut by one tool share a face in OpenCascade's result; that face got one
  // entity, which the second body took, leaving the first with 5 of its 6 faces.
  it("gives each of two touching cut bodies its own faces", () => {
    const r = run(
      [
        cube,
        'fCuboid(context, id + "next", { "corner1" : vector(10, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });',
        'const shared = evaluateQuery(context, qUnion([qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(10, 5, 5) * millimeter), qContainsPoint(qCreatedBy(id + "next", EntityType.FACE), vector(10, 5, 5) * millimeter)]));',
        'fCuboid(context, id + "slab", { "corner1" : vector(-5, -5, 8) * millimeter, "corner2" : vector(35, 15, 15) * millimeter });',
        'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qUnion([qCreatedBy(id + "block", EntityType.BODY), qCreatedBy(id + "next", EntityType.BODY)]), "tools" : qCreatedBy(id + "slab", EntityType.BODY) });',
        record("shared", "size(shared)"),
        record("owners", "size(evaluateQuery(context, qOwnerBody(qUnion(shared))))"),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // Each a 10 x 10 x 8 box with all six of its faces.
    expect(r.bodies()).toEqual([
      expect.objectContaining({ volume: expect.closeTo(800, 3), faces: 6, edges: 12, vertices: 8 }),
      expect.objectContaining({ volume: expect.closeTo(800, 3), faces: 6, edges: 12, vertices: 8 }),
    ]);
    // The touching faces kept their ids, one in each body.
    expect([r.get("shared"), r.get("owners")]).toEqual([2, 2]);
  });
  // A cylinder cut to a D whose seam lands inside the kept arc comes out of OpenCascade's boolean
  // as two faces split along the seam; Parasolid has no seam, so the tidy step must merge them,
  // also on the path that keeps a split elsewhere in the body, where the vertex OpenCascade puts
  // at a circle's seam mustn't count as a split to keep.
  it("merges a D-boss's cylinder split only by its seam", () => {
    for (const [angle, splitTop] of [
      [180, false],
      [120, false],
      [180, true],
    ] as const) {
      const r = run(
        [
          'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
          `opPattern(context, id + "turned", { "entities" : qCreatedBy(id + "pin", EntityType.BODY), "transforms" : [rotationAround(line(vector(0, 0, 0) * meter, Z_DIRECTION), ${angle} * degree)], "instanceNames" : ["1"] });`,
          'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "pin", EntityType.BODY) });',
          splitTop
            ? splitAt(
                'qContainsPoint(qCreatedBy(id + "turned", EntityType.FACE), vector(0, 0, 10) * millimeter)',
                "-2, 0, 0",
                "1, 0, 0",
              )
            : "",
          'fCuboid(context, id + "box", { "corner1" : vector(3, -10, -1) * millimeter, "corner2" : vector(10, 10, 11) * millimeter });',
          'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "turned", EntityType.BODY), "tools" : qCreatedBy(id + "box", EntityType.BODY) });',
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      // The circle less the segment beyond x = 3 (half-chord 4): 25 acos(3/5) + 3 * 4, times 10.
      close(r.bodies()[0]!.volume, (25 * (Math.PI - Math.acos(3 / 5)) + 3 * 4) * 10);
      // Arc, flat, top, bottom; with the top split by x = -2, one more face and the chord, and
      // the top arc cut in three.
      expect(r.bodies()[0], `${angle} ${splitTop}`).toMatchObject(
        splitTop ? { faces: 5, edges: 9, vertices: 6 } : { faces: 4, edges: 6, vertices: 4 },
      );
    }
  });
});

// Review round 3.
describe("review round 3", () => {
  const box =
    'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });';
  const top =
    'qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(20, 15, 10) * millimeter)';

  // OpenCascade's shell can return the body unchanged and report done; the run said OK with the
  // removed top still there and the input's volume.
  it("never reports a shell that didn't happen", () => {
    const r = run(
      [
        box,
        'fillet(context, id + "round", { "entities" : qCreatedBy(id + "block", EntityType.EDGE), "radius" : 1 * millimeter });',
        `shell(context, id + "shell", { "entities" : ${top}, "thickness" : 0.5 * millimeter });`,
      ].join("\n"),
    );
    if (r.status === "OK") {
      // Hollow: far less than the rounded box's 11932.67 mm^3, and no face left on the top.
      expect(r.bodies()[0]!.volume).toBeLessThan(11000);
    } else expect(r.fault).toMatch(/not supported locally/);
  });
  // OpenCascade's own shell made invalid wires on a plain box at 0.5 mm, failed hollow mode
  // outright, and those failures were reported as SHELL_FAILED, as if Onshape would fail too.
  it("shells ordinary boxes inward, outward and hollow", () => {
    const rounded = (radius: number) =>
      `fillet(context, id + "round", { "entities" : qUnion([${[
        [0, 0],
        [40, 0],
        [0, 30],
        [40, 30],
      ]
        .map(
          ([x, y]) =>
            `qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(${x}, ${y}, 5) * millimeter)`,
        )
        .join(", ")}]), "radius" : ${radius} * millimeter });`;
    const cases = [
      // 40 x 30 x 10 less 39 x 29 x 9.5: an open-topped tray with 0.5 mm walls.
      [
        "",
        `"entities" : ${top}, "thickness" : 0.5 * millimeter`,
        12000 - 39 * 29 * 9.5,
        [11, 24, 16],
      ],
      ["", `"entities" : ${top}, "thickness" : 1 * millimeter`, 12000 - 38 * 28 * 9, [11, 24, 16]],
      // Hollow: a 38 x 28 x 8 void inside, two shells.
      [
        "",
        `"isHollow" : true, "parts" : qCreatedBy(id + "block", EntityType.BODY), "thickness" : 1 * millimeter`,
        12000 - 38 * 28 * 8,
        [12, 24, 16],
      ],
      // Outward: walls round the outside up to the top's plane, 42 x 32 x 11 less the box.
      [
        "",
        `"entities" : ${top}, "thickness" : 1 * millimeter, "oppositeDirection" : true`,
        42 * 32 * 11 - 12000,
        [11, 24, 16],
      ],
      [
        "",
        `"isHollow" : true, "parts" : qCreatedBy(id + "block", EntityType.BODY), "thickness" : 1 * millimeter, "oppositeDirection" : true`,
        42 * 32 * 12 - 12000,
        [12, 24, 16],
      ],
      // Vertical edges rounded 3 mm: the outer section loses 4 (1 - pi/4) 9, the inner (radius 2)
      // 4 (1 - pi/4) 4; 10 and 9 tall.
      [
        rounded(3),
        `"entities" : ${top}, "thickness" : 1 * millimeter`,
        (1200 - 36 * (1 - Math.PI / 4)) * 10 - (38 * 28 - 16 * (1 - Math.PI / 4)) * 9,
        [19, 48, 32],
      ],
    ] as const;
    for (const [before, fields, volume, [faces, edges, vertices]] of cases) {
      const r = run(`${box}\n${before}\nshell(context, id + "shell", { ${fields} });`);
      expect(r.status, `${fields} ${r.why}`).toBe("OK");
      close(r.bodies()[0]!.volume, volume);
      expect(r.bodies()[0], fields).toMatchObject({ faces, edges, vertices });
    }
  });

  it("calls a shell or thicken OpenCascade can't build unsupported, not a model error", () => {
    // A top edge rounded 2 mm under a removed top: Onshape shells it; this runtime can't extend
    // the round's offset up to the opening.
    const r = run(
      [
        box,
        'fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(20, 0, 10) * millimeter), "radius" : 2 * millimeter });',
        `shell(context, id + "shell", { "entities" : ${top}, "thickness" : 1 * millimeter });`,
      ].join("\n"),
    );
    if (r.status !== "OK") {
      expect(r.statusEnum).not.toBe("SHELL_FAILED");
      expect(r.fault).toMatch(/not supported locally/);
    }
  });
  // Thickening a curved face used OpenCascade's simple thick solid, which approximates the walls:
  // a whole cylinder wall came out with a slit line across each annulus and B-spline rims.
  it("thickens curved faces with analytic walls", () => {
    const edges = (feature: string) =>
      `qOwnedByBody(qCreatedBy(id + "${feature}", EntityType.BODY), EntityType.EDGE)`;
    const kinds = [
      record(
        "circles",
        `size(evaluateQuery(context, qGeometry(${edges("thicken")}, GeometryType.CIRCLE)))`,
      ),
      record(
        "arcs",
        `size(evaluateQuery(context, qGeometry(${edges("thicken")}, GeometryType.ARC)))`,
      ),
      record(
        "lines",
        `size(evaluateQuery(context, qGeometry(${edges("thicken")}, GeometryType.LINE)))`,
      ),
    ].join("\n");
    const wall = [
      'fCylinder(context, id + "rod", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
      'opExtractSurface(context, id + "wall", { "faces" : qGeometry(qCreatedBy(id + "rod", EntityType.FACE), GeometryType.CYLINDER) });',
      'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "rod", EntityType.BODY) });',
    ].join("\n");
    // Out 1, in 1, and both ways: tubes of radii 5-6, 4-5 and 4-6, 10 tall, four circles.
    for (const [front, back, inner, outer] of [
      [1, 0, 5, 6],
      [0, 1, 4, 5],
      [1, 1, 4, 6],
    ] as const) {
      const r = run(
        `${wall}\nopThicken(context, id + "thicken", { "entities" : qCreatedBy(id + "wall", EntityType.BODY), "thickness1" : ${front} * millimeter, "thickness2" : ${back} * millimeter });\n${kinds}`,
      );
      expect(r.status, r.why).toBe("OK");
      const solid = r.bodies().find((b) => b.type === "SOLID")!;
      close(solid.volume, Math.PI * (outer * outer - inner * inner) * 10);
      expect(solid).toMatchObject({ faces: 4, edges: 4, vertices: 0 });
      expect([r.get("circles"), r.get("arcs"), r.get("lines")]).toEqual([4, 0, 0]);
    }
    // A quarter fillet (radius 4, 10 long) out 1: a quarter ring, its ends two arcs each, its
    // sides four lines each.
    const quarter = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "radius" : 4 * millimeter });',
        'opExtractSurface(context, id + "wall", { "faces" : qCreatedBy(id + "round", EntityType.FACE) });',
        'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "block", EntityType.BODY) });',
        'opThicken(context, id + "thicken", { "entities" : qCreatedBy(id + "wall", EntityType.BODY), "thickness1" : 1 * millimeter, "thickness2" : 0 * millimeter });',
        kinds,
      ].join("\n"),
    );
    expect(quarter.status, quarter.why).toBe("OK");
    const solid = quarter.bodies().find((b) => b.type === "SOLID")!;
    close(solid.volume, (Math.PI / 4) * (25 - 16) * 10);
    expect(solid).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
    expect([quarter.get("circles"), quarter.get("arcs"), quarter.get("lines")]).toEqual([0, 4, 8]);
  });
  // Thicken made one solid per face, so a two-face sheet came out as two solids.
  it("thickens a connected sheet as one solid", () => {
    const cube =
      'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
    // A 4 mm fillet and the top it's tangent to, 1 mm out: the top's 6 x 10 slab and the fillet's
    // quarter ring from radius 4 to 5, 10 long, in one piece.
    const tangent = run(
      [
        cube,
        'fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "radius" : 4 * millimeter });',
        'opExtractSurface(context, id + "sheet", { "faces" : qUnion([qCreatedBy(id + "round", EntityType.FACE), qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(3, 5, 10) * millimeter)]) });',
        'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "block", EntityType.BODY) });',
        'thicken(context, id + "thicken", { "entities" : qCreatedBy(id + "sheet", EntityType.BODY), "thickness1" : 1 * millimeter, "thickness2" : 0 * millimeter });',
      ].join("\n"),
    );
    expect(tangent.status, tangent.why).toBe("OK");
    const solids = tangent.bodies().filter((b) => b.type === "SOLID");
    expect(solids).toHaveLength(1);
    close(solids[0]!.volume, 60 + (Math.PI / 4) * (25 - 16) * 10);
    // A sheet bent at a sharp edge (a cube's top and front): how Onshape fills the corner isn't
    // known here, so it stops rather than leaving two slabs with a gap.
    const sharp = run(
      [
        cube,
        'opExtractSurface(context, id + "sheet", { "faces" : qUnion([qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 5, 10) * millimeter), qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 0, 5) * millimeter)]) });',
        'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "block", EntityType.BODY) });',
        'thicken(context, id + "thicken", { "entities" : qCreatedBy(id + "sheet", EntityType.BODY), "thickness1" : 1 * millimeter, "thickness2" : 0 * millimeter });',
      ].join("\n"),
    );
    expect(sharp.fault).toMatch(/not supported locally/);
  });
  // A cylinder's seam that a cut turned into a real edge (shared with a new face) was hidden as a
  // seam: the half-lap reported 6 edges, and the edge at the seam couldn't be selected or filleted.
  it("keeps a cylinder seam that now bounds another face", () => {
    const halfLap = [
      'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
      'fCuboid(context, id + "lap", { "corner1" : vector(-6, 0, 8) * millimeter, "corner2" : vector(6, 6, 11) * millimeter });',
      'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "pin", EntityType.BODY), "tools" : qCreatedBy(id + "lap", EntityType.BODY) });',
      record(
        "atSeam",
        'size(evaluateQuery(context, qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), vector(5, 0, 9) * millimeter)))',
      ),
    ];
    const lap = run(halfLap.join("\n"));
    expect(lap.status, lap.why).toBe("OK");
    // Faces: wall, bottom, top half disc, lap floor, lap wall. Edges: bottom circle, top half arc,
    // its diameter, floor half arc, floor diameter, and the two vertical lap edges at x = +-5.
    // Vertices: the four lap corners. The full pin is 250pi, the lap takes half of 25pi x 2.
    expect(lap.bodies()).toMatchObject([{ faces: 5, edges: 7, vertices: 4 }]);
    close(lap.bodies()[0]!.volume, 225 * Math.PI);
    expect(lap.get("atSeam")).toBe(1);
    const blend = (op: string, x: number) =>
      run(
        [
          ...halfLap,
          `${op}(context, id + "blend", { "entities" : qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), vector(${x}, 0, 9) * millimeter), "radius" : 0.5 * millimeter, "width" : 0.5 * millimeter });`,
        ].join("\n"),
      );
    // The lap edge at x = -5, away from the seam: the ball sits 0.5 off the lap wall and 4.5 from
    // the axis, touching the pin at angle t = asin(1/9). The corner it cuts is the pin's sector
    // (12.5t) less the triangle to the wall contact (0.25 sqrt(20)) and the ball's sector
    // (0.125 (pi / 2 + t)), 2 mm tall.
    const rounded = blend("fillet", -5);
    expect(rounded.status, rounded.why).toBe("OK");
    const t = Math.asin(1 / 9);
    const corner = 12.5 * t - 0.25 * Math.sqrt(20) - 0.125 * (Math.PI / 2 + t);
    close(rounded.bodies()[0]!.volume, 225 * Math.PI - 2 * corner);
    // The edge at x = 5 runs along where OpenCascade's cylinder starts and ends (its seam goes on
    // below it), which its fillet and chamfer can't take; the seam moves to the other lap corner
    // first. The same corner cut off at 0.5 along each face (an angle of 0.1 on the pin) is the
    // pin's sector (12.5 * 0.1) less the triangle to the wall point (0.5 * 4.5 * 5 sin(0.1)).
    const seamRounded = blend("fillet", 5);
    expect(seamRounded.status, seamRounded.why).toBe("OK");
    close(seamRounded.bodies()[0]!.volume, 225 * Math.PI - 2 * corner);
    const chamfered = blend("chamfer", 5);
    expect(chamfered.status, chamfered.why).toBe("OK");
    close(chamfered.bodies()[0]!.volume, 225 * Math.PI - 2 * (1.25 - 11.25 * Math.sin(0.1)));
    // Both lap edges at once leave the seam no vertex of its own to move to: a local limitation,
    // not FILLET_FAILED.
    const both = run(
      [
        ...halfLap,
        'fillet(context, id + "blend", { "entities" : qUnion([qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), vector(5, 0, 9) * millimeter), qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), vector(-5, 0, 9) * millimeter)]), "radius" : 0.5 * millimeter });',
      ].join("\n"),
    );
    expect(both.fault).toMatch(/seam is not supported locally/);
  });
  // OpenCascade starts each cylinder at a seam, and where the seam met a rim mid-arc it split the
  // arc with a vertex Parasolid's seamless cylinder doesn't have: a notch reported 8 edges and 5
  // vertices. Each case's rim already has a vertex the seam can run through instead.
  it("moves a cylinder's seam to a vertex its rim already has", () => {
    const pin =
      'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });';
    const counts = [
      record(
        "arcs",
        'size(evaluateQuery(context, qGeometry(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), GeometryType.ARC)))',
      ),
      record("pinFaces", 'size(evaluateQuery(context, qCreatedBy(id + "pin", EntityType.FACE)))'),
    ];
    const notch = run(
      [
        pin,
        'fCuboid(context, id + "notch", { "corner1" : vector(3, -6, 8) * millimeter, "corner2" : vector(6, 6, 11) * millimeter });',
        'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "pin", EntityType.BODY), "tools" : qCreatedBy(id + "notch", EntityType.BODY) });',
        ...counts,
      ].join("\n"),
    );
    expect(notch.status, notch.why).toBe("OK");
    // Faces: wall, bottom, what's left of the top, notch floor and notch wall. Edges: bottom circle,
    // top arc, floor arc, the top's and the floor's chords, and two vertical notch edges. Vertices:
    // the notch's four corners. The notch takes the segment past x = 3 (25 acos(0.6) - 3 * 4), 2 tall.
    expect(notch.bodies()).toMatchObject([{ faces: 5, edges: 7, vertices: 4 }]);
    expect([notch.get("arcs"), notch.get("pinFaces")]).toEqual([2, 3]);
    close(notch.bodies()[0]!.volume, 250 * Math.PI - 2 * (25 * Math.acos(0.6) - 12));
    const tab = run(
      [
        pin,
        'fCuboid(context, id + "tab", { "corner1" : vector(-2, 4, 6) * millimeter, "corner2" : vector(2, 9, 10) * millimeter });',
        'opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "pin", EntityType.BODY), qCreatedBy(id + "tab", EntityType.BODY)]) });',
        ...counts,
      ].join("\n"),
    );
    expect(tab.status, tab.why).toBe("OK");
    // Faces: wall, bottom, top (disc and tab top in one), and the tab's two sides, end and
    // underside. Edges: bottom circle; the top's rim arc and three tab edges; four vertical tab
    // edges; the underside's arc on the pin and three tab edges. Vertices: the tab's eight corners.
    // The tab's 80 mm^3 less the part inside the pin: the strip under the circle past y = 4,
    // (2 sqrt(21) + 25 asin(0.4)) - 16, 4 tall.
    expect(tab.bodies()).toMatchObject([{ faces: 7, edges: 13, vertices: 8 }]);
    expect(tab.get("arcs")).toBe(2);
    close(
      tab.bodies()[0]!.volume,
      250 * Math.PI + 80 - 4 * (2 * Math.sqrt(21) + 25 * Math.asin(0.4) - 16),
    );
    const split = run(
      [
        pin,
        'opPlane(context, id + "plane", { "plane" : plane(vector(2, 0, 0) * millimeter, vector(1, 0, 0)) });',
        'opSplitFace(context, id + "split", { "faceTargets" : qContainsPoint(qCreatedBy(id + "pin", EntityType.FACE), vector(0, 0, 10) * millimeter), "planeTools" : qCreatedBy(id + "plane", EntityType.FACE) });',
        ...counts,
      ].join("\n"),
    );
    expect(split.status, split.why).toBe("OK");
    // The top split at x = 2: two arcs, the chord, the bottom circle; the chord's two ends.
    expect(split.bodies()).toMatchObject([{ faces: 4, edges: 4, vertices: 2 }]);
    expect(split.get("arcs")).toBe(2);
  });
});

describe("review round 4", () => {
  // A box W x D x H shelled `t` thick: open at its top face, or hollow.
  const shellBox = (size: readonly [number, number, number], t: number, hollow: boolean) => {
    const [w, d, h] = size;
    const which = hollow
      ? `"isHollow" : true, "parts" : qCreatedBy(id + "box", EntityType.BODY)`
      : `"entities" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), vector(1, 1, ${h}) * millimeter)`;
    return run(
      [
        `fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${w}, ${d}, ${h}) * millimeter });`,
        `shell(context, id + "shell", { ${which}, "thickness" : ${t} * millimeter });`,
      ].join("\n"),
    );
  };

  // Walls thicker than half a box's height turned the whole-body inward offset inside out; it was
  // flipped back, passed OpenCascade's check with 1 mm tolerances, and gave wrong volumes (a 50 x 50
  // x 3 plate at 2.5 mm: 7162.5 for 6487.5) or a hollow with no room for a cavity.
  it("shells deep walls right, and fails like Onshape when no cavity fits", () => {
    // Open at the top, the cavity is (W - 2t) x (D - 2t) x (H - t); hollow, (H - 2t).
    const cases: [readonly [number, number, number], number, boolean][] = [
      [[50, 50, 3], 1.6, false],
      [[50, 50, 3], 2.5, false],
      [[20, 20, 4], 2.2, false],
      [[20, 20, 4], 3.2, false],
      [[40, 30, 10], 5.5, false],
      [[60, 40, 5], 2.2, true],
      [[60, 40, 5], 2.4, true],
      [[40, 30, 10], 4.9, true],
    ];
    for (const [size, t, hollow] of cases) {
      const [w, d, h] = size;
      const shelled = shellBox(size, t, hollow);
      expect(shelled.status, `${size} t ${t}: ${shelled.why}`).toBe("OK");
      expect(shelled.bodies(), `${size} t ${t}`).toMatchObject([
        { faces: hollow ? 12 : 11, edges: 24, vertices: 16 },
      ]);
      close(
        shelled.bodies()[0]!.volume,
        w * d * h - (w - 2 * t) * (d - 2 * t) * (h - (hollow ? 2 : 1) * t),
      );
    }
    // No cavity fits: 30 mm across is less than two 16 mm walls; 3.5 mm walls under a 3 mm plate's
    // opening reach past its bottom; a 10 mm tall box can't take two 5.5 mm walls, or two 8 mm ones
    // (OpenCascade's offset then has faces it can't even mesh).
    for (const [size, t, hollow] of [
      [[40, 30, 20], 16, false],
      [[50, 50, 3], 3.5, false],
      [[40, 30, 10], 5.5, true],
      [[40, 30, 10], 8, true],
    ] as const)
      expect(shellBox(size, t, hollow).statusEnum, `${size} t ${t}`).toBe("SHELL_FAILED");
  });
  // A removed face counted as surviving when its probe point, a third of the way across the face's
  // short side, fell on the rim the walls leave in its plane: walls over a third of that were
  // rejected though the shell was right.
  it("shells walls wider than a third of the removed face", () => {
    const cases: [readonly [number, number, number], number, string, number][] = [
      // The 40 x 10 side at y = 0 removed: a (40 - 2t) x (30 - t) x (10 - 2t) cavity.
      [[40, 30, 10], 3.5, "vector(1, 0, 1)", 12000 - 33 * 26.5 * 3],
      [[40, 30, 10], 4, "vector(1, 0, 1)", 12000 - 32 * 26 * 2],
      // A 4 mm wall open at the top: 37 x 1 x 8.5.
      [[40, 4, 10], 1.5, "vector(1, 1, 10)", 1600 - 37 * 1 * 8.5],
      // A 40 x 30 x 20 box open at the top: (40 - 2t) x (30 - 2t) x (20 - t).
      [[40, 30, 20], 10, "vector(1, 1, 20)", 24000 - 20 * 10 * 10],
      [[40, 30, 20], 11, "vector(1, 1, 20)", 24000 - 18 * 8 * 9],
      [[40, 30, 20], 14, "vector(1, 1, 20)", 24000 - 12 * 2 * 6],
    ];
    for (const [[w, d, h], t, at, volume] of cases) {
      const shelled = run(
        [
          `fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${w}, ${d}, ${h}) * millimeter });`,
          `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), ${at} * millimeter), "thickness" : ${t} * millimeter });`,
        ].join("\n"),
      );
      expect(shelled.status, `${w}x${d}x${h} t ${t}: ${shelled.why}`).toBe("OK");
      expect(shelled.bodies()).toMatchObject([{ faces: 11, edges: 24, vertices: 16 }]);
      close(shelled.bodies()[0]!.volume, volume);
    }
  });
  // Walls as thick as a convex blend's radius shrink it to nothing. The cylinder-and-sphere
  // pre-check missed a torus (a cup with a 1 mm bottom fillet shelled 1 mm came back with a face of
  // no area), and where it did catch one (a box's 1 mm rounds) it said SHELL_FAILED, though the
  // body has room for a cavity and Onshape likely builds it with sharp inner corners.
  it("calls a shell or thicken that shrinks one face to nothing unsupported, naming it", () => {
    const cup = (t: number) =>
      run(
        [
          'fCylinder(context, id + "cup", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 10 * millimeter });',
          'fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "cup", EntityType.EDGE), vector(10, 0, 0) * millimeter), "radius" : 1 * millimeter });',
          `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "cup", EntityType.FACE), vector(0, 0, 20) * millimeter), "thickness" : ${t} * millimeter });`,
        ].join("\n"),
      );
    const thin = cup(0.5);
    expect(thin.status, thin.why).toBe("OK");
    // Outside: wall, fillet, bottom; inside the same, the fillet 0.5 now; and the rim. Six circles.
    expect(thin.bodies()).toMatchObject([{ faces: 7, edges: 6, vertices: 0 }]);
    // A fillet of radius r in a corner at radius c takes off its spandrel, (1 - pi / 4) r^2, swept
    // round its centroid r (5/6 - pi/4) / (1 - pi/4) in from the corner (Pappus).
    const ring = (c: number, r: number) =>
      2 *
      Math.PI *
      (c - (r * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4)) *
      (1 - Math.PI / 4) *
      r *
      r;
    const outside = Math.PI * 100 * 20 - ring(10, 1);
    const cavity = Math.PI * 9.5 * 9.5 * 19.5 - ring(9.5, 0.5);
    close(thin.bodies()[0]!.volume, outside - cavity);
    for (const t of [1, 2])
      expect(cup(t).fault, `cup ${t}`).toMatch(/not supported locally.*torus face.*radius 1 mm/);

    // A 40 x 30 x 10 box with its four vertical edges rounded 1 mm, open at the top.
    const rounded = (t: number) =>
      run(
        [
          'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
          `fillet(context, id + "round", { "entities" : qUnion([${[
            [0, 0],
            [40, 0],
            [0, 30],
            [40, 30],
          ]
            .map(
              ([x, y]) =>
                `qContainsPoint(qCreatedBy(id + "box", EntityType.EDGE), vector(${x}, ${y}, 5) * millimeter)`,
            )
            .join(", ")}]), "radius" : 1 * millimeter });`,
          `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), vector(20, 15, 10) * millimeter), "thickness" : ${t} * millimeter });`,
        ].join("\n"),
      );
    for (const t of [1, 2])
      expect(rounded(t).fault, `box ${t}`).toMatch(
        /not supported locally.*cylinder face.*radius 1 mm/,
      );

    // A 2 mm wall standing on a 30 x 30 x 10 block, hollowed with 1.5 mm walls: the block has room,
    // the wall doesn't. Leaving the wall solid is a guess at what Onshape does, so it stops.
    const arm = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(30, 30, 10) * millimeter });',
        'fCuboid(context, id + "wall", { "corner1" : vector(0, 0, 10) * millimeter, "corner2" : vector(30, 2, 30) * millimeter });',
        'opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "block", EntityType.BODY), qCreatedBy(id + "wall", EntityType.BODY)]) });',
        'shell(context, id + "shell", { "isHollow" : true, "parts" : qCreatedBy(id + "block", EntityType.BODY), "thickness" : 1.5 * millimeter });',
      ].join("\n"),
    );
    expect(arm.fault).toMatch(/not supported locally.*feature thinner than two 1\.5 mm walls/);

    // The 4 mm fillet and the top it's tangent to, thickened 5 mm toward the fillet's axis.
    const sheet = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        'fillet(context, id + "round", { "entities" : qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), vector(10, 5, 10) * millimeter), "radius" : 4 * millimeter });',
        'opExtractSurface(context, id + "sheet", { "faces" : qUnion([qCreatedBy(id + "round", EntityType.FACE), qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(3, 5, 10) * millimeter)]) });',
        'opDeleteBodies(context, id + "drop", { "entities" : qCreatedBy(id + "block", EntityType.BODY) });',
        'thicken(context, id + "thicken", { "entities" : qCreatedBy(id + "sheet", EntityType.BODY), "thickness1" : 0 * millimeter, "thickness2" : 5 * millimeter });',
      ].join("\n"),
    );
    expect(sheet.fault).toMatch(/not supported locally.*cylinder face.*radius 4 mm/);
  });
  // A k-hole plate (holes 10 apart along y = 10) with a shallow slot along the row cutting every
  // hole's top rim, then `after`.
  const slotted = (k: number, after: string[] = []) => {
    const w = 10 * k + 10;
    return run(
      [
        `fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${w}, 20, 10) * millimeter });`,
        ...Array.from(
          { length: k },
          (_, i) =>
            `fCylinder(context, id + "h${i}", { "bottomCenter" : vector(${10 + 10 * i}, 10, -1) * millimeter, "topCenter" : vector(${10 + 10 * i}, 10, 11) * millimeter, "radius" : 3 * millimeter });`,
        ),
        'opBoolean(context, id + "holes", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qSubtraction(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), qCreatedBy(id + "plate", EntityType.BODY)) });',
        `fCuboid(context, id + "slot", { "corner1" : vector(-1, 9, 8) * millimeter, "corner2" : vector(${w + 1}, 11, 11) * millimeter });`,
        'opBoolean(context, id + "groove", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qCreatedBy(id + "slot", EntityType.BODY) });',
        ...after,
      ].join("\n"),
    );
  };

  // Seams were re-seated on every cylinder face of every boolean, at most 8 moves at a time: a
  // slot across 12 holes left 4 seams where the rest moved, and a later cut far from every hole
  // moved those and lost 4 edge ids.
  it("re-seats the seams of faces an operation touches, all of them, and no others", () => {
    // Every hole is alike, so each adds the same count.
    const one = slotted(1).bodies()[0]!;
    const two = slotted(2).bodies()[0]!;
    const twelve = slotted(12).bodies()[0]!;
    expect(twelve.edges - one.edges).toBe(11 * (two.edges - one.edges));
    expect(twelve.vertices - one.vertices).toBe(11 * (two.vertices - one.vertices));
    const later = slotted(12, [
      'const edges = evaluateQuery(context, qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.EDGE));',
      'fCuboid(context, id + "corner", { "corner1" : vector(-1, -1, 9) * millimeter, "corner2" : vector(1, 1, 11) * millimeter });',
      'opBoolean(context, id + "nick", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qCreatedBy(id + "corner", EntityType.BODY) });',
      "var lost = 0;",
      "for (var edge in edges) { if (size(evaluateQuery(context, edge)) == 0) lost += 1; }",
      record("lost", "lost"),
    ]);
    expect(later.status, later.why).toBe("OK");
    // The nick takes the corner's vertical edge's top; the three edges it cuts keep their ids.
    expect(later.get("lost")).toBe(0);
  });

  // Booleans that touch no cylinder shouldn't pay for the plate's hundred holes: five small cuts
  // took 3.4 times as long as the holes themselves (OpenCascade alone: 1.9). The ratio depends on
  // the machine (CI runners read 3.3 to 4.3 without the slowdown), so it's checked off CI only.
  it.skipIf(process.env.CI)(
    "doesn't slow booleans that touch no cylinder",
    () => {
      const plate = (cuts: number) => {
        const started = performance.now();
        const result = run(
          [
            'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(200, 200, 10) * millimeter });',
            ...Array.from(
              { length: 100 },
              (_, n) =>
                `fCylinder(context, id + "h${n}", { "bottomCenter" : vector(${10 + 20 * (n % 10)}, ${10 + 20 * Math.floor(n / 10)}, -1) * millimeter, "topCenter" : vector(${10 + 20 * (n % 10)}, ${10 + 20 * Math.floor(n / 10)}, 11) * millimeter, "radius" : 3 * millimeter });`,
            ),
            'opBoolean(context, id + "holes", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qSubtraction(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), qCreatedBy(id + "plate", EntityType.BODY)) });',
            ...Array.from({ length: cuts }, (_, k) =>
              [
                `fCuboid(context, id + "c${k}", { "corner1" : vector(${k * 4}, -1, 8) * millimeter, "corner2" : vector(${k * 4 + 2}, 3, 11) * millimeter });`,
                `opBoolean(context, id + "x${k}", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qCreatedBy(id + "c${k}", EntityType.BODY) });`,
              ].join("\n"),
            ),
          ].join("\n"),
        );
        expect(result.status, result.why).toBe("OK");
        return performance.now() - started;
      };
      // The fastest of a few runs each, so a busy machine's pauses don't decide the ratio.
      const fastest = (cuts: number) => Math.min(...[0, 1, 2].map(() => plate(cuts)));
      plate(0);
      expect(fastest(5) / fastest(0)).toBeLessThan(1.5 * 1.9);
    },
    60_000,
  );
  // Splitting a pin's top circle at one point moved the seam onto the new vertex, and a vertex
  // alone on a closed circle isn't reported: the vertex the split made couldn't be selected.
  it("keeps the vertex a split makes on a full circle", () => {
    const split = (parameters: string) =>
      run(
        [
          'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
          `opSplitEdges(context, id + "split", { "edges" : qContainsPoint(qCreatedBy(id + "pin", EntityType.EDGE), vector(5, 0, 10) * millimeter), "parameters" : ${parameters} });`,
          record(
            "atHalf",
            'size(evaluateQuery(context, qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.VERTEX), vector(-5, 0, 10) * millimeter)))',
          ),
        ].join("\n"),
      );
    // Halfway round is (-5, 0, 10). OpenCascade's seam keeps its own vertex at (5, 0, 10), so the
    // top is two arcs between the two (Onshape, unconfirmed: one closed edge with the one vertex).
    const once = split("[[0.5]]");
    expect(once.status, once.why).toBe("OK");
    expect(once.get("atHalf")).toBe(1);
    expect(once.bodies()).toMatchObject([{ faces: 3, edges: 3, vertices: 2 }]);
    // Split twice, the seam moves to one of the new vertices: two arcs, two vertices, as Onshape.
    expect(split("[[0.25, 0.75]]").bodies()).toMatchObject([{ faces: 3, edges: 3, vertices: 2 }]);
  });
  // The fillet's retry took any seam move that cleared the edge, even one that split a rim arc with
  // a vertex Onshape doesn't have: a half-lapped pin with a notch on its seam at the bottom came
  // back filleted with an extra vertex at (3, -4, 10).
  it("moves a seam clear of a fillet only where it adds no vertex", () => {
    const filleted = run(
      [
        'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
        'fCuboid(context, id + "lap", { "corner1" : vector(-6, 0, 8) * millimeter, "corner2" : vector(6, 6, 11) * millimeter });',
        'opBoolean(context, id + "lapCut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "pin", EntityType.BODY), "tools" : qCreatedBy(id + "lap", EntityType.BODY) });',
        'fCuboid(context, id + "low", { "corner1" : vector(3, -6, -1) * millimeter, "corner2" : vector(6, 0, 2) * millimeter });',
        'opBoolean(context, id + "lowCut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "pin", EntityType.BODY), "tools" : qCreatedBy(id + "low", EntityType.BODY) });',
        'fillet(context, id + "round", { "entities" : qContainsPoint(qOwnedByBody(qCreatedBy(id + "pin", EntityType.BODY), EntityType.EDGE), vector(5, 0, 9) * millimeter), "radius" : 0.5 * millimeter });',
      ].join("\n"),
    );
    // Every other vertex of the wall puts the seam across a rim arc (the top at (3, -4), the
    // bottom at (-5, 0)): a local limitation.
    expect(filleted.fault).toMatch(/seam is not supported locally/);
  });
});

describe("review round 5", () => {
  // A 40 x 30 x 10 box with `feature` added, shelled `t` thick from its bottom.
  const shellFromBottom = (feature: string[], t: number) =>
    run(
      [
        'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
        ...feature,
        `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), vector(1, 1, 0) * millimeter), "thickness" : ${t} * millimeter });`,
      ].join("\n"),
    );
  const join = (name: string, corner1: string, corner2: string) => [
    `fCuboid(context, id + "${name}", { "corner1" : ${corner1} * millimeter, "corner2" : ${corner2} * millimeter });`,
    `opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "box", EntityType.BODY), qCreatedBy(id + "${name}", EntityType.BODY)]) });`,
  ];
  const pad = (h: number) => join("pad", "vector(15, 10, 10)", `vector(25, 20, ${10 + h})`);
  const pocket = (h: number) => [
    `fCuboid(context, id + "pocket", { "corner1" : vector(15, 10, ${10 - h}) * millimeter, "corner2" : vector(25, 20, 11) * millimeter });`,
    'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "box", EntityType.BODY), "tools" : qCreatedBy(id + "pocket", EntityType.BODY) });',
  ];

  // A shell's walls past a concave edge are up to t sqrt 2 from it, so a right sharp-cornered shell
  // failed the check that every wall is exactly t from the body, and OpenCascade's shell, which
  // rounds those corners with cylinders, was taken instead; a step face between a convex and a
  // concave edge (shifted, not shrunk) was called a wall with no room.
  it("shells pads, pockets, steps and bosses with sharp inner corners", () => {
    // The box's cavity, (40 - 2t)(30 - 2t)(10 - t), at t = 2.
    const box = 36 * 26 * 8;
    const cases: [string, string[], number, [number, number, number]][] = [
      // A 10 x 10 pad h tall adds its (10 - 2t)^2 x h to the cavity.
      ...[1.9, 3, 4.1, 5].map((h): [string, string[], number, [number, number, number]] => [
        `pad ${h}`,
        pad(h),
        12000 + 100 * h - (box + 36 * h),
        [21, 48, 32],
      ]),
      // A 10 x 10 pocket h deep takes (10 + 2t)^2 x h from it.
      ...[3, 4.5, 5, 5.5].map((h): [string, string[], number, [number, number, number]] => [
        `pocket ${h}`,
        pocket(h),
        12000 - 100 * h - (box - 196 * h),
        [21, 48, 32],
      ]),
      // The right half of the top raised 3: its cavity, x 22 to 38, rises 3 too.
      [
        "step 3",
        join("step", "vector(20, 0, 10)", "vector(40, 30, 13)"),
        12000 + 1800 - (box + 16 * 26 * 3),
        [15, 36, 24],
      ],
      // A round boss r 5 h 3: the cavity rises into it as a cylinder r 3.
      [
        "boss 3",
        [
          'fCylinder(context, id + "boss", { "bottomCenter" : vector(20, 15, 10) * millimeter, "topCenter" : vector(20, 15, 13) * millimeter, "radius" : 5 * millimeter });',
          'opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "box", EntityType.BODY), qCreatedBy(id + "boss", EntityType.BODY)]) });',
        ],
        12000 + Math.PI * 25 * 3 - (box + Math.PI * 9 * 3),
        [15, 28, 16],
      ],
    ];
    for (const [name, feature, volume, [faces, edges, vertices]] of cases) {
      const shelled = shellFromBottom(feature, 2);
      expect(shelled.status, `${name}: ${shelled.why}`).toBe("OK");
      expect(shelled.bodies(), name).toMatchObject([{ faces, edges, vertices }]);
      close(shelled.bodies()[0]!.volume, volume);
    }
    // A pad shorter than the walls are thick: neither builder gets its offset right (OpenCascade
    // glues it with 1 mm tolerances; the face rebuild leaves the pad's part of the cavity out).
    expect(shellFromBottom(pad(1), 2).fault).toMatch(/not supported locally/);
  });

  // A shell OpenCascade glued together across a gap a wall wide passed its own check and the
  // 0.5 mm tolerance bound: a tapered rib's cavity came out short (23.2 mm^3 heavy, 0.24 mm
  // tolerances), a cone's cavity closed short of the opening and was held on by 0.47 mm.
  it("stops shells OpenCascade glues together, and builds the ones it can", () => {
    // A rib on the top tapering from 4 wide at x 5 to `tip` wide at x 35, 10 tall.
    const rib = (tip: number) => [
      'const sk = newSketchOnPlane(context, id + "sk", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
      `skLineSegment(sk, "a", { "start" : vector(5, 13) * millimeter, "end" : vector(35, ${15 - tip / 2}) * millimeter });`,
      `skLineSegment(sk, "b", { "start" : vector(35, ${15 - tip / 2}) * millimeter, "end" : vector(35, ${15 + tip / 2}) * millimeter });`,
      `skLineSegment(sk, "c", { "start" : vector(35, ${15 + tip / 2}) * millimeter, "end" : vector(5, 17) * millimeter });`,
      'skLineSegment(sk, "d", { "start" : vector(5, 17) * millimeter, "end" : vector(5, 13) * millimeter });',
      "skSolve(sk);",
      'opExtrude(context, id + "rib", { "entities" : qSketchRegion(id + "sk"), "direction" : vector(0, 0, 1), "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });',
      'opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "box", EntityType.BODY), qCreatedBy(id + "rib", EntityType.BODY)]) });',
    ];
    // Tapering to 1.5, 0.4 mm walls: each slanted side moves t sqrt(1 + slope^2) in y, so the
    // rib's cavity, x 5.4 to 34.6, narrows from w(5.4) to w(34.6), 10 tall.
    const slope = 2.5 / 2 / 30;
    const w = (x: number) => 4 - (2.5 * (x - 5)) / 30 - 2 * 0.4 * Math.sqrt(1 + slope * slope);
    const cavity = ((w(5.4) + w(34.6)) / 2) * 29.2 * 10;
    const tapered = shellFromBottom(rib(1.5), 0.4);
    expect(tapered.status, tapered.why).toBe("OK");
    close(tapered.bodies()[0]!.volume, 12000 + 2.75 * 300 - (39.2 * 29.2 * 9.6 + cavity));
    // Tapering to 1: OpenCascade's comes back glued, and the face rebuild can't build it.
    expect(shellFromBottom(rib(1), 0.4).fault).toMatch(/not supported locally/);

    // A frustum from r 6 at z 0 to `top` at z 10, shelled `t` open at its top.
    const frustum = (top: number, t: number) =>
      run(
        [
          'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
          'skLineSegment(sketch, "a", { "start" : vector(0, 0) * millimeter, "end" : vector(6, 0) * millimeter });',
          `skLineSegment(sketch, "b", { "start" : vector(6, 0) * millimeter, "end" : vector(${top}, 10) * millimeter });`,
          `skLineSegment(sketch, "c", { "start" : vector(${top}, 10) * millimeter, "end" : vector(0, 10) * millimeter });`,
          'skLineSegment(sketch, "d", { "start" : vector(0, 10) * millimeter, "end" : vector(0, 0) * millimeter });',
          "skSolve(sketch);",
          'opRevolve(context, id + "cone", { "entities" : qSketchRegion(id + "sketch"), "axis" : line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "angleForward" : 2 * PI * radian });',
          `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "cone", EntityType.FACE), vector(0, 0, 10) * millimeter), "thickness" : ${t} * millimeter });`,
        ].join("\n"),
      );
    // To r 3, 0.5 thick: the cavity's cone is 0.5 / cos(a) in from the wall (tan a = 0.3), from
    // z 0.5 to the opening.
    const inset = 0.5 * Math.sqrt(1 + 0.09);
    const [r0, r1] = [6 - 0.3 * 0.5 - inset, 3 - inset];
    const cone = frustum(3, 0.5);
    expect(cone.status, cone.why).toBe("OK");
    close(
      cone.bodies().find((b) => b.type === "SOLID")!.volume,
      ((Math.PI * 10) / 3) * (36 + 18 + 9) - ((Math.PI * 9.5) / 3) * (r0 * r0 + r0 * r1 + r1 * r1),
    );
    // To r 1, 1 thick: the cavity's cone closes at z 9.76, short of the opening.
    expect(frustum(1, 1).fault).toMatch(/not supported locally/);
  });

  // Hollowed outward 0.9 mm, a 2 mm slot narrows to 0.2 mm, and OpenCascade's offset merged the
  // vertices on its two sides through 0.2 mm tolerances: 28 vertices, not 32.
  it("keeps the two sides of a narrowed slot apart", () => {
    const hollow = run(
      [
        'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
        'fCuboid(context, id + "slot", { "corner1" : vector(19, -1, 6) * millimeter, "corner2" : vector(21, 31, 11) * millimeter });',
        'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "box", EntityType.BODY), "tools" : qCreatedBy(id + "slot", EntityType.BODY) });',
        'shell(context, id + "shell", { "isHollow" : true, "parts" : qCreatedBy(id + "box", EntityType.BODY), "thickness" : 0.9 * millimeter, "oppositeDirection" : true });',
      ].join("\n"),
    );
    expect(hollow.status, hollow.why).toBe("OK");
    // Each of the two shells: the slotted box's 16 vertices.
    expect(hollow.bodies()[0]).toMatchObject({ vertices: 32 });
    // The outside, 41.8 x 31.8 x 11.8 less its 0.2 x 4 slot 31.8 long, less the box and its slot.
    close(hollow.bodies()[0]!.volume, 41.8 * 31.8 * 11.8 - 0.2 * 4 * 31.8 - (12000 - 2 * 4 * 30));
  });

  // Checking a shell probed each face's deepest point, which took the 100-hole plate's shell from
  // 3.5 s to 7.3 s (from 10 to 19 times the plate itself). CI runners read about 15 without it, so
  // the ratio is checked off CI only.
  it.skipIf(process.env.CI)(
    "shells a plate of holes in about the time it did",
    () => {
      const plate = [
        'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(210, 210, 10) * millimeter });',
        ...Array.from(
          { length: 100 },
          (_, k) =>
            `fCylinder(context, id + "h${k}", { "bottomCenter" : vector(${10 + 20 * (k % 10)}, ${10 + 20 * Math.floor(k / 10)}, -1) * millimeter, "topCenter" : vector(${10 + 20 * (k % 10)}, ${10 + 20 * Math.floor(k / 10)}, 11) * millimeter, "radius" : 3 * millimeter });`,
        ),
        'opBoolean(context, id + "holes", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "plate", EntityType.BODY), "tools" : qSubtraction(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), qCreatedBy(id + "plate", EntityType.BODY)) });',
      ];
      const time = (code: string[]) => {
        const started = performance.now();
        const result = run(code.join("\n"));
        expect(result.status, result.why).toBe("OK");
        return { ms: performance.now() - started, result };
      };
      // The fastest of a few runs each, so a busy machine's pauses don't decide the ratio.
      const fastest = (code: string[]) => {
        const runs = [0, 1, 2].map(() => time(code));
        return { ms: Math.min(...runs.map((one) => one.ms)), result: runs[0]!.result };
      };
      time(plate);
      const base = fastest(plate).ms;
      const shelled = fastest([
        ...plate,
        'shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "plate", EntityType.FACE), vector(1, 1, 0) * millimeter), "thickness" : 1 * millimeter });',
      ]);
      // The plate less its holes, less the cavity (208^2 x 9) less 100 bosses r 4 round the holes.
      close(
        shelled.result.bodies()[0]!.volume,
        210 * 210 * 10 - 100 * Math.PI * 9 * 10 - (208 * 208 * 9 - 100 * Math.PI * 16 * 9),
      );
      expect((shelled.ms - base) / base).toBeLessThan(1.3 * 10.3);
    },
    60_000,
  );
});

describe("transforms", () => {
  // OpenCascade's gp_Trsf only holds rotations, mirrors and one scale; handed a matrix scaling each
  // axis differently it quietly makes the scale uniform. fEllipsoid with radii 5, 2 and 3 came back
  // a sphere of radius 3.107 (its box 3.107 every way), so std's evFaceCurvature example read
  // 0.322 both ways instead of 0.12 and 0.75.
  it("stops an uneven scale and keeps rotations with one scale exact", () => {
    const ellipsoid = run(
      'fEllipsoid(context, id + "e", { "center" : vector(0, 0, 0) * inch, "radius" : vector(5 * inch, 2 * inch, 3 * inch) });',
    );
    expect(ellipsoid.fault).toMatch(/scale unevenly.*not supported locally/);
    const box =
      'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 20, 30) * millimeter });';
    const moved = (linear: string) =>
      run(
        [
          box,
          `opTransform(context, id + "move", { "bodies" : qCreatedBy(id + "box", EntityType.BODY), "transform" : transform(${linear}, vector(1, 2, 3) * millimeter) });`,
          'const b = evBox3d(context, { "topology" : qCreatedBy(id + "box", EntityType.BODY) });',
          record("low", "b.minCorner / millimeter"),
          record("high", "b.maxCorner / millimeter"),
        ].join("\n"),
      );
    expect(moved("matrix([[2, 0, 0], [0, 1, 0], [0, 0, 3]])").fault).toMatch(
      /scale unevenly.*not supported locally/,
    );
    // A quarter turn about z doubled: x' = -2y, y' = 2x, z' = 2z, then moved (1, 2, 3).
    const turned = moved("matrix([[0, -2, 0], [2, 0, 0], [0, 0, 2]])");
    expect(turned.status, turned.why).toBe("OK");
    close(turned.bodies()[0]!.volume, 6000 * 8);
    const corners = [turned.get("low"), turned.get("high")].map((corner) =>
      (corner as unknown[]).map((v) => Number(untag(v as never))),
    );
    expect(corners[0]![0]).toBeCloseTo(-39, 6);
    expect(corners[0]![1]).toBeCloseTo(2, 6);
    expect(corners[0]![2]).toBeCloseTo(3, 6);
    expect(corners[1]![0]).toBeCloseTo(1, 6);
    expect(corners[1]![1]).toBeCloseTo(22, 6);
    expect(corners[1]![2]).toBeCloseTo(63, 6);
  });

  // The check lived in opTransform alone, so a pattern (or a face move) through the same matrix
  // still came out scaled uniformly: a 10 x 20 x 30 box patterned by diag(2, 1, 3) built a copy
  // 18.17 x 36.34 x 54.51 with the volume unchanged.
  it("stops every operation scaling unevenly, and patterns a uniform scale exactly", () => {
    const box =
      'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 20, 30) * millimeter });';
    const pattern = (linear: string) =>
      run(
        [
          box,
          `opPattern(context, id + "copy", { "entities" : qCreatedBy(id + "box", EntityType.BODY), "transforms" : [transform(${linear}, vector(50, 0, 0) * millimeter)], "instanceNames" : ["1"] });`,
          'const b = evBox3d(context, { "topology" : qCreatedBy(id + "copy", EntityType.BODY) });',
          record("low", "b.minCorner / millimeter"),
          record("high", "b.maxCorner / millimeter"),
        ].join("\n"),
      );
    expect(pattern("matrix([[2, 0, 0], [0, 1, 0], [0, 0, 3]])").fault).toMatch(
      /scale unevenly.*not supported locally/,
    );
    // Doubled and moved 50 in x: the copy spans (50, 0, 0) to (70, 40, 60), 8 times the volume.
    const doubled = pattern("matrix([[2, 0, 0], [0, 2, 0], [0, 0, 2]])");
    expect(doubled.status, doubled.why).toBe("OK");
    expect(doubled.bodies().map((b) => b.volume)).toEqual([
      expect.closeTo(6000, 3),
      expect.closeTo(48000, 3),
    ]);
    const corners = [doubled.get("low"), doubled.get("high")].map((corner) =>
      (corner as unknown[]).map((v) => Number(untag(v as never))),
    );
    expect(corners[0]!.map((v) => +v.toFixed(6))).toEqual([50, 0, 0]);
    expect(corners[1]!.map((v) => +v.toFixed(6))).toEqual([70, 40, 60]);
    // A face moved through the same uneven matrix stops too.
    const moved = run(
      [
        box,
        'opMoveFace(context, id + "move", { "moveFaces" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), vector(5, 10, 30) * millimeter), "transform" : transform(matrix([[2, 0, 0], [0, 1, 0], [0, 0, 3]]), vector(0, 0, 0) * millimeter) });',
      ].join("\n"),
    );
    expect(moved.fault).toMatch(/scale unevenly.*not supported locally/);
  });
});
describe("review round 6", () => {
  // Walls thicker than half a feature leave its faces no room for their offsets; the shell came
  // back with the feature left solid (a 1.5 mm rib under 2 mm walls: 4962, the shelled block plus
  // the whole rib). Onshape's documentation says nothing of that, so it stops.
  it("stops a shell whose walls don't fit a feature or a gap", () => {
    const rib = (t: number) =>
      run(
        [
          'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
          'fCuboid(context, id + "rib", { "corner1" : vector(5, 14.25, 10) * millimeter, "corner2" : vector(35, 15.75, 20) * millimeter });',
          'opBoolean(context, id + "join", { "operationType" : BooleanOperationType.UNION, "tools" : qUnion([qCreatedBy(id + "box", EntityType.BODY), qCreatedBy(id + "rib", EntityType.BODY)]) });',
          `shell(context, id + "shell", { "entities" : qContainsPoint(qCreatedBy(id + "box", EntityType.FACE), vector(1, 1, 0) * millimeter), "thickness" : ${t} * millimeter });`,
        ].join("\n"),
      );
    expect(rib(2).fault).toMatch(/not supported locally.*feature thinner than two 2 mm walls/);
    // 0.5 mm walls fit: the block's 39 x 29 x 9.5 cavity and the rib's 29 x 0.5 x 10.
    const thin = rib(0.5);
    expect(thin.status, thin.why).toBe("OK");
    expect(thin.bodies()).toMatchObject([{ faces: 21, edges: 48, vertices: 32 }]);
    close(thin.bodies()[0]!.volume, 12000 + 450 - (39 * 29 * 9.5 + 29 * 0.5 * 10));

    // Outward, a 2 mm slot under 1.5 mm walls: the walls' offsets cross inside it.
    const slot = run(
      [
        'fCuboid(context, id + "box", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });',
        'fCuboid(context, id + "slot", { "corner1" : vector(19, -1, 6) * millimeter, "corner2" : vector(21, 31, 11) * millimeter });',
        'opBoolean(context, id + "cut", { "operationType" : BooleanOperationType.SUBTRACTION, "targets" : qCreatedBy(id + "box", EntityType.BODY), "tools" : qCreatedBy(id + "slot", EntityType.BODY) });',
        'shell(context, id + "shell", { "isHollow" : true, "parts" : qCreatedBy(id + "box", EntityType.BODY), "thickness" : 1.5 * millimeter, "oppositeDirection" : true });',
      ].join("\n"),
    );
    expect(slot.fault).toMatch(/not supported locally.*gap narrower than two 1\.5 mm walls/);
  });
});
describe("construction tools", () => {
  // Split part never deletes construction planes it splits with (splitpart.fs: "Split part doesn't
  // delete single faces, construction planes, or mate connectors"), and Onshape's default planes
  // can't be deleted at all, so thicken keeps them too. A plain sheet tool is still deleted.
  const plane =
    'opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });';
  const sheets = record(
    "sheets",
    'size(evaluateQuery(context, qCreatedBy(id + "plane", EntityType.BODY)))',
  );
  it("keeps a construction plane used to split a part", () => {
    const split = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });',
        plane,
        'opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "block", EntityType.BODY), "tool" : qCreatedBy(id + "plane", EntityType.BODY) });',
        sheets,
      ].join("\n"),
    );
    expect(split.status, split.why).toBe("OK");
    expect(split.get("sheets")).toBe(1);
    expect(split.bodies().filter((body) => body.volume > 0)).toHaveLength(2);
  });
  it("keeps a construction plane thickened without keeping tools", () => {
    const thick = run(
      [
        plane,
        'opThicken(context, id + "thicken", { "entities" : qCreatedBy(id + "plane", EntityType.BODY), "thickness1" : 1 * millimeter, "thickness2" : 0 * millimeter, "keepTools" : false });',
        sheets,
      ].join("\n"),
    );
    expect(thick.status, thick.why).toBe("OK");
    expect(thick.get("sheets")).toBe(1);
  });
});

describe("offsets of curved faces", () => {
  // A frustum (radii 5 and 3 mm, 10 mm tall) has a reversed conical face; offsetting it 1 mm out
  // along its outward normal grows each radius by 1 / cos(atan 0.2): pi h / 3 (R^2 + R r + r^2).
  it("offsets a reversed cone face outward", () => {
    const grow = 1 / Math.cos(Math.atan(0.2));
    const [big, small] = [5 + grow, 3 + grow];
    const cone = run(
      [
        'fCone(context, id + "cone", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "bottomRadius" : 5 * millimeter, "topRadius" : 3 * millimeter });',
        'opOffsetFace(context, id + "offset", { "moveFaces" : qGeometry(qCreatedBy(id + "cone", EntityType.FACE), GeometryType.CONE), "offsetDistance" : 1 * millimeter });',
      ].join("\n"),
    );
    expect(cone.status, cone.why).toBe("OK");
    close(cone.bodies()[0]!.volume, (Math.PI * 10 * (big * big + big * small + small * small)) / 3);
  });

  // Offsetting a sphere's only face rebuilt it as the old ball plus a hollow shell around it: two
  // bodies where Onshape makes one bigger sphere. A body that comes back in pieces stops.
  it("stops an edit that leaves a body in pieces", () => {
    const sphere = run(
      [
        'opSphere(context, id + "ball", { "center" : vector(0, 0, 0) * millimeter, "radius" : 5 * millimeter });',
        'opOffsetFace(context, id + "offset", { "moveFaces" : qCreatedBy(id + "ball", EntityType.FACE), "offsetDistance" : 1 * millimeter });',
      ].join("\n"),
    );
    expect([sphere.status, sphere.why]).toEqual([
      "ERROR",
      expect.stringMatching(/not supported locally/),
    ]);
  });
});
