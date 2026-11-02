// @effect-diagnostics nodeBuiltinImport:off - runs the preview CLI as a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/** The preview CLI, run the way a person or an agent runs it. */
const packageDir = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const preview = (args: readonly string[]) =>
  NodeChildProcess.spawnSync(process.execPath, ["scripts/preview.ts", ...args], {
    cwd: packageDir,
    encoding: "utf8",
    timeout: 120_000,
  });

describe("preview CLI", () => {
  it("previews a feature on another feature's geometry and writes the artifacts", () => {
    const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fs-preview-"));
    const result = preview([
      "corpus/bolt-circle/feature.fs",
      "--before",
      "corpus/bolt-circle/plate.fs:plate",
      "--param",
      'face=qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(50, 30, 10) * millimeter)',
      "--param",
      "count=8",
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Bolt circle (boltCircle in corpus/bolt-circle/feature.fs): OK",
    );
    // 60000 - 8 * PI * 2.5^2 * 10
    expect(result.stdout).toContain("58429.204 mm^3, 14 faces");
    for (const file of [
      "iso.png",
      "top.png",
      "front.png",
      "right.png",
      "result.glb",
      "report.json",
    ])
      expect(NodeFS.existsSync(NodePath.join(out, file)), file).toBe(true);
  });

  it("cuts into a STEP base in millimeters, in a process that never wrote a STEP file", () => {
    const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fs-preview-"));
    const result = preview([
      "corpus/bolt-circle/feature.fs",
      "--base",
      "corpus/bolt-circle/plate.step",
      "--param",
      'face=qContainsPoint(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter)',
      "--out",
      out,
    ]);
    expect(result.status, result.stdout).toBe(0);
    // 60000 - 6 * PI * 2.5^2 * 10
    expect(result.stdout).toContain("from Base: 58821.903 mm^3, 12 faces");
  });

  it("explains a failure with its cause and the line that caused it", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fs-preview-"));
    const file = NodePath.join(dir, "bad.fs");
    NodeFS.writeFileSync(
      file,
      `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Bad" }
export const bad = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "b", { "corner1" : vector(0, 0, 0), "corner2" : vector(10, 10, 10) * millimeter });
    });
`,
    );
    const result = preview([file, "--out", NodePath.join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "cause: Precondition of function failed: is3dLengthVector(definition.corner1);",
    );
    expect(result.stdout).toContain(`${file}:7:9`);
  });
});
