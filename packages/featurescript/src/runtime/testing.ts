import { FeatureScriptRuntime } from "../Runtime.ts";
import { FsFault, FsThrow } from "./Errors.ts";
import { equals, formatValue, type FsValue } from "./Value.ts";

type Outcome = { readonly value: FsValue } | { readonly thrown: FsValue };

/** One runtime per test file: std is loaded and its constants evaluated once. */
export const testRuntime = (options: { readonly maxSteps?: number } = {}) => {
  const runtime = new FeatureScriptRuntime(options);
  let counter = 0;

  /**
   * Loads a module importing all of std, with `top` declarations, `actual()` running `body`, and
   * `expected()` returning `expected`. Both share the module, so they see the same enums and types.
   */
  const load = (body: string, top: string, expected = "undefined") =>
    runtime.load(
      `test/case${counter++}.fs`,
      `FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n${top}\nexport function actual()\n{\n${body}\n}\nexport function expected()\n{\nreturn ${expected};\n}\n`,
    );
  const call = (module: ReturnType<typeof load>, name: string): Outcome => {
    try {
      return {
        value: runtime.interpreter.callFunction(
          runtime.interpreter.topLevelValue(module, name),
          [],
        ),
      };
    } catch (error) {
      if (error instanceof FsThrow) return { thrown: error.value };
      throw error;
    }
  };
  const describe = (outcome: Outcome) =>
    "value" in outcome ? formatValue(outcome.value) : `exception ${formatValue(outcome.thrown)}`;

  /** `body` returns a value equal to the FeatureScript expression `expected`. */
  const expectValue = (body: string, expected: string, top = "") => {
    const module = load(body, top, expected);
    const wanted = call(module, "expected");
    const actual = call(module, "actual");
    if (!("value" in wanted)) throw new Error(`The expected expression raised ${describe(wanted)}`);
    if (!("value" in actual) || !equals(actual.value, wanted.value))
      throw new Error(`Got ${describe(actual)}; expected ${describe(wanted)}`);
  };

  /** `body` raises a FeatureScript exception (one `try` could catch). */
  const expectThrow = (body: string, top = "") => {
    const actual = call(load(body, top), "actual");
    if ("value" in actual) throw new Error(`Expected an exception, got ${describe(actual)}`);
  };

  /** `body` stops with a fault FeatureScript can't catch. */
  const expectFault = (body: string, reason: FsFault["reason"], top = "") => {
    let actual: Outcome;
    try {
      actual = call(load(body, top), "actual");
    } catch (error) {
      if (!(error instanceof FsFault)) throw error;
      if (error.reason !== reason)
        throw new Error(`Expected a ${reason} fault, got ${error.reason}: ${error.message}`, {
          cause: error,
        });
      return;
    }
    throw new Error(`Expected a ${reason} fault, got ${describe(actual)}`);
  };

  return { runtime, load, call, expectValue, expectThrow, expectFault };
};
