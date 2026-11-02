import { beforeAll, describe, expect, it } from "vite-plus/test";
import { partStudio, solidVolumes } from "./partStudio.ts";

/**
 * std's primitive features (fCone sketches a profile and revolves it), end to end.
 *
 * Ways it goes wrong:
 * - A pointed cone (topRadius 0) sketches a zero-length segment, and the solver or OpenCascade
 *   throws out of the run instead of building the cone.
 * - The revolved profile comes out with the wrong radii, so the volume is off.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

describe("fCone", () => {
  // A cone 20 mm tall on a 10 mm radius: pi r^2 h / 3 = 2094.395 mm^3 pointed, and the frustum
  // pi h (R^2 + R r + r^2) / 3 = 3665.191 mm^3 with a 5 mm top.
  it.each([
    [0, (Math.PI * 100 * 20) / 3],
    [5, (Math.PI * 20 * (100 + 50 + 25)) / 3],
  ])("builds a cone with a %i mm top radius", (top, volume) => {
    const run = studio.run([
      {
        body: `fCone(context, id + "cone", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "bottomRadius" : 10 * millimeter, "topRadius" : ${top} * millimeter });`,
      },
    ]);
    expect(run.features.map((f) => [f.status, f.fault?.message ?? null])).toEqual([["OK", null]]);
    const [solid] = solidVolumes(run);
    expect(solid!).toBeCloseTo(volume, 3);
  });
});
