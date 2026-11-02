// @effect-diagnostics nodeBuiltinImport:off - reads the vendored std sources.
import * as NodeFS from "node:fs";

/** One `@example` / `@ex` line in std's doc comments that states its result. */
export interface StdExample {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
  readonly expected: string;
}

const STD_DIR = new URL("../../std/", import.meta.url);
const EXAMPLE = /@(?:example|ex)[\s*]+`([^`]+)`[\s*]+returns[\s*]+`([^`]+)`/g;

/** Every std doc example of the form `` @example `expr` returns `value` ``. */
export function stdExamples(): StdExample[] {
  const examples: StdExample[] = [];
  for (const file of NodeFS.readdirSync(STD_DIR)
    .filter((name) => name.endsWith(".fs"))
    .sort()) {
    const text = NodeFS.readFileSync(new URL(file, STD_DIR), "utf8");
    for (const match of text.matchAll(EXAMPLE))
      examples.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        expression: match[1]!.trim(),
        expected: match[2]!.trim(),
      });
  }
  return examples;
}
