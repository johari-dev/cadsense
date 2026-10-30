import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered } from "../src/geometry/Model.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { untag } from "../src/runtime/Value.ts";

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

  it("qClosestTo finds a curved face from a point on its tessellation, where qContainsPoint can't", () => {
    // A click in the preview lands on a triangle, up to the tessellation's deflection off the exact
    // face. 4.98 mm from the axis is 20 µm inside a 5 mm cylinder wall.
    const faces = "qCreatedBy(id, EntityType.FACE)";
    const near = "vector(4.98, 0, 5) * millimeter";
    const count = (name: string, query: string) =>
      `setVariable(context, "${name}", size(evaluateQuery(context, ${query})));`;
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            'fCylinder(context, id + "cylinder", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
            count("contains", `qContainsPoint(${faces}, ${near})`),
            count("closest", `qClosestTo(${faces}, ${near})`),
            count("wall", `qGeometry(qClosestTo(${faces}, ${near}), GeometryType.CYLINDER)`),
            // On the rim, the wall and the top cap are equally close: both come back.
            count("rim", `qClosestTo(${faces}, vector(5, 0, 10) * millimeter)`),
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]?.status).toBe("OK");
    const variable = (name: string) => run.features[0]!.variables.getField(name);
    expect(variable("contains")).toBe(0);
    expect(variable("closest")).toBe(1);
    expect(variable("wall")).toBe(1);
    expect(variable("rim")).toBe(2);
  });

  it("a feature that faults after modeling leaves no geometry, like one that fails", () => {
    // An unsupported builtin stops the run past std's try, so std's rollback never runs.
    const run = runtime.runFeatures([
      { module: feature(`${cube}\n@opHelix(context, id + "helix", {});`), feature: "test" },
    ]);
    expect(run.features[0]?.status).toBe("ERROR");
    expect(run.features[0]?.fault?.message).toMatch(/opHelix/);
    expect(run.geometry!.entities.size).toBe(0);
  });

  it("filters qEverything by body type, the way std's qBodyType writes it", () => {
    // std folds the body types into the EVERYTHING query itself instead of wrapping it.
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 20) * millimeter, vector(0, 0, 1)) });',
            'skCircle(sketch, "c", { "center" : vector(30, 30) * millimeter, "radius" : 5 * millimeter });',
            "skSolve(sketch);",
            'setVariable(context, "solids", size(evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID))));',
            'setVariable(context, "sheets", size(evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SHEET))));',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]?.status).toBe("OK");
    expect(run.features[0]!.variables.getField("solids")).toBe(1);
    expect(run.features[0]!.variables.getField("sheets")).toBe(1);
  });

  // Fit splines. Ways this goes wrong: the curve misses its points; end derivatives are ignored or
  // land at the wrong end; meters and millimeters mixed; a closed spline left open; fields we can't
  // honor (second derivatives, target length) silently dropped; the result not a wire edge that
  // qCreatedBy finds, or drawn as a surface; too few points crashing instead of a feature error.
  describe("opFitSpline", () => {
    const run = (body: string) => {
      const result = runtime.runFeatures([{ module: feature(body), feature: "test" }]);
      return {
        status: result.features[0]?.status,
        message: result.features[0]?.fault?.message ?? result.features[0]?.message,
        get: (name: string) => result.features[0]!.variables.getField(name),
        result,
      };
    };
    const record = (name: string, expression: string) =>
      `setVariable(context, "${name}", ${expression});`;
    const edge = 'qCreatedBy(id + "spline", EntityType.EDGE)';

    it("interpolates collinear points as the straight line between them, in millimeters", () => {
      const r = run(
        [
          'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(50, 0, 0) * millimeter, vector(100, 0, 0) * millimeter] });',
          record("edges", `size(evaluateQuery(context, ${edge}))`),
          record("length", `evLength(context, { "entities" : ${edge} }) / millimeter`),
          record(
            "wires",
            `size(evaluateQuery(context, qBodyType(qCreatedBy(id + "spline", EntityType.BODY), BodyType.WIRE)))`,
          ),
        ].join("\n"),
      );
      expect(r.status).toBe("OK");
      expect(r.get("edges")).toBe(1);
      expect(r.get("length")).toBeCloseTo(100, 6);
      expect(r.get("wires")).toBe(1);
    });

    it("passes through every point and leaves and arrives along the given derivatives", () => {
      const points =
        "[vector(0, 0, 0) * millimeter, vector(40, 30, 20) * millimeter, vector(100, 0, 60) * millimeter]";
      const r = run(
        [
          `opFitSpline(context, id + "spline", { "points" : ${points}, "startDerivative" : vector(0, 0, 150) * millimeter, "endDerivative" : vector(150, 0, 0) * millimeter });`,
          record(
            "onCurve",
            `size(evaluateQuery(context, qUnion([qContainsPoint(${edge}, vector(0, 0, 0) * millimeter), qContainsPoint(${edge}, vector(40, 30, 20) * millimeter), qContainsPoint(${edge}, vector(100, 0, 60) * millimeter)])))`,
          ),
          record(
            "startZ",
            `evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 0 }).direction[2]`,
          ),
          record(
            "endX",
            `evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 1 }).direction[0]`,
          ),
          record(
            "endAt",
            `norm(evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 1 }).origin - vector(100, 0, 60) * millimeter) / millimeter`,
          ),
        ].join("\n"),
      );
      expect(r.status).toBe("OK");
      // One edge contains all three points.
      expect(r.get("onCurve")).toBe(1);
      expect(r.get("startZ")).toBeCloseTo(1, 6);
      expect(r.get("endX")).toBeCloseTo(1, 6);
      expect(r.get("endAt")).toBeCloseTo(0, 6);
    });

    it("closes when the last point repeats the first", () => {
      const r = run(
        [
          'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(50, 0, 0) * millimeter, vector(50, 50, 0) * millimeter, vector(0, 50, 0) * millimeter, vector(0, 0, 0) * millimeter] });',
          record(
            "gap",
            `norm(evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 0 }).origin - evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 1 }).origin) / millimeter`,
          ),
          record(
            "turn",
            `dot(evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 0 }).direction, evEdgeTangentLine(context, { "edge" : ${edge}, "parameter" : 1 }).direction)`,
          ),
        ].join("\n"),
      );
      expect(r.status).toBe("OK");
      expect(r.get("gap")).toBeCloseTo(0, 6);
      // Periodic, so the tangent is continuous across the seam.
      expect(r.get("turn")).toBeCloseTo(1, 6);
    });

    it("refuses what it can't honor, and reports too few points as the feature's error", () => {
      const second = run(
        'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(1, 1, 0) * millimeter], "startDerivative" : vector(1, 0, 0) * millimeter, "start2ndDerivative" : vector(0, 1, 0) * millimeter });',
      );
      expect(second.status).toBe("ERROR");
      expect(second.message).toMatch(/second derivatives are not supported locally/);
      const length = run(
        'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter, vector(1, 1, 0) * millimeter], "hasTargetLength" : true, "targetLength" : 5 * millimeter });',
      );
      expect(length.message).toMatch(/target length is not supported locally/);
      const one = run(
        'opFitSpline(context, id + "spline", { "points" : [vector(0, 0, 0) * millimeter] });',
      );
      expect(one.status).toBe("ERROR");
      expect(one.result.features[0]?.fault).toBeNull();
    });
  });

  // Mate connectors. Ways this goes wrong: the body isn't a MATE_CONNECTOR, so qBodyType misses it;
  // evMateConnector returns a different frame (axes swapped, scaled); evVertexPoint, which Onshape
  // allows on a connector, fails; the connector draws or counts as a solid.
  it("creates mate connectors that evaluate to their coordinate system and point", () => {
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            'opMateConnector(context, id + "port", { "coordSystem" : coordSystem(vector(5, 5, 10) * millimeter, vector(0, 1, 0), vector(0, 0, 2)), "owner" : qCreatedBy(id + "cube", EntityType.BODY) });',
            'const port = qBodyType(qCreatedBy(id + "port", EntityType.BODY), BodyType.MATE_CONNECTOR);',
            'setVariable(context, "connectors", size(evaluateQuery(context, port)));',
            'const frame = evMateConnector(context, { "mateConnector" : port });',
            'setVariable(context, "origin", norm(frame.origin - vector(5, 5, 10) * millimeter) / millimeter);',
            'setVariable(context, "x", frame.xAxis[1]);',
            'setVariable(context, "z", frame.zAxis[2]);',
            'setVariable(context, "point", norm(evVertexPoint(context, { "vertex" : port }) - vector(5, 5, 10) * millimeter) / millimeter);',
            'setVariable(context, "solids", size(evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID))));',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]?.status).toBe("OK");
    const variable = (name: string) => run.features[0]!.variables.getField(name);
    expect(variable("connectors")).toBe(1);
    expect(variable("origin")).toBeCloseTo(0, 9);
    expect(variable("x")).toBeCloseTo(1, 9);
    expect(variable("z")).toBeCloseTo(1, 9);
    expect(variable("point")).toBeCloseTo(0, 9);
    expect(variable("solids")).toBe(1);
  });

  it("a transformed or patterned mate connector keeps its frame, moved with it", () => {
    // Failure modes: the moved connector loses its frame (evMateConnector fails), loses its id
    // (it has no faces to vote with), keeps the old frame, or moves when only its owner moves.
    // Onshape leaves owned connectors behind when their part moves; they move only when selected.
    const port = 'qBodyType(qCreatedBy(id + "port", EntityType.BODY), BodyType.MATE_CONNECTOR)';
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            'opMateConnector(context, id + "port", { "coordSystem" : coordSystem(vector(5, 5, 10) * millimeter, vector(0, 1, 0), vector(0, 0, 1)), "owner" : qCreatedBy(id + "cube", EntityType.BODY) });',
            `opTransform(context, id + "turn", { "bodies" : ${port}, "transform" : rotationAround(line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), 90 * degree) });`,
            'opTransform(context, id + "lift", { "bodies" : qCreatedBy(id + "cube", EntityType.BODY), "transform" : transform(vector(0, 0, 50) * millimeter) });',
            `const turned = evMateConnector(context, { "mateConnector" : ${port} });`,
            `setVariable(context, "connectors", size(evaluateQuery(context, ${port})));`,
            'setVariable(context, "origin", turned.origin / millimeter);',
            'setVariable(context, "x", turned.xAxis);',
            'setVariable(context, "z", turned.zAxis);',
            `setVariable(context, "point", evVertexPoint(context, { "vertex" : ${port} }) / millimeter);`,
            `opPattern(context, id + "copies", { "entities" : ${port}, "transforms" : [transform(vector(0, 0, 5) * millimeter)], "instanceNames" : ["up"] });`,
            'const copy = qBodyType(qCreatedBy(id + "copies", EntityType.BODY), BodyType.MATE_CONNECTOR);',
            'setVariable(context, "copyOrigin", evMateConnector(context, { "mateConnector" : copy }).origin / millimeter);',
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]?.status, JSON.stringify(run.features[0]?.exceptions)).toBe("OK");
    const vector = (name: string) => {
      const value = untag(run.features[0]!.variables.getField(name)!);
      if (!Array.isArray(value)) throw new Error(`${name} is not a vector`);
      return value.map((n) => Number(untag(n)));
    };
    expect(run.features[0]!.variables.getField("connectors")).toBe(1);
    const close = (actual: number[], expected: number[]) =>
      actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 9));
    close(vector("origin"), [-5, 5, 10]);
    close(vector("x"), [-1, 0, 0]);
    close(vector("z"), [0, 0, 1]);
    close(vector("point"), [-5, 5, 10]);
    close(vector("copyOrigin"), [-5, 5, 15]);
  });
});

describe("panel picks", () => {
  it("finds the faces the preview draws: not sketch regions, construction planes or connectors", () => {
    // The panel's face picks search this query, so a click can land on a base face or one an
    // earlier feature made, and never on a sketch region or plane sitting under it.
    const drawn =
      "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
            'skCircle(sketch, "circle", { "center" : vector(5, 5) * millimeter, "radius" : 2 * millimeter });',
            "skSolve(sketch);",
            'opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });',
            'opMateConnector(context, id + "port", { "coordSystem" : coordSystem(vector(5, 5, 10) * millimeter, vector(1, 0, 0), vector(0, 0, 1)), "owner" : qCreatedBy(id + "cube", EntityType.BODY) });',
            `setVariable(context, "faces", size(evaluateQuery(context, ${drawn})));`,
            `setVariable(context, "top", size(evaluateQuery(context, qClosestTo(${drawn}, vector(5, 5, 10) * millimeter))));`,
          ].join("\n"),
        ),
        feature: "test",
      },
    ]);
    expect(run.features[0]?.status, JSON.stringify(run.features[0]?.exceptions)).toBe("OK");
    expect(run.features[0]!.variables.getField("faces")).toBe(6);
    expect(run.features[0]!.variables.getField("top")).toBe(1);
  });
});

describe("properties", () => {
  it("names a body, and the name follows it through later operations and features", () => {
    // Failure modes: an operation that keeps the body's id drops its properties; one custom
    // property id overwrites another; a failed feature's properties stay; getProperty reads the
    // current context, which Onshape refuses inside custom features, so scripts would pass here
    // and fail there.
    const body = 'qCreatedBy(makeId("Feature1"), EntityType.BODY)';
    const run = runtime.runFeatures([
      {
        module: feature(
          [
            cube,
            `setProperty(context, { "entities" : ${body}, "propertyType" : PropertyType.NAME, "value" : "Motor to Spark MAX" });`,
            `setProperty(context, { "entities" : ${body}, "propertyType" : PropertyType.CUSTOM, "customPropertyId" : "aaaaaaaaaaaaaaaaaaaaaaaa", "value" : "red" });`,
            `setProperty(context, { "entities" : ${body}, "propertyType" : PropertyType.CUSTOM, "customPropertyId" : "bbbbbbbbbbbbbbbbbbbbbbbb", "value" : "18 AWG" });`,
            `opTransform(context, id + "lift", { "bodies" : ${body}, "transform" : transform(vector(0, 0, 5) * millimeter) });`,
          ].join("\n"),
        ),
        feature: "test",
      },
      {
        module: feature(
          `setProperty(context, { "entities" : ${body}, "propertyType" : PropertyType.NAME, "value" : "Renamed" });\nthrow regenError("undo");`,
        ),
        feature: "test",
      },
      {
        module: feature(
          `getProperty(context, { "entity" : ${body}, "propertyType" : PropertyType.NAME });`,
        ),
        feature: "test",
      },
    ]);
    expect(run.features.map((feature) => feature.status)).toEqual(["OK", "ERROR", "ERROR"]);
    const named = ordered(run.geometry!, (entity) => entity.type === "BODY")[0];
    expect(Object.fromEntries(named!.properties)).toEqual({
      NAME: "Motor to Spark MAX",
      "CUSTOM:aaaaaaaaaaaaaaaaaaaaaaaa": "red",
      "CUSTOM:bbbbbbbbbbbbbbbbbbbbbbbb": "18 AWG",
    });
    expect(run.features[2]!.exceptions[0]?.message).toMatch(/getProperty can't read/);
  });
});
