// @effect-diagnostics nodeBuiltinImport:off - tests read fixture files directly.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { locate } from "./Diagnostic.ts";
import { parseModule } from "./Parser.ts";
import { sourceFile } from "./Source.ts";

const brokenDir = new URL("../../test/broken/", import.meta.url);

/** `line:column code` for every diagnostic, in source order. */
const diagnosticsOf = (path: string, text: string) => {
  const file = sourceFile(path, text);
  return parseModule(file).diagnostics.map((d) => {
    const { start, code } = locate(file, d);
    return `${start.line}:${start.column} ${code}`;
  });
};

// Failure modes 2, 5, 6 and 7 in FeatureScript.md. Each fixture lists every diagnostic it must produce
// in `// expect: line:column code` header lines, so extra (cascading) diagnostics fail the test too.
describe("broken fixtures", () => {
  const fixtures = NodeFS.readdirSync(brokenDir).filter((name) => name.endsWith(".fs"));
  it.each(fixtures)("%s", (name) => {
    const text = NodeFS.readFileSync(new URL(name, brokenDir), "utf8");
    const expected = [...text.matchAll(/^\/\/ expect: (\d+:\d+ [a-z-]+)$/gm)].map((m) => m[1]);
    expect(expected.length).toBeGreaterThan(0);
    expect(diagnosticsOf(name, text)).toEqual(expected);
  });
});

describe("positions", () => {
  it("counts CRLF as one line break and columns in UTF-16 units", () => {
    const text = "FeatureScript 3083;\r\n// naïve ✨ 😀 comment\r\nfunction f() { return 1 }\r\n";
    expect(diagnosticsOf("crlf.fs", text)).toEqual(["3:24 expected"]);
  });

  it("puts a missing semicolon after the previous token, not at the next line", () => {
    const text = "FeatureScript 3083;\nfunction f()\n{\n    f()\n    g();\n}\n";
    expect(diagnosticsOf("semicolon.fs", text)).toEqual(["4:8 expected"]);
  });
});
