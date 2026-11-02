import { describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { testRuntime } from "../src/runtime/testing.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * The vendored std is 3095 (released 2026-10-09). Ways the update goes wrong: contexts still report
 * 3083; 3095's additions (configurationInfo.fs, `libraryVerify`, the five-argument `table`, new
 * enum members) don't load or don't run; scripts that declare `FeatureScript 3083;` or older, or
 * import std at "3083.0", stop running; integer literals past 2^53 or 2^64
 * (`V3095_LARGE_INTEGER_LITERALS`) fail to parse or lose more than IEEE double rounding.
 * `src/syntax/std.test.ts` checks the files against VERSION.json and that each declares 3095.
 */
const { expectValue } = testRuntime();

describe("std 3095", () => {
  it("is the version new contexts run at", () => {
    expectValue(
      "return getCurrentVersion(newContext());",
      "FeatureScriptVersionNumber.V3095_LARGE_INTEGER_LITERALS",
    );
    expectValue(
      "return FeatureScriptVersionNumberCurrent;",
      "FeatureScriptVersionNumber.V3095_LARGE_INTEGER_LITERALS",
    );
    expectValue(
      "return isAtVersionOrLater(newContext(), FeatureScriptVersionNumber.V3094_SWEEP_EXTEND_PATH_PRESERVES_OPERATION_TYPE);",
      "true",
    );
  });

  it("has 3095's additions", () => {
    expectValue(
      'const problems = new box([]); libraryVerify(false, problems, "A"); libraryVerify(true, problems, "B"); return problems[];',
      '["A"]',
    );
    expectValue('return table("Wires", [], [], qNothing(), "12 mm").titleSuffix;', '"12 mm"');
    // `as` runs the typecheck, whose predicate picks the input type's rules with a `switch`.
    expectValue(
      'const input = { "id" : "thickness", "name" : "Thickness", "excludeFromProperties" : false, "inputType" : ConfigurationInputType.LENGTH, "defaultValue" : 1, "minValue" : 0, "maxValue" : 10, "units" : millimeter } as ConfigurationInputInfo; return ({ "inputs" : [input] } as ConfigurationInfo) is ConfigurationInfo;',
      "true",
      'import(path : "onshape/std/configurationInfo.fs", version : "3095.0");',
    );
    expectValue("return ConstraintType.EQUAL_CURVATURE_G3 is ConstraintType;", "true");
    expectValue(
      "return PCB_K_FACTOR_BOUNDS[unitless];",
      "[0, 0, 1]",
      'import(path : "onshape/std/sheetMetalUtils.fs", version : "3095.0");',
    );
  });

  it("reads integer literals past 2^53 and 2^64 as the nearest double", () => {
    // 2^53 + 1 rounds to 2^53; 2^64 + 1 and a 20-digit literal round the same way a decimal
    // literal with an exponent does.
    expectValue("return 9007199254740993;", "9007199254740992");
    expectValue("return 18446744073709551617;", "1.8446744073709552e19");
    expectValue("return 98765432109876543210 - 9.876543210987654e19;", "0");
    expectValue("return isInteger(123456789012345678901234567890);", "true");
  });
});

describe("scripts written for older std", () => {
  it("run when they declare 3083 or 1560 and import std at that version", async () => {
    const runtime = await FeatureScriptRuntime.withGeometry();
    for (const version of [3083, 1560]) {
      const module = runtime.load(
        `test/stdVersion${version}.fs`,
        `FeatureScript ${version};
import(path : "onshape/std/geometry.fs", version : "${version}.0");
annotation { "Feature Type Name" : "Old" }
export const old = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 20, 30) * millimeter });
        setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id, EntityType.BODY) }) / millimeter ^ 3);
    });
`,
      );
      const run = runtime.runFeature(module, "old");
      expect(run.status, `${version}: ${run.fault?.message}`).toBe("OK");
      expect(Number(untag(run.variables.getField("volume"))), String(version)).toBeCloseTo(6000, 6);
    }
  });
});
