import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag } from "../src/runtime/Value.ts";
import { partStudio, variable } from "./partStudio.ts";

/**
 * Features held back to an older FeatureScript version (`definition.asVersion`), as Onshape runs
 * features made before a std upgrade.
 *
 * Ways this can fail:
 * - `asVersion` is ignored, so version-gated std code takes today's path.
 * - The lower version leaks: into later features, or out of a subfeature into its parent after
 *   the subfeature ends.
 * - A subfeature doesn't inherit its parent's held-back version, or a subfeature asking for a
 *   newer version raises it.
 * - `@isAtVersionOrLater`'s third argument (sketch.fs passes `value.asVersion`) is ignored.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const V681 = "FeatureScriptVersionNumber.V681_ANGLE_BOUNDS_CHANGE";
const V600 = "FeatureScriptVersionNumber.V600_PIERCE_COEDGE";
const angle = (asVersion?: string) => ({
  std: "variable.fs",
  feature: "assignVariable",
  parameters: {
    name: '"turn"',
    variableType: "VariableType.ANGLE",
    angleValue: "370 * degree",
    ...(asVersion ? { asVersion } : {}),
  },
});
const readTurn = {
  body: 'setVariable(context, "turnDegrees", getVariable(context, "turn") / degree);',
};
const turnDegrees = (run: ReturnType<typeof studio.run>) =>
  untag(variable(run, "turnDegrees")) as number;

describe("held-back features", () => {
  it("take std's older path in the Variable feature", () => {
    // Before V694 the Variable feature adjusts angles: from V681 it wraps them into a turn,
    // before V681 it rejects anything past 360 degrees.
    const current = studio.run([angle(), readTurn]);
    expect(current.features.map((f) => f.status)).toEqual(["OK", "OK"]);
    expect(turnDegrees(current)).toBeCloseTo(370, 9);

    const wrapped = studio.run([angle(V681), readTurn]);
    expect(wrapped.features.map((f) => f.status)).toEqual(["OK", "OK"]);
    expect(turnDegrees(wrapped)).toBeCloseTo(10, 9);

    const rejected = studio.run([angle(V600)]);
    expect(rejected.features[0]).toMatchObject({
      status: "ERROR",
      statusEnum: "PARAMETER_OUT_OF_RANGE",
      fault: null,
    });
  });

  it("hold back their subfeatures, and only until they end", () => {
    const check = (name: string) =>
      `setVariable(context, "${name}", isAtVersionOrLater(context, FeatureScriptVersionNumber.V694_FILL_GUIDE_CURVES_FS));`;
    const run = studio.run([
      {
        parameters: { asVersion: V681 },
        body: `
        ${check("held")}
        setVariable(context, "current", getCurrentVersion(context) == ${V681});
        startFeature(context, id + "sub", {});
        ${check("sub")}
        endFeature(context, id + "sub");
        startFeature(context, id + "newer", { "asVersion" : FeatureScriptVersionNumber.V700_REVERTED_TANGENT_JOINT });
        ${check("newer")}
        endFeature(context, id + "newer");
        ${check("after")}`,
      },
      {
        body: `
        ${check("next")}
        startFeature(context, id + "older", { "asVersion" : ${V681} });
        ${check("older")}
        endFeature(context, id + "older");
        ${check("restored")}
        setVariable(context, "explicit", @isAtVersionOrLater(context, FeatureScriptVersionNumber.V694_FILL_GUIDE_CURVES_FS, ${V681}));
        setVariable(context, "explicitUndefined", @isAtVersionOrLater(context, FeatureScriptVersionNumber.V694_FILL_GUIDE_CURVES_FS, undefined));`,
      },
    ]);
    expect(run.features.map((f) => f.fault?.message ?? f.status)).toEqual(["OK", "OK"]);
    const value = (name: string, feature: number) => variable(run, name, feature);
    expect(value("held", 0)).toBe(false);
    expect(value("current", 0)).toBe(true);
    expect(value("sub", 0)).toBe(false);
    expect(value("newer", 0)).toBe(false);
    expect(value("after", 0)).toBe(false);
    expect(value("next", 1)).toBe(true);
    expect(value("older", 1)).toBe(false);
    expect(value("restored", 1)).toBe(true);
    expect(value("explicit", 1)).toBe(false);
    expect(value("explicitUndefined", 1)).toBe(true);
  });
});
