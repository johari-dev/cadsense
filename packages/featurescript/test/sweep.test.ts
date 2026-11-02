import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { untag } from "../src/runtime/Value.ts";

/**
 * opSweep's orientation and options.
 *
 * Ways it goes wrong:
 * - A path drawn toward the profile sweeps from its far end, so the START and END caps swap
 *   (Onshape's START cap is the one at the profile) or the body moves.
 * - Profile control ignored: a kept orientation still turns with the path, a locked direction or
 *   locked faces don't hold the profile's up direction.
 * - Twist or scale silently dropped (std passes `hasTwist`/`angle` and `hasScale`/`scaleFactor`),
 *   applied in the wrong sense, or scaled about the wrong point. Scale that follows each edge's
 *   own parameter instead of length, so it bunches up along an arc or an unevenly run spline, or
 *   follows length in one profile control mode and not the others.
 * - By default the profile turns with a frame that depends on how the path's curve is
 *   parameterized (OpenCascade's corrected Frenet samples per knot span), not on its shape: the
 *   same path with more knots sweeps differently, and an off-path profile drifts from where a
 *   rotation-minimizing frame carries it.
 * - A twist along a curved path, or a sweep that shouldn't extend the full path, built anyway
 *   instead of refused.
 * - The path is a compact high-degree spline (a helix) whose long spans OpenCascade's pipe can't
 *   follow: the sweep fails, or "succeeds" millimeters off. A twist drifts off its helices.
 *   Either must fail loudly, never pass silently.
 * - Following the frame costs far more than the kernel's own frame on a long spring (the frame's
 *   fit raised to the helix's degree on every sample), or leaves the kernel's heap larger after
 *   every sweep (objects not freed, or a support sheet as large as all those samples).
 * - A path with a sharp corner builds a body OpenCascade's checker rejects (std doesn't say how
 *   Onshape turns such corners), instead of stopping. Corners the check can miss: a path that
 *   doubles straight back (tangents parallel but opposed), and a closed edge whose own ends meet
 *   at an angle. A closed edge that meets itself smoothly must still sweep.
 * - Lines and arcs swept into B-spline faces where OpenCascade makes cylinders and tori, so std's
 *   evaluators (evAxis, qGeometry) no longer recognize them.
 * - A closed 3D path fails: the frame comes back turned, so the swept shell doesn't close and
 *   OpenCascade caps it inside the tube, or a periodic path curve's knots run past its ends.
 * - A face with holes is swept by cutting the inner tubes from the outer one, which is many
 *   times slower on the default frame's surfaces than building the solid from the tubes. Round a
 *   closed path, capping the tubes' coinciding ends makes a body of no volume, or fails.
 * - A sweep whose profile reaches past a bend's center, or one stretch of whose path passes
 *   within the profile's reach of another (a spring's turns), is built crossing itself, which
 *   OpenCascade's checker passes; or a sweep that clears itself is refused.
 * - A scaled sweep round a closed path is glued shut where its first and last sections differ in
 *   size, with a millimeter's tolerance, instead of stopping.
 * - A kept or locked profile that comes to lie along the path (kept level round a ring or a hook,
 *   locked to the direction the path then runs in) folds the body through itself, solid or sheet;
 *   OpenCascade's checker passes it, so it must be caught directly, not by volume (a partial fold
 *   keeps plenty, and a small profile near a bend's axis rightly sweeps very little). The check
 *   must not skip a kept profile that isn't planar, nor a crossing between two samples, even
 *   off an interval's middle (it needs a true upper bound on how far the tangent turns).
 * - A path whose curve stops dead at an end (its first control points coincide, so its derivative
 *   is zero there) ends the run on the kernel's exception, instead of using the direction it heads.
 *   Inside an edge, a stall goes unseen until the kernel fails, and a corner hidden there isn't
 *   refused as one between edges is. Every mode refuses a stall: a kept profile's fold check
 *   can't bound how its direction turns there.
 * - std's unset forms (`qNothing()` lock faces, which Curve pattern always passes, even with
 *   `profileControl` LOCK_FACES) treated as a real request, so the sweep faults or fails.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/sweep${counter++}.fs`,
    `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });
`,
  );
  const result = runtime.runFeatures([{ module, feature: "test" }]);
  const feature = result.features[0]!;
  return {
    result,
    valid: allValid(result),
    status: feature.status,
    fault: feature.fault,
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    number: (name: string) => Number(untag(feature.variables.getField(name))),
    numbers: (name: string) => {
      const value = untag(feature.variables.getField(name));
      if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
      return value.map((item) => Number(untag(item)));
    },
  };
};
/** The volume of the body "sweep" made, in mm^3, integrated to 1e-9 relative. */
const sweptVolume = (result: ReturnType<typeof runtime.runFeatures>) => {
  const oc = result.oc!;
  const body = [...result.geometry!.entities.values()].find(
    (entity) => entity.type === "BODY" && entity.createdBy.at(-1) === "sweep",
  )!;
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(body.shape, props, 1e-9, false, false);
  return props.Mass() * 1e9;
};
/** The centroid of the END cap of the body "sweep" made, in mm, integrated exactly. */
const endCapCentroid = (result: ReturnType<typeof runtime.runFeatures>) => {
  const oc = result.oc!;
  const cap = [...result.geometry!.entities.values()].find(
    (entity) =>
      entity.type === "FACE" && entity.cap === "END" && entity.createdBy.at(-1) === "sweep",
  )!;
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(cap.shape, props, false, false);
  const center = props.CentreOfMass();
  return [center.X(), center.Y(), center.Z()].map((c) => c * 1000);
};
const distanceBetween = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((c, k) => c - b[k]!));
const close = (actual: readonly number[], expected: readonly number[], digits = 5) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));

/** A 2 mm circle at the origin facing +z, swept along a fit spline through `points` (mm). */
const sweepAlong = (points: string) =>
  [
    'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
    'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
    "skSolve(profile);",
    `opFitSpline(context, id + "path", { "points" : ${points}, "startDerivative" : vector(0, 0, 30) * millimeter, "endDerivative" : vector(30, 0, 0) * millimeter });`,
    'opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });',
    'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "sweep", EntityType.BODY) }) / millimeter ^ 3);',
    'setVariable(context, "start", evApproximateCentroid(context, { "entities" : qCapEntity(id + "sweep", CapType.START, EntityType.FACE) }) / millimeter);',
    'setVariable(context, "end", evApproximateCentroid(context, { "entities" : qCapEntity(id + "sweep", CapType.END, EntityType.FACE) }) / millimeter);',
  ].join("\n");

describe("opSweep orientation", () => {
  it("starts at the profile whichever way the path runs", () => {
    const along = run(
      sweepAlong(
        "[vector(0, 0, 0) * millimeter, vector(8, 0, 14) * millimeter, vector(20, 0, 20) * millimeter]",
      ),
    );
    // The same path, drawn from its far end toward the profile (end derivatives swap and flip).
    const toward = run(
      sweepAlong(
        "[vector(20, 0, 20) * millimeter, vector(8, 0, 14) * millimeter, vector(0, 0, 0) * millimeter]",
      )
        .replace('"startDerivative" : vector(0, 0, 30)', '"startDerivative" : vector(-30, 0, 0)')
        .replace('"endDerivative" : vector(30, 0, 0)', '"endDerivative" : vector(0, 0, -30)'),
    );
    for (const r of [along, toward]) {
      expect(r.status, r.why).toBe("OK");
      close(r.numbers("start"), [0, 0, 0]);
      close(r.numbers("end"), [20, 0, 20]);
    }
    expect(toward.number("volume")).toBeCloseTo(along.number("volume"), 4);
  });
});

/** A `width` x `depth` mm rectangle centered at the origin, facing +z. */
const rectangle = (width: number, depth: number) =>
  [
    'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
    `skRectangle(profile, "rectangle", { "firstCorner" : vector(${-width / 2}, ${-depth / 2}) * millimeter, "secondCorner" : vector(${width / 2}, ${depth / 2}) * millimeter });`,
    "skSolve(profile);",
  ].join("\n");
/** A quarter arc of radius 20 in the XZ plane, leaving the origin along +z and ending along +x. */
const ARC =
  'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });\n' +
  'skArc(pathSketch, "arc", { "start" : vector(0, 0) * millimeter, "mid" : vector(20 - 20 / sqrt(2), 20 / sqrt(2)) * millimeter, "end" : vector(20, 20) * millimeter });\n' +
  "skSolve(pathSketch);";
const LINE =
  'opFitSpline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 30) * millimeter] });';
const sweepWith = (path: string, fields: string) =>
  `opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : ${path}, ${fields} });`;
const measureSweep = [
  'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "sweep", EntityType.BODY) }) / millimeter ^ 3);',
  'const endCap = qCapEntity(id + "sweep", CapType.END, EntityType.FACE);',
  'setVariable(context, "endNormal", evPlane(context, { "face" : endCap }).normal);',
  'setVariable(context, "endArea", evArea(context, { "entities" : endCap }) / millimeter ^ 2);',
  'const box = evBox3d(context, { "topology" : endCap });',
  'setVariable(context, "endSize", (box.maxCorner - box.minCorner) / millimeter);',
].join("\n");
const arcPath = 'qCreatedBy(id + "path", EntityType.EDGE)';
const linePath = 'qCreatedBy(id + "line", EntityType.EDGE)';

describe("opSweep profile control", () => {
  it("keeps the profile's orientation: a level square rising 20 mm sweeps 16 x 20 mm^3", () => {
    // Every level slice is one translated square (Cavalieri), and the end cap stays level.
    const kept = run(
      [
        rectangle(4, 4),
        ARC,
        sweepWith(arcPath, '"keepProfileOrientation" : true'),
        measureSweep,
      ].join("\n"),
    );
    expect(kept.status, kept.why).toBe("OK");
    expect(kept.number("volume")).toBeCloseTo(16 * 20, 3);
    close(kept.numbers("endNormal").map(Math.abs), [0, 0, 1], 6);
    // Turning with the path instead, the volume is area times path length.
    const turned = run(
      [
        rectangle(4, 4),
        ARC,
        sweepWith(arcPath, '"keepProfileOrientation" : false'),
        measureSweep,
      ].join("\n"),
    );
    expect(turned.number("volume")).toBeCloseTo(16 * 10 * Math.PI, 3);
    close(turned.numbers("endNormal").map(Math.abs), [1, 0, 0], 6);
  });

  it("locks the profile to a direction or to faces, holding its up direction", () => {
    // The arc lies in XZ, so holding +y up turns the profile exactly as the path does.
    const direction = run(
      [
        rectangle(2, 6),
        ARC,
        sweepWith(arcPath, '"lockDirection" : vector(0, 1, 0)'),
        measureSweep,
      ].join("\n"),
    );
    expect(direction.status, direction.why).toBe("OK");
    expect(direction.number("volume")).toBeCloseTo(12 * 10 * Math.PI, 3);
    close(direction.numbers("endSize"), [0, 6, 2], 3);
    // A path along the top rim of a cylinder, locked to its top face: Pappus, r 10 around z.
    const faces = run(
      [
        'fCylinder(context, id + "cylinder", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 20) * millimeter, "radius" : 10 * millimeter });',
        'const rim = qGeometry(qContainsPoint(qCreatedBy(id + "cylinder", EntityType.EDGE), vector(10, 0, 20) * millimeter), GeometryType.CIRCLE);',
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 20) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });',
        'skRectangle(profile, "rectangle", { "firstCorner" : vector(-1, 1) * millimeter, "secondCorner" : vector(1, 3) * millimeter });',
        "skSolve(profile);",
        sweepWith(
          "rim",
          '"lockFaces" : qContainsPoint(qCreatedBy(id + "cylinder", EntityType.FACE), vector(0, 0, 20) * millimeter)',
        ),
        'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "sweep", EntityType.BODY) }) / millimeter ^ 3);',
      ].join("\n"),
    );
    expect(faces.status, faces.why).toBe("OK");
    // The 2 x 2 square's centroid sits 10 mm from the axis: 4 x 2 PI 10.
    expect(faces.number("volume")).toBeCloseTo(4 * 2 * Math.PI * 10, 3);
  });
});

describe("opSweep along helices", () => {
  it("sweeps a 1 mm circle along springs of 10 to 20 turns into tubes of area times length", () => {
    // Helix radius 10, pitch 3: each turn is sqrt((20 PI)^2 + 9) long.
    const speed = "sqrt((20 * PI) ^ 2 + 9)";
    for (const turns of [10, 12, 15, 20]) {
      const r = run(
        [
          `opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, ${turns}], "clockwise" : true, "helicalPitch" : 3 * millimeter, "spiralPitch" : 0 * millimeter });`,
          `const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, 20 * PI, 3) / ${speed}, vector(1, 0, 0)) });`,
          'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
          "skSolve(profile);",
          sweepWith(
            'qCreatedBy(id + "helix", EntityType.EDGE)',
            '"keepProfileOrientation" : false',
          ),
          'setVariable(context, "volume", evVolume(context, { "entities" : qCreatedBy(id + "sweep", EntityType.BODY) }) / millimeter ^ 3);',
        ].join("\n"),
      );
      expect(r.status, `${turns} turns: ${r.why}`).toBe("OK");
      expect(r.valid).toBe(true);
      const tube = Math.PI * turns * Math.hypot(20 * Math.PI, 3);
      expect(Math.abs(r.number("volume") / tube - 1), `${turns} turns`).toBeLessThan(1e-5);
    }
  });

  it("sweeps long springs about as fast as the kernel's own frame, and frees what it made", () => {
    // A 0.5 mm circle round springs of radius 10 rising 3 per turn. The baseline is the same spring
    // with its profile's up direction locked to the axis: the kernel's own frame on the same path.
    const c = Math.hypot(20 * Math.PI, 3);
    const spring = (turns: number, fields: string) => {
      const start = performance.now();
      const r = run(
        [
          `opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, ${turns}], "clockwise" : true, "helicalPitch" : 3 * millimeter, "spiralPitch" : 0 * millimeter });`,
          `const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, ${(20 * Math.PI) / c}, ${3 / c}), vector(1, 0, 0)) });`,
          'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 0.5 * millimeter });',
          "skSolve(profile);",
          sweepWith('qCreatedBy(id + "helix", EntityType.EDGE)', fields),
        ].join("\n"),
      );
      expect(r.status, `${turns} turns${fields}: ${r.why}`).toBe("OK");
      return performance.now() - start;
    };
    // The kernel never frees shapes made through it, so each sweep keeps a little; its heap grows
    // in steps of about a quarter of its size. Before, ten of these sweeps grew it by a gigabyte.
    spring(100, '"keepProfileOrientation" : false');
    const before = runtime.memoryBytes();
    for (let k = 0; k < 10; k++) spring(100, '"keepProfileOrientation" : false');
    expect((runtime.memoryBytes() - before) / 2 ** 20).toBeLessThan(32);
    // Before, a 300-turn spring took 47 times as long as the baseline.
    const baseline = spring(300, '"lockDirection" : vector(0, 0, 1)');
    const framed = spring(300, '"keepProfileOrientation" : false');
    expect(framed / baseline).toBeLessThan(5);
  }, 120_000);

  it("keeps a twisted profile's corners on their helices, many turns along", () => {
    // A 4 x 2 rectangle twisted along 100 mm: each corner (2, 1) traces an exact helix.
    for (const turns of [3.25, 5.25, 10.25]) {
      const r = run(
        [
          rectangle(4, 2),
          'opFitSpline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 100) * millimeter] });',
          sweepWith(linePath, `"hasTwist" : true, "angle" : ${turns} * 2 * PI`),
        ].join("\n"),
      );
      expect(r.status, `${turns} turns: ${r.why}`).toBe("OK");
      // evVolume's default integration loses ~5e-5 on these many-turn twisted surfaces, so the
      // volume is integrated here to 1e-9 relative. Walls fitted to 0.1 um over a 12 mm perimeter
      // could shift it 1.5e-4; it comes out near 2e-6.
      expect(Math.abs(sweptVolume(r.result) / 800 - 1), `${turns} turns`).toBeLessThan(1e-5);
      const oc = r.result.oc!;
      // The farthest any point of a lengthwise edge strays from its corner's helix.
      let drift = 0;
      for (const entity of r.result.geometry!.entities.values()) {
        if (entity.type !== "EDGE" || entity.createdBy.at(-1) !== "sweep") continue;
        const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
        const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
        if (Math.abs(curve.Value(a).Z() - curve.Value(b).Z()) < 1e-6) continue;
        for (let i = 0; i <= 400; i++) {
          const p = curve.Value(a + ((b - a) * i) / 400);
          const angle = (2 * Math.PI * turns * p.Z()) / 0.1;
          drift = Math.max(
            drift,
            Math.min(
              ...[
                [2, 1],
                [-2, 1],
                [-2, -1],
                [2, -1],
              ].map(([x, y]) =>
                Math.hypot(
                  p.X() - (x! * Math.cos(angle) - y! * Math.sin(angle)) / 1000,
                  p.Y() - (x! * Math.sin(angle) + y! * Math.cos(angle)) / 1000,
                ),
              ),
            ),
          );
        }
      }
      expect(drift, `${turns} turns`).toBeLessThan(2e-7);
    }
  });
});

describe("opSweep along a sharp corner", () => {
  it("stops rather than build an invalid body around the corner", () => {
    const r = run(
      [
        rectangle(4, 2),
        'opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 10) * millimeter, vector(10, 0, 10) * millimeter] });',
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/sharp corner/);
    // Rounded, the same corner sweeps into a valid body.
    const rounded = run(
      [
        rectangle(4, 2),
        'opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 10) * millimeter, vector(10, 0, 10) * millimeter], "bendRadii" : [3 * millimeter] });',
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
        measureSweep,
      ].join("\n"),
    );
    expect(rounded.status, rounded.why).toBe("OK");
    expect(rounded.valid).toBe(true);
    // Area times path length: 7 + 7 straight and a quarter circle of radius 3.
    expect(rounded.number("volume")).toBeCloseTo(8 * (14 + 1.5 * Math.PI), 3);
  });

  it("stops where the path doubles back, and where a closed edge's ends meet at an angle", () => {
    // Up 10 mm, then a quarter arc that leaves the top heading straight back down.
    const hairpin = run(
      [
        rectangle(2, 2),
        'opPolyline(context, id + "up", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 10) * millimeter] });',
        `opCreateBSplineCurve(context, id + "back", { "bSplineCurve" : bSplineCurve({ "degree" : 2, "isPeriodic" : false, "isRational" : true, "controlPoints" : [vector(0, 0, 10) * millimeter, vector(0, 0, 5) * millimeter, vector(5, 0, 5) * millimeter], "weights" : [1, ${Math.SQRT1_2}, 1], "knots" : [0, 0, 0, 1, 1, 1] as KnotArray }) });`,
        sweepWith(
          'qUnion([qCreatedBy(id + "up", EntityType.EDGE), qCreatedBy(id + "back", EntityType.EDGE)])',
          '"keepProfileOrientation" : false',
        ),
      ].join("\n"),
    );
    expect(hairpin.status).toBe("ERROR");
    expect(hairpin.fault?.message).toMatch(/sharp corner/);
    // One edge out along +x and back in along -y: its two ends meet at a right angle.
    const teardrop = run(
      [
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(1, -1, 0) / sqrt(2), vector(0, 0, 1)) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
        "skSolve(profile);",
        'opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [vector(0, 0, 0) * millimeter, vector(20, 0, 0) * millimeter, vector(20, 20, 0) * millimeter, vector(0, 20, 0) * millimeter, vector(0, 0, 0) * millimeter], "knots" : [0, 0, 0, 0, 0.5, 1, 1, 1, 1] as KnotArray }) });',
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(teardrop.status).toBe("ERROR");
    expect(teardrop.fault?.message).toMatch(/sharp corner/);
    // A full circle is one closed edge whose ends meet smoothly: it sweeps into a torus.
    const corners = [
      [10, 0],
      [10, 10],
      [0, 10],
      [-10, 10],
      [-10, 0],
      [-10, -10],
      [0, -10],
      [10, -10],
      [10, 0],
    ];
    const circle = `bSplineCurve({ "degree" : 2, "isPeriodic" : false, "isRational" : true, "controlPoints" : [${corners.map(([x, y]) => `vector(${x}, ${y}, 0) * millimeter`).join(", ")}], "weights" : [${corners.map((_, i) => (i % 2 ? Math.SQRT1_2 : 1)).join(", ")}], "knots" : [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1] as KnotArray })`;
    const torus = run(
      [
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
        "skSolve(profile);",
        `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : ${circle} });`,
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(torus.status, torus.why).toBe("OK");
    expect(torus.valid).toBe(true);
    // Integrated precisely: evVolume's default integration comes out 2.8e-4 low on this torus.
    expect(Math.abs(sweptVolume(torus.result) / (2 * Math.PI ** 2 * 10) - 1)).toBeLessThan(1e-6);
  });
});

describe("opSweep default frame", () => {
  // A 2 mm circle 6 mm off the start of a cubic 3D path, in the plane square to it there.
  const POINTS = [
    [0, 0, 0],
    [0, 0, 10],
    [10, 5, 20],
    [0, 15, 30],
    [-10, 5, 40],
    [0, 0, 50],
  ];
  const sweepPath = (points: readonly (readonly number[])[], knots: readonly number[]) =>
    [
      'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(6, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
      'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
      "skSolve(profile);",
      `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([${knots.join(", ")}]) }) });`,
      sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
    ].join("\n");
  /** Inserts knot `t` into a cubic spline (Boehm's algorithm): the same curve, one more span. */
  const insertKnot = (
    points: readonly (readonly number[])[],
    knots: readonly number[],
    t: number,
  ) => {
    const k = knots.findLastIndex((knot) => knot <= t);
    const next = points.flatMap((point, i) => {
      if (i <= k - 3) return [point];
      const a = (t - knots[i]!) / (knots[i + 3]! - knots[i]!);
      const blended = point.map((c, j) => (1 - a) * points[i - 1]![j]! + a * c);
      return i === k ? [blended, point] : i > k ? [point] : [blended];
    });
    return { points: next, knots: [...knots.slice(0, k + 1), t, ...knots.slice(k + 1)] };
  };

  it("carries the profile the same way whatever the path's knots", () => {
    const knots = [0, 0, 0, 0, 1 / 3, 2 / 3, 1, 1, 1, 1];
    let more: { points: readonly (readonly number[])[]; knots: readonly number[] } = {
      points: POINTS,
      knots,
    };
    for (const t of [0.15, 0.5, 0.5, 0.8]) more = insertKnot(more.points, more.knots, t);
    const [plain, knotted] = [
      run(sweepPath(POINTS, knots)),
      run(sweepPath(more.points, more.knots)),
    ];
    expect(plain.status, plain.why).toBe("OK");
    expect(knotted.status, knotted.why).toBe("OK");
    const [a, b] = [endCapCentroid(plain.result), endCapCentroid(knotted.result)];
    expect(distanceBetween(a, b) / Math.hypot(...a)).toBeLessThan(1e-6);
    expect(Math.abs(sweptVolume(knotted.result) / sweptVolume(plain.result) - 1)).toBeLessThan(
      1e-6,
    );
  });

  it("turns an off-path profile along a helix as a rotation-minimizing frame does", () => {
    // Helix radius a = 10 rising 3 per turn: (10 cos t, 10 sin t, b t) with b = 3 / (2 PI), speed
    // c = sqrt(a^2 + b^2). A rotation-minimizing frame turns against the Frenet frame at the
    // torsion b / c^2 per unit length, so over 2 turns (length 4 PI c) a point set 2 mm in along the
    // principal normal ends turned 4 PI b / c from it, away from the binormal.
    const [a, b] = [10, 3 / (2 * Math.PI)];
    const c = Math.hypot(a, b);
    const tangent = [0, a / c, b / c];
    const [normal, binormal] = [
      [-1, 0, 0],
      [0, -b / c, a / c],
    ];
    const r = run(
      [
        `opHelix(context, id + "helix", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, 2], "clockwise" : true, "helicalPitch" : 3 * millimeter, "spiralPitch" : 0 * millimeter });`,
        `const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(8, 0, 0) * millimeter, vector(${tangent.join(", ")}), vector(1, 0, 0)) });`,
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
        "skSolve(profile);",
        sweepWith('qCreatedBy(id + "helix", EntityType.EDGE)', '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    const angle = (-4 * Math.PI * b) / c;
    const expected = [0, 1, 2].map(
      (k) => [10, 0, 6][k]! + 2 * (Math.cos(angle) * normal[k]! + Math.sin(angle) * binormal[k]!),
    );
    expect(distanceBetween(endCapCentroid(r.result), expected)).toBeLessThan(1e-6);
  });

  it("matches a finely stepped rotation-minimizing frame along a winding 3D fit spline", () => {
    // A 0.5 mm circle 1.5 mm off the start of a fit spline through 8 winding points, whose
    // tightest bend (radius 5.2 mm) the circle stays inside. The reference carries the offset by
    // double reflection (Wang et al. 2008) over 200000 equal steps of the edge's own parameter.
    // (The same path left almost at rest, start derivative 1 mm, turns at a 0.6 um radius: any
    // profile off the path folds there, which the sweep refuses.)
    const points = Array.from({ length: 8 }, (_, k) =>
      k === 0 ? [0, 0, 0] : [10 * Math.sin(0.9 * k), 10 * Math.cos(1.3 * k) - 10, 10 * k],
    );
    const r = run(
      [
        `opFitSpline(context, id + "path", { "points" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}] });`,
        'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "path", EntityType.EDGE), "parameter" : 0 });',
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(start.origin, start.direction) });',
        'skCircle(profile, "circle", { "center" : vector(1.5, 0) * millimeter, "radius" : 0.5 * millimeter });',
        "skSolve(profile);",
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    const oc = r.result.oc!;
    const path = [...r.result.geometry!.entities.values()].find(
      (entity) => entity.type === "EDGE" && entity.createdBy.at(-1) === "path",
    )!;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(path.shape));
    const at = (u: number) => {
      const { Point, D1 } = curve.EvalD1(u);
      const d = [D1.X(), D1.Y(), D1.Z()];
      const length = Math.hypot(...d);
      return { point: [Point.X(), Point.Y(), Point.Z()], tangent: d.map((x) => x / length) };
    };
    const reflect = (v: number[], n: number[]) => {
      const nn = n.reduce((sum, x) => sum + x * x, 0);
      const along = (2 * n.reduce((sum, x, k) => sum + x * v[k]!, 0)) / nn;
      return v.map((x, k) => x - along * n[k]!);
    };
    const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
    let here = at(first);
    // The profile's centroid, from the path's start.
    const face = [...r.result.geometry!.entities.values()].find(
      (entity) => entity.type === "FACE" && entity.createdBy.at(-1) === "profile",
    )!;
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face.shape, props, false, false);
    const center = props.CentreOfMass();
    let offset = [center.X(), center.Y(), center.Z()].map((x, k) => x - here.point[k]!);
    const steps = 200000;
    for (let k = 1; k <= steps; k++) {
      const next = at(first + ((last - first) * k) / steps);
      const chord = next.point.map((x, j) => x - here.point[j]!);
      const turned = reflect(here.tangent, chord);
      const fix = next.tangent.map((x, j) => x - turned[j]!);
      offset = reflect(reflect(offset, chord), fix);
      here = next;
    }
    const expected = here.point.map((x, k) => (x + offset[k]!) * 1000);
    expect(distanceBetween(endCapCentroid(r.result), expected)).toBeLessThan(1e-5);
  });
});

describe("opSweep faces with holes", () => {
  it("sweeps an annulus as quickly as a kept one, into area times length", () => {
    // Radii 2 and 1 round a 5-point fit spline (tightest bend 5.2 mm). Before, cutting the inner
    // tube from the outer one on the frame's support sheets took 28 times as long as with a kept
    // profile.
    const sweep = (fields: string) => {
      const start = performance.now();
      const r = run(
        [
          'opFitSpline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(3, 0, 8) * millimeter, vector(10, 4, 14) * millimeter, vector(18, 2, 20) * millimeter, vector(20, 12, 30) * millimeter], "startDerivative" : vector(0, 0, 40) * millimeter });',
          'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
          'skCircle(profile, "outer", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
          'skCircle(profile, "inner", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
          "skSolve(profile);",
          `opSweep(context, id + "sweep", { "profiles" : qSubtraction(qSketchRegion(id + "profile"), qContainsPoint(qSketchRegion(id + "profile"), vector(0, 0, 0) * millimeter)), "path" : qCreatedBy(id + "path", EntityType.EDGE), ${fields} });`,
        ].join("\n"),
      );
      expect(r.status, `${fields}: ${r.why}`).toBe("OK");
      expect(r.valid, fields).toBe(true);
      return { r, ms: performance.now() - start };
    };
    const keep = '"keepProfileOrientation" : true';
    // The fastest of three runs each, against noise from whatever else the machine runs.
    const fastest = (fields: string) =>
      [0, 1, 2].map(() => sweep(fields)).reduce((best, next) => (next.ms < best.ms ? next : best));
    const kept = fastest(keep);
    const turned = fastest('"keepProfileOrientation" : false');
    // The path's length by Simpson's rule.
    const oc = turned.r.result.oc!;
    const path = [...turned.r.result.geometry!.entities.values()].find(
      (entity) => entity.type === "EDGE" && entity.createdBy.at(-1) === "path",
    )!;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(path.shape));
    const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
    const speed = (u: number) => curve.EvalD1(u).D1.Magnitude();
    const h = (last - first) / 4000;
    let length = 0;
    for (let k = 0; k < 4000; k++) {
      const a = first + k * h;
      length += (h / 6) * (speed(a) + 4 * speed(a + h / 2) + speed(a + h));
    }
    expect(Math.abs(sweptVolume(turned.r.result) / (3 * Math.PI * length * 1e3) - 1)).toBeLessThan(
      1e-6,
    );
    // The default frame is fitted on top (about 5 times a kept sweep here); with the cut it was 28.
    expect(turned.ms / kept.ms).toBeLessThan(10);
  });
});

describe("opSweep faces with holes round a closed path", () => {
  it("sweeps a holed face round a ring into a hollow ring of area times centroid's travel", () => {
    // A circle of radius 20, swept by a profile in the plane y = 0 at (20, 0, 0) (its x runs
    // outward from the ring's axis, its y along -z). Pappus: area times 2 PI times the distance
    // of the profile's centroid from the axis. Before, these came out as two coincident caps
    // holding no volume, or failed.
    const ring = [
      'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
      'skCircle(pathSketch, "ring", { "center" : vector(0, 0) * millimeter, "radius" : 20 * millimeter });',
      "skSolve(pathSketch);",
      'const path = qOwnedByBody(qBodyType(qCreatedBy(id + "path", EntityType.BODY), BodyType.WIRE), EntityType.EDGE);',
    ].join("\n");
    const profile = (loops: string) =>
      [
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(20, 0, 0) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });',
        loops,
        "skSolve(profile);",
      ].join("\n");
    const annulus = profile(
      'skCircle(profile, "outer", { "center" : vector(0, 0) * millimeter, "radius" : 3 * millimeter }); skCircle(profile, "inner", { "center" : vector(0, 0) * millimeter, "radius" : 1.5 * millimeter });',
    );
    const square = profile(
      'skRectangle(profile, "outer", { "firstCorner" : vector(-3, -3) * millimeter, "secondCorner" : vector(3, 3) * millimeter }); skCircle(profile, "h1", { "center" : vector(-1.2, 0) * millimeter, "radius" : 1 * millimeter }); skCircle(profile, "h2", { "center" : vector(1.5, 1) * millimeter, "radius" : 0.7 * millimeter });',
    );
    // The holed region: the one holding a point off its holes, here (2.25, 0) in the sketch.
    const holed = 'qContainsPoint(qSketchRegion(id + "profile"), vector(22.25, 0, 0) * millimeter)';
    const squareArea = 36 - Math.PI * (1 + 0.49);
    const squareCentroid = (Math.PI * 1.2 - 0.49 * Math.PI * 1.5) / squareArea;
    for (const [name, loops, area, centroid] of [
      ["annulus", annulus, Math.PI * (9 - 2.25), 0],
      ["square with two holes", square, squareArea, squareCentroid],
    ] as const)
      for (const fields of [
        '"keepProfileOrientation" : false',
        '"lockDirection" : vector(0, 0, 1)',
      ]) {
        const r = run(
          [
            ring,
            loops,
            sweepWith("path", fields).replace(
              `"profiles" : qSketchRegion(id + "profile")`,
              `"profiles" : ${holed}`,
            ),
          ].join("\n"),
        );
        const label = `${name}, ${fields}`;
        expect(r.status, `${label}: ${r.why}`).toBe("OK");
        expect(r.valid, label).toBe(true);
        const expected = area * 2 * Math.PI * (20 + centroid);
        expect(Math.abs(sweptVolume(r.result) / expected - 1), label).toBeLessThan(1e-6);
      }
  });
});

describe("opSweep along lines and arcs", () => {
  const types = [
    'setVariable(context, "cylinders", size(evaluateQuery(context, qGeometry(qCreatedBy(id + "sweep", EntityType.FACE), GeometryType.CYLINDER))));',
    'setVariable(context, "tori", size(evaluateQuery(context, qGeometry(qCreatedBy(id + "sweep", EntityType.FACE), GeometryType.TORUS))));',
  ].join("\n");
  const circle = (r: number, center = "0, 0") =>
    [
      'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
      `skCircle(profile, "circle", { "center" : vector(${center}) * millimeter, "radius" : ${r} * millimeter });`,
      "skSolve(profile);",
    ].join("\n");

  it("sweeps cylinders and tori, which std's evaluators read as such", () => {
    const sketchLine = [
      'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
      'skLineSegment(pathSketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 30) * millimeter });',
      "skSolve(pathSketch);",
    ].join("\n");
    const pipe = run(
      [
        circle(2),
        sketchLine,
        sweepWith(arcPath, '"keepProfileOrientation" : false'),
        types,
        'const side = qSubtraction(qCreatedBy(id + "sweep", EntityType.FACE), qUnion([qCapEntity(id + "sweep", CapType.START, EntityType.FACE), qCapEntity(id + "sweep", CapType.END, EntityType.FACE)]));',
        'const axis = evAxis(context, { "axis" : side });',
        'setVariable(context, "axis", concatenateArrays([axis.origin / millimeter, axis.direction]));',
      ].join("\n"),
    );
    expect(pipe.status, pipe.why).toBe("OK");
    expect([pipe.number("cylinders"), pipe.number("tori")]).toEqual([1, 0]);
    const [x, y, , ...direction] = pipe.numbers("axis");
    close([x!, y!, Math.abs(direction[2]!)], [0, 0, 1], 9);
    const bent = run(
      [circle(2), ARC, sweepWith(arcPath, '"keepProfileOrientation" : false'), types].join("\n"),
    );
    expect(bent.status, bent.why).toBe("OK");
    expect([bent.number("cylinders"), bent.number("tori")]).toEqual([0, 1]);
    const bar = run(
      [rectangle(4, 2), ARC, sweepWith(arcPath, '"keepProfileOrientation" : false'), types].join(
        "\n",
      ),
    );
    expect(bar.status, bar.why).toBe("OK");
    expect([bar.number("cylinders"), bar.number("tori")]).toEqual([2, 0]);
  });

  it("turns a profile round a 3D polyline's bends as a rotation-minimizing frame does", () => {
    // Lines and arcs in different planes, meeting tangentially. A rotation-minimizing frame turns
    // about each bend's axis by its angle and not at all along a line, so the end cap is the start
    // cap turned by those rotations: here an off-center circle's centroid.
    const points = [
      [0, 0, 0],
      [0, 0, 20],
      [15, 5, 30],
      [15, 25, 40],
      [-5, 30, 55],
    ];
    const r = run(
      [
        `opPolyline(context, id + "path", { "points" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "bendRadii" : [6 * millimeter, 5 * millimeter, 7 * millimeter] });`,
        circle(0.4, "1.5, 0.8"),
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
        types,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect([r.number("cylinders"), r.number("tori")]).toEqual([4, 3]);
    const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
    const legs = points.slice(1).map((p, i) => unit(p.map((x, k) => x - points[i]![k]!)));
    let offset = [1.5, 0.8, 0];
    for (let i = 0; i + 1 < legs.length; i++) {
      const [a, b] = [legs[i]!, legs[i + 1]!];
      const axis = unit([
        a[1]! * b[2]! - a[2]! * b[1]!,
        a[2]! * b[0]! - a[0]! * b[2]!,
        a[0]! * b[1]! - a[1]! * b[0]!,
      ]);
      const angle = Math.acos(a.reduce((sum, x, k) => sum + x * b[k]!, 0));
      const along = axis.reduce((sum, x, k) => sum + x * offset[k]!, 0);
      const side = [
        axis[1]! * offset[2]! - axis[2]! * offset[1]!,
        axis[2]! * offset[0]! - axis[0]! * offset[2]!,
        axis[0]! * offset[1]! - axis[1]! * offset[0]!,
      ];
      offset = offset.map(
        (x, k) =>
          x * Math.cos(angle) +
          side[k]! * Math.sin(angle) +
          axis[k]! * along * (1 - Math.cos(angle)),
      );
    }
    const expected = points.at(-1)!.map((x, k) => x + offset[k]!);
    expect(distanceBetween(endCapCentroid(r.result), expected)).toBeLessThan(1e-9);
  });
});

describe("opSweep along a closed path", () => {
  /** Six points on a wavy ellipse, for a periodic fit spline through them. */
  const RING = Array.from({ length: 6 }, (_, k) => [
    30 * Math.cos((k * Math.PI) / 3),
    20 * Math.sin((k * Math.PI) / 3),
    5 * Math.sin(k),
  ]);

  it("closes a tube around a closed 3D path without caps", () => {
    // A periodic fit spline through RING, and a 2 mm circle square to it at its start: a ring of
    // volume PI r^2 L, one face, no caps.
    const ring = RING;
    const r = run(
      [
        `opFitSpline(context, id + "path", { "points" : [${[...ring, ring[0]!].map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}] });`,
        'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "path", EntityType.EDGE), "parameter" : 0 });',
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(start.origin, start.direction) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
        "skSolve(profile);",
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : false'),
        'setVariable(context, "faces", size(evaluateQuery(context, qCreatedBy(id + "sweep", EntityType.FACE))));',
        'setVariable(context, "caps", size(evaluateQuery(context, qUnion([qCapEntity(id + "sweep", CapType.START, EntityType.FACE), qCapEntity(id + "sweep", CapType.END, EntityType.FACE)]))));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect([r.number("faces"), r.number("caps")]).toEqual([1, 0]);
    // The path's length by Simpson's rule on its own parameter.
    const oc = r.result.oc!;
    const path = [...r.result.geometry!.entities.values()].find(
      (entity) => entity.type === "EDGE" && entity.createdBy.at(-1) === "path",
    )!;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(path.shape));
    const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
    const speed = (u: number) => curve.EvalD1(u).D1.Magnitude();
    const steps = 20000;
    const h = (last - first) / steps;
    let length = 0;
    for (let k = 0; k < steps; k++) {
      const a = first + k * h;
      length += (h / 6) * (speed(a) + 4 * speed(a + h / 2) + speed(a + h));
    }
    expect(Math.abs(sweptVolume(r.result) / (Math.PI * 4 * length * 1e3) - 1)).toBeLessThan(1e-6);
  });

  it("refuses to scale round a closed path, whose ends would have to meet at two sizes", () => {
    // Before, the start (radius 1) and end (radius 2) sections were glued with a 1 mm tolerance.
    const flat = RING.map(([x, y]) => [x!, y!, 0]);
    for (const points of [RING, flat]) {
      const r = run(
        [
          `opFitSpline(context, id + "path", { "points" : [${[...points, points[0]!].map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}] });`,
          'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "path", EntityType.EDGE), "parameter" : 0 });',
          'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(start.origin, start.direction) });',
          'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
          "skSolve(profile);",
          sweepWith(
            'qCreatedBy(id + "path", EntityType.EDGE)',
            '"hasScale" : true, "scaleFactor" : 2',
          ),
        ].join("\n"),
      );
      expect(r.status).toBe("ERROR");
      expect(r.fault?.message).toMatch(/scale.*closed path/);
    }
  });

  it("stops when a profile kept level around the ring folds through itself", () => {
    // Kept at its start orientation, the circle lies along the path halfway round: the tube
    // flattens there and turns inside out, and its signed volume cancels to about nothing.
    const r = run(
      [
        `opFitSpline(context, id + "path", { "points" : [${[...RING, RING[0]!].map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}] });`,
        'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "path", EntityType.EDGE), "parameter" : 0 });',
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(start.origin, start.direction) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
        "skSolve(profile);",
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', '"keepProfileOrientation" : true'),
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/KEEP_ORIENTATION/);
  });
});

describe("opSweep folds", () => {
  /** A disc of radius 2 at the origin, level (facing +z). */
  const disc = [
    'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
    'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
    "skSolve(profile);",
  ].join("\n");
  /** A level segment of length 4 through the origin along (x, y). */
  const segment = (x: number, y: number) =>
    [
      'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
      `skLineSegment(profile, "line", { "start" : vector(${-2 * x}, ${-2 * y}) * millimeter, "end" : vector(${2 * x}, ${2 * y}) * millimeter });`,
      "skSolve(profile);",
    ].join("\n");
  /** An arc of radius 20 in the XZ plane leaving the origin along +z, turning `degrees`. */
  const arc = (degrees: number) => {
    const at = (a: number) => `vector(${20 - 20 * Math.cos(a)}, ${20 * Math.sin(a)}) * millimeter`;
    const turn = (degrees * Math.PI) / 180;
    return [
      'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
      `skArc(pathSketch, "arc", { "start" : vector(0, 0) * millimeter, "mid" : ${at(turn / 2)}, "end" : ${at(turn)} });`,
      "skSolve(pathSketch);",
    ].join("\n");
  };
  const ring = [
    'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
    'skCircle(pathSketch, "ring", { "center" : vector(20, 0) * millimeter, "radius" : 20 * millimeter });',
    "skSolve(pathSketch);",
  ].join("\n");
  const keep = '"keepProfileOrientation" : true';
  const sheet = (
    path: string,
    profile: string,
    edges = 'qNthElement(qCreatedBy(id + "path", EntityType.EDGE), 0)',
  ) =>
    run(
      [
        path,
        profile,
        `opSweep(context, id + "sweep", { "profiles" : qCreatedBy(id + "profile", EntityType.EDGE), "path" : ${edges}, ${keep} });`,
      ].join("\n"),
    );

  it("stops where a kept or locked profile comes to lie along the path, solid or sheet", () => {
    // Up 20, a half turn of radius 10, down 15: the level disc runs edge-on over the top, and the
    // locked direction x is the path's direction there.
    const hook = (fields: string) =>
      run(
        [
          'opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 30) * millimeter, vector(20, 0, 30) * millimeter, vector(20, 0, 5) * millimeter], "bendRadii" : [10 * millimeter, 10 * millimeter] });',
          disc,
          sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', fields),
        ].join("\n"),
      );
    for (const [fields, mode] of [
      [keep, /KEEP_ORIENTATION/],
      ['"lockDirection" : vector(1, 0, 0)', /LOCK_DIRECTION/],
    ] as const) {
      const r = hook(fields);
      expect(r.status, fields).toBe("ERROR");
      expect(r.fault?.message, fields).toMatch(mode);
      expect(r.fault?.message, fields).toMatch(/folds/);
    }
    const turned = hook('"keepProfileOrientation" : false');
    expect(turned.status, turned.why).toBe("OK");
    expect(turned.valid).toBe(true);
    // Kept level round 120 degrees of arc the disc runs back on itself; round 90 it only ends
    // edge-on, a valid body of A R.
    const back = run([arc(120), disc, sweepWith(arcPath, keep)].join("\n"));
    expect(back.status).toBe("ERROR");
    expect(back.fault?.message).toMatch(/KEEP_ORIENTATION/);
    const quarter = run([arc(90), disc, sweepWith(arcPath, keep)].join("\n"));
    expect(quarter.status, quarter.why).toBe("OK");
    expect(Math.abs(sweptVolume(quarter.result) / (4 * Math.PI * 20) - 1)).toBeLessThan(1e-6);
    // A level segment along x lies along the path where it runs along x; along y it never does.
    for (const [path, x, y, folds] of [
      [ring, 1, 0, true],
      [ring, 0, 1, false],
      [arc(120), 1, 0, true],
      [arc(120), 0, 1, false],
    ] as const) {
      const r = sheet(path, segment(x, y));
      const name = `segment (${x}, ${y}) along ${path === ring ? "a ring" : "120 degrees"}`;
      if (folds) {
        expect(r.status, name).toBe("ERROR");
        expect(r.fault?.message, name).toMatch(/KEEP_ORIENTATION/);
      } else {
        expect(r.status, `${name}: ${r.why}`).toBe("OK");
        expect(r.valid, name).toBe(true);
      }
    }
  });

  it("finds a dip through the kept plane between a sample and its interval's middle", () => {
    // A two-span cubic in the xz plane whose slope comes down to 0.0006 at u = 1, dips to -0.003
    // at u = 1.06 and rises again: it runs down through a kept level disc's plane and back up.
    // Lifting the dip (slope never below 0.0006) leaves nothing to fold.
    const path = (points: readonly (readonly number[])[]) =>
      `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([0, 0, 0, 0, 1, 1, 2, 2, 2, 2]) }) });`;
    const dipping = [
      [0, 0, 0],
      [10, 0, 5],
      [20, 0, 5.606],
      [40, 0, 5.618],
      [50, 0, 5.024],
      [60, 0, 13.83],
    ];
    const lifted = dipping.map((p, i) =>
      i === 4 ? [50, 0, 5.618 + 0.006] : i === 5 ? [60, 0, 5.618 + 0.006 + 8.806] : p,
    );
    const sweep = (points: readonly (readonly number[])[]) =>
      run(
        [
          path(points),
          disc.replace("2 * millimeter", "1 * millimeter"),
          sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', keep),
        ].join("\n"),
      );
    const dipped = sweep(dipping);
    expect(dipped.status).toBe("ERROR");
    expect(dipped.fault?.message).toMatch(/KEEP_ORIENTATION folds the profile/);
    const level = sweep(lifted);
    expect(level.status, level.why).toBe("OK");
    expect(level.valid).toBe(true);
  });

  it("checks a kept profile that isn't planar edge by edge", () => {
    // Edges along x, y and (0, 1, 1): the x edge's strip folds where the path runs along x. Round
    // 60 degrees of arc no edge's direction is reached; round 120, and over the hook, x is.
    const profile =
      'opPolyline(context, id + "profile", { "points" : [vector(-2, 0, 0) * millimeter, vector(2, 0, 0) * millimeter, vector(2, 2, 0) * millimeter, vector(2, 4, 2) * millimeter] });';
    const hook =
      'opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 30) * millimeter, vector(20, 0, 30) * millimeter, vector(20, 0, 5) * millimeter], "bendRadii" : [10 * millimeter, 10 * millimeter] });';
    for (const [path, folds] of [
      [hook, true],
      [arc(120), true],
      [arc(60), false],
    ] as const) {
      const r = sheet(path, profile, 'qCreatedBy(id + "path", EntityType.EDGE)');
      const name = path === hook ? "hook" : path;
      if (folds) {
        expect(r.status, name).toBe("ERROR");
        expect(r.fault?.message, name).toMatch(/KEEP_ORIENTATION/);
      } else {
        expect(r.status, `${name}: ${r.why}`).toBe("OK");
        expect(r.valid, name).toBe(true);
      }
    }
  });

  it("finds a fold between two samples, where the sampled low is elsewhere", () => {
    // A degree-2 path with derivatives (1, 0, 0.1), (1, 0, 0.06), (1, 0, -0.004), (1, 0.012, 0.008)
    // at knots 0 to 3: its tangent passes through +x near u = 1.94, between samples, while the
    // lowest sample sits later. A line kept along x folds its strip there.
    const derivatives = [
      [1, 0, 0.1],
      [1, 0, 0.06],
      [1, 0, -0.004],
      [1, 0.012, 0.008],
    ];
    const knots = [0, 0, 0, 1, 2, 3, 3, 3];
    const points = [[0, 0, 0]];
    derivatives.forEach((d, i) => {
      const h = (knots[i + 3]! - knots[i + 1]!) / 2;
      points.push(points[i]!.map((x, k) => x + d[k]! * 10 * h));
    });
    const r = run(
      [
        `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 2, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([${knots.join(", ")}]) }) });`,
        'opPolyline(context, id + "profile", { "points" : [vector(-1, 0, 0) * millimeter, vector(1, 0, 0) * millimeter] });',
        `opSweep(context, id + "sweep", { "profiles" : qCreatedBy(id + "profile", EntityType.EDGE), "path" : qCreatedBy(id + "path", EntityType.EDGE), ${keep} });`,
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/KEEP_ORIENTATION/);
  });

  it("sweeps a small profile near an arc's axis as a revolve would", () => {
    // A 0.04 x 0.4 mm rectangle 0.01 to 0.05 mm from the axis of a 90 degree arc of radius 50: the
    // frame turns it about the axis, V = A (PI / 2) x_c.
    const r = run(
      [
        'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        `skArc(pathSketch, "arc", { "start" : vector(50, 0) * millimeter, "mid" : vector(${50 * Math.SQRT1_2}, ${50 * Math.SQRT1_2}) * millimeter, "end" : vector(0, 50) * millimeter });`,
        "skSolve(pathSketch);",
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });',
        'skRectangle(profile, "rectangle", { "firstCorner" : vector(0.01, -0.2) * millimeter, "secondCorner" : vector(0.05, 0.2) * millimeter });',
        "skSolve(profile);",
        sweepWith(arcPath, '"keepProfileOrientation" : false'),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(Math.abs(sweptVolume(r.result) / (0.016 * (Math.PI / 2) * 0.03) - 1)).toBeLessThan(1e-6);
  });
});

describe("opSweep along a path that stops inside an edge", () => {
  // A cubic through a triple control point at (0, 0, 10): it comes to rest there. Running on
  // along z it's smooth; turning to (1, 0, 1) it hides a 45 degree corner.
  const path = (onward: readonly (readonly number[])[]) => {
    const points = [[0, 0, 0], [0, 0, 5], [0, 0, 10], [0, 0, 10], [0, 0, 10], ...onward];
    return `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 4]) }) });`;
  };
  const sweep = (onward: readonly (readonly number[])[], fields: string) =>
    run(
      [
        path(onward),
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });',
        "skSolve(profile);",
        sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', fields),
      ].join("\n"),
    );
  const fields = [
    '"keepProfileOrientation" : true',
    '"lockDirection" : vector(0, 1, 0)',
    '"keepProfileOrientation" : false',
  ];

  it("stops where the path has no direction, as at an end, in every mode", () => {
    // A kept profile needs no direction, but the fold check bounds how fast the direction turns,
    // and near a stall that bound doesn't shrink.
    const smooth = [
      [0, 0, 15],
      [3, 0, 20],
    ];
    for (const f of fields) {
      const r = sweep(smooth, f);
      expect(r.status, f).toBe("ERROR");
      expect(r.fault?.message, f).toMatch(/stops dead/);
    }
  });

  it("refuses a corner hidden where it stops, as between two edges", () => {
    const corner = [
      [5, 0, 15],
      [10, 0, 20],
    ];
    for (const f of fields) {
      const r = sweep(corner, f);
      expect(r.status, f).toBe("ERROR");
      expect(r.fault?.message, f).toMatch(/sharp corner/);
    }
  });
});

describe("opSweep along a path that sets off from rest", () => {
  it("takes the path's direction from where it heads, not its zero derivative", () => {
    // The first two control points coincide, so the derivative is zero at the start; the path
    // still heads up +z from there. Before, the kernel threw on the zero vector and ended the run.
    // It stops either way: no frame direction there, and no bound on its turn for the fold check.
    const points = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 10],
      [8, 4, 20],
      [3, 12, 30],
    ];
    const sweep = (fields: string) =>
      run(
        [
          `opCreateBSplineCurve(context, id + "path", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [${points.map((p) => `vector(${p.join(", ")}) * millimeter`).join(", ")}], "knots" : knotArray([0, 0, 0, 0, 0.5, 1, 1, 1, 1]) }) });`,
          'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
          'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 0.5 * millimeter });',
          "skSolve(profile);",
          sweepWith('qCreatedBy(id + "path", EntityType.EDGE)', fields),
        ].join("\n"),
      );
    for (const fields of ['"keepProfileOrientation" : true', '"keepProfileOrientation" : false']) {
      const r = sweep(fields);
      expect(r.status, fields).toBe("ERROR");
      expect(r.fault?.message, fields).toMatch(/stops dead/);
    }
  });
});

describe("opSweep that would run into itself", () => {
  // A half turn of radius 3 and 3 turns of a radius-10 helix rising 4 per turn, each with a
  // profile square to its start.
  const bendPath = [
    'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
    'skArc(pathSketch, "arc", { "start" : vector(0, 0) * millimeter, "mid" : vector(-3, 3) * millimeter, "end" : vector(-6, 0) * millimeter });',
    "skSolve(pathSketch);",
  ].join("\n");
  const helixPath =
    'opHelix(context, id + "path", { "direction" : vector(0, 0, 1), "axisStart" : vector(0, 0, 0) * millimeter, "startPoint" : vector(10, 0, 0) * millimeter, "interval" : [0, 3], "clockwise" : false, "helicalPitch" : 4 * millimeter, "spiralPitch" : 0 * millimeter });';
  const c = Math.hypot(20 * Math.PI, 4);
  const profile = (origin: string, normal: string, loops: string) =>
    [
      `const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(${origin}, ${normal}, vector(1, 0, 0)) });`,
      loops,
      "skSolve(profile);",
    ].join("\n");
  const disc = (r: number) =>
    `skCircle(profile, "outer", { "center" : vector(0, 0) * millimeter, "radius" : ${r} * millimeter });`;
  const sweep = (
    path: string,
    origin: string,
    normal: string,
    loops: string,
    profiles = 'qSketchRegion(id + "profile")',
  ) =>
    run(
      [
        path,
        profile(origin, normal, loops),
        `opSweep(context, id + "sweep", { "profiles" : ${profiles}, "path" : qCreatedBy(id + "path", EntityType.EDGE) });`,
      ].join("\n"),
    );
  const atBend = ["vector(0, 0, 0) * millimeter", "vector(0, 1, 0)"] as const;
  const atHelix = [
    "vector(10, 0, 0) * millimeter",
    `vector(0, ${(-20 * Math.PI) / c}, ${4 / c})`,
  ] as const;

  it("stops where the profile reaches past a bend's center, or one turn reaches the next", () => {
    // A radius-4 disc round a radius-3 bend, with or without a hole near the inside of the bend.
    const reaching = sweep(bendPath, ...atBend, disc(4));
    const holed = sweep(
      bendPath,
      ...atBend,
      disc(4) +
        'skCircle(profile, "hole", { "center" : vector(-2.8, 0) * millimeter, "radius" : 0.8 * millimeter });',
      'qSubtraction(qSketchRegion(id + "profile"), qContainsPoint(qSketchRegion(id + "profile"), vector(-2.8, 0, 0) * millimeter))',
    );
    // A radius-2.8 disc round a helix rising 4 per turn: each turn overlaps the next.
    const stacked = sweep(helixPath, ...atHelix, disc(2.8));
    for (const [name, r] of [
      ["bend", reaching],
      ["bend with a hole", holed],
      ["helix", stacked],
    ] as const) {
      expect(r.status, name).toBe("ERROR");
      expect(r.fault?.message, name).toMatch(/runs? into itself/);
    }
    // A radius-2 disc fits the bend; a radius-1.9 disc fits between the helix's turns.
    const fits = sweep(bendPath, ...atBend, disc(2));
    expect(fits.status, fits.why).toBe("OK");
    expect(fits.valid).toBe(true);
    const spring = sweep(helixPath, ...atHelix, disc(1.9));
    expect(spring.status, spring.why).toBe("OK");
    expect(Math.abs(sweptVolume(spring.result) / (Math.PI * 1.9 ** 2 * 3 * c) - 1)).toBeLessThan(
      1e-5,
    );
  });
});

describe("opSweep inside std's features", () => {
  it("lets Curve pattern's default orientation sweep with no faces to lock", () => {
    // Curve pattern's "Tangent to curve" orientation (refinePatternTangents) sketches a short line
    // square to the path's start and sweeps it along the path with profile control NONE and
    // lockFaces: qNothing(), to read tangent planes off the sheet. That exact call must sweep.
    const mirrored = run(
      [
        'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skLineSegment(pathSketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(40, 0) * millimeter });',
        "skSolve(pathSketch);",
        'const start = evEdgeTangentLine(context, { "edge" : qCreatedBy(id + "path", EntityType.EDGE), "parameter" : 0 });',
        'const line = newSketchOnPlane(context, id + "line", { "sketchPlane" : plane(start.origin, start.direction) });',
        'skLineSegment(line, "line1", { "start" : vector(0, 0) * inch, "end" : vector(0 * meter, 1e-4 * meter) });',
        "skSolve(line);",
        'opSweep(context, id + "sweep", { "profiles" : qCreatedBy(id + "line", EntityType.EDGE), "path" : qCreatedBy(id + "path", EntityType.EDGE), "profileControl" : ProfileControlMode.NONE, "lockFaces" : qNothing() });',
        'setVariable(context, "faces", size(evaluateQuery(context, qCreatedBy(id + "sweep", EntityType.FACE))));',
      ].join("\n"),
    );
    expect(mirrored.status, mirrored.why).toBe("OK");
    expect(mirrored.number("faces")).toBe(1);
    // The feature itself, 4 copies along a straight sketch line. Where they land depends on
    // evDistance's face parameters (another stream's), and here it stops earlier, at the
    // startTracking call before the sweep (lastOperationId isn't supported locally yet): only
    // that it doesn't stop at opSweep is checked.
    const r = run(
      [
        'fCuboid(context, id + "box", { "corner1" : vector(-1, -1, -1) * millimeter, "corner2" : vector(1, 1, 1) * millimeter });',
        'const pathSketch = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skLineSegment(pathSketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(40, 0) * millimeter });',
        "skSolve(pathSketch);",
        'curvePattern(context, id + "pattern", { "patternType" : PatternType.PART, "entities" : qCreatedBy(id + "box", EntityType.BODY), "edges" : qCreatedBy(id + "path", EntityType.EDGE), "spacingType" : CurvePatternSpacingType.EQUAL, "instanceCount" : 4, "orientationType" : CurvePatternOrientationType.DEFAULT, "operationType" : NewBodyOperationType.NEW, "skipInstances" : false, "skippedInstances" : [] });',
      ].join("\n"),
    );
    expect(r.why).not.toMatch(/opSweep|lockFaces/);
  });
});

describe("opSweep unset options", () => {
  it("treats empty lock faces as no lock, as std's Curve pattern passes them", () => {
    const plain = run(
      [
        rectangle(2, 6),
        ARC,
        sweepWith(arcPath, '"keepProfileOrientation" : false'),
        measureSweep,
      ].join("\n"),
    );
    for (const fields of [
      '"lockFaces" : qNothing()',
      '"profileControl" : ProfileControlMode.LOCK_FACES, "lockFaces" : qNothing()',
      '"lockFaces" : qUnion([])',
    ]) {
      const r = run([rectangle(2, 6), ARC, sweepWith(arcPath, fields), measureSweep].join("\n"));
      expect(r.status, `${fields}: ${r.why}`).toBe("OK");
      expect(r.number("volume")).toBeCloseTo(plain.number("volume"), 6);
      close(r.numbers("endSize"), plain.numbers("endSize"), 6);
    }
  });
});

describe("opSweep twist and scale", () => {
  it("scales the profile linearly along the path, about the path", () => {
    // A 2 mm circle grown to 4 mm over 30 mm: a frustum, PI 30 (4 + 8 + 16) / 3.
    const r = run(
      [
        'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
        'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
        "skSolve(profile);",
        LINE,
        sweepWith(linePath, '"hasScale" : true, "scaleFactor" : 2'),
        measureSweep,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("volume")).toBeCloseTo((Math.PI * 30 * 28) / 3, 3);
    expect(r.number("endArea")).toBeCloseTo(16 * Math.PI, 4);
  });

  it("scales the profile linearly with length along the path, through a line, an arc and a line", () => {
    // Up 10 and across 30 with a 5 mm bend: legs of 5 and 25 and a quarter circle of 2.5 PI.
    // A circle of radius 2 (1 + s / L) sweeps PI 4 L (1 + 1 + 1 / 3) for any path that doesn't
    // fold it, so long as the scale follows length and not each edge's own parameter.
    const length = 30 + 2.5 * Math.PI;
    for (const [name, path] of [
      [
        "polyline",
        'opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 10) * millimeter, vector(30, 0, 10) * millimeter], "bendRadii" : [5 * millimeter] });',
      ],
      ["arc", ARC.replace(/20/g, "10")],
    ] as const) {
      const r = run(
        [
          'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
          'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
          "skSolve(profile);",
          path,
          sweepWith(arcPath, '"hasScale" : true, "scaleFactor" : 2'),
        ].join("\n"),
      );
      expect(r.status, `${name}: ${r.why}`).toBe("OK");
      const along = name === "arc" ? 5 * Math.PI : length;
      expect(
        Math.abs(sweptVolume(r.result) / ((Math.PI * 4 * along * 7) / 3) - 1),
        name,
      ).toBeLessThan(1e-6);
    }
  });

  it("scales evenly with length in every profile control mode, however the path's curve runs", () => {
    // Straight up the z axis but run unevenly: a cubic with control points at z = 0, 1, 2 and 30
    // spends most of its parameter near the start. Alone, and after a 10 mm line. A circle of
    // radius 2 (1 + s / L) sweeps PI 4 L 7 / 3 when its scale follows length s.
    const uneven = (from: number) =>
      `opCreateBSplineCurve(context, id + "uneven", { "bSplineCurve" : bSplineCurve({ "degree" : 3, "isPeriodic" : false, "controlPoints" : [${[0, 1, 2, 30].map((z) => `vector(0, 0, ${from + z}) * millimeter`).join(", ")}], "knots" : knotArray([0, 0, 0, 0, 1, 1, 1, 1]) }) });`;
    const line =
      'opPolyline(context, id + "line", { "points" : [vector(0, 0, 0) * millimeter, vector(0, 0, 10) * millimeter] });';
    const both =
      'qUnion([qCreatedBy(id + "line", EntityType.EDGE), qCreatedBy(id + "uneven", EntityType.EDGE)])';
    for (const [path, edges, length] of [
      [uneven(0), 'qCreatedBy(id + "uneven", EntityType.EDGE)', 30],
      [line + uneven(10), both, 40],
    ] as const)
      for (const fields of [
        "",
        ', "keepProfileOrientation" : true',
        ', "lockDirection" : vector(1, 0, 0)',
        ', "hasTwist" : true, "angle" : 30 * degree',
      ]) {
        const r = run(
          [
            'const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });',
            'skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });',
            "skSolve(profile);",
            path,
            sweepWith(edges, `"hasScale" : true, "scaleFactor" : 2${fields}`),
          ].join("\n"),
        );
        const name = `${length} mm${fields}`;
        expect(r.status, `${name}: ${r.why}`).toBe("OK");
        expect(
          Math.abs(sweptVolume(r.result) / ((Math.PI * 4 * length * 7) / 3) - 1),
          name,
        ).toBeLessThan(1e-6);
      }
  });

  it("twists a positive angle right-handed about the path", () => {
    // Corner (1, 3) of the 2 x 6 rectangle turned 45 degrees about +z lands at (-sqrt 2, 2 sqrt 2).
    const r = run(
      [
        rectangle(2, 6),
        LINE,
        sweepWith(linePath, '"hasTwist" : true, "angle" : 45 * degree'),
        'setVariable(context, "corner", size(evaluateQuery(context, qContainsPoint(qCapEntity(id + "sweep", CapType.END, EntityType.VERTEX), vector(-sqrt(2), 2 * sqrt(2), 30) * millimeter))));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("corner")).toBe(1);
  });

  it("twists the profile about a straight path, keeping every slice's area", () => {
    // A 2 x 6 rectangle turned a quarter turn over 30 mm: every slice keeps its area.
    const r = run(
      [
        rectangle(2, 6),
        LINE,
        sweepWith(linePath, '"hasTwist" : true, "angle" : PI / 2'),
        measureSweep,
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // The twisted walls are fitted surfaces; their volume integral lands within 2e-5.
    expect(Math.abs(r.number("volume") / (12 * 30) - 1)).toBeLessThan(2e-5);
    close(r.numbers("endSize"), [6, 2, 0], 3);
  });

  it("refuses a twist along a curved path, and a sweep from mid-path one way only", () => {
    const curved = run(
      [rectangle(2, 6), ARC, sweepWith(arcPath, '"hasTwist" : true, "angle" : PI / 2')].join("\n"),
    );
    expect(curved.status).toBe("ERROR");
    expect(curved.fault?.message).toMatch(/twist along a curved path/);
    const midway = run(
      [
        rectangle(2, 6),
        'opFitSpline(context, id + "line", { "points" : [vector(0, 0, -10) * millimeter, vector(0, 0, 30) * millimeter] });',
        sweepWith(linePath, '"extendToFullPath" : false'),
      ].join("\n"),
    );
    expect(midway.status).toBe("ERROR");
    expect(midway.fault?.message).toMatch(/extendToFullPath/);
  });
});
