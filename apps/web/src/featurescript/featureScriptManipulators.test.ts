import type { FeatureScriptDialogInput, FeatureScriptManipulator } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  alongAxis,
  angleAbout,
  dragManipulator,
  dragStep,
  manipulatorRow,
  onPlane,
  readManipulator,
  startDrag,
  type Ray,
} from "./featureScriptManipulators";

/**
 * Drawing and dragging a feature's manipulators: its fields read from the run, a pointer ray
 * projected onto the handle's axis, plane or arc, and the change sent back on release. Ways this
 * goes wrong: a manipulator with no expression to send back, an unknown type, or a malformed
 * field (a zero direction, a missing base) is drawn and its drag can't run; a ray along the axis
 * (looking down the arrow) gives a huge jump instead of holding still; a ray parallel to a plane,
 * or meeting it behind the camera, puts the handle at infinity; the handle jumps to the pointer on
 * grab instead of moving by how far the pointer moved; a negative offset or a direction that
 * isn't unit length scales the value; an arc's angle wraps from +180 to -180 mid-drag, so a revolve
 * past half a turn snaps back; values past the manipulator's min or max are sent; values are sent
 * at the pointer's sub-pixel precision (39.87342 mm) instead of a step the zoom can show; the
 * change is written in other units or loses the triad's other two components; the dialog row the
 * drag drives isn't found from `primaryParameterId`, or a list item from a key such as
 * `waypoint1` lands on the wrong item.
 */

const manipulator = (
  type: string,
  fields: FeatureScriptManipulator["fields"],
  key = "m",
): FeatureScriptManipulator => ({ key, type, expression: `(m as Manipulator)`, fields });

/** A ray from `origin` toward `to`. */
const ray = (origin: readonly [number, number, number], to: readonly [number, number, number]) => {
  const d = [to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]] as const;
  const length = Math.hypot(...d);
  return { origin, direction: [d[0] / length, d[1] / length, d[2] / length] } satisfies Ray;
};

describe("readManipulator", () => {
  it("reads linear, triad, angular and flip manipulators in meters and radians", () => {
    expect(
      readManipulator(
        manipulator("LINEAR_1D", {
          base: [0, 0, 0.01],
          direction: [0, 0, 2],
          offset: 0.02,
          minValue: 0,
          maxValue: 0.1,
          primaryParameterId: "depth",
        }),
      ),
    ).toMatchObject({
      type: "LINEAR_1D",
      base: [0, 0, 0.01],
      direction: [0, 0, 1],
      offset: 0.02,
      min: 0,
      max: 0.1,
      primaryParameterId: "depth",
    });
    expect(
      readManipulator(manipulator("LINEAR_3D", { base: [0.1, 0, 0], offset: [0, 0, 0.04] })),
    ).toMatchObject({ type: "LINEAR_3D", base: [0.1, 0, 0], offset: [0, 0, 0.04] });
    expect(
      readManipulator(
        manipulator("ANGULAR", {
          axisOrigin: [0, 0, 0],
          axisDirection: [0, 0, 1],
          rotationOrigin: [0.01, 0, 0],
          angle: Math.PI / 2,
        }),
      ),
    ).toMatchObject({ type: "ANGULAR", angle: Math.PI / 2, min: -Math.PI, max: Math.PI });
    expect(
      readManipulator(
        manipulator("FLIP", { base: [0, 0, 0], direction: [1, 0, 0], flipped: true }),
      ),
    ).toMatchObject({ type: "FLIP", flipped: true, shown: [-1, 0, 0] });
    // A flipped arrow with its own other direction points that way.
    expect(
      readManipulator(
        manipulator("FLIP", {
          base: [0, 0, 0],
          direction: [1, 0, 0],
          flipped: true,
          otherDirection: [0, 1, 0],
        }),
      ),
    ).toMatchObject({ shown: [0, 1, 0] });
  });

  it("skips what it can't draw or send back", () => {
    for (const bad of [
      manipulator("POINTS", { points: [[0, 0, 0]], index: 0 }),
      manipulator("TRIAD_FULL", {}),
      manipulator("LINEAR_1D", { base: [0, 0, 0], direction: [0, 0, 0], offset: 0 }),
      manipulator("LINEAR_1D", { direction: [0, 0, 1], offset: 0 }),
      manipulator("LINEAR_3D", { base: [0, 0, 0], offset: [0, null, 0] }),
      manipulator("ANGULAR", {
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 0, 1],
        // On the axis: no radius to draw the arc at.
        rotationOrigin: [0, 0, 0.01],
        angle: 0,
      }),
      manipulator("FLIP", { base: [0, 0, 0], direction: [1, 0, 0] }),
    ])
      expect(readManipulator(bad), bad.type).toBeNull();
    expect(
      readManipulator({
        ...manipulator("LINEAR_3D", { base: [0, 0, 0], offset: [0, 0, 0] }),
        expression: null,
      }),
    ).toBeNull();
  });
});

describe("projecting the pointer ray", () => {
  it("finds the point on an axis nearest the ray, in the axis's direction", () => {
    // Looking along -y at the z axis from (0.3, 1, 0.2): the nearest axis point is z = 0.2.
    expect(alongAxis(ray([0.3, 1, 0.2], [0.3, 0, 0.2]), [0, 0, 0], [0, 0, 1])).toBeCloseTo(0.2);
    expect(alongAxis(ray([0.3, 1, 0.2], [0.3, 0, 0.2]), [0, 0, 0.5], [0, 0, -1])).toBeCloseTo(0.3);
  });

  it("holds still when the ray runs along the axis", () => {
    expect(alongAxis(ray([0, 0, 1], [0, 0, 0]), [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(alongAxis(ray([0, 0.001, 1], [0, 0, 0]), [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("meets a plane in front of the camera only", () => {
    expect(onPlane(ray([0, 0, 1], [0.1, 0, 0]), [0, 0, 0], [0, 0, 1])).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0),
      expect.closeTo(0),
    ]);
    // Parallel to it, and pointing away from it.
    expect(onPlane(ray([0, 0, 1], [1, 0, 1]), [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(onPlane(ray([0, 0, 1], [0, 0, 2]), [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("measures an angle about an axis from the zero direction, right-handed", () => {
    expect(angleAbout([0, 1, 0], [0, 0, 0], [0, 0, 1], [1, 0, 0])).toBeCloseTo(Math.PI / 2);
    expect(angleAbout([0, -1, 5], [0, 0, 0], [0, 0, 1], [1, 0, 0])).toBeCloseTo(-Math.PI / 2);
    expect(angleAbout([0, 0, 3], [0, 0, 0], [0, 0, 1], [1, 0, 0])).toBeNull();
  });
});

describe("dragStep", () => {
  it("rounds to the smallest power of ten a pixel shows", () => {
    expect(dragStep(0.0004)).toBeCloseTo(0.001);
    expect(dragStep(0.00003)).toBeCloseTo(0.0001);
    expect(dragStep(0.001)).toBeCloseTo(0.001);
  });
});

describe("dragging", () => {
  // Seen from +y, one meter away, so the pointer ray runs along -y.
  const from = (x: number, z: number) => ray([x, 1, z], [x, 0, z]);
  const STEP = { worldPerPixel: 0.0004 };

  it("moves a linear arrow by how far the pointer moved along it, rounded and clamped", () => {
    const linear = readManipulator(
      manipulator("LINEAR_1D", {
        base: [0, 0, 0],
        direction: [0, 0, -1],
        offset: 0.0102,
        minValue: -0.05,
        maxValue: 0.05,
        primaryParameterId: "depth",
      }),
    )!;
    // Grabbed 3 mm off its tip, at z = -13.2 mm; the tip is at z = -10.2 mm.
    const drag = startDrag(linear, "axis", from(0, -0.0132))!;
    const moved = dragManipulator(drag, from(0, -0.0332), STEP)!;
    expect(moved.value).toBeCloseTo(0.03);
    expect(moved.at[2]).toBeCloseTo(-0.03);
    expect(moved.changes).toEqual({ offset: "30 * millimeter" });
    expect(dragManipulator(drag, from(0, -0.5), STEP)!.changes).toEqual({
      offset: "50 * millimeter",
    });
    // Looking down the arrow, the value holds.
    expect(dragManipulator(drag, ray([0, 0, -1], [0, 0, 0]), STEP)).toBeNull();
  });

  it("moves one triad axis and keeps the other two components", () => {
    const triad = readManipulator(
      manipulator("LINEAR_3D", { base: [0.1, 0, 0], offset: [0.0123456, 0, 0.02] }, "waypoint1"),
    )!;
    const drag = startDrag(triad, "z", from(0.1123456, 0.02))!;
    const moved = dragManipulator(drag, from(0.2, 0.0601), STEP)!;
    expect(moved.value).toEqual([0.0123456, 0, expect.closeTo(0.06)]);
    expect(moved.at).toEqual([expect.closeTo(0.1123456), 0, expect.closeTo(0.06)]);
    expect(moved.changes).toEqual({ offset: "vector(12.3456, 0, 60) * millimeter" });
    expect(moved.label).toBe("Z offset 60 mm");
  });

  it("moves a triad's middle in the plane facing the camera", () => {
    const triad = readManipulator(
      manipulator("LINEAR_3D", { base: [0, 0, 0], offset: [0, 0, 0] }),
    )!;
    const drag = startDrag(triad, "center", from(0, 0))!;
    const moved = dragManipulator(drag, from(0.0201, -0.0102), STEP)!;
    expect(moved.value).toEqual([expect.closeTo(0.02), 0, expect.closeTo(-0.01)]);
    expect(moved.label).toBe("Offset (20, 0, -10) mm");
  });

  it("turns an arc past half a turn without wrapping, in whole degrees within its bounds", () => {
    const angular = readManipulator(
      manipulator("ANGULAR", {
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 1, 0],
        rotationOrigin: [0.01, 0, 0],
        angle: 0,
        minValue: -2 * Math.PI,
        maxValue: 2 * Math.PI,
        primaryParameterId: "angle",
      }),
    )!;
    // About +y seen from +y: x toward z is a negative turn, so walk the pointer the other way.
    const around = (degrees: number) => {
      const radians = (degrees * Math.PI) / 180;
      return from(0.01 * Math.cos(radians), -0.01 * Math.sin(radians));
    };
    const drag = startDrag(angular, "arc", around(0))!;
    for (const degrees of [60, 120, 170, 190, 250]) dragManipulator(drag, around(degrees), STEP);
    const moved = dragManipulator(drag, around(270.4), STEP)!;
    expect(moved.value).toBeCloseTo((270 * Math.PI) / 180);
    expect(moved.changes).toEqual({ angle: "270 * degree" });
    expect(moved.at).toEqual([expect.closeTo(0), 0, expect.closeTo(0.01)]);
  });

  it("flips a flip arrow with a click", () => {
    const flip = readManipulator(
      manipulator("FLIP", { base: [0, 0, 0], direction: [1, 0, 0], flipped: false }),
    )!;
    const drag = startDrag(flip, "flip", from(0, 0))!;
    expect(dragManipulator(drag, from(0, 0), STEP)!.changes).toEqual({ flipped: "true" });
  });
});

describe("manipulatorRow", () => {
  const input = (
    id: string,
    label: string,
    extra: Partial<FeatureScriptDialogInput> = {},
  ): FeatureScriptDialogInput => ({
    id,
    label,
    kind: "length",
    value: "0 mm",
    options: [],
    visible: true,
    faulty: false,
    group: null,
    filter: null,
    maxPicks: null,
    itemName: null,
    items: [],
    ...extra,
  });
  const inputs = [
    input("depth", "Depth"),
    input("waypoints", "Waypoints", { kind: "array", itemName: "Waypoint", items: [[], [], []] }),
  ];
  const listKeys = { waypoints: ["a", "b", "c"] };
  const linear = readManipulator(
    manipulator("LINEAR_1D", {
      base: [0, 0, 0],
      direction: [0, 0, 1],
      offset: 0,
      primaryParameterId: "depth",
    }),
  )!;

  it("finds the row a manipulator's primaryParameterId names", () => {
    expect(manipulatorRow(linear, inputs, listKeys)).toEqual({ input: "depth", name: "Depth" });
  });

  it("finds the list item a numbered key belongs to, counting from zero", () => {
    const triad = (key: string) =>
      readManipulator(manipulator("LINEAR_3D", { base: [0, 0, 0], offset: [0, 0, 0] }, key))!;
    expect(manipulatorRow(triad("waypoint1"), inputs, listKeys)).toEqual({
      list: "waypoints",
      index: 1,
      item: "b",
      name: "Waypoint 2",
    });
    // The list ran as one expression: the list itself lights up.
    expect(manipulatorRow(triad("waypoint1"), inputs, {})).toEqual({
      list: "waypoints",
      index: 1,
      item: null,
      name: "Waypoint 2",
    });
    expect(manipulatorRow(triad("waypoint7"), inputs, listKeys)).toBeNull();
    expect(manipulatorRow(triad("handle1"), inputs, listKeys)).toBeNull();
    // A primaryParameterId the dialog doesn't show falls back to the key.
    expect(
      manipulatorRow(
        { ...linear, primaryParameterId: "hidden" },
        [...inputs, input("hidden", "Hidden", { visible: false })],
        listKeys,
      ),
    ).toBeNull();
  });
});
