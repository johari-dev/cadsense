import type { PickedConnector } from "../Runtime.ts";
import { addBodies, type GeometryState } from "./Model.ts";
import type { Oc } from "./occt.ts";

type Vec3 = readonly [number, number, number];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Std's `perpendicularVector` (vector.fs), so a picked point's X axis matches Onshape's. Its
 * constants are written here at double precision, which is all std's evaluate to.
 */
function perpendicular(v: Vec3): Vec3 {
  const [x, y, z] = v.map(Math.abs) as [number, number, number];
  const different: Vec3 =
    x > 1.0366636528619326 * y
      ? x > 0.9517029893922334 * z
        ? [0, 0, 1]
        : [0, 1, 0]
      : y > 0.9204199474553859 * z
        ? [1, 0, 0]
        : [0, 1, 0];
  return unit(cross(different, v));
}

/**
 * Adds picked points as mate connectors created by `["Picked", id]`, Z along each one's axis and X
 * std's `perpendicularVector` of it.
 */
export function addConnectors(
  oc: Oc,
  state: GeometryState,
  connectors: readonly PickedConnector[],
): GeometryState {
  return addBodies(
    oc,
    state,
    connectors.map((connector) => {
      // Scaled first, so components near the largest double don't overflow the length.
      const largest = Math.max(...connector.zAxis.map(Math.abs));
      if (!(largest > 0 && Number.isFinite(largest)))
        throw new Error(`Picked point ${connector.id} has no direction for its Z axis.`);
      const zAxis = unit([
        connector.zAxis[0] / largest,
        connector.zAxis[1] / largest,
        connector.zAxis[2] / largest,
      ]);
      return {
        shape: new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...connector.origin)).Vertex(),
        bodyType: "MATE_CONNECTOR",
        createdBy: ["Picked", connector.id],
        frame: { origin: connector.origin, xAxis: perpendicular(zAxis), zAxis },
      };
    }),
  ).state;
}
