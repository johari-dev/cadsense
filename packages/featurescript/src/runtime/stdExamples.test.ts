import { describe, expect, it } from "vite-plus/test";
import { stdExamples } from "./stdExamples.ts";
import { testRuntime } from "./testing.ts";

/**
 * Failure mode 12: std's own `` @example `expr` returns `value` `` doc lines, written by Onshape, run
 * through real std overloads. Examples known to be wrong as written are listed with the reason; the
 * test fails if one of them starts passing, so this list can only shrink.
 */
const KNOWN_WRONG: Readonly<Record<string, string>> = {
  "math.fs:70":
    "abs(1 - 1.01) is 0.010000000000000009 in IEEE doubles, which Onshape also uses, so this is false",
  "math.fs:175": "the result is written as `2.71828...`, not a value",
  "math.fs:176": "exp(log(3)) is 2.9999999999999996 in IEEE doubles",
  "string.fs:150": "the result `X~X~a` is missing its quotes",
  "string.fs:218": "splitByRegex isn't a std function (the real one is splitByRegexp)",
};

/** Splits `a; b; c` on semicolons outside brackets, so lambdas in examples stay whole. */
const statements = (source: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      out.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(source.slice(start).trim());
  return out.filter(Boolean);
};

const { expectValue } = testRuntime();
const examples = stdExamples();

describe("std doc examples", () => {
  it("finds the examples", () => expect(examples.length).toBeGreaterThan(140));

  it.each(
    examples.map(
      (example) => [`${example.file}:${example.line} ${example.expression}`, example] as const,
    ),
  )("%s", (_, example) => {
    const parts = statements(example.expression);
    const body = [...parts.slice(0, -1).map((part) => `${part};`), `return ${parts.at(-1)};`].join(
      "\n",
    );
    const known = KNOWN_WRONG[`${example.file}:${example.line}`];
    let failure: unknown = null;
    try {
      expectValue(body, example.expected);
    } catch (error) {
      failure = error;
    }
    if (known === undefined && failure) throw failure;
    if (known !== undefined && !failure)
      throw new Error(
        `Listed as known wrong (${known}) but now passes; remove it from KNOWN_WRONG.`,
      );
  });
});
