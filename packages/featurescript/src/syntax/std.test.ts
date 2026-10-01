// @effect-diagnostics nodeBuiltinImport:off - tests read the vendored std files directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePerfHooks from "node:perf_hooks";
import { describe, expect, it } from "vite-plus/test";
import { formatDiagnostic, locate } from "./Diagnostic.ts";
import { parseModule } from "./Parser.ts";
import { sourceFile } from "./Source.ts";

const stdDir = new URL("../../std/", import.meta.url);
const manifest = JSON.parse(NodeFS.readFileSync(new URL("VERSION.json", stdDir), "utf8")) as {
  version: number;
  files: Record<string, string>;
};
const names = NodeFS.readdirSync(stdDir)
  .filter((name) => name.endsWith(".fs"))
  .sort();
const read = (name: string) => NodeFS.readFileSync(new URL(name, stdDir), "utf8");

describe(`vendored std ${manifest.version}`, () => {
  it("matches std/VERSION.json, so nobody edits std by hand", () => {
    expect(names).toEqual(Object.keys(manifest.files).sort());
    for (const name of names)
      expect(NodeCrypto.createHash("sha256").update(read(name)).digest("hex"), name).toBe(
        manifest.files[name],
      );
  });

  // Failure modes 1 and 8 in FeatureScript.md.
  it("parses every file with no diagnostics, within the time budget", () => {
    const sources = names.map((name) => sourceFile(`onshape/std/${name}`, read(name)));
    const started = NodePerfHooks.performance.now();
    const problems = sources.flatMap((file) =>
      parseModule(file).diagnostics.map((d) => formatDiagnostic(locate(file, d))),
    );
    const elapsed = NodePerfHooks.performance.now() - started;
    expect(problems).toEqual([]);
    // ~230 ms on a dev machine for 7 MB; the budget leaves room for slow CI.
    expect(elapsed).toBeLessThan(3000);
  });

  it("starts every file with the vendored version header", () => {
    for (const name of names)
      expect(parseModule(sourceFile(name, read(name))).module.version, name).toBe(manifest.version);
  });
});
