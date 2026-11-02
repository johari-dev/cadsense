import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ordered, topologyNamesOf } from "../src/geometry/Model.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { allValid } from "./valid.ts";
import { FsMap, untag } from "../src/runtime/Value.ts";

/**
 * opHole through std's own `opHole` wrapper and `holeDefinition` helpers, the way std's Hole feature
 * builds them.
 *
 * Ways it goes wrong:
 * - The tool lands at the wrong depth: a reference measured from the axis point instead of the
 *   target's face, `beforeReference` ignored, meters and millimeters mixed. Volumes catch it.
 * - Counterbore and countersink profiles build the wrong solid (the countersink cone's depth, the
 *   counterbore's flat step), or the tip cone is missing. Volumes and face counts catch it.
 * - LAST_TARGET_START, LAST_TARGET_END, LAST_TARGET_START_IN_DEPTH and UP_TO_NEXT pick the wrong
 *   target in a stack of plates.
 * - The return value disagrees with std's wrapper: missing `success`, distances not in meters,
 *   targets not transient ids, references keyed wrong, `holeDepth` not the up-to depth.
 * - Tools are left behind after subtracting, or missing when `keepTools` or `subtractFromTargets`
 *   asks for them.
 * - A hole that misses everything is reported as success, or one miss fails the whole operation.
 * - `targetMustDifferFromPrevious` and `notApplicableForFirstTarget` are ignored, so blind-in-last
 *   and clearance holes cut a single plate as if it were a stack.
 * - A matched profile on a slanted face is silently flattened instead of refused.
 * - holeDepth measured from where the hole is fully in rather than where it first enters (std:
 *   "from the first entrance of the intersected targets to the termination entity"), or to the
 *   up-to bound itself when the hole's end is offset from it.
 * - A tool or cut result that OpenCascade's checker rejects is kept.
 * - Hole faces aren't named, so std's `qOpHoleFace` can't find them for hole attributes.
 */
let runtime: FeatureScriptRuntime;
let counter = 0;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

const run = (body: string) => {
  const module = runtime.load(
    `test/hole${counter++}.fs`,
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
    valid: allValid(result),
    status: feature.status,
    message: feature.fault?.message ?? feature.message,
    statusEnum: feature.statusEnum,
    /** Everything a failure left behind, for assertion messages. */
    why: JSON.stringify([feature.fault?.message, feature.message, feature.exceptions]),
    fault: feature.fault,
    get: (name: string) => feature.variables.getField(name),
    number: (name: string) => Number(untag(feature.variables.getField(name))),
    /** An array variable (a vector of lengths divided by a unit) as plain numbers. */
    numbers: (name: string) => {
      const value = untag(feature.variables.getField(name));
      if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
      return value.map((item) => Number(untag(item)));
    },
    result,
  };
};

const mm = (x: number) => `${x} * millimeter`;
/** A 40 x 40 mm plate from z0 to z1 (mm). */
const plate = (name: string, z0: number, z1: number) =>
  `fCuboid(context, id + "${name}", { "corner1" : vector(0, 0, ${z0}) * millimeter, "corner2" : vector(40, 40, ${z1}) * millimeter });`;
/** A hole axis down -z through (20, 20, z). */
const down = (z: number) => `line(vector(20, 20, ${z}) * millimeter, vector(0, 0, -1))`;
/** Calls std's opHole; `extra` adds definition fields, `faceNames` std's face names. */
const holeAt = (profiles: string, axes: string, targets: string, extra = "", faceNames?: string) =>
  `const holes = opHole(context, id + "hole", { "holeDefinition" : holeDefinition([${profiles}]${faceNames ? `, { "faceNames" : ${faceNames} }` : ""}), "axes" : [${axes}], "targets" : ${targets}${extra} });`;
const volumeOf = (name: string, query: string) =>
  `setVariable(context, "${name}", evVolume(context, { "entities" : ${query} }) / millimeter ^ 3);`;
const countOf = (name: string, query: string) =>
  `setVariable(context, "${name}", size(evaluateQuery(context, ${query})));`;
const body = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
const P = "HolePositionReference";

/** Height of a drill tip cone of radius r (mm) and included angle 118 degrees. */
const tip = (r: number) => r / Math.tan((59 * Math.PI) / 180);
const fsTip = (r: number) => `${r} * millimeter / tan(59 * degree)`;
const PLATE = 40 * 40 * 20;

describe("opHole on a curved target", () => {
  // TARGET_START is where the hole's cylinder first meets the target: drilling a 10 mm sphere from
  // z = 20 mm down with a 5 mm radius, the pole at 10 mm from the axis point, not the rim where the
  // wall cuts the sphere (20 - sqrt(75)), which left the dome over the hole.
  it("starts at the first point inside the cylinder, not the wall's rim", () => {
    const r = run(
      [
        'opSphere(context, id + "sphere", { "center" : vector(0, 0, 0) * millimeter, "radius" : 10 * millimeter });',
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, 0 * millimeter, 5 * millimeter)`,
            `holeProfile(${P}.TARGET_START, 5 * millimeter, 5 * millimeter)`,
            `holeProfile(${P}.TARGET_START, 5 * millimeter, 0 * millimeter)`,
          ].join(", "),
          "line(vector(0, 0, 20) * millimeter, vector(0, 0, -1))",
          body("sphere"),
        ),
        "const info = holes[0].positionReferenceInfo[HolePositionReference.TARGET_START];",
        'setVariable(context, "range", [info.referenceRootStart / millimeter, info.referenceRootEnd / millimeter]);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const [start, end] = r.numbers("range");
    expect(start).toBeCloseTo(10, 6);
    expect(end).toBeCloseTo(20 - Math.sqrt(75), 6);
  });
});

describe("opHole", () => {
  it("cuts a simple blind hole measured from the target's face, tip included", () => {
    // Axis starts 5 mm above a 20 mm plate; the 8 mm depth is from the top face, not the axis point.
    const r = run(
      [
        plate("plate", 0, 20),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.TARGET_START, ${mm(8)}, ${mm(5)})`,
            `holeProfile(${P}.TARGET_START, ${mm(8)} + ${fsTip(5)}, ${mm(0)})`,
          ].join(", "),
          down(25),
          body("plate"),
        ),
        volumeOf("volume", body("plate")),
        countOf(
          "faces",
          'qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.FACE)',
        ),
        countOf("bodies", "qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)"),
        'setVariable(context, "success", holes[0].success);',
        'setVariable(context, "start", holes[0].positionReferenceInfo[HolePositionReference.TARGET_START].referenceRootStart / millimeter);',
        'setVariable(context, "same", holes[0].positionReferenceInfo[HolePositionReference.TARGET_START].target == qCreatedBy(id + "plate", EntityType.BODY));',
        'const extremes = holes[0].targetToDepthExtremes[qTransient(evaluateQuery(context, qCreatedBy(id + "plate", EntityType.BODY))[0].transientId)];',
        'setVariable(context, "extremes", mapArray([extremes.firstEntrance, extremes.fullEntrance, extremes.firstExit, extremes.fullExit], d => d / millimeter));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    const removed = Math.PI * 25 * 8 + (Math.PI * 25 * tip(5)) / 3;
    expect(r.number("volume")).toBeCloseTo(PLATE - removed, 4);
    // 6 plate faces, the shaft and the tip cone.
    expect(r.get("faces")).toBe(8);
    expect(r.get("bodies")).toBe(1);
    expect(r.get("success")).toBe(true);
    expect(r.number("start")).toBeCloseTo(5, 9);
    expect(r.numbers("extremes")).toEqual([5, 5, 25, 25].map((x) => expect.closeTo(x, 9)));
  });

  it("cuts through all with a tip past the last exit, measured from LAST_TARGET_END", () => {
    const r = run(
      [
        plate("plate", 0, 20),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.LAST_TARGET_END, ${mm(0.002)}, ${mm(5)})`,
            `holeProfile(${P}.LAST_TARGET_END, ${mm(0.002)}, ${mm(0)})`,
          ].join(", "),
          down(20),
          body("plate"),
        ),
        volumeOf("volume", body("plate")),
        countOf(
          "faces",
          'qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.FACE)',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("volume")).toBeCloseTo(PLATE - Math.PI * 25 * 20, 4);
    expect(r.get("faces")).toBe(7);
  });

  it("cuts a counterbore: a wide flat-bottomed step, then the shaft and tip", () => {
    const r = run(
      [
        plate("plate", 0, 20),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(8)})`,
            `holeProfile(${P}.TARGET_START, ${mm(4)}, ${mm(8)})`,
            `holeProfile(${P}.TARGET_START, ${mm(4)}, ${mm(4)})`,
            `holeProfile(${P}.TARGET_START, ${mm(12)}, ${mm(4)})`,
            `holeProfile(${P}.TARGET_START, ${mm(12)} + ${fsTip(4)}, ${mm(0)})`,
          ].join(", "),
          down(20),
          body("plate"),
          "",
          '["cap", "cboreCylinder", "cborePlane", "shaft", "tip"]',
        ),
        volumeOf("volume", body("plate")),
        countOf(
          "faces",
          'qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.FACE)',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const removed = Math.PI * 64 * 4 + Math.PI * 16 * 8 + (Math.PI * 16 * tip(4)) / 3;
    expect(r.number("volume")).toBeCloseTo(PLATE - removed, 4);
    // Counterbore wall, its flat step, the shaft, the tip.
    expect(r.get("faces")).toBe(10);
    // Each carries its name; the cap lies on the plate's top face, which stays the plate's own.
    const names = ordered(r.result.geometry!, (entity) => entity.type === "FACE").flatMap((face) =>
      topologyNamesOf(r.result.oc!, face.shape).map((n) => n.name),
    );
    expect(names.toSorted()).toEqual(["cboreCylinder", "cborePlane", "shaft", "tip"]);
  });

  it("cuts a 90 degree countersink through, collapsing the flat-entry transition profile", () => {
    // std's countersink: profile 1 sits on profile 0 when the entry face is flat, and is dropped.
    const r = run(
      [
        plate("plate", 0, 20),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(8)}, { "name" : "beforeCSink" })`,
            `holeProfile(${P}.TARGET_START, ${mm(0)}, ${mm(8)}, { "name" : "csinkTransition" })`,
            `holeProfile(${P}.TARGET_START, ${mm(4)}, ${mm(4)}, { "name" : "beforeShaft" })`,
            `holeProfile(${P}.LAST_TARGET_END, ${mm(0.002)}, ${mm(4)}, { "name" : "beforeTip" })`,
            `holeProfile(${P}.LAST_TARGET_END, ${mm(0.002)}, ${mm(0)}, { "name" : "tip" })`,
          ].join(", "),
          down(20),
          body("plate"),
          "",
          '["cap", "csinkCylinder", "csinkCone", "shaft", "tip"]',
        ),
        volumeOf("volume", body("plate")),
        countOf(
          "faces",
          'qOwnedByBody(qCreatedBy(id + "plate", EntityType.BODY), EntityType.FACE)',
        ),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    // Frustum r 8 -> 4 over 4 mm, then the 4 mm shaft for the remaining 16 mm.
    const removed = ((Math.PI * 4) / 3) * (64 + 32 + 16) + Math.PI * 16 * 16;
    expect(r.number("volume")).toBeCloseTo(PLATE - removed, 4);
    // Cone and shaft.
    expect(r.get("faces")).toBe(8);
    // The cone and shaft faces carry std's face names; the entry circle keeps the first collapsed
    // profile's name. The exit circle is new, since the tool's own end lies below the plate.
    const faces = ordered(r.result.geometry!, (entity) => entity.type === "FACE");
    const names = faces.flatMap((face) =>
      topologyNamesOf(r.result.oc!, face.shape).map((n) => `${n.kind}:${n.name}`),
    );
    expect(names.toSorted()).toEqual(["HOLE_FACE:csinkCone", "HOLE_FACE:shaft"]);
    const profiles = ordered(r.result.geometry!, (entity) => entity.type === "EDGE").flatMap(
      (edge) => topologyNamesOf(r.result.oc!, edge.shape).map((n) => n.name),
    );
    expect(profiles.toSorted()).toEqual(["beforeCSink", "beforeShaft"]);
  });

  it("measures blind-in-last from the last plate in a stack, with a matched step at its face", () => {
    const r = run(
      [
        plate("top", 10, 20),
        plate("bottom", 0, 10),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `matchedHoleProfile(${P}.LAST_TARGET_START, ${mm(5)}, { "targetMustDifferFromPrevious" : true })`,
            `matchedHoleProfile(${P}.LAST_TARGET_START, ${mm(3)})`,
            `holeProfile(${P}.LAST_TARGET_START, ${mm(6)}, ${mm(3)})`,
            `holeProfile(${P}.LAST_TARGET_START, ${mm(6)} + ${fsTip(3)}, ${mm(0)})`,
          ].join(", "),
          down(20),
          `qUnion([${body("top")}, ${body("bottom")}])`,
        ),
        volumeOf("top", body("top")),
        volumeOf("bottom", body("bottom")),
        'setVariable(context, "last", holes[0].positionReferenceInfo[HolePositionReference.LAST_TARGET_START].referenceRootEnd / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("top")).toBeCloseTo(16000 - Math.PI * 25 * 10, 4);
    expect(r.number("bottom")).toBeCloseTo(16000 - Math.PI * 9 * 6 - (Math.PI * 9 * tip(3)) / 3, 4);
    expect(r.number("last")).toBeCloseTo(10, 9);
  });

  it("fails a hole whose last target is its first when the profile asks them to differ", () => {
    const r = run(
      [
        plate("plate", 0, 20),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.LAST_TARGET_START, ${mm(6)}, ${mm(5)}, { "targetMustDifferFromPrevious" : true })`,
            `holeProfile(${P}.LAST_TARGET_START, ${mm(6)} + ${fsTip(5)}, ${mm(0)})`,
          ].join(", "),
          down(20),
          body("plate"),
        ),
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault).toBeNull();
    expect(r.statusEnum).toBe("HOLE_TARGETS_DO_NOT_DIFFER");
  });

  it("drops clearance profiles in one plate and steps down to the tap drill in the second", () => {
    // std's fastener-fit clearance: a 5 mm clearance radius to the last target in depth, then 3 mm.
    const profiles = [
      `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
      `matchedHoleProfile(${P}.LAST_TARGET_START_IN_DEPTH, ${mm(5)}, { "notApplicableForFirstTarget" : true })`,
      `matchedHoleProfile(${P}.LAST_TARGET_START_IN_DEPTH, ${mm(3)}, { "notApplicableForFirstTarget" : true })`,
      `holeProfile(${P}.TARGET_START, ${mm(16)}, ${mm(3)})`,
      `holeProfile(${P}.TARGET_START, ${mm(16)} + ${fsTip(3)}, ${mm(0)})`,
    ].join(", ");
    const one = run(
      [
        plate("plate", 0, 20),
        holeAt(profiles, down(20), body("plate")),
        volumeOf("volume", body("plate")),
        'setVariable(context, "inDepth", holes[0].positionReferenceInfo[HolePositionReference.LAST_TARGET_START_IN_DEPTH] != undefined);',
      ].join("\n"),
    );
    expect(one.status, one.why).toBe("OK");
    expect(one.number("volume")).toBeCloseTo(
      PLATE - Math.PI * 9 * 16 - (Math.PI * 9 * tip(3)) / 3,
      4,
    );
    expect(one.get("inDepth")).toBe(false);

    const two = run(
      [
        plate("top", 10, 20),
        plate("bottom", 0, 10),
        holeAt(profiles, down(20), `qUnion([${body("top")}, ${body("bottom")}])`),
        volumeOf("top", body("top")),
        volumeOf("bottom", body("bottom")),
      ].join("\n"),
    );
    expect(two.status, two.why).toBe("OK");
    expect(two.number("top")).toBeCloseTo(16000 - Math.PI * 25 * 10, 4);
    expect(two.number("bottom")).toBeCloseTo(
      16000 - Math.PI * 9 * 6 - (Math.PI * 9 * tip(3)) / 3,
      4,
    );
  });

  it("goes up to the next face, and reports that depth", () => {
    // Two stacked plates: up to next ends at the first plate's bottom; the tip pokes into the second.
    const r = run(
      [
        plate("top", 10, 20),
        plate("bottom", 0, 10),
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.UP_TO_NEXT, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.UP_TO_NEXT, ${fsTip(5)}, ${mm(0)})`,
          ].join(", "),
          down(25),
          `qUnion([${body("top")}, ${body("bottom")}])`,
        ),
        volumeOf("top", body("top")),
        volumeOf("bottom", body("bottom")),
        'setVariable(context, "depth", holes[0].holeDepth / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("top")).toBeCloseTo(16000 - Math.PI * 25 * 10, 4);
    expect(r.number("bottom")).toBeCloseTo(16000 - (Math.PI * 25 * tip(5)) / 3, 4);
    expect(r.number("depth")).toBeCloseTo(10, 9);
  });

  it("measures an up-to depth from the first entrance, on a slanted face", () => {
    // A 40 x 40 x 20 block turned 30 degrees about y: over the hole's 3 mm radius its top runs from
    // z = (10 - 1.5) / cos 30 to (10 + 1.5) / cos 30. Down from z = 30 to the plane z = 0, the
    // depth is from the first entrance (z = 11.5 / cos 30) to the plane.
    const r = run(
      [
        'fCuboid(context, id + "block", { "corner1" : vector(-20, -20, -10) * millimeter, "corner2" : vector(20, 20, 10) * millimeter });',
        'opTransform(context, id + "turn", { "bodies" : qCreatedBy(id + "block", EntityType.BODY), "transform" : rotationAround(line(vector(0, 0, 0) * millimeter, vector(0, 1, 0)), 30 * degree) });',
        'opPlane(context, id + "end", { "plane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1)), "width" : 50 * millimeter, "height" : 50 * millimeter });',
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(3)})`,
            `holeProfile(${P}.UP_TO_ENTITY, ${mm(0)}, ${mm(3)})`,
            `holeProfile(${P}.UP_TO_ENTITY, ${mm(0)}, ${mm(0)})`,
          ].join(", "),
          down(30).replace("vector(20, 20, 30)", "vector(0, 0, 30)"),
          body("block"),
          ', "endBoundEntity" : qCreatedBy(id + "end", EntityType.FACE)',
        ),
        'setVariable(context, "depth", holes[0].holeDepth / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.valid).toBe(true);
    expect(r.number("depth")).toBeCloseTo(11.5 / Math.cos(Math.PI / 6), 6);
  });

  it("stops up to a plane or a vertex given as the end bound", () => {
    const r = run(
      [
        plate("plate", 0, 20),
        'opPlane(context, id + "stop", { "plane" : plane(vector(0, 0, 7) * millimeter, vector(0, 0, 1)) });',
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.UP_TO_ENTITY, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.UP_TO_ENTITY, ${fsTip(5)}, ${mm(0)})`,
          ].join(", "),
          down(20),
          body("plate"),
          ', "endBoundEntity" : qCreatedBy(id + "stop", EntityType.FACE)',
        ),
        volumeOf("volume", body("plate")),
        'setVariable(context, "depth", holes[0].holeDepth / millimeter);',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.number("volume")).toBeCloseTo(
      PLATE - Math.PI * 25 * 13 - (Math.PI * 25 * tip(5)) / 3,
      4,
    );
    expect(r.number("depth")).toBeCloseTo(13, 9);
  });

  it("measures an offset up-to depth to the shoulder, as std's hole attributes read it", () => {
    // std's computeEndProfiles (hole.fs 1806-1820) for an offset d from the bound: offsetDistance
    // becomes -d (without oppositeOffsetDirection), the shoulder sits tipOffset = -d - tipDepth
    // past the bound and the tip point -d past it. The hole attributes (hole.fs 3270) then read
    // |holeDepth - tipOffset - referenceRootEnd| as the first entrance, so holeDepth runs from the
    // first entrance to the shoulder. Here the bound is 13 mm down and the tip is 3.00429 mm deep:
    // d = 4 puts the shoulder at 13 - 4 - 3.00429 = 5.99571, d = -4 at 13 + 4 - 3.00429 = 13.99571.
    for (const offset of [4, -4]) {
      const tipOffset = -offset - tip(5);
      const shoulder = 13 + tipOffset;
      const r = run(
        [
          plate("plate", 0, 20),
          'opPlane(context, id + "stop", { "plane" : plane(vector(0, 0, 7) * millimeter, vector(0, 0, 1)) });',
          holeAt(
            [
              `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
              `holeProfile(${P}.UP_TO_ENTITY, ${mm(tipOffset)}, ${mm(5)})`,
              `holeProfile(${P}.UP_TO_ENTITY, ${mm(-offset)}, ${mm(0)})`,
            ].join(", "),
            down(20),
            body("plate"),
            ', "endBoundEntity" : qCreatedBy(id + "stop", EntityType.FACE)',
          ),
          volumeOf("volume", body("plate")),
          'setVariable(context, "depth", holes[0].holeDepth / millimeter);',
          `setVariable(context, "firstEntrance", abs(holes[0].holeDepth - ${mm(tipOffset)} - holes[0].positionReferenceInfo[${P}.UP_TO_ENTITY].referenceRootEnd) / millimeter);`,
        ].join("\n"),
      );
      expect(r.status, r.why).toBe("OK");
      expect(r.valid).toBe(true);
      expect(r.number("volume"), `offset ${offset}`).toBeCloseTo(
        PLATE - Math.PI * 25 * shoulder - (Math.PI * 25 * tip(5)) / 3,
        4,
      );
      expect(r.number("depth"), `offset ${offset}`).toBeCloseTo(shoulder, 9);
      expect(r.number("firstEntrance"), `offset ${offset}`).toBeCloseTo(0, 9);
    }
  });

  it("keeps the tools as solids when asked, and leaves the targets alone without subtracting", () => {
    const profiles = [
      `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
      `holeProfile(${P}.TARGET_START, ${mm(8)}, ${mm(5)})`,
      `holeProfile(${P}.TARGET_START, ${mm(8)}, ${mm(0)})`,
    ].join(", ");
    const kept = run(
      [
        plate("plate", 0, 20),
        holeAt(profiles, down(20), body("plate"), ', "keepTools" : true'),
        volumeOf("plate", body("plate")),
        volumeOf("tools", body("hole")),
      ].join("\n"),
    );
    expect(kept.status, kept.why).toBe("OK");
    expect(kept.number("plate")).toBeCloseTo(PLATE - Math.PI * 25 * 8, 4);
    expect(kept.number("tools")).toBeCloseTo(Math.PI * 25 * 8, 4);

    const untouched = run(
      [
        plate("plate", 0, 20),
        holeAt(profiles, down(20), body("plate"), ', "subtractFromTargets" : false'),
        volumeOf("plate", body("plate")),
        volumeOf("tools", body("hole")),
      ].join("\n"),
    );
    expect(untouched.status, untouched.why).toBe("OK");
    expect(untouched.number("plate")).toBeCloseTo(PLATE, 4);
    expect(untouched.number("tools")).toBeCloseTo(Math.PI * 25 * 8, 4);
  });

  it("reports a missed hole as unsuccessful, and fails only when every hole misses", () => {
    const profiles = [
      `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(2)})`,
      `holeProfile(${P}.TARGET_START, ${mm(5)}, ${mm(2)})`,
      `holeProfile(${P}.TARGET_START, ${mm(5)}, ${mm(0)})`,
    ].join(", ");
    const miss = "line(vector(100, 100, 20) * millimeter, vector(0, 0, -1))";
    const partial = run(
      [
        plate("plate", 0, 20),
        holeAt(profiles, `${down(20)}, ${miss}`, body("plate")),
        'setVariable(context, "success", [holes[0].success, holes[1].success]);',
        volumeOf("volume", body("plate")),
      ].join("\n"),
    );
    expect(partial.status, partial.why).toBe("OK");
    expect(untag(partial.get("success"))).toEqual([true, false]);
    expect(partial.number("volume")).toBeCloseTo(PLATE - Math.PI * 4 * 5, 4);

    const none = run([plate("plate", 0, 20), holeAt(profiles, miss, body("plate"))].join("\n"));
    expect(none.status).toBe("ERROR");
    expect(none.fault).toBeNull();
    expect(none.statusEnum).toBe("HOLE_NO_HITS");
  });

  it("refuses a matched profile on a slanted face rather than flattening it", () => {
    // A wedge: the top face rises 10 mm over 40 mm in x.
    const r = run(
      [
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
        'skLineSegment(sketch, "a", { "start" : vector(0, 0) * millimeter, "end" : vector(40, 0) * millimeter });',
        'skLineSegment(sketch, "b", { "start" : vector(40, 0) * millimeter, "end" : vector(40, 30) * millimeter });',
        'skLineSegment(sketch, "c", { "start" : vector(40, 30) * millimeter, "end" : vector(0, 20) * millimeter });',
        'skLineSegment(sketch, "d", { "start" : vector(0, 20) * millimeter, "end" : vector(0, 0) * millimeter });',
        "skSolve(sketch);",
        'opExtrude(context, id + "wedge", { "entities" : qSketchRegion(id + "sketch"), "direction" : vector(0, -1, 0), "endBound" : BoundingType.BLIND, "endDepth" : 40 * millimeter });',
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `matchedHoleProfile(${P}.TARGET_START, ${mm(5)})`,
            `matchedHoleProfile(${P}.TARGET_START, ${mm(3)})`,
            `holeProfile(${P}.TARGET_START, ${mm(6)}, ${mm(3)})`,
            `holeProfile(${P}.TARGET_START, ${mm(6)}, ${mm(0)})`,
          ].join(", "),
          "line(vector(20, -20, 40) * millimeter, vector(0, 0, -1))",
          body("wedge"),
        ),
      ].join("\n"),
    );
    expect(r.status).toBe("ERROR");
    expect(r.fault?.message).toMatch(/matched hole profile on a face that isn't perpendicular/i);
  });

  it("measures before-reference profiles from where a slanted face starts", () => {
    // Same wedge; at x = 20 its top is z = 25, and over the 5 mm hole radius it spans z 23.75..26.25.
    const r = run(
      [
        'const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });',
        'skLineSegment(sketch, "a", { "start" : vector(0, 0) * millimeter, "end" : vector(40, 0) * millimeter });',
        'skLineSegment(sketch, "b", { "start" : vector(40, 0) * millimeter, "end" : vector(40, 30) * millimeter });',
        'skLineSegment(sketch, "c", { "start" : vector(40, 30) * millimeter, "end" : vector(0, 20) * millimeter });',
        'skLineSegment(sketch, "d", { "start" : vector(0, 20) * millimeter, "end" : vector(0, 0) * millimeter });',
        "skSolve(sketch);",
        'opExtrude(context, id + "wedge", { "entities" : qSketchRegion(id + "sketch"), "direction" : vector(0, -1, 0), "endBound" : BoundingType.BLIND, "endDepth" : 40 * millimeter });',
        holeAt(
          [
            `holeProfileBeforeReference(${P}.TARGET_START, ${mm(0)}, ${mm(5)})`,
            `holeProfile(${P}.TARGET_START, ${mm(10)}, ${mm(5)})`,
            `holeProfile(${P}.TARGET_START, ${mm(10)}, ${mm(0)})`,
          ].join(", "),
          "line(vector(20, -20, 40) * millimeter, vector(0, 0, -1))",
          body("wedge"),
        ),
        "const info = holes[0].positionReferenceInfo[HolePositionReference.TARGET_START];",
        'setVariable(context, "range", [info.referenceRootStart / millimeter, info.referenceRootEnd / millimeter]);',
        volumeOf("volume", body("wedge")),
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    const range = r.numbers("range");
    expect(range[0]).toBeCloseTo(40 - 26.25, 6);
    expect(range[1]).toBeCloseTo(40 - 23.75, 6);
    // The flat bottom sits 10 mm below the lowest point of the entry (z = 23.75 - 10); the slanted
    // top cuts the cylinder at its mean height 25, so the removed length averages 25 - 13.75.
    const wedge = ((40 * (20 + 30)) / 2) * 40;
    expect(r.number("volume")).toBeCloseTo(wedge - Math.PI * 25 * (25 - 13.75), 3);
  });
});

describe("getHoleAttributes", () => {
  it("returns the hole attributes on the entities and nothing else", () => {
    const r = run(
      [
        plate("plate", 0, 20),
        'const top = qCreatedBy(id + "plate", EntityType.FACE)->qNthElement(0);',
        'setAttribute(context, { "entities" : top, "attribute" : asHoleAttribute({ "holeType" : HoleStyle.SIMPLE, "holeDiameter" : 5 * millimeter }) });',
        'setAttribute(context, { "entities" : top, "name" : "other", "attribute" : 7 });',
        'const found = @getHoleAttributes(context, { "entities" : top });',
        'setVariable(context, "count", size(found));',
        'setVariable(context, "isHole", found[0] is HoleAttribute);',
        'setVariable(context, "diameter", found[0].holeDiameter / millimeter);',
        'setVariable(context, "none", size(@getHoleAttributes(context, { "entities" : qCreatedBy(id + "plate", EntityType.EDGE) })));',
      ].join("\n"),
    );
    expect(r.status, r.why).toBe("OK");
    expect(r.get("count")).toBe(1);
    expect(r.get("isHole")).toBe(true);
    expect(r.number("diameter")).toBeCloseTo(5, 9);
    expect(r.get("none")).toBe(0);
  });
});

/**
 * std's Hole feature, end to end: it finds its faces with `qOpHoleFace`/`qOpHoleProfile`, places
 * from mate connectors with `evAxis`, and reads `lastModifyingOperationId` and
 * `getParameterToleranceInfo`.
 *
 * Ways it goes wrong beyond opHole's: std can't find the hole faces, so it writes no attributes or
 * writes them on every face; a hole starting on the part's top face is called a partial through;
 * table sizes (tap drill, clearance fit, major diameter) don't reach the geometry.
 */
describe("std's Hole feature", () => {
  /** Runs std's `hole` from a mate connector at the top of the plate(s), after its editing logic. */
  const stdHole = (fields: string, stacked = false) =>
    run(
      [
        stacked ? plate("plate", 10, 20) : plate("plate", 0, 20),
        stacked ? plate("plate2", 0, 10) : "",
        'opMateConnector(context, id + "at", { "coordSystem" : coordSystem(vector(20, 20, 20) * millimeter, vector(1, 0, 0), vector(0, 0, 1)), "owner" : qCreatedBy(id + "plate", EntityType.BODY) });',
        `var holeDefinition = { "locations" : qBodyType(qCreatedBy(id + "at", EntityType.BODY), BodyType.MATE_CONNECTOR), "scope" : qUnion([${body("plate")}, ${body("plate2")}]), "initEntities" : qNothing(), "oppositeDirection" : false, "startStyle" : HoleStartStyle.PART, "tipAngleStyle" : TipAngleStyle.DEGREE118, "tipAngle" : 118 * degree, "featureName" : "", "locationSignatures" : [], "tapClearance" : 3, "isTappedThrough" : false, "offset" : false, "isMultiple" : false, ${fields} };`,
        'if (holeDefinition.isV2 == true) holeDefinition = holeEditLogic(context, id + "hole", {}, holeDefinition, true, { "scope" : true, "oppositeDirection" : true, "locations" : true }, qNothing());',
        // The dialog evaluates the expressions editing logic returns.
        'for (var k, v in holeDefinition) if (v is string && k != "featureName") { const value = try silent(lookupTableEvaluate(v)); if (value != undefined) holeDefinition[k] = value; }',
        'hole(context, id + "hole", holeDefinition);',
        volumeOf("volume", body("plate")),
        volumeOf("volume2", body("plate2")),
        `const faces = qOwnedByBody(qUnion([${body("plate")}, ${body("plate2")}]), EntityType.FACE);`,
        'setVariable(context, "attributes", getAttributes(context, { "entities" : faces, "attributePattern" : asHoleAttribute({}) }));',
      ].join("\n"),
    );
  const attributes = (r: ReturnType<typeof run>) => {
    const value = untag(r.get("attributes"));
    if (!Array.isArray(value)) throw new Error("no attributes");
    return value.map((attribute) => {
      const fields = untag(attribute);
      if (!(fields instanceof FsMap)) throw new Error("attribute isn't a map");
      return (name: string) => untag(fields.getField(name));
    });
  };
  const legacy = (style: string, end: string, sizes: string) =>
    `"style" : HoleStyle.${style}, "endStyle" : HoleEndStyle.${end}, ${sizes}`;

  it("cuts simple, counterbore and countersink holes with their hand-checked volumes", () => {
    const simple = stdHole(
      legacy("SIMPLE", "BLIND", '"holeDiameter" : 10 * millimeter, "holeDepth" : 8 * millimeter'),
    );
    expect(simple.status, simple.why).toBe("OK");
    expect(simple.number("volume")).toBeCloseTo(
      PLATE - Math.PI * 25 * 8 - (Math.PI * 25 * tip(5)) / 3,
      3,
    );
    expect(attributes(simple).map((a) => a("endType"))).toEqual(["BLIND", "BLIND"]);

    const through = stdHole(legacy("SIMPLE", "THROUGH", '"holeDiameter" : 10 * millimeter'));
    expect(through.number("volume")).toBeCloseTo(PLATE - Math.PI * 25 * 20, 3);
    expect(attributes(through).map((a) => a("partialThrough"))).toEqual([false]);

    const cbore = stdHole(
      legacy(
        "C_BORE",
        "BLIND",
        '"holeDiameter" : 8 * millimeter, "holeDepth" : 12 * millimeter, "cBoreDiameter" : 16 * millimeter, "cBoreDepth" : 4 * millimeter',
      ),
    );
    expect(cbore.number("volume")).toBeCloseTo(
      PLATE - Math.PI * 64 * 4 - Math.PI * 16 * 8 - (Math.PI * 16 * tip(4)) / 3,
      3,
    );
    expect(attributes(cbore)).toHaveLength(4);

    const csink = stdHole(
      legacy(
        "C_SINK",
        "THROUGH",
        '"holeDiameter" : 8 * millimeter, "cSinkDiameter" : 16 * millimeter, "cSinkAngle" : 90 * degree',
      ),
    );
    expect(csink.number("volume")).toBeCloseTo(
      PLATE - ((Math.PI * 4) / 3) * 112 - Math.PI * 16 * 16,
      3,
    );
  });

  it("sizes tapped and fastener-fit holes from std's ISO tables", () => {
    const v3 = (fit: string) =>
      `"isV2" : true, "holeVersion" : HoleVersion.V3, "unitsSystem" : UnitsSystem.METRIC, "styleV2" : HoleStyle.SIMPLE, "style" : HoleStyle.SIMPLE, "endStyleV2" : HoleEndStyleV2.BLIND, "showTappedDepth" : true, "threadStandard" : ThreadStandard.ISO, "holeDepth" : 12 * millimeter, "tappedDepth" : 9 * millimeter, "holeDepthV3" : 12 * millimeter, "tappedDepthV3" : 9 * millimeter, "hasClearance" : ${fit !== "None"}, "isoHoleTableEx" : { "holeType" : "Tapped", "type" : "Straight tap", "size" : "M6", "pitch" : "1.00 mm (Coarse)", "fit" : "${fit}" } as LookupTablePath`;
    // M6 x 1 tapped: a 5 mm tap drill, 12 mm deep.
    const tapped = stdHole(v3("None"));
    expect(tapped.status, tapped.why).toBe("OK");
    expect(tapped.number("volume")).toBeCloseTo(
      PLATE - Math.PI * 6.25 * 12 - (Math.PI * 6.25 * tip(2.5)) / 3,
      3,
    );
    const [shaft] = attributes(tapped);
    expect([shaft!("isTappedHole"), shaft!("tapSize")]).toEqual([true, "M6x1.00"]);
    // A normal fit through a 10 mm plate: 6.6 mm clearance, then the tap drill 2 mm into the next.
    const fit = stdHole(v3("Normal"), true);
    expect(fit.status, fit.why).toBe("OK");
    expect(fit.number("volume")).toBeCloseTo(16000 - Math.PI * 3.3 ** 2 * 10, 3);
    expect(fit.number("volume2")).toBeCloseTo(
      16000 - Math.PI * 6.25 * 2 - (Math.PI * 6.25 * tip(2.5)) / 3,
      3,
    );
    expect(attributes(fit).map((a) => a("isClearanceAndTapped"))).toEqual([false, true, true]);
  });
});
