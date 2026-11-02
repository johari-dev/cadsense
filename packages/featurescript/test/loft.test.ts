import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * opLoft connections and guides.
 *
 * Ways it goes wrong:
 * - A connection is ignored, so the loft pairs vertices its own way (no twist where one was asked).
 * - Profiles wound opposite ways pair up backward and the loft folds through itself.
 * - A connection vertex that isn't on a profile is accepted instead of raising std's error.
 * - Guides, several connections or connections at edge parameters are silently dropped.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/loft${counter++}.fs`,
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
  const result = runtime.runFeatures([{ module, feature: "test" }]);
  const feature = result.features[0]!;
  return {
    valid: allValid(result),
    status: feature.status,
    statusEnum: feature.statusEnum,
    fault: feature.fault,
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    number: (name: string) => Number(untag(feature.variables.getField(name))),
  };
};

/** Two 10 mm squares centered on the z axis, at z = 0 and z = 10. */
const SQUARES = [0, 10]
  .map((z, i) =>
    [
      `const s${i} = newSketchOnPlane(context, id + "s${i}", { "sketchPlane" : plane(vector(0, 0, ${z}) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });`,
      `skRectangle(s${i}, "r", { "firstCorner" : vector(-5, -5) * millimeter, "secondCorner" : vector(5, 5) * millimeter });`,
      `skSolve(s${i});`,
    ].join("\n"),
  )
  .join("\n");
const corner = (sketch: string, x: number, y: number, z: number) =>
  `qContainsPoint(qCreatedBy(id + "${sketch}", EntityType.VERTEX), vector(${x}, ${y}, ${z}) * millimeter)`;
const loft = (extra: string) =>
  `opLoft(context, id + "loft", { "profileSubqueries" : [qSketchRegion(id + "s0"), qSketchRegion(id + "s1")]${extra} });\n` +
  'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "loft", EntityType.BODY) }) / millimeter ^ 3);';

describe("opLoft connections", () => {
  it("pairs the profiles at a connection, twisting the loft a quarter turn", () => {
    // Corner (5, 5) at the bottom joins (5, -5) at the top. Each side is a bilinear patch, so the
    // volume is Simpson's h / 6 (A0 + 4 Am + A1): the mid-section is a diamond of area 50.
    const twisted = run(
      [
        SQUARES,
        loft(
          `, "connections" : [{ "connectionEntities" : qUnion([${corner("s0", 5, 5, 0)}, ${corner("s1", 5, -5, 10)}]), "connectionEdges" : [], "connectionEdgeParameters" : [] }]`,
        ),
      ].join("\n"),
    );
    expect(twisted.status, twisted.why).toBe("OK");
    expect(twisted.valid).toBe(true);
    expect(twisted.number("volume")).toBeCloseTo((10 / 6) * (100 + 4 * 50 + 100), 3);
    const straight = run(
      [
        SQUARES,
        loft(
          `, "connections" : [{ "connectionEntities" : qUnion([${corner("s0", 5, 5, 0)}, ${corner("s1", 5, 5, 10)}]), "connectionEdges" : [], "connectionEdgeParameters" : [] }]`,
        ),
      ].join("\n"),
    );
    expect(straight.number("volume")).toBeCloseTo(1000, 3);
  });

  it("pairs profiles that wind opposite ways", () => {
    // The top square sketched facing down, so its region winds the other way around z.
    const r = run(
      [
        SQUARES.replace(
          "plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0))",
          "plane(vector(0, 0, 10) * millimeter, vector(0, 0, -1), vector(1, 0, 0))",
        ),
        loft(
          `, "connections" : [{ "connectionEntities" : qUnion([${corner("s0", 5, 5, 0)}, ${corner("s1", 5, -5, 10)}]), "connectionEdges" : [], "connectionEdgeParameters" : [] }]`,
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("volume")).toBeCloseTo((10 / 6) * (100 + 4 * 50 + 100), 3);
  });

  it("raises std's error for a connection off a profile, and refuses what it can't match", () => {
    const off = run(
      [
        SQUARES,
        'opPoint(context, id + "elsewhere", { "point" : vector(50, 50, 10) * millimeter });',
        loft(
          `, "connections" : [{ "connectionEntities" : qUnion([${corner("s0", 5, 5, 0)}, qCreatedBy(id + "elsewhere", EntityType.VERTEX)]), "connectionEdges" : [], "connectionEdgeParameters" : [] }]`,
        ),
      ].join("\n"),
    );
    expect(off.status).toBe("ERROR");
    expect(off.statusEnum).toBe("LOFT_CONNECTION_MATCHING");
    const guided = run(
      [SQUARES, loft(', "guideSubqueries" : [qCreatedBy(id + "s0", EntityType.EDGE)]')].join("\n"),
    );
    expect(guided.fault?.message).toMatch(/guideSubqueries/);
    // Queries that find nothing are std's way of leaving an option unset.
    const unset = run(
      [SQUARES, loft(', "guideSubqueries" : [qNothing()], "connections" : []')].join("\n"),
    );
    expect(unset.status, unset.why).toBe("OK");
    expect(unset.number("volume")).toBeCloseTo(1000, 3);
  });
});
