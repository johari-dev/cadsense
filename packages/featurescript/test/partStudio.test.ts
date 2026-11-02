// @effect-diagnostics nodeBuiltinImport:off - reads the corpus STEP base.
import * as NodeFS from "node:fs";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { runPreview } from "../src/preview/Preview.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { untag, type FsMap } from "../src/runtime/Value.ts";

/**
 * The context every feature runs in, the way an Onshape Part Studio builds it (std's
 * `definePartStudio`): default features first, then the base and the features.
 *
 * Default features can go wrong by: missing, so `qCreatedBy(makeId("Top"), EntityType.FACE)` finds
 * nothing; the wrong ids, normals or x directions (Front's normal is -Y, not +Y); the wrong size
 * (std sizes them from `PLANE_SIZE_BOUNDS`, 0.15 m for metric units); not construction, so face
 * picks, `qConstructionFilter` and the preview treat them as surfaces; counted as solids or drawn,
 * changing the preview's solids, volumes and amber faces; created after the base or the features,
 * so creation order (and `qNthElement`) shifts and base bodies lose their place; undone by a later
 * feature's rollback; or failing a runtime that has no geometry kernel.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const feature = (body: string) =>
  runtime.load(
    `test/partStudio${counter++}.fs`,
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

const run = (body: string, options: Parameters<FeatureScriptRuntime["runFeatures"]>[1] = {}) => {
  const result = runtime.runFeatures([{ module: feature(body), feature: "test" }], options);
  const first = result.features[0]!;
  expect(first.status, first.fault?.message ?? JSON.stringify(first.exceptions)).toBe("OK");
  return { result, variables: first.variables };
};
const numbers = (variables: FsMap, name: string) => {
  const value = untag(variables.getField(name));
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
  return value.map((item) => Number(untag(item)));
};
const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((n, i) => expect(n, `[${i}]`).toBeCloseTo(expected[i]!, 9));
};
const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';

describe("default features", () => {
  it("creates the Origin and the Top, Front and Right planes with Onshape's ids", () => {
    const { variables } = run(
      [
        'for (var name in ["Top", "Front", "Right"])',
        "{",
        "    const face = qCreatedBy(makeId(name), EntityType.FACE);",
        '    setVariable(context, name ~ "Faces", size(evaluateQuery(context, face)));',
        '    const plane = evPlane(context, { "face" : face });',
        '    setVariable(context, name ~ "Normal", plane.normal);',
        '    setVariable(context, name ~ "X", plane.x);',
        '    setVariable(context, name ~ "Origin", plane.origin / millimeter);',
        '    setVariable(context, name ~ "Area", evArea(context, { "entities" : face }) / millimeter ^ 2);',
        "}",
        'setVariable(context, "origins", size(evaluateQuery(context, qOrigin(EntityType.VERTEX))));',
        'setVariable(context, "originPoint", evVertexPoint(context, { "vertex" : qOrigin(EntityType.VERTEX) }) / millimeter);',
        'setVariable(context, "construction", size(evaluateQuery(context, qConstructionFilter(qDefaultBodies(), ConstructionObject.YES))));',
        'setVariable(context, "sheets", size(evaluateQuery(context, qBodyType(qDefaultBodies(), BodyType.SHEET))));',
        'setVariable(context, "points", size(evaluateQuery(context, qBodyType(qOrigin(EntityType.BODY), BodyType.POINT))));',
        'setVariable(context, "solids", size(evaluateQuery(context, qAllSolidBodies())));',
      ].join("\n"),
    );
    for (const name of ["Top", "Front", "Right"]) {
      expect(variables.getField(`${name}Faces`), name).toBe(1);
      close(numbers(variables, `${name}Origin`), [0, 0, 0]);
      // PLANE_SIZE_BOUNDS[meter][1]: a 0.15 m square.
      expect(Number(untag(variables.getField(`${name}Area`))), name).toBeCloseTo(150 * 150, 6);
    }
    // defaultFeatures.fs: Top is XY, Front is XZ seen from -Y, Right is YZ.
    close(numbers(variables, "TopNormal"), [0, 0, 1]);
    close(numbers(variables, "TopX"), [1, 0, 0]);
    close(numbers(variables, "FrontNormal"), [0, -1, 0]);
    close(numbers(variables, "FrontX"), [1, 0, 0]);
    close(numbers(variables, "RightNormal"), [1, 0, 0]);
    close(numbers(variables, "RightX"), [0, 1, 0]);
    expect(variables.getField("origins")).toBe(1);
    close(numbers(variables, "originPoint"), [0, 0, 0]);
    expect(variables.getField("construction")).toBe(4);
    expect(variables.getField("sheets")).toBe(3);
    expect(variables.getField("points")).toBe(1);
    expect(variables.getField("solids")).toBe(0);
  });

  it("sketches on the default planes' own coordinate systems", () => {
    // A 10 x 20 mm rectangle at sketch (0, 0)-(10, 20), extruded 5 mm along each plane's normal.
    // Sketch y is normal x x: Top +Y, Front +Z, Right +Z.
    const extrudeOn = (plane: string) =>
      [
        `const ${plane}Plane = evPlane(context, { "face" : qCreatedBy(makeId("${plane}"), EntityType.FACE) });`,
        `const ${plane}Sketch = newSketchOnPlane(context, id + "${plane}Sketch", { "sketchPlane" : ${plane}Plane });`,
        `skRectangle(${plane}Sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 20) * millimeter });`,
        `skSolve(${plane}Sketch);`,
        `opExtrude(context, id + "${plane}Extrude", { "entities" : qSketchRegion(id + "${plane}Sketch"), "direction" : ${plane}Plane.normal, "endBound" : BoundingType.BLIND, "endDepth" : 5 * millimeter });`,
        `const ${plane}Box = evBox3d(context, { "topology" : qCreatedBy(id + "${plane}Extrude", EntityType.BODY) });`,
        `setVariable(context, "${plane}Min", ${plane}Box.minCorner / millimeter);`,
        `setVariable(context, "${plane}Max", ${plane}Box.maxCorner / millimeter);`,
        `setVariable(context, "${plane}Volume", evVolume(context, { "entities" : qCreatedBy(id + "${plane}Extrude", EntityType.BODY) }) / millimeter ^ 3);`,
      ].join("\n");
    const { variables } = run(["Top", "Front", "Right"].map(extrudeOn).join("\n"));
    close(numbers(variables, "TopMin"), [0, 0, 0]);
    close(numbers(variables, "TopMax"), [10, 20, 5]);
    close(numbers(variables, "FrontMin"), [0, -5, 0]);
    close(numbers(variables, "FrontMax"), [10, 0, 20]);
    close(numbers(variables, "RightMin"), [0, 0, 0]);
    close(numbers(variables, "RightMax"), [5, 10, 20]);
    for (const plane of ["Top", "Front", "Right"])
      expect(Number(variables.getField(`${plane}Volume`)), plane).toBeCloseTo(1000, 6);
  });

  it("take std's newSketch, which realigns the plane canonically, and so do faces facing the same way", () => {
    // newSketch passes the face's plane through alignCanonically and moves its origin to the
    // projection of the world origin. A sketch on Top, Front or Right has the plane's own axes in
    // Onshape; so does a cube's top face (normal +Z), whose sketch origin is (0, 0, 10) mm.
    // Failure modes: the call faults; the x axis comes from the input plane or from
    // perpendicularVector (which gives Front -Z); the origin stays at the face's centroid.
    const sketchOn = (name: string, face: string) =>
      [
        `const ${name}Plane = evPlane(context, { "face" : ${face} });`,
        `const ${name}Sketch = newSketch(context, id + "${name}Sketch", { "sketchPlane" : ${face} });`,
        `skRectangle(${name}Sketch, "r", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(10, 20) * millimeter });`,
        `skSolve(${name}Sketch);`,
        `opExtrude(context, id + "${name}Extrude", { "entities" : qSketchRegion(id + "${name}Sketch"), "direction" : ${name}Plane.normal, "endBound" : BoundingType.BLIND, "endDepth" : 5 * millimeter });`,
        `const ${name}Box = evBox3d(context, { "topology" : qCreatedBy(id + "${name}Extrude", EntityType.BODY) });`,
        `setVariable(context, "${name}Min", ${name}Box.minCorner / millimeter);`,
        `setVariable(context, "${name}Max", ${name}Box.maxCorner / millimeter);`,
      ].join("\n");
    const { variables } = run(
      [
        'fCuboid(context, id + "cube", { "corner1" : vector(-50, -50, 0) * millimeter, "corner2" : vector(-40, -40, 10) * millimeter });',
        ...["Top", "Front", "Right"].map((plane) =>
          sketchOn(plane, `qCreatedBy(makeId("${plane}"), EntityType.FACE)`),
        ),
        sketchOn(
          "face",
          'qContainsPoint(qCreatedBy(id + "cube", EntityType.FACE), vector(-45, -45, 10) * millimeter)',
        ),
      ].join("\n"),
    );
    close(numbers(variables, "TopMin"), [0, 0, 0]);
    close(numbers(variables, "TopMax"), [10, 20, 5]);
    close(numbers(variables, "FrontMin"), [0, -5, 0]);
    close(numbers(variables, "FrontMax"), [10, 0, 20]);
    close(numbers(variables, "RightMin"), [0, 0, 0]);
    close(numbers(variables, "RightMax"), [5, 10, 20]);
    close(numbers(variables, "faceMin"), [0, 0, 10]);
    close(numbers(variables, "faceMax"), [10, 20, 15]);
  });

  it("stops a sketch on a face whose canonical axes aren't known locally", () => {
    // A cube's bottom face faces -Z. Onshape doesn't document which x axis it gets.
    const result = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            'newSketch(context, id + "sketch", { "sketchPlane" : qContainsPoint(qCreatedBy(id + "cube", EntityType.FACE), vector(5, 5, 0) * millimeter) });',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(result.features[0]?.status).toBe("ERROR");
    expect(result.features[0]?.fault?.message).toMatch(/alignCanonically.*\(0, 0, -1\)/);
  });

  it("aren't solids, don't change volumes, and aren't drawn or picked", () => {
    const module = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Cube" }
export const cube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        ${cube}
    });
`;
    const result = runPreview(runtime, [{ path: "partStudioCube.fs", source: module }]);
    expect(result.solids.map((solid) => Math.round(solid.volumeMm3))).toEqual([1000]);
    expect(result.meshes.length).toBe(1);
    expect(result.changes).toEqual({ volumeMm3: expect.closeTo(1000, 6), createdFaces: 6 });

    // The panel's face picks: the nearest drawn face to a point on the Top plane is the cube's.
    const { variables } = run(
      [
        cube,
        "const drawn = qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO);",
        'setVariable(context, "drawn", size(evaluateQuery(context, drawn)));',
        'setVariable(context, "faces", size(evaluateQuery(context, qEverything(EntityType.FACE))));',
      ].join("\n"),
    );
    expect(variables.getField("drawn")).toBe(6);
    expect(variables.getField("faces")).toBe(9);
  });

  it("come first, before the base and the features, in std's order", () => {
    const base = NodeFS.readFileSync(new URL("../corpus/bolt-circle/plate.step", import.meta.url));
    const { result, variables } = run(
      [
        cube,
        "const bodies = evaluateQuery(context, qEverything(EntityType.BODY));",
        'setVariable(context, "bodies", size(bodies));',
        "for (var i = 0; i < 4; i += 1)",
        '    setVariable(context, "body" ~ i, size(evaluateQuery(context, qIntersection([bodies[i], qDefaultBodies()]))));',
        'setVariable(context, "origin", size(evaluateQuery(context, qIntersection([bodies[0], qOrigin(EntityType.BODY)]))));',
        'setVariable(context, "front", size(evaluateQuery(context, qIntersection([bodies[1], qFrontPlane(EntityType.BODY)]))));',
        'setVariable(context, "top", size(evaluateQuery(context, qIntersection([bodies[2], qTopPlane(EntityType.BODY)]))));',
        'setVariable(context, "right", size(evaluateQuery(context, qIntersection([bodies[3], qRightPlane(EntityType.BODY)]))));',
        'setVariable(context, "base", size(evaluateQuery(context, qIntersection([bodies[4], qCreatedBy(makeId("Base"), EntityType.BODY)]))));',
        'setVariable(context, "cube", size(evaluateQuery(context, qIntersection([bodies[5], qCreatedBy(id + "cube", EntityType.BODY)]))));',
      ].join("\n"),
      { base },
    );
    expect(variables.getField("bodies")).toBe(6);
    for (const name of ["body0", "body1", "body2", "body3", "origin", "front", "top", "right"])
      expect(variables.getField(name), name).toBe(1);
    expect(variables.getField("base")).toBe(1);
    expect(variables.getField("cube")).toBe(1);
    // The base plate is still the first solid.
    const [plate] = ordered(
      result.geometry!,
      (entity) => entity.type === "BODY" && entity.bodyType === "SOLID",
    );
    expect(plate?.createdBy).toEqual(["Base"]);
  });

  it("survive a later feature that deletes them and fails", () => {
    const failing = feature(
      'opDeleteBodies(context, id + "delete", { "entities" : qDefaultBodies() });\nthrow regenError("undo");',
    );
    const counting = feature(
      'setVariable(context, "defaults", size(evaluateQuery(context, qDefaultBodies())));',
    );
    const result = runtime.runFeatures([
      { module: failing, feature: "test" },
      { module: counting, feature: "test" },
    ]);
    expect(result.features.map((f) => f.status)).toEqual(["ERROR", "OK"]);
    expect(result.features[1]!.variables.getField("defaults")).toBe(4);
  });

  it("are skipped by a runtime without a geometry kernel", () => {
    const plain = new FeatureScriptRuntime();
    const module = plain.load(
      "test/partStudioPlain.fs",
      `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "answer", 42);
    });
`,
    );
    const outcome = plain.runFeature(module, "test");
    expect(outcome.status).toBe("OK");
    expect(outcome.variables.getField("answer")).toBe(42);
  });
});

/**
 * Script versions. Like a new Onshape Part Studio, every context runs at std's current version,
 * whatever `FeatureScript N;` header a script declares: the header is the module's language
 * version, and only a feature Onshape holds back (`asVersion`) runs std's older branches. Ways this
 * goes wrong: a module's header lowers the context's version, so std's `isAtVersionOrLater` gates
 * take old branches (a 680 header rejects 400 degrees, which current std wraps to 40); a later
 * old-header feature changes an earlier modern one in the same run; an old-header script stops
 * running.
 */
describe("script versions", () => {
  const versioned = (version: number) =>
    runtime.load(
      `test/version${counter++}.fs`,
      `FeatureScript ${version};
import(path : "onshape/std/geometry.fs", version : "${version}.0");
annotation { "Feature Type Name" : "Versioned" }
export const versioned = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "version", getCurrentVersion(context));
        // std's adjustAngle wraps 400 degrees to 40 from V681_ANGLE_BOUNDS_CHANGE on; before, it's out of range.
        setVariable(context, "angle", round(adjustAngle(context, 400 * degree) / degree));
        ${cube}
    });
`,
    );
  const runAt = (...versions: number[]) =>
    runtime
      .runFeatures(
        versions.map((version) => ({ module: versioned(version), feature: "versioned" })),
      )
      .features.map((feature) => ({
        status: feature.status,
        version: untag(feature.variables.getField("version")),
        angle: feature.variables.getField("angle"),
      }));
  const current = { status: "OK", version: "V3095_LARGE_INTEGER_LITERALS", angle: 40 };

  it("runs every feature at std's current version, whatever its header declares", () => {
    for (const version of [3095, 3083, 1560, 680, 9999])
      expect(runAt(version), String(version)).toEqual([current]);
  });

  it("runs a modern feature the same when an old-header feature follows it", () => {
    expect(runAt(3095, 680)).toEqual([current, current]);
  });
});
