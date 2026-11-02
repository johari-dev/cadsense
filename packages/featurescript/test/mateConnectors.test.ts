import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag, type FsValue } from "../src/runtime/Value.ts";
import { partStudio, variable } from "./partStudio.ts";

/**
 * std's Mate connector feature end to end, through `@evMateConnectorCoordSystem`.
 *
 * Ways it can fail:
 * - An inference puts the origin in the wrong place: not the vertex, the face's centroid, the
 *   circle's center, the edge's arc length midpoint, or the axis point at the face's top,
 *   middle or bottom.
 * - Axes that std documents come out wrong: the world system at a vertex, Z along the face normal,
 *   the edge, the circle's or the cylinder's axis.
 * - The modifiers apply in the wrong frame: translation along the axes after realign and the
 *   secondary axis choice, rotation about the result's own axis without moving the origin.
 * - "Between entities" doesn't land midway.
 * - An origin that resolves to nothing passes instead of failing the feature.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const solids = `
  fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
  fCylinder(context, id + "pin", { "bottomCenter" : vector(20, 0, 0) * millimeter, "topCenter" : vector(20, 0, 10) * millimeter, "radius" : 5 * millimeter });`;
const at = (type: string, x: number, y: number, z: number) =>
  `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.${type}), vector(${x}, ${y}, ${z}) * millimeter)`;
const cubeBody = `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.BODY), vector(5, 5, 5) * millimeter)`;

/** Runs the solids, one std Mate connector with `parameters`, and reads its coordinate system back. */
const connector = (parameters: Record<string, string>) => {
  const run = studio.run([
    { body: solids },
    {
      std: "mateConnector.fs",
      feature: "mateConnector",
      parameters: { ownerPart: cubeBody, ...parameters },
    },
    {
      body: `
      const system = evMateConnector(context, { "mateConnector" : qCreatedBy(makeId("Feature2"), EntityType.BODY) });
      setVariable(context, "origin", system.origin / millimeter);
      setVariable(context, "x", system.xAxis);
      setVariable(context, "z", system.zAxis);`,
    },
  ]);
  const [, made, read] = run.features;
  if (made!.fault || made!.status !== "OK")
    throw new Error(
      made!.fault?.message ??
        `${made!.statusEnum}: ${made!.exceptions.map((e) => e.message).join("; ")}`,
    );
  const vector = (name: string) =>
    (untag(read!.variables.getField(name)) as readonly FsValue[]).map((c) => untag(c) as number);
  return { origin: vector("origin"), x: vector("x"), z: vector("z") };
};
const near = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(3);
  expected.forEach((value, i) => expect(actual[i], `component ${i}`).toBeCloseTo(value, 9));
};
const inference = (type: string, origin: string) => ({
  entityInferenceType: `EntityInferenceType.${type}`,
  originQuery: origin,
});

describe("Mate connector inferences", () => {
  it("POINT: the vertex, with the world's axes", () => {
    const system = connector(inference("POINT", at("VERTEX", 10, 10, 10)));
    near(system.origin, [10, 10, 10]);
    near(system.x, [1, 0, 0]);
    near(system.z, [0, 0, 1]);
  });

  it("CENTROID: the face's centroid, Z along its outward normal", () => {
    const system = connector(inference("CENTROID", at("FACE", 5, 5, 10)));
    near(system.origin, [5, 5, 10]);
    near(system.z, [0, 0, 1]);
    expect(Math.abs(system.x[2]!)).toBeCloseTo(0, 12);
    const side = connector(inference("CENTROID", at("FACE", 5, 0, 5)));
    near(side.origin, [5, 0, 5]);
    near(side.z, [0, -1, 0]);
  });

  it("CENTER: a circle's center, Z along its axis", () => {
    const system = connector(
      inference("CENTER", `qGeometry(${at("EDGE", 25, 0, 10)}, GeometryType.CIRCLE)`),
    );
    near(system.origin, [20, 0, 10]);
    expect(Math.abs(system.z[2]!)).toBeCloseTo(1, 12);
  });

  it("MID_POINT: the edge's midpoint, Z along the edge", () => {
    const system = connector(inference("MID_POINT", at("EDGE", 2, 0, 10)));
    near(system.origin, [5, 0, 10]);
    expect(Math.abs(system.z[0]!)).toBeCloseTo(1, 12);
    expect(system.x[0]!).toBeCloseTo(0, 12);
  });

  it("axis points: the top, middle and bottom of a cylinder's axis, Z along it", () => {
    const wall = `qGeometry(qCreatedBy(makeId("Feature1"), EntityType.FACE), GeometryType.CYLINDER)`;
    // "Top" is along the axis direction, so origin . z picks the top end.
    for (const [type, along] of [
      ["TOP_AXIS_POINT", 5],
      ["MID_AXIS_POINT", 0],
      ["BOTTOM_AXIS_POINT", -5],
    ] as const) {
      const system = connector(inference(type, wall));
      expect(Math.abs(system.z[2]!), type).toBeCloseTo(1, 12);
      expect(system.origin[0], type).toBeCloseTo(20, 9);
      expect(system.origin[1], type).toBeCloseTo(0, 9);
      expect((system.origin[2]! - 5) * system.z[2]!, type).toBeCloseTo(along, 9);
    }
  });
});

describe("Mate connector modifiers", () => {
  const vertex = inference("POINT", at("VERTEX", 0, 0, 0));
  it("flips the primary axis", () => {
    const system = connector({ ...vertex, flipPrimary: "true" });
    near(system.z, [0, 0, -1]);
    expect(system.x[0]! * system.z[0]! + system.x[1]! * system.z[1]!).toBeCloseTo(0, 12);
  });

  it("points the chosen axis along the secondary direction", () => {
    // +Y along what was +X: X becomes Y x Z = (1, 0, 0) x (0, 0, 1).
    near(connector({ ...vertex, secondaryAxisType: "MateConnectorAxisType.PLUS_Y" }).x, [0, -1, 0]);
    near(
      connector({ ...vertex, secondaryAxisType: "MateConnectorAxisType.MINUS_X" }).x,
      [-1, 0, 0],
    );
  });

  it("moves along the resulting axes, then rotates in place", () => {
    const moved = connector({
      ...vertex,
      secondaryAxisType: "MateConnectorAxisType.PLUS_Y",
      transform: "true",
      translationX: "1 * millimeter",
      translationY: "2 * millimeter",
      translationZ: "3 * millimeter",
      rotationType: "RotationType.ABOUT_Z",
      rotation: "90 * degree",
    });
    // X is (0, -1, 0) and Y is (1, 0, 0) here, so 1 along X and 2 along Y is (2, -1).
    near(moved.origin, [2, -1, 3]);
    // Then X turns 90 degrees about Z: (0, -1, 0) -> (1, 0, 0).
    near(moved.x, [1, 0, 0]);
    near(moved.z, [0, 0, 1]);
  });

  it("realigns Z and X along other entities' axes", () => {
    const system = connector({
      ...vertex,
      realign: "true",
      primaryAxisQuery: at("EDGE", 5, 0, 0),
      secondaryAxisQuery: at("FACE", 5, 5, 10),
    });
    expect(Math.abs(system.z[0]!)).toBeCloseTo(1, 12);
    expect(Math.abs(system.x[2]!)).toBeCloseTo(1, 12);
    near(system.origin, [0, 0, 0]);
  });

  it("places the origin midway between two entities", () => {
    const system = connector({
      ...inference("CENTROID", at("FACE", 5, 5, 10)),
      originType: "OriginCreationType.BETWEEN_ENTITIES",
      originAdditionalQuery: at("FACE", 5, 5, 0),
    });
    near(system.origin, [5, 5, 5]);
  });

  it("fails the feature when the origin resolves to nothing", () => {
    const run = studio.run([
      { body: solids },
      {
        std: "mateConnector.fs",
        feature: "mateConnector",
        parameters: { ownerPart: cubeBody, ...inference("POINT", "qNothing()") },
      },
    ]);
    expect(run.features[1]).toMatchObject({ status: "ERROR", fault: null });
    expect(variable(run, "origin", 1)).toBeUndefined();
  });
});
