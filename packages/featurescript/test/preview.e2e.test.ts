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
});
