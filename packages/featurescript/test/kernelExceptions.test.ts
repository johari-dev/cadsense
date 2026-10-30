import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { loadOcct, type Oc } from "../src/geometry/occt.ts";
import { partStudio } from "./partStudio.ts";

/**
 * OpenCascade throwing inside a builtin (a WebAssembly exception, or a JS error from the bindings).
 *
 * Ways it goes wrong:
 * - The exception escapes runFeatures, so the whole preview crashes with
 *   "[object WebAssembly.Exception]" instead of one feature failing.
 * - The fault doesn't name the builtin that threw.
 * - std's `try` swallows it, hiding a kernel failure as a regen error Onshape might not give.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
/** The runtime's kernel: loadOcct shares one instance. */
let oc: Oc;
let restore: () => void = () => {};
/** What OpenCascade itself throws for a circle of negative radius: a WebAssembly exception. */
let kernelError: unknown;
beforeAll(async () => {
  studio = await partStudio();
  oc = await loadOcct();
  try {
    const circle = new oc.gp_Circ(new oc.gp_Ax2(), -1);
    circle.delete();
  } catch (error) {
    kernelError = error;
  }
});
afterEach(() => restore());

/** Makes OpenCascade's sphere builder throw `error`, as the kernel does on input it rejects. */
const sphereThrows = (error: unknown) => {
  const original = oc.BRepPrimAPI_MakeSphere;
  oc.BRepPrimAPI_MakeSphere = new Proxy(original, {
    construct: () => {
      throw error;
    },
  });
  restore = () => {
    oc.BRepPrimAPI_MakeSphere = original;
  };
};

const sphere =
  'opSphere(context, id + "s", { "center" : vector(0, 0, 0) * millimeter, "radius" : 5 * millimeter });';
const cube =
  'fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';

describe("kernel exceptions", () => {
  it.each([
    ["a WebAssembly exception", () => kernelError],
    ["a JS error", () => new Error("Standard_ConstructionError")],
  ])("stop the run at the feature whose builtin threw %s, naming the builtin", (_, error) => {
    expect(String(kernelError)).toMatch(/WebAssembly\.Exception/);
    sphereThrows(error());
    const run = studio.run([{ body: sphere }, { body: cube }]);
    expect(run.features[0]!.status).toBe("ERROR");
    expect(run.features[0]!.fault?.reason).toBe("internal");
    expect(run.features[0]!.fault?.message).toMatch(/@opSphere/);
    // Like every fault, it stops the run there, so the cube after it never runs.
    expect(run.features).toHaveLength(1);
  });

  it("aren't caught by std's try", () => {
    sphereThrows(new Error("Standard_ConstructionError"));
    const run = studio.run([{ body: `try silent { ${sphere} }` }]);
    expect(run.features[0]!.fault?.message).toMatch(/@opSphere/);
  });
});
