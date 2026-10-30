import { describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../Runtime.ts";
import { FsMap } from "./Value.ts";

/**
 * Failure modes 16 and 17: features run through std's real `defineFeature` wrapper, which reports
 * errors as feature status and rolls back a failed feature's changes.
 */
const runtime = new FeatureScriptRuntime();
let counter = 0;

/** Loads a feature module whose `test` feature has the given precondition and body. */
const feature = (body: string, precondition = "") =>
  runtime.load(
    `test/feature${counter++}.fs`,
    `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
${precondition}
    }
    {
${body}
    });
`,
  );

describe("feature runs", () => {
  it("a successful feature keeps its variables and prints to the console", () => {
    const run = runtime.runFeature(
      feature('setVariable(context, "result", 6 * 7); println("hello");'),
      "test",
    );
    expect(run).toMatchObject({ status: "OK", fault: null, console: ["hello\n"] });
    expect(run.variables.getField("result")).toBe(42);
  });

  it("regenError reports the message and rolls back the feature's changes", () => {
    const run = runtime.runFeature(
      feature('setVariable(context, "x", 1);\nthrow regenError("Too small");'),
      "test",
    );
    expect(run).toMatchObject({
      status: "ERROR",
      statusEnum: "CUSTOM_ERROR",
      message: "Too small",
      fault: null,
    });
    expect(run.variables.size).toBe(0);
  });

  it("an ErrorStringEnum error keeps its enum", () => {
    const run = runtime.runFeature(
      feature("throw regenError(ErrorStringEnum.EXTRUDE_NO_DIRECTION);"),
      "test",
    );
    expect(run).toMatchObject({ status: "ERROR", statusEnum: "EXTRUDE_NO_DIRECTION" });
  });

  it("a language error inside the feature becomes a regeneration error", () => {
    const run = runtime.runFeature(feature("var m; m.x = 1;"), "test");
    expect(run).toMatchObject({ status: "ERROR", statusEnum: "REGEN_ERROR", fault: null });
  });

  it("parameters come through the definition and are checked by the precondition", () => {
    const module = feature(
      'setVariable(context, "double", definition.count * 2);',
      'annotation { "Name" : "Count" }\nisInteger(definition.count, POSITIVE_COUNT_BOUNDS);',
    );
    const ok = runtime.runFeature(module, "test", FsMap.fromEntries([["count", 3]]));
    expect(ok.status).toBe("OK");
    expect(ok.variables.getField("double")).toBe(6);
    expect(runtime.runFeature(module, "test", FsMap.empty).status).toBe("ERROR");
  });

  it("an unsupported builtin stops the run with a located fault, even under try silent", () => {
    const run = runtime.runFeature(
      feature('try silent\n{\n    opExtrude(context, id + "extrude", {});\n}'),
      "test",
    );
    expect(run.status).toBe("ERROR");
    expect(run.fault?.reason).toBe("unsupported-builtin");
    expect(run.fault?.message).toContain("@opExtrude");
    expect(run.fault?.stack.some((frame) => frame.file.startsWith("test/feature"))).toBe(true);
  });
});
