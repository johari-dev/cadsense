import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";

/** Geometry behavior that the corpus doesn't pin down on its own. */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const feature = (body: string) =>
  runtime.load(
    `test/geometry${counter++}.fs`,
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
const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
const solids = (run: ReturnType<FeatureScriptRuntime["runFeatures"]>) =>
  ordered(run.geometry!, (entity) => entity.type === "BODY" && entity.bodyType === "SOLID").length;

describe("geometry", () => {
  it("a feature that fails after modeling leaves no geometry (failure mode 17)", () => {
    const run = runtime.runFeatures([
      { module: feature(`${cube}\nthrow regenError("after modeling");`), feature: "test" },
    ]);
    expect(run.features[0]).toMatchObject({ status: "ERROR", message: "after modeling" });
    expect(run.geometry!.entities.size).toBe(0);
  });

  it("an earlier feature's geometry survives a later feature's failure", () => {
    const run = runtime.runFeatures([
      { module: feature(cube), feature: "test" },
      {
        module: feature(
          'opDeleteBodies(context, id + "delete", { "entities" : qEverything(EntityType.BODY) });\nthrow regenError("undo me");',
        ),
        feature: "test",
      },
    ]);
    expect(run.features.map((f) => f.status)).toEqual(["OK", "ERROR"]);
    expect(solids(run)).toBe(1);
  });

  it("queries resolve to transient ids that later features can use", () => {
    const run = runtime.runFeatures([
      {
        module: feature(
          `${cube}\nconst top = evaluateQuery(context, qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 5, 10) * millimeter));\nsetVariable(context, "top", transientQueriesToStrings(top[0]));\nsetVariable(context, "faces", size(evaluateQuery(context, qCreatedBy(id, EntityType.FACE))));`,
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]!.status).toBe("OK");
    expect(run.features[0]!.variables.getField("faces")).toBe(6);
    expect(
      run.geometry!.entities.get(String(run.features[0]!.variables.getField("top")))?.type,
    ).toBe("FACE");
  });
});

describe("base models", () => {
  it("runs a feature on a STEP base, as if on the synced Onshape model", async () => {
    const { writeStep } = await import("../src/geometry/Step.ts");
    const plateRun = runtime.runFeatures([
      {
        module: feature(
          'fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });',
        ),
        feature: "test",
      },
    ]);
    const oc = plateRun.oc!;
    const base = writeStep(
      oc,
      ordered(plateRun.geometry!, (entity) => entity.type === "BODY").map((body) => body.shape),
    );

    const cut = feature(
      'const top = qContainsPoint(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter);\n' +
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : evPlane(context, { "face" : top }) });\n' +
        'skCircle(sketch, "hole", { "center" : vector(0, 0) * millimeter, "radius" : 5 * millimeter });\n' +
        "skSolve(sketch);\n" +
        'extrude(context, id + "cut", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.THROUGH_ALL, "oppositeDirection" : true, "operationType" : NewBodyOperationType.REMOVE, "defaultScope" : false, "booleanScope" : qCreatedBy(makeId("Base"), EntityType.BODY) });',
    );
    const run = runtime.runFeatures([{ module: cut, feature: "test" }], { base });
    expect(run.features[0]).toMatchObject({ status: "OK", fault: null });
    const [plate] = ordered(
      run.geometry!,
      (entity) => entity.type === "BODY" && entity.bodyType === "SOLID",
    );
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(plate!.shape, props, false, false, false);
    expect(props.Mass() * 1e9).toBeCloseTo(60000 - Math.PI * 25 * 10, 3);
    expect(plate!.createdBy).toEqual(["Base"]);
  });
});
