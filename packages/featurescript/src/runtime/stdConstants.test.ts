// @effect-diagnostics nodeBuiltinImport:off - lists the vendored std files.
import * as NodeFS from "node:fs";
import * as NodePerfHooks from "node:perf_hooks";
import { describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../Runtime.ts";
import { FsFault, FsThrow } from "./Errors.ts";
import { formatValue } from "./Value.ts";

/**
 * Failure modes 18 and 19: every top-level constant in std evaluates, and loading std is fast enough
 * to do per preview worker. Constants Onshape itself never evaluates are listed with the reason; the
 * test fails if one of them starts evaluating, so the list can only shrink.
 */
const NEVER_EVALUATED: Readonly<Record<string, string>> = {
  "tolerance.fs lengthTolerance":
    "defineTolerance calls its one-argument lambda with no arguments; only the precondition (the tolerance UI) is used",
  "tolerance.fs diameterTolerance": "same as lengthTolerance",
  "tolerance.fs angleTolerance": "same as lengthTolerance",
};

describe("std constants", () => {
  it("evaluate, and std loads quickly", () => {
    const runtime = new FeatureScriptRuntime();
    const names = NodeFS.readdirSync(new URL("../../std/", import.meta.url)).filter((name) =>
      name.endsWith(".fs"),
    );
    const started = NodePerfHooks.performance.now();
    for (const name of names) runtime.load(`onshape/std/${name}`);
    const loadMs = NodePerfHooks.performance.now() - started;

    const failures: string[] = [];
    let count = 0;
    for (const module of runtime.loader.loaded)
      for (const [name, entries] of module.own)
        for (const entry of entries) {
          if (entry.kind !== "const") continue;
          count++;
          const key = `${module.path.slice("onshape/std/".length)} ${name}`;
          try {
            runtime.interpreter.topLevelValue(module, name);
          } catch (error) {
            if (!(error instanceof FsThrow) && !(error instanceof FsFault)) throw error;
            if (!NEVER_EVALUATED[key])
              failures.push(
                `${key}: ${error instanceof FsThrow ? formatValue(error.value) : error.message}`,
              );
            continue;
          }
          if (NEVER_EVALUATED[key])
            failures.push(`${key} now evaluates; remove it from NEVER_EVALUATED.`);
        }
    expect(count).toBeGreaterThan(900);
    expect(failures).toEqual([]);
    // ~220 ms on a dev machine to parse and link all 276 files.
    expect(loadMs).toBeLessThan(3000);
  });
});
