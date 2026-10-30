import { beforeAll, describe, expect, it } from "vite-plus/test";
import { numberVariable, partStudio, variable } from "./partStudio.ts";

/**
 * Operation bookkeeping builtins and the identity tracking queries built on `lastOperationId`.
 *
 * Ways this can fail:
 * - `lastOperationId` stays unsupported, so every std feature that makes a robust query (the Query
 *   variable feature, rib, frame) faults before it does anything.
 * - Identity tracking loses an entity that a later operation modified one-to-one (a filleted face),
 *   or keeps one that was deleted.
 * - Tracking silently gives a wrong answer where it can't know the right one: an entity split or
 *   merged by a later operation, or `startTracking`'s derived entities (which need history this
 *   runtime doesn't record). Those must stop the run.
 * - A rolled-back feature's geometry changes leak into tracking.
 * - `valuesSortedById` sorts by key instead of start order; `containsSketch` misses a sketch or
 *   counts a feature that only contains one.
 * - `getLanguageVersion` reports std's version for a user module, or the reverse.
 * - `getFeatureName` returns something a table-only builtin can't know inside a feature.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
const topFace =
  'qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(5, 5, 10) * millimeter)';
const queryVariable = (selection: string) => ({
  std: "queryVariable.fs",
  feature: "queryVariable",
  parameters: {
    name: '"top"',
    selectionType: "SelectionType.SELECTION",
    selectionQuery: selection,
  },
});
const readTop = `
  const top = getQueryVariable(context, "top");
  setVariable(context, "count", size(evaluateQuery(context, top)));
  if (size(evaluateQuery(context, top)) == 1)
      setVariable(context, "areaMm2", evArea(context, { "entities" : top }) / (millimeter ^ 2));`;
const outcomes = (run: ReturnType<typeof studio.run>) =>
  run.features.map((feature) => feature.fault?.message ?? feature.status);

describe("identity tracking", () => {
  it("std's Query variable feature follows a face that a later fillet modifies", () => {
    const run = studio.run([
      { body: cube },
      queryVariable(topFace),
      {
        body: 'fillet(context, id + "fillet", { "entities" : qParallelEdges(qCreatedBy(makeId("Feature1"), EntityType.EDGE), Z_DIRECTION), "radius" : 1 * millimeter });',
      },
      { body: readTop },
    ]);
    expect(outcomes(run)).toEqual(["OK", "OK", "OK", "OK"]);
    expect(numberVariable(run, "count")).toBe(1);
    // The 10 x 10 top loses (4 - PI) r^2 to its four rounded corners, r = 1 mm.
    expect(numberVariable(run, "areaMm2")).toBeCloseTo(100 - (4 - Math.PI), 6);
  });

  it("resolves to nothing once the tracked entity's body is deleted", () => {
    const run = studio.run([
      { body: cube },
      queryVariable(topFace),
      {
        body: 'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(makeId("Feature1"), EntityType.BODY) });',
      },
      { body: readTop },
    ]);
    expect(outcomes(run)).toEqual(["OK", "OK", "OK", "OK"]);
    expect(numberVariable(run, "count")).toBe(0);
  });

  it("stops the run when the tracked entity was split, rather than guess which piece follows it", () => {
    const run = studio.run([
      { body: cube },
      queryVariable(topFace),
      {
        body: 'opSplitPart(context, id + "split", { "targets" : qCreatedBy(makeId("Feature1"), EntityType.BODY), "tool" : plane(vector(5, 0, 0) * millimeter, X_DIRECTION) });',
      },
      { body: readTop },
    ]);
    expect(outcomes(run).slice(0, 3)).toEqual(["OK", "OK", "OK"]);
    expect(run.features[3]!.fault?.message).toMatch(/split, merged or consumed/);
  });

  it("ignores changes a rolled-back feature made", () => {
    const run = studio.run([
      { body: cube },
      queryVariable(topFace),
      {
        body: 'opDeleteBodies(context, id + "delete", { "entities" : qCreatedBy(makeId("Feature1"), EntityType.BODY) });\nthrow regenError("undo");',
      },
      { body: readTop },
    ]);
    expect(outcomes(run)).toEqual(["OK", "OK", "ERROR", "OK"]);
    expect(numberVariable(run, "count")).toBe(1);
    expect(numberVariable(run, "areaMm2")).toBeCloseTo(100, 9);
  });

  it("makeRobustQuery includes the entity itself", () => {
    const run = studio.run([
      {
        body: `${cube}
        const robust = makeRobustQuery(context, qCreatedBy(id, EntityType.FACE));
        setVariable(context, "count", size(evaluateQuery(context, robust)));
        setVariable(context, "lastIsId", canBeId(@lastOperationId(context)));`,
      },
    ]);
    expect(outcomes(run)).toEqual(["OK"]);
    expect(numberVariable(run, "count")).toBe(6);
    expect(variable(run, "lastIsId")).toBe(true);
  });

  it("startTracking's derived entities stop the run as unsupported", () => {
    const run = studio.run([
      {
        body: `${cube}
        const tracked = startTracking(context, qCreatedBy(id, EntityType.EDGE));
        evaluateQuery(context, tracked);`,
      },
    ]);
    expect(run.features[0]!.fault?.message).toMatch(/startTracking/);
  });
});

describe("operation ids", () => {
  it("lastModifyingOperationId moves on when an operation modifies the entity, and throws for nothing", () => {
    const run = studio.run([
      {
        body: `${cube}
        const top = qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 5, 10) * millimeter);
        const side = qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(5, 0, 5) * millimeter);
        const before = lastModifyingOperationId(context, top);
        // fCuboid's last operation deletes its sketch, after the extrude that made the top.
        setVariable(context, "createdBeforeLast", before != (@lastOperationId(context) as Id));
        fillet(context, id + "fillet", { "entities" : qContainsPoint(qCreatedBy(id, EntityType.EDGE), vector(5, 10, 10) * millimeter), "radius" : 1 * millimeter });
        setVariable(context, "topMoved", lastModifyingOperationId(context, top) != before);
        setVariable(context, "topIsLast", lastModifyingOperationId(context, top) == (@lastOperationId(context) as Id));
        setVariable(context, "sideStayed", lastModifyingOperationId(context, side) == before);
        var caught;
        try silent { lastModifyingOperationId(context, qNothing()); }
        catch (error) { caught = true; }
        setVariable(context, "throwsForNothing", caught);`,
      },
    ]);
    expect(outcomes(run)).toEqual(["OK"]);
    expect(variable(run, "createdBeforeLast")).toBe(true);
    expect(variable(run, "topMoved")).toBe(true);
    expect(variable(run, "topIsLast")).toBe(true);
    expect(variable(run, "sideStayed")).toBe(true);
    expect(variable(run, "throwsForNothing")).toBe(true);
  });

  it("valuesSortedById sorts by when each subfeature started, not by id", () => {
    const run = studio.run([
      {
        body: `
        fCuboid(context, id + "zeta", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(1, 1, 1) * millimeter });
        fCuboid(context, id + "alpha", { "corner1" : vector(2, 0, 0) * millimeter, "corner2" : vector(3, 1, 1) * millimeter });
        setVariable(context, "sorted", valuesSortedById(context, { (id + "alpha") : "alpha", (id + "zeta") : "zeta" }));`,
      },
    ]);
    expect(outcomes(run)).toEqual(["OK"]);
    expect(variable(run, "sorted")).toEqual(["zeta", "alpha"]);
  });

  it("containsSketch is true only for a sketch's own id", () => {
    const run = studio.run([
      {
        body: `
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : XY_PLANE });
        skCircle(sketch, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 5 * millimeter });
        skSolve(sketch);
        ${cube}
        const f = function(context is Context, id is Id, definition is map) {};
        setVariable(context, "sketch", containsSketch(context, { (id + "sketch") : f, (id + "cube") : f }));
        setVariable(context, "cube", containsSketch(context, { (id + "cube") : f }));
        setVariable(context, "feature", containsSketch(context, { (id) : f }));`,
      },
    ]);
    expect(outcomes(run)).toEqual(["OK"]);
    expect(variable(run, "sketch")).toBe(true);
    expect(variable(run, "cube")).toBe(false);
    expect(variable(run, "feature")).toBe(false);
  });
});

describe("environment", () => {
  it("reports the calling module's language version, and no feature names inside a feature", () => {
    const run = studio.run([
      {
        body: `
        setVariable(context, "user", @getLanguageVersion());
        setVariable(context, "library", libraryLanguageVersion());
        setVariable(context, "name", try silent(getFeatureName(context, id)));
        skipOrderDisambiguation(context, id + "derived");
        setVariable(context, "converted", @convert([1, 2], undefined));
        @clampContextVersion(context, { "loadedContext" : newContext() });`,
      },
    ]);
    expect(outcomes(run)).toEqual(["OK"]);
    expect(numberVariable(run, "user")).toBe(3083);
    // std's own modules declare `FeatureScript 3095;`.
    expect(numberVariable(run, "library")).toBe(3095);
    expect(variable(run, "name")).toBeUndefined();
    expect(variable(run, "converted")).toEqual([1, 2]);
  });

  it("stops on a conversion it can't do", () => {
    const run = studio.run([
      { body: "@convert([1, 2], FeatureScriptVersionNumber.V0_ORIGINAL_VERSION);" },
    ]);
    expect(run.features[0]!.fault?.message).toMatch(/@convert to a FeatureScript version/);
  });
});
