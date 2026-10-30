// @effect-diagnostics nodeBuiltinImport:off - decodes the preview PNGs with Node's zlib.
import { beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeZlib from "node:zlib";
import { toGlb } from "../src/geometry/Glb.ts";
import { renderPng } from "../src/preview/Render.ts";
import { variableReferences } from "../src/preview/Dialog.ts";
import { dialogInputs, type DialogInput } from "../src/preview/Inputs.ts";
import { featureFailure, featureNotice, formatInput, runPreview } from "../src/preview/Preview.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { FsMap, untag, type FsValue } from "../src/runtime/Value.ts";

/**
 * The file panel's Onshape-style dialog, run through the real runtime: what a feature reports
 * besides OK and ERROR, which inputs it blames, what it marks in red, and the functions Onshape's
 * dialog calls around a feature (editing logic, manipulator changes).
 */
let runtime: FeatureScriptRuntime;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

/** A feature with a length, a count and a list input, whose body is `body`. */
const feature = (body: string, extra = "") => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Panel test"${extra} }
export const panelTest = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Size" }
        isLength(definition.size, { (millimeter) : [1, 10, 100] } as LengthBoundSpec);
        annotation { "Name" : "Count" }
        isInteger(definition.count, { (unitless) : [1, 2, 10] } as IntegerBoundSpec);
        annotation { "Name" : "Waypoints", "Item name" : "Waypoint" }
        definition.waypoints is array;
        for (var waypoint in definition.waypoints)
        {
            annotation { "Name" : "Height" }
            isLength(waypoint.height, ZERO_DEFAULT_LENGTH_BOUNDS);
        }
    }
    {
        ${body}
    });
`;
const cube =
  'fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(1, 1, 1) * definition.size });';
const run = (body: string, parameters: Record<string, string> = {}) =>
  runPreview(runtime, [{ path: "panel.fs", source: feature(body), parameters }]);

describe("notices: INFO and WARNING statuses", () => {
  // Failure modes: an INFO or WARNING reads as OK with nothing to show; a custom message is lost
  // and only CUSTOM_ERROR shows; an ErrorStringEnum status has no text at all; an ERROR or an OK
  // feature gets a notice too; the feature's geometry is dropped as if it had failed.
  it("reports a custom INFO message, and keeps what the feature built", () => {
    const result = run(
      `${cube}\n        reportFeatureInfo(context, id, "Add at least two waypoints to build the wire.");`,
    );
    const ran = result.features[0]!.run!;
    expect(ran.status).toBe("INFO");
    expect(featureNotice(ran)).toEqual({
      status: "INFO",
      message: "Add at least two waypoints to build the wire.",
    });
    expect(result.features[0]!.notice).toEqual(featureNotice(ran));
    // 10 mm cube: an INFO doesn't roll the feature back.
    expect(result.solids.map((solid) => Math.round(solid.volumeMm3))).toEqual([1000]);
  });

  it("reports a WARNING by its ErrorStringEnum member when it has no message", () => {
    const ran = run(
      `${cube}\n        reportFeatureWarning(context, id, ErrorStringEnum.EXTRUDE_NO_DIRECTION);`,
    ).features[0]!.run!;
    expect(ran.status).toBe("WARNING");
    expect(featureNotice(ran)).toEqual({ status: "WARNING", message: "EXTRUDE_NO_DIRECTION" });
  });

  it("gives OK and ERROR features no notice", () => {
    expect(featureNotice(run(cube).features[0]!.run)).toBeNull();
    expect(featureNotice(run('throw regenError("Broken");').features[0]!.run)).toBeNull();
    expect(featureNotice(null)).toBeNull();
  });
});

describe("faulty parameters", () => {
  // Failure modes: the names a regenError or a warning blames are dropped; a list item's inner
  // input (`waypoints[1].height`, std's faultyArrayParameterId) marks the whole list, the wrong
  // item, or nothing; an OK feature, or a failure that names nothing, marks rows anyway.
  const dialog = (body: string, parameters: Record<string, string> = {}) => {
    const result = run(body, parameters);
    const step = result.features[0]!;
    return {
      run: step.run!,
      rows: dialogInputs(runtime, step.module, step.spec, step.definition, {
        faulty: step.run!.faultyParameters,
      }),
    };
  };
  const faulty = (rows: readonly DialogInput[]) =>
    rows.flatMap((row) => [
      ...(row.faulty ? [row.id] : []),
      ...row.items.flatMap((item, i) =>
        item.filter((inner) => inner.faulty).map((inner) => `${row.id}[${i}].${inner.id}`),
      ),
    ]);

  it("marks the inputs a regenError names", () => {
    const { run: ran, rows } = dialog(
      'throw regenError("Add at least two waypoints", ["waypoints"]);',
    );
    expect(ran.faultyParameters).toEqual(["waypoints"]);
    expect(faulty(rows)).toEqual(["waypoints"]);
    const byEnum = dialog(
      'throw regenError(ErrorStringEnum.CANNOT_RESOLVE_ENTITIES, ["size", "count"]);',
    );
    expect(faulty(byEnum.rows)).toEqual(["size", "count"]);
  });

  it("marks one list item's inner input, by std's array parameter id", () => {
    const { rows } = dialog(
      'throw regenError("Waypoint 2 is too low", [faultyArrayParameterId("waypoints", 1, "height")]);',
      { waypoints: '[{}, { "height" : 2 * millimeter }]' },
    );
    expect(faulty(rows)).toEqual(["waypoints[1].height"]);
  });

  it("marks the inputs a warning names, and nothing for OK or an unnamed failure", () => {
    const warned = dialog(
      `${cube}\n        reportFeatureWarning(context, id, "Count is high", ["count"]);`,
    );
    expect(warned.run.status).toBe("WARNING");
    expect(faulty(warned.rows)).toEqual(["count"]);
    expect(dialog(cube).run.faultyParameters).toEqual([]);
    expect(faulty(dialog('throw regenError("Nothing named");').rows)).toEqual([]);
  });
});

describe("error entities", () => {
  // Failure modes: setErrorEntities and regenError's entities do nothing; entities are evaluated
  // after the rollback, so ones the failed feature made are gone; a subfeature's error display
  // isn't carried up by transferSubfeatureErrorDisplay; faces that are still in the model are
  // drawn twice (coplanar red over grey) instead of recolored; an edge or vertex isn't drawn at
  // all; the red material is missing from the GLB; an OK feature draws red; a gone body's red
  // faces have no edges drawn on them.
  const block = (corner: string) =>
    `fCuboid(context, id + "${corner}", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });`;
  const materials = (result: ReturnType<typeof run>) =>
    result.meshes.flatMap((mesh) => mesh.groups.map((group) => group.material));
  const triangleCount = (result: ReturnType<typeof run>, material: number) =>
    result.meshes
      .flatMap((mesh) => mesh.groups)
      .filter((group) => group.material === material)
      .reduce((sum, group) => sum + group.indices.length / 3, 0);

  it("records what a regenError names before the rollback, and draws the gone body in red", () => {
    const result = run(
      `${block("tool")}\n        throw regenError("Tool hits the plate", ["size"], qCreatedBy(id + "tool", EntityType.BODY));`,
    );
    const ran = result.features[0]!.run!;
    expect(ran.status).toBe("ERROR");
    expect(ran.errorEntities.map((entity) => entity.type)).toEqual(["BODY"]);
    expect(result.errorEntities).toBe(1);
    // Rolled back: no solids remain, but the cube that failed is drawn in the error material.
    expect(result.solids).toEqual([]);
    expect(materials(result)).toEqual([2]);
    // A box face is two triangles.
    expect(triangleCount(result, 2)).toBe(12);
  });

  it("outlines a gone body's edges on its red faces, as the model's are", () => {
    // Failure mode: the red cube is drawn with no edges, where the model draws every body's.
    const result = run(
      `${block("tool")}\n        throw regenError("Tool hits the plate", qCreatedBy(id + "tool", EntityType.BODY));`,
    );
    const overlay = result.meshes.find((mesh) => mesh.overlay)!;
    // A 10 mm cube's 12 straight edges, one segment each.
    const edges = overlay.outline!.edges;
    expect(edges).toHaveLength(12 * 6);
    for (let i = 0; i < edges.length; i += 6)
      expect(
        Math.hypot(
          edges[i + 3]! - edges[i]!,
          edges[i + 4]! - edges[i + 1]!,
          edges[i + 5]! - edges[i + 2]!,
        ),
      ).toBeCloseTo(0.01, 9);
    // In the outline material, as the model's bodies' are.
    const glb = toGlb(result.meshes);
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
    );
    expect(
      json.meshes.map((mesh: { primitives: { mode?: number; material: number }[] }) =>
        mesh.primitives.map((p) => [p.mode ?? 4, p.material]),
      ),
    ).toEqual([
      [
        [4, 2],
        [1, 3],
      ],
    ]);
  });

  it("recolors faces that are still in the model instead of drawing them twice", () => {
    const result = run(
      `${block("kept")}\n        setErrorEntities(context, id, { "entities" : qNthElement(qCreatedBy(id + "kept", EntityType.FACE), 0) });\n        reportFeatureWarning(context, id, "One face is suspicious");`,
    );
    expect(result.features[0]!.run!.status).toBe("WARNING");
    expect(result.errorEntities).toBe(1);
    // One body mesh: five faces grey-amber (made by this feature), one red; nothing extra drawn.
    expect(result.meshes).toHaveLength(1);
    expect(triangleCount(result, 2)).toBe(2);
    expect(triangleCount(result, 1)).toBe(10);
  });

  it("draws error edges as segments and vertices as points", () => {
    const result = run(
      `${block("e")}\n        setErrorEntities(context, id, { "entities" : qUnion([qNthElement(qCreatedBy(id + "e", EntityType.EDGE), 0), qNthElement(qCreatedBy(id + "e", EntityType.VERTEX), 0)]) });`,
    );
    const overlay = result.meshes.find((mesh) => mesh.edges !== undefined)!;
    // A straight 10 mm edge: one segment, two points of 3 coordinates; one vertex.
    expect(overlay.edges).toHaveLength(6);
    expect(overlay.vertices).toHaveLength(3);
    const [x0, y0, z0, x1, y1, z1] = overlay.edges!;
    expect(Math.hypot(x1! - x0!, y1! - y0!, z1! - z0!)).toBeCloseTo(0.01, 9);
    const glb = toGlb(result.meshes);
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
    );
    expect(json.materials.map((material: { name: string }) => material.name)).toEqual([
      "plain",
      "highlight",
      "error",
      "outline",
    ]);
    // The overlay isn't the model: it says so, so the viewport doesn't pick through it. A body's
    // node names its body, so a click on one of its meshes finds the body's outline.
    expect(json.nodes.map((node: { extras?: unknown }) => node.extras)).toMatchObject([
      { body: result.meshes[0]!.bodyId },
      { overlay: true },
    ]);
    // The body: its faces (the feature's own, highlighted), then its outline's edges and
    // vertices; the overlay: red lines and points.
    expect(
      json.meshes.map((mesh: { primitives: { mode?: number; material: number }[] }) =>
        mesh.primitives.map((p) => [p.mode ?? 4, p.material]),
      ),
    ).toEqual([
      [
        [4, 1],
        [1, 3],
        [0, 3],
      ],
      [
        [1, 2],
        [0, 2],
      ],
    ]);
    // The agent's PNGs draw them too: count the red pixels.
    const red = (meshes: ReturnType<typeof run>["meshes"]) => {
      const png = renderPng(meshes, "iso", 200);
      const idat = Buffer.from(png).indexOf("IDAT");
      const length = new DataView(png.buffer, png.byteOffset).getUint32(idat - 4);
      const raw = NodeZlib.inflateSync(png.subarray(idat + 4, idat + 4 + length));
      let count = 0;
      for (let row = 0; row < 200; row++)
        for (let x = 0; x < 200; x++) {
          const o = row * 601 + 1 + x * 3;
          if (raw[o] === 222 && raw[o + 1] === 45 && raw[o + 2] === 38) count++;
        }
      return count;
    };
    expect(red(result.meshes)).toBeGreaterThan(20);
    expect(red(run(block("plain")).meshes)).toBe(0);
  });

  it("draws a wire or point body it marked with the error edges' lines and points", () => {
    // Failure mode: a body with no faces is counted as drawn but nothing red appears, so the
    // panel shows the failed run's model with nothing marked.
    const wire = run(
      'opFitSpline(context, id + "w", { "points" : [vector(0, 0, 0) * millimeter, vector(10, 5, 0) * millimeter, vector(20, 0, 3) * millimeter] });\n        throw regenError("Bad wire", qCreatedBy(id + "w", EntityType.BODY));',
    );
    const lines = wire.meshes.find((mesh) => mesh.bodyId === "errors");
    expect(wire.errorEntities).toBe(1);
    // One curved edge, in 64 segments of 6 numbers.
    expect(lines?.edges).toHaveLength(64 * 6);
    const point = run(
      'opPoint(context, id + "p", { "point" : vector(1, 2, 3) * millimeter });\n        throw regenError("Bad point", qCreatedBy(id + "p", EntityType.BODY));',
    );
    expect(point.errorEntities).toBe(1);
    expect(
      [...(point.meshes.find((mesh) => mesh.bodyId === "errors")?.vertices ?? [])].map(
        (n) => +n.toFixed(6),
      ),
    ).toEqual([0.001, 0.002, 0.003]);
  });

  it("never changes the feature's status when its error entities can't be found", () => {
    // Failure modes: a query this runtime can't evaluate faults and replaces the feature's own
    // result; a value that isn't a query fails std's processError, which turns the custom message
    // into REGEN_ERROR; nothing tells the person why nothing is red.
    const unknownQuery = '{ "queryType" : "NOT_A_QUERY_TYPE" }';
    const warned = run(
      `${block("w")}\n        setErrorEntities(context, id, { "entities" : ${unknownQuery} });\n        reportFeatureWarning(context, id, "Suspicious wall");`,
    );
    const ran = warned.features[0]!.run!;
    expect([ran.status, ran.message, ran.fault]).toEqual(["WARNING", "Suspicious wall", null]);
    expect(warned.solids.map((solid) => Math.round(solid.volumeMm3))).toEqual([1000]);
    expect(warned.errorEntities).toBe(0);
    expect(warned.features[0]!.notice).toEqual({
      status: "WARNING",
      message:
        "Suspicious wall Some error entities can't be drawn locally: Query type NOT_A_QUERY_TYPE is not supported locally yet.",
    });
    const source = feature(
      `${block("t")}\n        throw { "message" : ErrorStringEnum.CUSTOM_ERROR, "customMessage" : "Wall is too thin", "entities" : ${unknownQuery} };`,
    );
    const thrown = runPreview(runtime, [{ path: "panel.fs", source }]);
    const failed = thrown.features[0]!.run!;
    expect(featureFailure(runtime, failed)).toEqual({
      message: "Wall is too thin",
      location: {
        path: "panel.fs",
        line: source.split("\n").findIndex((line) => line.includes("Wall is too thin")) + 1,
        column: 9,
      },
      unsupported: false,
    });
    expect(thrown.features[0]!.notice?.status).toBe("INFO");
    const notQuery = run(
      `${block("n")}\n        setErrorEntities(context, id, { "entities" : 5 });`,
    );
    expect([notQuery.features[0]!.run!.status, notQuery.features[0]!.notice?.message]).toEqual([
      "OK",
      "Some error entities can't be drawn locally: Expected a Query.",
    ]);
  });

  it("carries a subfeature's error display up when the feature transfers it", () => {
    const sub = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Outer" }
export const outer = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        ${block("c")}
        setErrorEntities(context, id + "inner", { "entities" : qNthElement(qCreatedBy(id + "c", EntityType.FACE), 0) });
        processSubfeatureStatus(context, id, { "subfeatureId" : id + "inner", "propagateErrorDisplay" : true });
    });
`;
    const result = runPreview(runtime, [{ path: "outer.fs", source: sub }]);
    expect(result.features[0]!.run!.errorEntities).toHaveLength(1);
    expect(run(block("ok")).errorEntities).toBe(0);
    expect(materials(run(block("ok")))).toEqual([1]);
  });
});

describe("editing logic", () => {
  // Failure modes: the "Editing Logic Function" never runs, or runs on a re-save with no input
  // change (undoing what it set); the optional arguments are passed by position, so a function
  // declared like extrude's (..., specifiedParameters is map, hiddenBodies is Query) gets
  // isCreating as specifiedParameters; oldDefinition and definition are swapped, or carry
  // defineFeature's programmatic defaults; oldDefinition isn't {} when the dialog opens; what it
  // returns isn't what the feature runs with or the dialog shows; what it set is forgotten at the
  // next edit, so a stateful flip (extrude's canSetBooleanFlip) reverts; its context changes leak
  // into the feature; a throwing logic stops the run with an uncaught fault instead of failing
  // the feature at the logic's line.
  const withLogic = (logic: string, signature: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export enum Operation { NEW, ADD, REMOVE }
annotation { "Feature Type Name" : "Logic test", "Editing Logic Function" : "logicTestEdit" }
export const logicTest = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Operation" }
        definition.operation is Operation;
        annotation { "Name" : "Opposite direction" }
        definition.opposite is boolean;
        annotation { "Name" : "Depth" }
        isLength(definition.depth, { (millimeter) : [1, 10, 100] } as LengthBoundSpec);
    }
    {
        setVariable(context, "ran", definition);
        // Only what the editing logic made: a fresh context may hold default bodies (the origin).
        setVariable(context, "bodies", size(evaluateQuery(context, qCreatedBy(id + "probe", EntityType.BODY))));
    }, { "programmatic" : 5 });

export function logicTestEdit(${signature}) returns map
{
    ${logic}
    return definition;
}
`;
  type Editing = NonNullable<ReturnType<typeof runPreview>["editing"]>;
  /** The panel's loop: each run sends the state the last one returned. */
  const dialog = (source: string) => {
    let state: Editing | null = null;
    return (parameters: Record<string, string>) => {
      const result = runPreview(runtime, [{ path: "logic.fs", source, parameters }], undefined, {
        editing: { previous: state },
      });
      state = result.editing;
      const ran = result.features[0]!.run!;
      const value = (key: string) => {
        const definition = untag(ran.variables.getField("ran"));
        return definition instanceof FsMap ? formatInput(definition.getField(key)) : undefined;
      };
      return { result, ran, value, state };
    };
  };
  const base = "context is Context, id is Id, oldDefinition is map, definition is map";

  it("flips a direction when the operation changes sign, and keeps the flip at later edits", () => {
    const edit = dialog(
      withLogic(
        `if (!specifiedParameters.opposite && oldDefinition.operation != undefined && oldDefinition.operation != definition.operation)
        definition.opposite = !definition.opposite;`,
        `${base}, specifiedParameters is map, hiddenBodies is Query`,
      ),
    );
    // Opening the dialog: oldDefinition is {}, so nothing flips.
    expect(edit({}).value("opposite")).toBe("false");
    const removed = edit({ operation: "Operation.REMOVE" });
    expect(removed.value("opposite")).toBe("true");
    // The dialog shows what the feature ran with.
    const row = (id: string) =>
      dialogInputs(
        runtime,
        removed.result.features[0]!.module,
        removed.result.features[0]!.spec,
        removed.result.features[0]!.definition,
      ).find((input) => input.id === id)?.value;
    expect(row("opposite")).toBe("true");
    expect(removed.state?.edited).toEqual({ opposite: "true" });
    // A later edit of another input keeps it; so does running again with nothing changed.
    expect(
      edit({ operation: "Operation.REMOVE", depth: "20 * millimeter" }).value("opposite"),
    ).toBe("true");
    expect(
      edit({ operation: "Operation.REMOVE", depth: "20 * millimeter" }).value("opposite"),
    ).toBe("true");
    // Setting the direction yourself wins, and the logic leaves it alone after.
    const own = edit({
      operation: "Operation.REMOVE",
      depth: "20 * millimeter",
      opposite: "false",
    });
    expect(own.value("opposite")).toBe("false");
    expect(
      edit({ operation: "Operation.ADD", depth: "20 * millimeter", opposite: "false" }).value(
        "opposite",
      ),
    ).toBe("false");
  });

  it("runs std's own extrudeEditLogic, which flips an extrude into the part when it turns to Remove", () => {
    // extrude's dialog inputs that extrudeEditLogic reads, with std's ids and defaults.
    const extrudeLike = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Extrude-like", "Editing Logic Function" : "extrudeEditLogic" }
export const extrudeLike = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Domain", "UIHint" : UIHint.ALWAYS_HIDDEN, "Default" : OperationDomain.MODEL }
        definition.domain is OperationDomain;
        annotation { "Name" : "Creation type" }
        definition.bodyType is ExtendedToolBodyType;
        annotation { "Name" : "Operation" }
        definition.operationType is NewBodyOperationType;
        annotation { "Name" : "Faces", "Filter" : EntityType.FACE }
        definition.entities is Query;
        annotation { "Name" : "End type" }
        definition.endBound is BoundingType;
        annotation { "Name" : "Depth" }
        isLength(definition.depth, LENGTH_BOUNDS);
        annotation { "Name" : "Opposite direction" }
        definition.oppositeDirection is boolean;
        annotation { "Name" : "Symmetric" }
        definition.symmetric is boolean;
        annotation { "Name" : "Second direction" }
        definition.hasSecondDirection is boolean;
        annotation { "Name" : "Merge with all", "Default" : true }
        definition.defaultScope is boolean;
        annotation { "Name" : "Merge scope", "Filter" : EntityType.BODY }
        definition.booleanScope is Query;
    }
    {
        setVariable(context, "ran", definition);
    });
`;
    const edit = dialog(extrudeLike);
    const opened = edit({});
    expect(
      opened.ran.status,
      JSON.stringify(
        opened.ran.exceptions.map((e) => [
          e.message,
          e.stack.slice(0, 5).map((f) => `${f.function} ${f.file}`),
        ]),
      ),
    ).toBe("OK");
    expect(opened.value("oppositeDirection")).toBe("false");
    const removing = edit({ operationType: "NewBodyOperationType.REMOVE" });
    expect(removing.value("oppositeDirection")).toBe("true");
    expect(removing.value("operationType")).toBe("NewBodyOperationType.REMOVE");
    // Back to New flips it back out.
    expect(edit({ operationType: "NewBodyOperationType.NEW" }).value("oppositeDirection")).toBe(
      "false",
    );
  });

  it("takes an input the person sets again after the logic overrode it", () => {
    // Failure mode: the person's value is the same string as before the logic overrode it, so the
    // input reads as unchanged and the logic's value stays. `touched` names inputs set since the
    // last run, whatever their text.
    const source = withLogic(
      "if (oldDefinition != {} && oldDefinition.operation != definition.operation) { definition.depth = 14 * millimeter; definition.opposite = false; }",
      base,
    );
    let state: Editing | null = null;
    const edit = (parameters: Record<string, string>, touched: readonly string[] = []) => {
      const result = runPreview(runtime, [{ path: "logic.fs", source, parameters }], undefined, {
        editing: { previous: state, touched },
      });
      state = result.editing;
      const value = (key: string) => formatInput(result.features[0]!.definition.getField(key));
      return [value("depth"), value("opposite")];
    };
    edit({});
    const mine = { depth: "10 * millimeter", opposite: "true" };
    expect(edit(mine, ["depth", "opposite"])).toEqual(["10 mm", "true"]);
    const removing = { ...mine, operation: "Operation.REMOVE" };
    expect(edit(removing, ["operation"])).toEqual(["14 mm", "false"]);
    // Typing 10 mm and checking the box again: the same strings, but set again.
    expect(edit(removing, ["depth", "opposite"])).toEqual(["10 mm", "true"]);
    // And they stay at the next run.
    expect(edit(removing)).toEqual(["10 mm", "true"]);
  });

  it("passes the optional arguments Onshape passes, by the parameters the function declares", () => {
    const record = (expression: string) =>
      `definition.depth = (${expression}) ? 42 * millimeter : 1 * millimeter;`;
    const cases = [
      [base, "oldDefinition == {} && definition.programmatic == undefined"],
      [`${base}, isCreating is boolean`, "isCreating == true"],
      [
        `${base}, specifiedParameters is map`,
        'specifiedParameters == { "operation" : false, "opposite" : false, "depth" : true }',
      ],
      [
        `${base}, isCreating is boolean, specifiedParameters is map, hiddenBodies is Query`,
        "isCreating && specifiedParameters.depth && hiddenBodies == qNothing()",
      ],
      [
        `${base}, specifiedParameters is map, hiddenBodies is Query`,
        "specifiedParameters.depth && isQueryEmpty(context, hiddenBodies)",
      ],
      [
        `${base}, isCreating is boolean, specifiedParameters is map, hiddenBodies is Query, clickedButton is string`,
        'clickedButton == ""',
      ],
    ] as const;
    for (const [signature, check] of cases)
      expect(
        dialog(withLogic(record(check), signature))({ depth: "3 * millimeter" }).value("depth"),
        signature,
      ).toBe("42 mm");
    expect(() =>
      dialog(withLogic("", "context is Context, id is Id, oldDefinition is map"))({}),
    ).toThrow(/at least four/);
  });

  it("runs the logic on a rolled-back context, so only its definition reaches the feature", () => {
    const edit = dialog(
      withLogic(
        'opPoint(context, id + "probe", { "point" : vector(0, 0, 0) * meter });\n    setVariable(context, "fromLogic", true);\n    definition.depth = 42 * millimeter;',
        base,
      ),
    );
    const { ran, value } = edit({ depth: "5 * millimeter" });
    expect(ran.status, JSON.stringify(ran.exceptions)).toBe("OK");
    expect(value("depth")).toBe("42 mm");
    expect(ran.variables.getField("fromLogic")).toBeUndefined();
    expect(Number(untag(ran.variables.getField("bodies")))).toBe(0);
  });

  it("fails the feature at the logic's line when the logic throws", () => {
    const source = withLogic('throw regenError("Logic says no");', base);
    const { result, ran } = dialog(source)({ depth: "5 * millimeter" });
    expect(ran.status).toBe("ERROR");
    expect(ran.fault).toBeNull();
    expect(featureFailure(runtime, ran)).toMatchObject({
      message: "Logic says no",
      location: {
        path: "logic.fs",
        line: source.split("\n").findIndex((line) => line.includes("Logic says no")) + 1,
      },
    });
    expect(result.features[0]!.run!.variables.getField("ran")).toBeUndefined();
  });

  it("doesn't run a feature's logic outside the panel, or report state for a feature without one", () => {
    const source = withLogic("definition.depth = 42 * millimeter;", base);
    const plain = runPreview(runtime, [
      { path: "logic.fs", source, parameters: { depth: "5 * millimeter" } },
    ]);
    expect(plain.editing).toBeNull();
    expect(formatInput(plain.features[0]!.definition.getField("depth"))).toBe("5 mm");
    const none = runPreview(runtime, [{ path: "panel.fs", source: feature(cube) }], undefined, {
      editing: { previous: null },
    });
    expect(none.editing).toBeNull();
  });
});

describe("picks", () => {
  // The panel's pick queries (apps/web featureScriptDialog's pickQuery, whose tests assert the
  // same strings), evaluated here. The web finds the face a click hit by its triangle, and names
  // it by the face's probe (a point inside it, on its true surface, from the GLB); an edge or
  // vertex the click snapped to it names by its exact point (an edge's middle on its curve, a
  // vertex where it is). The query takes the drawn face nearest the probe, and the clicked part's
  // edge or vertex nearest the exact point. Failure modes: two touching parts' shared edge or
  // vertex gives both parts' at once; a click by a curved face's rim, where the drawn triangles sit
  // inside the true surface, is nearer the face beyond the rim, or two stacked parts' discs; an
  // edge hidden inside the part (a pocket's, under the clicked face) or a sketch region's edge lying
  // on the face is nearer and wins; a body pick returns the face, or the sketch region on it; any of
  // them finds nothing on a solid from an earlier step.
  const drawnFaces =
    "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";
  // A 10 mm cube, and a sketch on its top face whose region's near edge is 0.1 mm from the
  // edge pick's click, nearer than the cube's own edge (0.2 mm).
  const blockAndSketch = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Block" }
export const block = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        const sketch = newSketchOnPlane(context, id + "sk", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1)) });
        skRectangle(sketch, "r", { "firstCorner" : vector(0, 0.3) * millimeter, "secondCorner" : vector(10, 5) * millimeter });
        skSolve(sketch);
    });
`;
  const picker = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Picker" }
export const picker = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Picked" }
        definition.picked is Query;
    }
    {
        const picked = evaluateQuery(context, definition.picked);
        setVariable(context, "count", size(picked));
        var found = "";
        for (var entityType in [EntityType.BODY, EntityType.FACE, EntityType.EDGE, EntityType.VERTEX])
            if (!isQueryEmpty(context, qEntityFilter(definition.picked, entityType)))
                found = toString(entityType);
        setVariable(context, "type", found);
        setVariable(context, "at", try silent(evEdgeTangentLine(context, { "edge" : picked[0], "parameter" : 0.5 }).origin / millimeter));
        setVariable(context, "vertex", try silent(evVertexPoint(context, { "vertex" : picked[0] }) / millimeter));
        setVariable(context, "volume", try silent(evVolume(context, { "entities" : picked[0] }) / millimeter ^ 3));
        setVariable(context, "bottom", try silent(evBox3d(context, { "topology" : qOwnerBody(definition.picked) }).minCorner[2] / millimeter));
    });
`;
  /** The clicked face: the drawn face nearest its `probe`, or of several there, `clicked`'s. */
  const faceAt = (probe: string, clicked = probe) =>
    `qClosestTo(qClosestTo(${drawnFaces}, ${probe}), ${clicked})`;
  /** The clicked part's edge or vertex at `exact`; `probe` is the clicked face's. */
  const ofPartAt = (exact: string, type: "EDGE" | "VERTEX", probe: string) =>
    `qClosestTo(qOwnedByBody(qOwnerBody(${faceAt(probe)}), EntityType.${type}), ${exact})`;
  const pick = (expression: string, base = blockAndSketch) => {
    const ran = runPreview(runtime, [
      { path: "block.fs", source: base },
      { path: "picker.fs", source: picker, parameters: { picked: expression } },
    ]).features[1]!.run!;
    expect(
      ran.status,
      JSON.stringify([ran.fault?.message, ran.exceptions.map((e) => e.message)]),
    ).toBe("OK");
    const get = (name: string) => ran.variables.getField(name);
    const numbers = (name: string) => {
      const value = untag(get(name));
      return Array.isArray(value) ? value.map((n) => Number(Number(untag(n)).toFixed(6))) : null;
    };
    return {
      count: Number(untag(get("count"))),
      type: untag(get("type")),
      at: numbers("at"),
      vertex: numbers("vertex"),
      volume: Number(untag(get("volume"))),
      bottom: Number(untag(get("bottom"))),
    };
  };

  it("finds the edge the click snapped to among the clicked face's, not a sketch region's", () => {
    expect(
      pick(ofPartAt("vector(5, 0, 10) * millimeter", "EDGE", "vector(5, 7, 10) * millimeter")),
    ).toMatchObject({
      count: 1,
      type: "EDGE",
      at: [5, 0, 10],
    });
    // Nearest of every edge, the sketch's lying on the face (0.1 mm off) wins.
    expect(
      pick("qClosestTo(qEverything(EntityType.EDGE), vector(5, 0.2, 10) * millimeter)").at,
    ).toEqual([5, 0.3, 10]);
  });

  it("finds the corner the click snapped to", () => {
    expect(
      pick(ofPartAt("vector(10, 10, 10) * millimeter", "VERTEX", "vector(5, 7, 10) * millimeter")),
    ).toMatchObject({
      count: 1,
      type: "VERTEX",
      vertex: [10, 10, 10],
    });
  });

  it("never picks an edge hidden inside the part", () => {
    // A 10 mm block with a pocket cut up from below, its ceiling 0.5 mm under the top face and its
    // walls 0.5 mm thick. A click 0.6 mm in from the top's edge is nearer the hidden ceiling edge.
    const pocketed = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Pocketed" }
export const pocketed = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "pocket", { "corner1" : vector(0.5, 0.5, -1) * millimeter, "corner2" : vector(9.5, 9.5, 9.5) * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "pocket", EntityType.BODY), "targets" : qCreatedBy(id + "block", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });
    });
`;
    expect(
      pick("qClosestTo(qEverything(EntityType.EDGE), vector(0.6, 5, 10) * millimeter)", pocketed)
        .at,
    ).toEqual([0.5, 5, 9.5]);
    // The click snaps to the top's drawn edge, x = 0, which the query names by its middle.
    expect(
      pick(
        ofPartAt("vector(0, 5, 10) * millimeter", "EDGE", "vector(3, 7, 10) * millimeter"),
        pocketed,
      ).at,
    ).toEqual([0, 5, 10]);
  });

  it("finds one part's edge or corner where two touching parts share it: the clicked one's", () => {
    // Two separate 10 mm cubes, b stacked on a: a's top front edge is b's bottom front edge.
    const stacked = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Stacked" }
export const stacked = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(0, 0, 10) * millimeter, "corner2" : vector(10, 10, 20) * millimeter });
    });
`;
    const edge = "vector(5, 0, 10) * millimeter";
    // A click on b's front face (its probe in its middle) by the edge, then on a's.
    expect(pick(ofPartAt(edge, "EDGE", "vector(5, 0, 15) * millimeter"), stacked)).toMatchObject({
      count: 1,
      type: "EDGE",
      at: [5, 0, 10],
      bottom: 10,
    });
    expect(pick(ofPartAt(edge, "EDGE", "vector(5, 0, 5) * millimeter"), stacked)).toMatchObject({
      count: 1,
      bottom: 0,
    });
    // Among every drawn face at the edge, both parts' are nearest, and give both parts' edges.
    expect(
      pick(
        `qClosestTo(qAdjacent(qClosestTo(${drawnFaces}, ${edge}), AdjacencyType.EDGE, EntityType.EDGE), ${edge})`,
        stacked,
      ).count,
    ).toBe(2);
    expect(
      pick(
        ofPartAt("vector(0, 0, 10) * millimeter", "VERTEX", "vector(5, 0, 15) * millimeter"),
        stacked,
      ),
    ).toMatchObject({ count: 1, type: "VERTEX", vertex: [0, 0, 10], bottom: 10 });
  });

  it("finds the clicked face, part and rim of two stacked cylinders, not the discs between", () => {
    // Two separate 5 mm cylinders, b standing on a: a's top disc and b's bottom disc coincide.
    const cylinders = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Cylinders" }
export const cylinders = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCylinder(context, id + "a", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        fCylinder(context, id + "b", { "bottomCenter" : vector(0, 0, 10) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 5 * millimeter });
    });
`;
    // b's side, by a probe in its middle; its bottom rim, by the rim's middle on the true circle.
    const side = "vector(0, -5, 15) * millimeter";
    expect(pick(faceAt(side), cylinders)).toMatchObject({ count: 1, type: "FACE", bottom: 10 });
    expect(pick(`qOwnerBody(${faceAt(side)})`, cylinders)).toMatchObject({
      count: 1,
      type: "BODY",
      bottom: 10,
    });
    expect(pick(ofPartAt("vector(-5, 0, 10) * millimeter", "EDGE", side), cylinders)).toMatchObject(
      { count: 1, type: "EDGE", bottom: 10 },
    );
    // Where a click on b's side just above its bottom rim meets the drawn triangles: 0.019 mm
    // inside the true side, 0.005 mm above the rim. The two discs are nearer than the side, and tie.
    expect(
      pick(`qClosestTo(${drawnFaces}, vector(4.981, 0, 10.005) * millimeter)`, cylinders).count,
    ).toBe(2);
  });

  it("finds the clicked face where another part covers some of it", () => {
    // A 4 mm cube standing on a 20 mm plate: the plate's top face lies under the cube's bottom.
    const blockOnPlate = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Block on plate" }
export const blockOnPlate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "p", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 2) * millimeter });
        fCuboid(context, id + "c", { "corner1" : vector(8, 8, 2) * millimeter, "corner2" : vector(12, 12, 6) * millimeter });
    });
`;
    // The plate's probe can fall under the cube, where both faces are; the click can't.
    const probe = "vector(10, 10, 2) * millimeter";
    expect(pick(`qClosestTo(${drawnFaces}, ${probe})`, blockOnPlate).count).toBe(2);
    expect(pick(faceAt(probe, "vector(3, 3, 2) * millimeter"), blockOnPlate)).toMatchObject({
      count: 1,
      type: "FACE",
      bottom: 0,
    });
  });

  it("finds the solid that owns the clicked face, under the sketch region lying on it", () => {
    expect(
      pick(`qOwnerBody(qClosestTo(${drawnFaces}, vector(5, 2, 10) * millimeter))`),
    ).toMatchObject({
      count: 1,
      type: "BODY",
      volume: 1000,
    });
  });
});

describe("outline: the B-rep edges and vertices the viewport draws and snaps to", () => {
  // The panel draws each body's own edges and snaps clicks to them and its vertices, as Onshape
  // does. Failure modes: a fillet's tangent edge is missing, so a click on it can't pick it; the
  // outline has segments that aren't edges (creases between a curved face's facets) for a click
  // to snap to; a fillet's tangent vertex, where edges meet in a line, isn't there to snap to; a
  // cylinder's seam or seam vertex shows, which Onshape doesn't have; the lines aren't on the drawn
  // triangles' nodes, so the faces hide them in places.
  const body = (build: string) =>
    runPreview(runtime, [
      {
        path: "body.fs",
        source: `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Body" }
export const body = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        ${build}
    });
`,
      },
    ]).meshes;
  // A 20 x 20 x 10 mm block with its top back edge (y = 20, z = 10) filleted at 2 mm.
  const filleted = () =>
    body(`fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 10) * millimeter });
        opFillet(context, id + "f", { "entities" : qClosestTo(qCreatedBy(id + "c", EntityType.EDGE), vector(10, 20, 10) * millimeter), "radius" : 2 * millimeter });`);
  type Point = readonly [number, number, number];
  /** Points of a flat coordinate array, in millimeters. */
  const points = (array: Float32Array): Point[] =>
    Array.from({ length: array.length / 3 }, (_, i) => [
      array[i * 3]! * 1000,
      array[i * 3 + 1]! * 1000,
      array[i * 3 + 2]! * 1000,
    ]);
  const toSegment = (p: Point, a: Point, b: Point) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p[0] - a[0]) * ab[0]! + (p[1] - a[1]) * ab[1]! + (p[2] - a[2]) * ab[2]!) /
          (ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2),
      ),
    );
    return Math.hypot(p[0] - a[0] - ab[0]! * t, p[1] - a[1] - ab[1]! * t, p[2] - a[2] - ab[2]! * t);
  };
  // The filleted block's 15 edges: 13 lines, and the fillet's arc (center y = 18, z = 8) at each end.
  const lines: [Point, Point][] = [
    ...(
      [
        [0, 0],
        [0, 10],
        [20, 0],
        [18, 10],
        [20, 8],
      ] as const
    ).map(([y, z]): [Point, Point] => [
      [0, y, z],
      [20, y, z],
    ]),
    ...[0, 20].flatMap((x): [Point, Point][] => [
      [
        [x, 0, 0],
        [x, 0, 10],
      ],
      [
        [x, 0, 0],
        [x, 20, 0],
      ],
      [
        [x, 20, 0],
        [x, 20, 8],
      ],
      [
        [x, 0, 10],
        [x, 18, 10],
      ],
    ]),
  ];
  const toEdges = (p: Point) =>
    Math.min(
      ...lines.map(([a, b]) => toSegment(p, a, b)),
      ...[0, 20].map((x) =>
        p[1] >= 18 && p[2] >= 8
          ? Math.hypot(p[0] - x, Math.hypot(p[1] - 18, p[2] - 8) - 2)
          : Infinity,
      ),
    );

  const key = (point: Point) => point.map((n) => n.toFixed(4)).join(",");
  /** A flat array of line segments' ends, as pairs of points in millimeters. */
  const pairs = (array: Float32Array) => {
    const ends = points(array);
    return Array.from({ length: ends.length / 2 }, (_, i): readonly [Point, Point] => [
      ends[i * 2]!,
      ends[i * 2 + 1]!,
    ]);
  };
  const lengthOf = (segments: readonly (readonly [Point, Point])[]) =>
    segments.reduce((sum, [a, b]) => sum + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), 0);

  it("has every edge, a fillet's tangent edges too, and nothing that isn't one", () => {
    const [mesh] = filleted();
    const segments = pairs(mesh!.outline!.edges);
    // Ends and middles on the block's edges, within the 0.05 mm an arc's chords may cut inside it.
    for (const [a, b] of segments) {
      const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      for (const point of [a, b, middle]) expect(toEdges(point), String(point)).toBeLessThan(0.05);
    }
    // All of every edge: 212 mm of lines and two 2 mm quarter arcs (their chords a little short).
    expect(lengthOf(segments)).toBeCloseTo(212 + 2 * Math.PI, 1);
    // The straight tangent edge between the top and the fillet: one segment, end to end.
    const ends = segments.map((segment) => segment.map(key).sort().join(" "));
    expect(ends).toContain([key([0, 18, 10]), key([20, 18, 10])].sort().join(" "));
  });

  it("has every vertex as a point, a fillet's tangent vertices too", () => {
    const [mesh] = filleted();
    expect(points(mesh!.outline!.vertices).map(key).sort()).toEqual(
      (
        [
          [0, 0, 0],
          [20, 0, 0],
          [0, 20, 0],
          [20, 20, 0],
          [0, 0, 10],
          [20, 0, 10],
          [0, 18, 10],
          [20, 18, 10],
          [0, 20, 8],
          [20, 20, 8],
        ] as const
      )
        .map(key)
        .sort(),
    );
  });

  it("lies on the drawn triangles' own nodes", () => {
    const [mesh] = filleted();
    const exact = (point: Point) => point.join(",");
    const nodes = new Set(mesh!.groups.flatMap((group) => points(group.positions).map(exact)));
    for (const point of points(mesh!.outline!.edges)) expect(nodes.has(exact(point))).toBe(true);
  });

  it("draws a cylinder's two circles, without its seam or a vertex", () => {
    const [mesh] = body(
      'fCylinder(context, id + "c", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
    );
    for (const point of points(mesh!.outline!.edges))
      expect([0, 10]).toContain(+point[2].toFixed(6));
    expect(lengthOf(pairs(mesh!.outline!.edges))).toBeCloseTo(4 * Math.PI * 5, 0);
    expect(mesh!.outline!.vertices).toHaveLength(0);
  });

  it("draws nothing for a cylinder too thin for the kernel", () => {
    // A cylinder 1 nm tall, below Parasolid's 10 nm resolution: OpenCascade's own check refuses it,
    // so the feature stops and the mesher never sees a side it can't triangulate.
    expect(
      body(
        'fCylinder(context, id + "c", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 0.000001) * millimeter, "radius" : 5 * millimeter });',
      ),
    ).toEqual([]);
  });

  it("puts the outline in its own GLB material, which says it is one", () => {
    const glb = toGlb(filleted());
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
    );
    expect(json.materials[3]).toMatchObject({ name: "outline", extras: { outline: true } });
  });
});

describe("pick data: where each drawn face and edge truly is", () => {
  // What the GLB gives the viewport to name what a click hit: each face's probe (a point inside it,
  // on its true surface, away from its edges) and the face each triangle draws; each edge's middle
  // on its true curve and the edge each outline segment draws. Failure modes: a probe outside its
  // face (the middle of a holed plate's top is in the hole) or on an edge, so the drawn face nearest
  // it isn't that face, or is two; a triangle names a face it doesn't draw; an edge's point is on a
  // chord, off the curve, or names another edge; a segment names an edge it doesn't draw.
  const build = (body: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Base" }
export const base = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        ${body}
    });
`;
  type Point = readonly [number, number, number];
  const vector = (point: Point) =>
    `vector(${point.map((n) => (n * 1000).toFixed(6)).join(", ")}) * millimeter`;
  /** What the base's drawn bodies' pick data name, found by FeatureScript. */
  const check = (base: string) =>
    runPreview(runtime, [{ path: "base.fs", source: base }]).meshes.map((mesh) => {
      const probes = mesh.probes!;
      // Each face's area as its triangles draw it.
      const drawnAreas = probes.map(() => 0);
      for (const group of mesh.groups)
        for (let t = 0; t < group.indices.length; t += 3) {
          const [a, b, c] = [0, 1, 2].map((k) => group.indices[t + k]! * 3);
          const at = (i: number, k: number) => group.positions[i + k]!;
          const u = [0, 1, 2].map((k) => at(b!, k) - at(a!, k));
          const v = [0, 1, 2].map((k) => at(c!, k) - at(a!, k));
          const area =
            Math.hypot(
              u[1]! * v[2]! - u[2]! * v[1]!,
              u[2]! * v[0]! - u[0]! * v[2]!,
              u[0]! * v[1]! - u[1]! * v[0]!,
            ) / 2;
          drawnAreas[group.faces[a! / 3]!]! += area * 1e6;
        }
      const { midpoints, edgeOf, edges } = mesh.outline!;
      // One end of a segment of each edge.
      const ends = midpoints.map((_, k) => {
        const i = edgeOf.indexOf(k);
        return [edges[i * 3]!, edges[i * 3 + 1]!, edges[i * 3 + 2]!] as const;
      });
      const checker =
        build(`const drawn = qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO);
        var faces = [];
        var counts = [];
        var areas = [];
        for (var probe in [${probes.map((probe) => vector(probe!)).join(", ")}])
        {
            const face = qClosestTo(drawn, probe);
            faces = append(faces, face);
            counts = append(counts, size(evaluateQuery(context, face)));
            areas = append(areas, evArea(context, { "entities" : face }) / millimeter ^ 2);
        }
        setVariable(context, "counts", counts);
        setVariable(context, "areas", areas);
        setVariable(context, "faces", size(evaluateQuery(context, qUnion(faces))));
        const part = qOwnerBody(faces[0]);
        const middles = [${midpoints.map(vector).join(", ")}];
        const ends = [${ends.map(vector).join(", ")}];
        var edges = [];
        var edgeCounts = [];
        var offCurve = [];
        for (var i = 0; i < size(middles); i += 1)
        {
            const edge = qClosestTo(qOwnedByBody(part, EntityType.EDGE), middles[i]);
            edges = append(edges, edge);
            edgeCounts = append(edgeCounts, size(evaluateQuery(context, edge)));
            offCurve = append(offCurve, max(evDistance(context, { "side0" : edge, "side1" : middles[i] }).distance, evDistance(context, { "side0" : edge, "side1" : ends[i] }).distance) / millimeter);
        }
        setVariable(context, "edgeCounts", edgeCounts);
        setVariable(context, "offCurve", offCurve);
        setVariable(context, "edges", size(evaluateQuery(context, qUnion(edges))));`);
      const ran = runPreview(runtime, [
        { path: "base.fs", source: base },
        { path: "check.fs", source: checker },
      ]).features[1]!.run!;
      expect(ran.status, featureFailure(runtime, ran)?.message).toBe("OK");
      const numbers = (name: string) =>
        (untag(ran.variables.getField(name)) as readonly FsValue[]).map((n) => Number(untag(n)));
      return {
        faces: probes.length,
        counts: numbers("counts"),
        distinctFaces: Number(untag(ran.variables.getField("faces"))),
        areaErrors: numbers("areas").map((area, i) => Math.abs(drawnAreas[i]! - area) / area),
        edges: midpoints.length,
        edgeCounts: numbers("edgeCounts"),
        distinctEdges: Number(untag(ran.variables.getField("edges"))),
        offCurve: Math.max(...numbers("offCurve")),
      };
    });
  const expectNamed = (checked: ReturnType<typeof check>[number]) => {
    expect(checked.counts).toEqual(checked.counts.map(() => 1));
    expect(checked.distinctFaces).toBe(checked.faces);
    // Chords cut a curved face's area a little; a face named wrongly is off by far more.
    for (const error of checked.areaErrors) expect(error).toBeLessThan(0.01);
    expect(checked.edgeCounts).toEqual(checked.edgeCounts.map(() => 1));
    expect(checked.distinctEdges).toBe(checked.edges);
    expect(checked.offCurve).toBeLessThan(1e-4);
  };

  it("names every face and edge of a plate with a hole through its middle", () => {
    const [plate] = check(
      build(`fCuboid(context, id + "p", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 5) * millimeter });
        fCylinder(context, id + "h", { "bottomCenter" : vector(10, 10, -1) * millimeter, "topCenter" : vector(10, 10, 6) * millimeter, "radius" : 6 * millimeter });
        opBoolean(context, id + "cut", { "tools" : qCreatedBy(id + "h", EntityType.BODY), "targets" : qCreatedBy(id + "p", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`),
    );
    expect([plate!.faces, plate!.edges]).toEqual([7, 14]);
    expectNamed(plate!);
  });

  it("names every face and edge of a block with its edges filleted", () => {
    const [block] = check(
      build(`fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 10) * millimeter });
        opFillet(context, id + "f", { "entities" : qCreatedBy(id + "c", EntityType.EDGE), "radius" : 2 * millimeter });`),
    );
    // 6 sides, 12 fillets and 8 corner blends; 48 edges.
    expect([block!.faces, block!.edges]).toEqual([26, 48]);
    expectNamed(block!);
  });

  it("writes them into the GLB: each body's probes and edge middles, each vertex's face and edge", () => {
    const meshes = runPreview(runtime, [
      {
        path: "base.fs",
        source: build(
          'fCylinder(context, id + "a", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });',
        ),
      },
    ]).meshes;
    const glb = toGlb(meshes);
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))),
    );
    const [node] = json.nodes;
    expect(node.extras.faces).toHaveLength(3);
    expect(node.extras.edges).toHaveLength(2);
    for (const point of [...node.extras.faces, ...node.extras.edges]) expect(point).toHaveLength(3);
    const primitives: { mode?: number; attributes: Record<string, number> }[] =
      json.meshes[0].primitives;
    for (const primitive of primitives.filter((p) => (p.mode ?? 4) === 4))
      expect(Object.keys(primitive.attributes)).toContain("_FACE");
    expect(Object.keys(primitives.find((p) => p.mode === 1)!.attributes)).toContain("_EDGE");
  });
});

describe("variable references", () => {
  // Failure modes: `#width` fails to parse; it's evaluated before the run, so a variable an earlier
  // feature sets isn't there yet; a `#` inside a string is rewritten; a list item's reference is
  // missed; a missing variable stops the run with an uncaught fault instead of failing the feature
  // and blaming the input; the dialog shows the value instead of the reference typed; the editing
  // logic gets the unevaluated reference.
  const setsWidth = (millimeters: number) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Variable" }
export const variable = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "width", ${millimeters} * millimeter);
    });
`;
  const withWidth = (parameters: Record<string, string>, body = cube) =>
    runPreview(runtime, [
      { path: "variable.fs", source: setsWidth(20) },
      { path: "panel.fs", source: feature(body), parameters },
    ]);

  it("translates #name outside strings to getVariable(context, name)", () => {
    expect(variableReferences("#width / 2 + #_a1 * millimeter ~ \"#not\" ~ '#nor'")).toBe(
      'getVariable(context, "width") / 2 + getVariable(context, "_a1") * millimeter ~ "#not" ~ \'#nor\'',
    );
    expect(variableReferences('"a \\" #b"')).toBeNull();
    expect(variableReferences("2 * millimeter")).toBeNull();
  });

  it("reads a variable an earlier feature set, when the feature runs", () => {
    const result = withWidth({ size: "#width" });
    expect(result.features[1]!.run!.status).toBe("OK");
    // A 20 mm cube.
    expect(result.solids.map((solid) => Math.round(solid.volumeMm3))).toEqual([8000]);
    expect(
      Math.round(withWidth({ size: "#width / 2 + 1 * millimeter" }).solids[0]!.volumeMm3),
    ).toBe(1331);
  });

  it("shows the reference as typed in the dialog, and evaluates one in a list item", () => {
    const result = withWidth(
      { size: " #width ", waypoints: '[{ "height" : #width }]' },
      'setVariable(context, "height", definition.waypoints[0].height / millimeter);',
    );
    const step = result.features[1]!;
    expect(Number(untag(step.run!.variables.getField("height")))).toBeCloseTo(20, 9);
    const rows = dialogInputs(runtime, step.module, step.spec, step.definition, {
      expressions: step.parameters,
    });
    expect(rows.find((row) => row.id === "size")?.value).toBe("#width");
    expect(rows.find((row) => row.id === "waypoints")?.items[0]?.[0]?.value).toBe("20 mm");
  });

  it("gives the editing logic the variables' values, in the old definition too", () => {
    // The logic sets the count from the size only when the size changed since the last run.
    const source = `${feature(cube, ', "Editing Logic Function" : "panelLogic"')}
export function panelLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    if (oldDefinition.size != definition.size)
        definition.count = round(definition.size / millimeter / 4);
    return definition;
}
`;
    const steps = (parameters: Record<string, string>) => [
      { path: "variable.fs", source: setsWidth(20) },
      { path: "panel.fs", source, parameters },
    ];
    const count = (result: ReturnType<typeof runPreview>) =>
      formatInput(result.features[1]!.definition.getField("count"));
    const opened = runPreview(runtime, steps({ size: "#width" }), undefined, {
      editing: { previous: null },
    });
    expect(count(opened)).toBe("5");
    // The count changes, the size doesn't: with the old size evaluated too, the logic leaves it.
    const counted = runPreview(runtime, steps({ size: "#width", count: "3" }), undefined, {
      editing: { previous: opened.editing },
    });
    expect(count(counted)).toBe("3");
  });

  it("lets the editing logic replace a reference, shows its value, and keeps it", () => {
    // Failure modes: the dialog keeps showing #width though the feature ran with the logic's value;
    // the next unrelated edit evaluates #width again, so the logic's value is lost; setting
    // #width again doesn't take it back.
    const source = `${feature(cube, ', "Editing Logic Function" : "panelLogic"')}
export function panelLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    if (oldDefinition != {} && oldDefinition.count != definition.count)
        definition.size = definition.count * 3 * millimeter;
    return definition;
}
`;
    let state: NonNullable<ReturnType<typeof runPreview>["editing"]> | null = null;
    const edit = (parameters: Record<string, string>, touched: readonly string[]) => {
      const result = runPreview(
        runtime,
        [
          { path: "variable.fs", source: setsWidth(20) },
          { path: "panel.fs", source, parameters },
        ],
        undefined,
        { editing: { previous: state, touched } },
      );
      state = result.editing;
      const step = result.features[1]!;
      const shown = dialogInputs(runtime, step.module, step.spec, step.definition, {
        expressions: step.shown,
      }).find((row) => row.id === "size")?.value;
      return [formatInput(step.definition.getField("size")), shown];
    };
    edit({}, []);
    expect(edit({ size: "#width" }, ["size"])).toEqual(["20 mm", "#width"]);
    // The count changes, and the logic sets the size to 3 * 4 mm.
    expect(edit({ size: "#width", count: "4" }, ["count"])).toEqual(["12 mm", "12 mm"]);
    // An unrelated run keeps the logic's value.
    expect(edit({ size: "#width", count: "4" }, [])).toEqual(["12 mm", "12 mm"]);
    // Setting #width again takes it back.
    expect(edit({ size: "#width", count: "4" }, ["size"])).toEqual(["20 mm", "#width"]);
  });

  it("keeps the dialog's state through a run whose logic or variable failed", () => {
    // Failure mode: a run with no definition from the logic falls back to the definition before
    // the logic, which lacks the variable's value, so the state records the input's default as
    // the logic's and later runs stop reading #width.
    const source = `${feature(cube, ', "Editing Logic Function" : "panelLogic"')}
export function panelLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    if (definition.count == 7)
        throw regenError("Logic says no");
    return definition;
}
`;
    let state: NonNullable<ReturnType<typeof runPreview>["editing"]> | null = null;
    const sets = 'setVariable(context, "width", 20 * millimeter);';
    const edit = (line: string, parameters: Record<string, string>, touched: readonly string[]) => {
      const result = runPreview(
        runtime,
        [
          { path: "variable.fs", source: setsWidth(20).replace(sets, line) },
          { path: "panel.fs", source, parameters },
        ],
        undefined,
        { editing: { previous: state, touched } },
      );
      state = result.editing;
      const step = result.features[1]!;
      return [step.run!.status, formatInput(step.definition.getField("size")), state?.edited];
    };
    expect(edit(sets, { size: "#width" }, ["size"])).toEqual(["OK", "20 mm", {}]);
    // The logic throws: the state stays as it was.
    expect(edit(sets, { size: "#width", count: "7" }, ["count"])).toEqual(["ERROR", "10 mm", {}]);
    expect(edit(sets, { size: "#width", count: "4" }, ["count"])).toEqual(["OK", "20 mm", {}]);
    // The variable is missing for a run (its feature set another): the same.
    expect(edit('setVariable(context, "other", 1);', { size: "#width", count: "4" }, [])[0]).toBe(
      "ERROR",
    );
    expect(edit(sets, { size: "#width", count: "4" }, [])).toEqual(["OK", "20 mm", {}]);
  });

  it("shows what the person typed into an input the logic set, after it failed the run", () => {
    // Failure mode: the failed run leaves the dialog's state as it was, which says the logic set
    // Height, so the row shows the logic's value (or the default) instead of the #nope just typed,
    // and typing that value back does nothing.
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Panel", "Editing Logic Function" : "panelLogic" }
export const panel = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(definition.width, definition.width, definition.height) });
    });
export function panelLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    if (oldDefinition.width != definition.width)
        definition.height = definition.width * 2;
    return definition;
}
`;
    let state: ReturnType<typeof runPreview>["editing"] = null;
    const rows = (parameters: Record<string, string>, touched: readonly string[]) => {
      const result = runPreview(runtime, [{ path: "panel.fs", source, parameters }], undefined, {
        editing: { previous: state, touched },
      });
      state = result.editing;
      const last = result.features.at(-1)!;
      return dialogInputs(runtime, last.module, last.spec, last.definition, {
        faulty: last.run?.faultyParameters ?? [],
        expressions: last.shown,
      }).map((row) => `${row.label}: ${row.value}${row.faulty ? " (faulty)" : ""}`);
    };
    // Opening the dialog, the logic sets Height from Width.
    expect(rows({}, [])).toEqual(["Width: 25 mm", "Height: 50 mm"]);
    expect(rows({ height: "#nope" }, ["height"])).toEqual([
      "Width: 25 mm",
      "Height: #nope (faulty)",
    ]);
    // Height the person didn't touch still shows the logic's value.
    state = null;
    rows({}, []);
    expect(rows({ width: "#nope" }, ["width"])).toEqual(["Width: #nope (faulty)", "Height: 50 mm"]);
  });

  it("fails the feature and blames the input when the variable doesn't exist", () => {
    const result = withWidth({ size: "#nope" });
    const ran = result.features[1]!.run!;
    expect(ran.status).toBe("ERROR");
    expect(ran.fault).toBeNull();
    expect(ran.faultyParameters).toEqual(["size"]);
    // The expression isn't in the file, so no line is blamed: the input is, by its label.
    expect(featureFailure(runtime, ran)).toEqual({
      message: 'Size: Variable "nope" not found.',
      location: null,
      unsupported: false,
    });
  });
});

describe("manipulators", () => {
  // Failure modes: addManipulators does nothing, or keeps only the last call's (Wire run adds one
  // per waypoint); a manipulator can't be sent back for a change; the "Manipulator Change
  // Function" doesn't run, or gets the definition with programmatic defaults; what it returns isn't what the feature runs with, or isn't returned
  // as inputs the panel can keep; a quantity it returns as a string isn't read as an expression;
  // the editing logic doesn't run after it, as Onshape runs it after any definition change; a
  // throwing change function stops the run instead of failing the feature at its line.
  // manipulator.fs's own example, with a cuboid instead of an extruded face.
  const fakeExtrude = (change: string, extra = "") => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Fake extrude", "Manipulator Change Function" : "fakeExtrudeManipulatorChange"${extra} }
export const fakeExtrude = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "My Length" }
        isLength(definition.depth, LENGTH_BOUNDS);
        annotation { "Name" : "Opposite direction", "UIHint" : UIHint.OPPOSITE_DIRECTION }
        definition.shouldFlip is boolean;
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        addManipulators(context, id, { "myManipulator" : linearManipulator({
                "base" : vector(0, 0, 10) * millimeter,
                "direction" : vector(0, 0, 1),
                "offset" : definition.shouldFlip ? definition.depth : -definition.depth,
                "primaryParameterId" : "depth" }) });
        addManipulators(context, id, { "corner" : triadManipulator({ "base" : vector(0, 0, 0) * meter, "offset" : vector(10, 10, 0) * millimeter }) });
        fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10 * millimeter, 10 * millimeter, definition.depth) });
    }, { "programmatic" : 1 });

export function fakeExtrudeManipulatorChange(context is Context, definition is map, newManipulators is map) returns map
{
    ${change}
    return definition;
}
`;
  const example = `if (definition.programmatic != undefined) throw "programmatic defaults leaked";
    var newDepth is ValueWithUnits = newManipulators["myManipulator"].offset;
    definition.depth = abs(newDepth);
    definition.shouldFlip = newDepth > 0;`;
  const preview = (
    source: string,
    parameters: Record<string, string>,
    options: Parameters<typeof runPreview>[3] = {},
  ) => runPreview(runtime, [{ path: "fake.fs", source, parameters }], undefined, options);

  it("collects every manipulator the feature adds, ready to send back", () => {
    const result = preview(fakeExtrude(example), { depth: "15 * millimeter" });
    expect(result.features[0]!.run!.manipulators.entries().map(([key]) => key)).toEqual([
      "corner",
      "myManipulator",
    ]);
    const linear = result.manipulators.find((manipulator) => manipulator.key === "myManipulator")!;
    expect(linear).toMatchObject({
      type: "LINEAR_1D",
      fields: {
        base: [0, 0, 0.01],
        direction: [0, 0, 1],
        offset: -0.015,
        primaryParameterId: "depth",
      },
    });
    expect(linear.expression).toMatch(/as Manipulator\)$/);
    expect(result.manipulators.find((manipulator) => manipulator.key === "corner")).toMatchObject({
      type: "LINEAR_3D",
      fields: { offset: [0.01, 0.01, 0] },
    });
  });

  it("runs the change function on a dragged manipulator, then the feature with its definition", () => {
    const source = fakeExtrude(example);
    const first = preview(source, { depth: "15 * millimeter" });
    const linear = first.manipulators.find((manipulator) => manipulator.key === "myManipulator")!;
    // Dragged up to +20 mm: depth 20 mm, flipped.
    const dragged = preview(
      source,
      { depth: "15 * millimeter" },
      {
        manipulatorChange: {
          key: "myManipulator",
          manipulator: linear.expression!,
          changes: { offset: "20 * millimeter" },
        },
      },
    );
    expect(
      dragged.features[0]!.run!.status,
      JSON.stringify(dragged.features[0]!.run!.exceptions.map((e) => e.message)),
    ).toBe("OK");
    expect(dragged.parameters).toEqual({ depth: "0.02 * meter", shouldFlip: "true" });
    // 10 x 10 x 20 mm.
    expect(Math.round(dragged.solids[0]!.volumeMm3)).toBe(2000);
    // Dragged back down to -5 mm keeps the inputs it didn't change.
    const back = preview(source, dragged.parameters!, {
      manipulatorChange: {
        key: "myManipulator",
        manipulator: dragged.manipulators.find((m) => m.key === "myManipulator")!.expression!,
        changes: { offset: "-5 * millimeter" },
      },
    });
    expect(back.parameters).toEqual({ depth: "0.005 * meter", shouldFlip: "false" });
  });

  it("reads a quantity the change function returns as a string as an expression", () => {
    const source = fakeExtrude('definition.depth = "25 * millimeter";');
    const linear = preview(source, {}).manipulators.find((m) => m.key === "myManipulator")!;
    const dragged = preview(
      source,
      {},
      {
        manipulatorChange: {
          key: "myManipulator",
          manipulator: linear.expression!,
          changes: { offset: "1 * millimeter" },
        },
      },
    );
    expect(dragged.parameters).toEqual({ depth: "25 * millimeter" });
    expect(Math.round(dragged.solids[0]!.volumeMm3)).toBe(2500);
  });

  it("runs the editing logic after the change, as for any definition change", () => {
    const source = `${fakeExtrude(example, ', "Editing Logic Function" : "fakeExtrudeLogic"')}
export function fakeExtrudeLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    if (oldDefinition.depth != definition.depth)
        definition.height = definition.depth * 2;
    return definition;
}
`;
    const opened = preview(source, {}, { editing: { previous: null } });
    const dragged = preview(
      source,
      {},
      {
        editing: { previous: opened.editing },
        manipulatorChange: {
          key: "myManipulator",
          manipulator: opened.manipulators.find((m) => m.key === "myManipulator")!.expression!,
          changes: { offset: "-30 * millimeter" },
        },
      },
    );
    expect(formatInput(dragged.features[0]!.definition.getField("height"))).toBe("60 mm");
    expect(dragged.editing?.parameters).toEqual({ depth: "0.03 * meter" });
  });

  it("fails the feature at the change function's line when it throws", () => {
    const source = fakeExtrude('throw regenError("Can\'t drag there");');
    const linear = preview(source, {}).manipulators.find((m) => m.key === "myManipulator")!;
    const dragged = preview(
      source,
      {},
      {
        manipulatorChange: {
          key: "myManipulator",
          manipulator: linear.expression!,
          changes: { offset: "1 * millimeter" },
        },
      },
    );
    const ran = dragged.features[0]!.run!;
    expect(ran.status).toBe("ERROR");
    expect(featureFailure(runtime, ran)).toMatchObject({
      message: "Can't drag there",
      location: { line: source.split("\n").findIndex((line) => line.includes("drag there")) + 1 },
    });
    expect(dragged.parameters).toBeNull();
    // A feature with no change function can't take a manipulator change.
    const without = source.replace(
      ', "Manipulator Change Function" : "fakeExtrudeManipulatorChange"',
      "",
    );
    expect(() =>
      preview(
        without,
        {},
        {
          manipulatorChange: { key: "myManipulator", manipulator: linear.expression!, changes: {} },
        },
      ),
    ).toThrow(/Manipulator Change Function/);
  });
});

describe("manipulator changes beyond the dialog's inputs", () => {
  // std's manipulator.fs lets the change function change the definition "in any way": a field it
  // sets that isn't a dialog input still reaches the feature.
  it("keeps every field the change function sets", () => {
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Derived", "Manipulator Change Function" : "change" }
export const derived = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Count" }
        isInteger(definition.count, POSITIVE_COUNT_BOUNDS);
    }
    {
        setVariable(context, "received", [definition.count, definition.derived]);
        addManipulators(context, id, { "drag" : linearManipulator({ "base" : vector(0, 0, 0) * meter, "direction" : vector(1, 0, 0), "offset" : 0 * meter }) });
    });
export function change(context is Context, definition is map, newManipulators is map) returns map
{
    definition.count = 2;
    definition.derived = 42;
    return definition;
}`;
    const steps = [{ path: "derived.fs", source }];
    const first = runPreview(runtime, steps);
    const changed = runPreview(runtime, steps, undefined, {
      manipulatorChange: {
        key: "drag",
        manipulator: first.manipulators[0]!.expression!,
        changes: { offset: "1 * meter" },
      },
    });
    const received = untag(
      changed.features[0]!.run!.variables.getField("received"),
    ) as readonly FsValue[];
    expect(received.map(untag)).toEqual([2, 42]);
  });
});

describe("definition fields beyond the dialog's inputs, across runs", () => {
  const derived = (body: string, extra = "") => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Derived"${extra} }
export const derived = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Count" }
        isInteger(definition.count, POSITIVE_COUNT_BOUNDS);
    }
    {
        setVariable(context, "received", [definition.count, definition.derived]);
        addManipulators(context, id, { "drag" : linearManipulator({ "base" : vector(0, 0, 0) * meter, "direction" : vector(1, 0, 0), "offset" : 0 * meter }) });
    });
${body}`;
  const received = (result: ReturnType<typeof runPreview>) =>
    (untag(result.features[0]!.run!.variables.getField("received")) as readonly FsValue[]).map(
      untag,
    );

  // A field the change function removes is gone, even one the person's saved inputs carried.
  it("drops a field the change function removes", () => {
    const source = derived(
      "export function change(context is Context, definition is map, newManipulators is map) returns map { definition.count = 2; definition.derived = undefined; return definition; }",
      ', "Manipulator Change Function" : "change"',
    );
    const steps = [{ path: "derived.fs", source, parameters: { derived: "42" } }];
    const first = runPreview(runtime, steps);
    const changed = runPreview(runtime, steps, undefined, {
      manipulatorChange: {
        key: "drag",
        manipulator: first.manipulators[0]!.expression!,
        changes: { offset: "1 * meter" },
      },
    });
    expect(received(changed)).toEqual([2, undefined]);
  });

  // A field the editing logic sets stays set on a later run with nothing changed (after a save),
  // as Onshape keeps the definition the logic returned.
  it("keeps a field the editing logic set on the next unchanged run", () => {
    const source = derived(
      "export function logic(context is Context, id is Id, oldDefinition is map, definition is map) returns map { definition.derived = 42; return definition; }",
      ', "Editing Logic Function" : "logic"',
    );
    const steps = [{ path: "derived.fs", source }];
    const first = runPreview(runtime, steps, undefined, { editing: { previous: null } });
    // Count is POSITIVE_COUNT_BOUNDS' default, 2.
    expect(received(first)).toEqual([2, 42]);
    const second = runPreview(runtime, steps, undefined, { editing: { previous: first.editing } });
    expect(received(second)).toEqual([2, 42]);
  });
});

describe("editing logic and manipulators, round 3", () => {
  const review = (logic: string, change = "definition.derived = 42;") => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Review", "Editing Logic Function" : "logic", "Manipulator Change Function" : "change" }
export const review = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Count" }
        isInteger(definition.count, POSITIVE_COUNT_BOUNDS);
        annotation { "Name" : "Length" }
        isLength(definition.length, ZERO_DEFAULT_LENGTH_BOUNDS);
    }
    {
        addManipulators(context, id, { "drag" : linearManipulator({ "base" : vector(0, 0, 0) * meter, "direction" : vector(1, 0, 0), "offset" : 0 * meter }) });
    });
export function logic(context is Context, id is Id, oldDefinition is map, definition is map) returns map { ${logic} return definition; }
export function change(context is Context, definition is map, newManipulators is map) returns map { ${change} return definition; }
`;

  // Onshape's UI spec allows a quantity as an expression string; locally it can't be evaluated in
  // the run, so the run stops on it rather than failing the feature's precondition.
  it("stops when editing logic returns a quantity as a string", () => {
    const result = runPreview(
      runtime,
      [{ path: "review.fs", source: review('definition.length = "3/8 in";') }],
      undefined,
      {
        editing: { previous: null },
      },
    );
    expect(result.features[0]!.run!.fault?.reason).toBe("unsupported-builtin");
  });

  it("keeps a saved field the editing logic removed removed on the next run", () => {
    const steps = [
      {
        path: "review.fs",
        source: review("definition.derived = undefined;"),
        parameters: { derived: "42" },
      },
    ];
    const first = runPreview(runtime, steps, undefined, { editing: { previous: null } });
    const next = runPreview(runtime, steps, undefined, { editing: { previous: first.editing } });
    expect(next.features[0]!.definition.get("derived")).toBeUndefined();
  });

  it("runs the editing logic after a manipulator changes only a field that isn't an input", () => {
    const steps = [
      { path: "review.fs", source: review("if (definition.derived == 42) definition.count = 7;") },
    ];
    const first = runPreview(runtime, steps, undefined, { editing: { previous: null } });
    const next = runPreview(runtime, steps, undefined, {
      editing: { previous: first.editing },
      manipulatorChange: {
        key: "drag",
        manipulator: first.manipulators[0]!.expression!,
        changes: { offset: "1 * meter" },
      },
    });
    expect(formatInput(next.features[0]!.definition.get("count"))).toBe("7");
  });
});

describe("list item defaults in every definition", () => {
  // Failure modes: oldDefinition is built from the raw list the person set, without the items'
  // defaults that the new definition gets, so editing logic sees a list change that didn't happen;
  // a list whose item reads a variable is evaluated raw, so an inner input left at its default is
  // missing and the feature's precondition fails while the dialog shows the default.
  const listy = (logic: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Listy", "Editing Logic Function" : "listyLogic" }
export const listy = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Count" }
        isInteger(definition.count, { (unitless) : [1, 2, 100] } as IntegerBoundSpec);
        annotation { "Name" : "Waypoints", "Item name" : "Waypoint" }
        definition.waypoints is array;
        for (var waypoint in definition.waypoints)
        {
            annotation { "Name" : "Height" }
            isLength(waypoint.height, ZERO_DEFAULT_LENGTH_BOUNDS);
            annotation { "Name" : "Width" }
            isLength(waypoint.width, ZERO_DEFAULT_LENGTH_BOUNDS);
        }
    }
    {
        setVariable(context, "firstWidth", definition.waypoints[0].width);
    });

export function listyLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    ${logic}
    return definition;
}
`;
  const setsW = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Variable" }
export const variable = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "w", 20 * millimeter);
    });
`;

  it("gives oldDefinition's list items their defaults, so an unchanged list reads unchanged", () => {
    const source = listy(
      "if (oldDefinition != {} && oldDefinition.waypoints != definition.waypoints) definition.count = size(definition.waypoints) + 5;",
    );
    let state: NonNullable<ReturnType<typeof runPreview>["editing"]> | null = null;
    const edit = (parameters: Record<string, string>) => {
      const result = runPreview(runtime, [{ path: "listy.fs", source, parameters }], undefined, {
        editing: { previous: state },
      });
      state = result.editing;
      return formatInput(result.features[0]!.definition.getField("count"));
    };
    const waypoints = '[{ "height" : 1 * millimeter }]';
    edit({});
    // Adding the item changes the list: one item, so 6.
    expect(edit({ waypoints })).toBe("6");
    // Setting the count leaves the list as it was.
    expect(edit({ waypoints, count: "3" })).toBe("3");
  });

  it("gives a list item that reads a variable its other inputs' defaults", () => {
    const result = runPreview(runtime, [
      { path: "variable.fs", source: setsW },
      { path: "listy.fs", source: listy(""), parameters: { waypoints: '[{ "height" : #w }]' } },
    ]);
    const ran = result.features[1]!.run!;
    expect(ran.status, featureFailure(runtime, ran)?.message).toBe("OK");
    expect(formatInput(ran.variables.getField("firstWidth"))).toBe("0 mm");
    // The dialog's definition has the item complete too: the height read, the width defaulted.
    const [item] = untag(
      result.features[1]!.definition.getField("waypoints"),
    ) as readonly FsValue[];
    const fields = untag(item) as FsMap;
    expect([formatInput(fields.getField("height")), formatInput(fields.getField("width"))]).toEqual(
      ["20 mm", "0 mm"],
    );
  });
});
