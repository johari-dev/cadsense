import { beforeAll, describe, expect, it } from "vite-plus/test";
import { runPreview } from "../src/preview/Preview.ts";
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
