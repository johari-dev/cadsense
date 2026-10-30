import { beforeAll, describe, expect, it } from "vite-plus/test";
import { featureFailure, runPreview } from "../src/preview/Preview.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";

/** One warm runtime previews many edits of the same script, the way the server's worker does. */
const cube = (size: number) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Cube" }
export const cube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${size}, ${size}, ${size}) * millimeter });
    });
`;

let runtime: FeatureScriptRuntime;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

describe("runPreview on a warm runtime", () => {
  it("runs the edited source, not the first one loaded at that path", () => {
    const volume = (source: string) =>
      runPreview(runtime, [{ path: "cube.fs", source }]).solids.map((solid) =>
        Math.round(solid.volumeMm3),
      );
    expect(volume(cube(10))).toEqual([1000]);
    expect(volume(cube(20))).toEqual([8000]);
  });

  it("recovers from a script that failed to load", () => {
    expect(() =>
      runPreview(runtime, [{ path: "cube.fs", source: cube(10).replace("precondition", "") }]),
    ).toThrow();
    expect(
      runPreview(runtime, [{ path: "cube.fs", source: cube(10) }]).features[0]?.run?.status,
    ).toBe("OK");
  });

  it("refuses a script that claims a standard library path, and std stays intact", () => {
    // Std loads lazily, so a caller-supplied source at a std path would replace it in a warm
    // runtime for every later preview, the agent's included.
    expect(() =>
      runPreview(runtime, [
        { path: "onshape/std/context.fs", source: cube(10).replace("fCuboid", "throw") },
      ]),
    ).toThrow(/standard library/);
    expect(
      runPreview(runtime, [{ path: "cube.fs", source: cube(10) }]).features[0]?.run?.status,
    ).toBe("OK");
  });

  it("has no change to report when the previewed feature never ran", () => {
    const failing = cube(10).replace("fCuboid(", 'throw regenError("first"); fCuboid(');
    const result = runPreview(runtime, [
      { path: "first.fs", source: failing.replace("Cube", "First").replace("cube =", "first =") },
      { path: "cube.fs", source: cube(10) },
    ]);
    expect(result.features.map((feature) => feature.run?.status ?? "NOT_RUN")).toEqual([
      "ERROR",
      "OK",
    ]);
    const faulting = cube(10).replace("fCuboid(", "@opHelix(context, id, {}); fCuboid(");
    const stopped = runPreview(runtime, [
      { path: "fault.fs", source: faulting.replace("cube =", "fault =") },
      { path: "cube.fs", source: cube(10) },
    ]);
    expect(stopped.features[1]?.run).toBeNull();
    expect(stopped.changes).toBeNull();
  });

  it("summarizes each solid with its name and its bounds in millimeters", () => {
    // Failure modes: bounds in meters, inside the solid, or loose by more than the tessellation;
    // the name set by setProperty missing; a solid with no name given a made-up one.
    const named = cube(10)
      .replace("vector(0, 0, 0) * millimeter", "vector(-5, 2, 0) * millimeter")
      .replace(
        "});\n    });",
        '});\n        setProperty(context, { "entities" : qCreatedBy(id + "c", EntityType.BODY), "propertyType" : PropertyType.NAME, "value" : "Spark MAX" });\n    });',
      );
    const [solid] = runPreview(runtime, [{ path: "named.fs", source: named }]).solids;
    expect(solid?.name).toBe("Spark MAX");
    // Within the tessellation's deflection, and never inside the solid.
    const near = (actual: readonly number[] | undefined, expected: number[], outward: 1 | -1) =>
      expected.forEach((n, i) => {
        expect(Math.abs(actual![i]! - n)).toBeLessThan(0.06);
        expect((actual![i]! - n) * outward).toBeGreaterThanOrEqual(-1e-9);
      });
    near(solid?.boundsMm.min, [-5, 2, 0], -1);
    near(solid?.boundsMm.max, [10, 10, 10], 1);
    expect(runPreview(runtime, [{ path: "cube.fs", source: cube(10) }]).solids[0]?.name).toBeNull();
  });

  it("reports a regenError by its message and the line that threw it", () => {
    // Failure modes: the thrown map shown raw; an exception the feature caught earlier blamed
    // instead of the throw; an ErrorStringEnum error with no message; a rethrown error found twice.
    const before = (body: string) => cube(10).replace("fCuboid(", `${body}\n        fCuboid(`);
    const lineOf = (source: string, text: string) =>
      source.split("\n").findIndex((line) => line.includes(text)) + 1;
    const failure = (source: string) =>
      featureFailure(runtime, runPreview(runtime, [{ path: "fails.fs", source }]).features[0]!.run);

    const direct = before('throw regenError("Add at least two waypoints", ["waypoints"]);');
    expect(failure(direct)).toMatchObject({
      message: "Add at least two waypoints",
      location: { path: "fails.fs", line: lineOf(direct, "throw regenError") },
    });

    const caughtFirst = before(
      'try { throw "earlier"; } catch (error) {}\n        throw regenError("Pick a connector");',
    );
    expect(failure(caughtFirst)).toMatchObject({
      message: "Pick a connector",
      location: { line: lineOf(caughtFirst, "Pick a connector") },
    });

    const rethrown = before(
      'try { throw regenError("Path crosses itself"); } catch (error) { throw error; }',
    );
    expect(failure(rethrown)?.message).toBe("Path crosses itself");

    const byEnum = before("throw regenError(ErrorStringEnum.EXTRUDE_NO_DIRECTION);");
    expect(failure(byEnum)).toMatchObject({
      message: "EXTRUDE_NO_DIRECTION",
      location: { line: lineOf(byEnum, "EXTRUDE_NO_DIRECTION") },
    });

    // A recovered exception isn't the cause, even when it carries the same message.
    const recovered = before(
      'try { throw "recovered"; } catch (error) {}\n        var m; m.x = 1;',
    );
    expect(failure(recovered)).toMatchObject({ location: { line: lineOf(recovered, "m.x = 1") } });
    expect(failure(recovered)?.message).not.toBe("recovered");
    const sameTwice = before(
      'try { throw regenError("same"); } catch (error) {}\n        throw regenError("same", ["x"]);',
    );
    expect(failure(sameTwice)?.location?.line).toBe(lineOf(sameTwice, '"same", ["x"]'));
    // A rethrow (Aarav's Wiring script does this around opSweep) is blamed where it was first thrown.
    const rethrowAt = before(
      'try {\n        throw regenError("Path crosses itself");\n        } catch (error) { println("cleanup"); throw error; }',
    );
    expect(failure(rethrowAt)?.location?.line).toBe(lineOf(rethrowAt, "throw regenError"));

    // A language error has only std's generic REGEN_ERROR; the exception says what went wrong.
    const generic = failure(before("var m; m.x = 1;"));
    expect(generic?.message).not.toMatch(/^\{|REGEN_ERROR/);
    expect(generic?.location?.line).toBe(lineOf(before("var m; m.x = 1;"), "m.x = 1"));
  });

  it("loads imports of other Onshape documents as unavailable, and names them where they're used", () => {
    // Community scripts import icons, images and libraries by Onshape element id. Icons only feed
    // annotations, so a script that imports nothing else runs; a missing library fails at its use.
    const withIcon = cube(10)
      .replace(
        'import(path : "onshape/std/geometry.fs", version : "3083.0");',
        'import(path : "onshape/std/geometry.fs", version : "3083.0");\nicon::import(path : "48b129c6e2a454acde3a3baf", version : "53bdfee7fd2c348eaa0b8dc3");',
      )
      .replace(
        '"Feature Type Name" : "Cube"',
        '"Feature Type Name" : "Cube", "Icon" : icon::BLOB_DATA',
      );
    const ran = runPreview(runtime, [{ path: "icon.fs", source: withIcon }]);
    expect(ran.features[0]?.spec.typeName).toBe("Cube");
    expect(ran.features[0]?.run?.status).toBe("OK");

    const usesLibrary = cube(10)
      .replace(
        'import(path : "onshape/std/geometry.fs", version : "3083.0");',
        'import(path : "onshape/std/geometry.fs", version : "3083.0");\nimport(path : "9f4c9835d8018ff7dbdb5683/ffaca39d1d22450f59e60d16/c60f4a6e12f07acee647a2a1", version : "198e65e227da4b79f32bd021");',
      )
      .replace("fCuboid(", "libraryHelper(context); fCuboid(");
    const fault = runPreview(runtime, [{ path: "lib.fs", source: usesLibrary }]).features[0]?.run
      ?.fault;
    expect(fault?.message).toMatch(/libraryHelper not found/);
    expect(fault?.message).toMatch(/c60f4a6e12f07acee647a2a1.*isn't available locally/);

    // Types from a missing library (an enum in the feature's precondition) say the same.
    const usesLibraryType = usesLibrary
      .replace("libraryHelper(context); ", "")
      .replace("precondition {}", "precondition { definition.mode is LibraryMode; }");
    expect(() => runPreview(runtime, [{ path: "lib.fs", source: usesLibraryType }])).toThrow(
      /Type LibraryMode not found\. It may come from Onshape element .*c60f4a6e12f07acee647a2a1/,
    );

    // A missing file that isn't an Onshape reference is still a load error.
    const missingFile = cube(10).replace(
      'import(path : "onshape/std/geometry.fs", version : "3083.0");',
      'import(path : "onshape/std/geometry.fs", version : "3083.0");\nimport(path : "nope.fs", version : "1.0");',
    );
    expect(() => runPreview(runtime, [{ path: "missing.fs", source: missingFile }])).toThrow(
      /nope\.fs not found/,
    );
  });
});

describe("imports between workspace scripts", () => {
  // Failure modes: an import resolves from the workspace root instead of the importing file's
  // folder; `../` isn't followed; an import climbs out of the workspace and the reader is asked
  // for it; a warm runtime keeps the first version of an imported file after it's edited; an error
  // inside the imported file is blamed on the importer; std and Onshape element paths get resolved
  // relative too.
  const files = new Map<string, string>();
  const asked: string[] = [];
  let workspace: FeatureScriptRuntime;
  beforeAll(async () => {
    workspace = await FeatureScriptRuntime.withGeometry({
      readModule: (path) => {
        asked.push(path);
        return files.get(path);
      },
    });
  });
  const library = (size: number) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function block(context is Context, id is Id)
{
    fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${size}, ${size}, ${size}) * millimeter });
}
`;
  const user = (importPath: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
import(path : "${importPath}", version : "");
annotation { "Feature Type Name" : "Uses block" }
export const usesBlock = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        block(context, id);
    });
`;
  const volume = (path: string, source: string) =>
    runPreview(workspace, [{ path, source }]).solids.map((solid) => Math.round(solid.volumeMm3));

  it("resolves a script's imports from its own folder, and re-reads them after an edit", () => {
    files.set("wiring/block.fs", library(10));
    expect(volume("wiring/robot.fs", user("block.fs"))).toEqual([1000]);
    files.set("wiring/block.fs", library(20));
    expect(volume("wiring/robot.fs", user("block.fs"))).toEqual([8000]);
    files.set("lib/block.fs", library(10));
    expect(volume("wiring/robot.fs", user("../lib/block.fs"))).toEqual([1000]);
    expect(asked).not.toContain("onshape/std/geometry.fs");
  });

  it("never reads a workspace file as part of the standard library", () => {
    // Std modules stay loaded across previews and may call builtins; a workspace file at
    // onshape/std/... must not become one.
    asked.length = 0;
    files.set("onshape/std/custom.fs", library(10));
    expect(() => volume("robot.fs", user("onshape/std/custom.fs"))).toThrow(/custom\.fs/);
    expect(asked).not.toContain("onshape/std/custom.fs");
  });

  it("never asks for a path outside the workspace", () => {
    asked.length = 0;
    expect(() => volume("wiring/robot.fs", user("../../secret.fs"))).toThrow(/secret\.fs/);
    expect(asked.filter((path) => path.includes(".."))).toEqual([]);
  });

  it("locates an error inside the imported file there", () => {
    files.set(
      "wiring/block.fs",
      library(10).replace("fCuboid(", 'throw regenError("Block failed");\n    fCuboid('),
    );
    const run = runPreview(workspace, [{ path: "wiring/robot.fs", source: user("block.fs") }])
      .features[0]!.run;
    expect(featureFailure(workspace, run)).toMatchObject({
      message: "Block failed",
      location: { path: "wiring/block.fs", line: 5 },
    });
  });
});
