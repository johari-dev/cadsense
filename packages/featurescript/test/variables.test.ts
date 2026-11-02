import { beforeAll, describe, expect, it } from "vite-plus/test";
import { numberVariable, partStudio, solidVolumes, variable } from "./partStudio.ts";

/**
 * std's Variable feature (`assignVariable`) and query variables, end to end.
 *
 * Ways this can fail:
 * - `@getQueryVariable` without a default must throw a catchable error for an unknown name, or the
 *   Variable feature's name check (`verifyVariableName`, in a `try silent`) faults or wrongly fails.
 * - A value of one type comes back as another (a length without units, an angle in degrees).
 * - A later feature can't read the variable, or reads a stale one after a rename or overwrite.
 * - `@getVariable` ignores `defaultValue` and throws for a missing name.
 * - A failed feature's query variables survive its rollback.
 * - Name rules: invalid identifiers, and names shared between query and plain variables, must fail
 *   with std's own error enums rather than pass.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const assign = (parameters: Record<string, string>) => ({
  std: "variable.fs",
  feature: "assignVariable",
  parameters,
});

describe("Variable feature", () => {
  it("assigns each variable type, and later features read them", () => {
    const run = studio.run([
      assign({
        name: '"len"',
        variableType: "VariableType.LENGTH",
        lengthValue: "25 * millimeter",
      }),
      assign({ name: '"ang"', variableType: "VariableType.ANGLE", angleValue: "30 * degree" }),
      assign({ name: '"num"', variableType: "VariableType.NUMBER", numberValue: "7" }),
      assign({
        name: '"any"',
        variableType: "VariableType.ANY",
        anyValue: '[1, "two", { "three" : 3 * inch }]',
        description: '"a mixed array"',
      }),
      {
        body: `
        const len = getVariable(context, "len");
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(len, len, len) });
        setVariable(context, "lenMm", len / millimeter);
        setVariable(context, "angDeg", getVariable(context, "ang") / degree);
        setVariable(context, "angRad", getVariable(context, "ang") / radian);
        setVariable(context, "numPlusOne", getVariable(context, "num") + 1);
        const any = getVariable(context, "any");
        setVariable(context, "anyThreeMm", any[2].three / millimeter);
        setVariable(context, "anyIsArray", any is array && size(any) == 3 && any[1] == "two");
        setVariable(context, "description", getAllVariablesAndDescriptions(context).any.description);`,
      },
    ]);
    expect(run.features.map((feature) => feature.fault?.message ?? feature.status)).toEqual([
      "OK",
      "OK",
      "OK",
      "OK",
      "OK",
    ]);
    expect(numberVariable(run, "lenMm")).toBeCloseTo(25, 9);
    expect(numberVariable(run, "angDeg")).toBeCloseTo(30, 9);
    expect(numberVariable(run, "angRad")).toBeCloseTo(Math.PI / 6, 12);
    expect(numberVariable(run, "numPlusOne")).toBe(8);
    expect(numberVariable(run, "anyThreeMm")).toBeCloseTo(76.2, 9);
    expect(variable(run, "anyIsArray")).toBe(true);
    expect(variable(run, "description")).toBe("a mixed array");
    // 25 mm cube from the length variable.
    expect(solidVolumes(run)).toHaveLength(1);
    expect(solidVolumes(run)[0]).toBeCloseTo(15625, 6);
  });

  it("overwrites a variable assigned again under the same name", () => {
    const run = studio.run([
      assign({ name: '"n"', variableType: "VariableType.NUMBER", numberValue: "1" }),
      assign({ name: '"n"', variableType: "VariableType.NUMBER", numberValue: "2" }),
      { body: 'setVariable(context, "read", getVariable(context, "n"));' },
    ]);
    expect(run.features.map((feature) => feature.status)).toEqual(["OK", "OK", "OK"]);
    expect(numberVariable(run, "read")).toBe(2);
  });

  it("rejects names that aren't identifiers with VARIABLE_NAME_INVALID", () => {
    for (const name of ['"1abc"', '"has space"', '""']) {
      const run = studio.run([
        assign({ name, variableType: "VariableType.NUMBER", numberValue: "1" }),
      ]);
      expect(run.features[0], name).toMatchObject({
        status: "ERROR",
        statusEnum: "VARIABLE_NAME_INVALID",
        fault: null,
      });
      expect(run.features[0]!.variables.size, name).toBe(0);
    }
  });

  it("warns VARIABLE_CANNOT_EVALUATE when an Any variable has no value", () => {
    const run = studio.run([assign({ name: '"empty"', variableType: "VariableType.ANY" })]);
    expect(run.features[0]).toMatchObject({
      status: "WARNING",
      statusEnum: "VARIABLE_CANNOT_EVALUATE",
      fault: null,
    });
  });

  it("measures lengths and diameters", () => {
    const run = studio.run([
      {
        body: 'fCylinder(context, id + "pin", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 30) * millimeter, "radius" : 4 * millimeter });',
      },
      assign({
        name: '"rim"',
        mode: "VariableMode.MEASURED",
        measurementMode: "VariableMeasurementMode.LENGTH",
        lengthEntities:
          'qGeometry(qCreatedBy(makeId("Feature1"), EntityType.EDGE), GeometryType.CIRCLE)',
      }),
      assign({
        name: '"bore"',
        mode: "VariableMode.MEASURED",
        measurementMode: "VariableMeasurementMode.DIAMETER",
        diameterEntity:
          'qGeometry(qCreatedBy(makeId("Feature1"), EntityType.FACE), GeometryType.CYLINDER)',
      }),
      {
        body: `
        setVariable(context, "rimMm", getVariable(context, "rim") / millimeter);
        setVariable(context, "boreMm", getVariable(context, "bore") / millimeter);`,
      },
    ]);
    expect(run.features.map((feature) => feature.fault?.message ?? feature.status)).toEqual([
      "OK",
      "OK",
      "OK",
      "OK",
    ]);
    // Two rims of a 4 mm radius pin: 2 * 2 PI r.
    expect(numberVariable(run, "rimMm")).toBeCloseTo(16 * Math.PI, 6);
    expect(numberVariable(run, "boreMm")).toBeCloseTo(8, 9);
  });

  it("measures the distance between two faces", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(25, 0, 0) * millimeter, "corner2" : vector(35, 10, 10) * millimeter });`,
      },
      assign({
        name: '"gap"',
        mode: "VariableMode.MEASURED",
        measurementMode: "VariableMeasurementMode.DISTANCE",
        entityCouple:
          'qUnion([qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(10, 5, 5) * millimeter), qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(25, 5, 5) * millimeter)])',
      }),
      { body: 'setVariable(context, "gapMm", getVariable(context, "gap") / millimeter);' },
    ]);
    expect(run.features.map((feature) => feature.fault?.message ?? feature.status)).toEqual([
      "OK",
      "OK",
      "OK",
    ]);
    expect(numberVariable(run, "gapMm")).toBeCloseTo(15, 9);
  });
});

describe("query variables", () => {
  const cube =
    'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
  const top = "qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 5, 10) * millimeter)";

  it("store a query that a later feature evaluates", () => {
    const run = studio.run([
      { body: `${cube}\nsetQueryVariable(context, "top", ${top});` },
      {
        body: `
        setVariable(context, "top", size(evaluateQuery(context, getQueryVariable(context, "top"))));
        setVariable(context, "topZ", evPlane(context, { "face" : getQueryVariable(context, "top") }).origin[2] / millimeter);
        setVariable(context, "missing", size(evaluateQuery(context, getQueryVariable(context, "missing"))));`,
      },
    ]);
    expect(run.features.map((feature) => feature.fault?.message ?? feature.status)).toEqual([
      "OK",
      "OK",
    ]);
    expect(numberVariable(run, "top")).toBe(1);
    expect(numberVariable(run, "topZ")).toBeCloseTo(10, 9);
    // std's getQueryVariable defaults to qNothing().
    expect(numberVariable(run, "missing")).toBe(0);
  });

  it("raise a catchable error for a missing name without a default", () => {
    const run = studio.run([
      {
        body: `
        var caught;
        try silent { @getQueryVariable(context, { "name" : "nope" }); }
        catch (error) { caught = error; }
        setVariable(context, "caught", caught);
        setVariable(context, "fallback", getVariable(context, "nope", 42));`,
      },
    ]);
    expect(run.features[0]).toMatchObject({ status: "OK", fault: null });
    expect(variable(run, "caught")).toBe('Query variable "nope" not found.');
    expect(numberVariable(run, "fallback")).toBe(42);
  });

  it("are rolled back with a failed feature", () => {
    const run = studio.run([
      { body: `${cube}\nsetQueryVariable(context, "top", ${top});\nthrow regenError("undo");` },
      {
        body: 'setVariable(context, "top", size(evaluateQuery(context, getQueryVariable(context, "top"))));',
      },
    ]);
    expect(run.features.map((feature) => feature.status)).toEqual(["ERROR", "OK"]);
    expect(numberVariable(run, "top")).toBe(0);
  });

  it("can't share a name with a plain variable, in either order", () => {
    const queryFirst = studio.run([
      { body: `${cube}\nsetQueryVariable(context, "shared", ${top});` },
      assign({ name: '"shared"', variableType: "VariableType.NUMBER", numberValue: "1" }),
    ]);
    expect(queryFirst.features[1]).toMatchObject({
      status: "ERROR",
      statusEnum: "VARIABLE_NAME_ALREADY_USED_IN_QUERY_VARIABLE",
      fault: null,
    });

    const plainFirst = studio.run([
      assign({ name: '"shared"', variableType: "VariableType.NUMBER", numberValue: "1" }),
      {
        std: "queryVariable.fs",
        feature: "queryVariable",
        parameters: {
          name: '"shared"',
          selectionType: "SelectionType.SELECTION",
          selectionQuery: "qEverything(EntityType.BODY)",
          evaluateOnUse: "true",
        },
      },
    ]);
    expect(plainFirst.features[1]).toMatchObject({
      status: "ERROR",
      statusEnum: "QUERY_VARIABLE_NAME_ALREADY_USED_IN_NON_QUERY_VARIABLE",
      fault: null,
    });
  });

  it("are set by std's Query variable feature, evaluated on use", () => {
    const run = studio.run([
      { body: cube },
      {
        std: "queryVariable.fs",
        feature: "queryVariable",
        parameters: {
          name: '"bodies"',
          selectionType: "SelectionType.SELECTION",
          // Solids only: a context may start with construction bodies (std's default planes).
          selectionQuery: "qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)",
          evaluateOnUse: "true",
        },
      },
      { body: cube },
      {
        body: 'setVariable(context, "bodies", size(evaluateQuery(context, getQueryVariable(context, "bodies"))));',
      },
    ]);
    expect(run.features.map((feature) => feature.fault?.message ?? feature.status)).toEqual([
      "OK",
      "OK",
      "OK",
      "OK",
    ]);
    // Evaluated on use, the query sees the cube made after it too.
    expect(numberVariable(run, "bodies")).toBe(2);
  });
});
