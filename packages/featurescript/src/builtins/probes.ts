import type { Entity } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinImpl } from "../runtime/Interpreter.ts";
import { FsMap, untag } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { dot, faceParameters, minus, plus, scaled, unit } from "./edges.ts";
import { kernel, resolve, transient, vector } from "./geometryArgs.ts";
import { length, lengthVector, stdEnum, unitVector } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Evaluators that probe the model from outside: raycasts, point deviation, mesh points. */

const vertexAt = (oc: Oc, point: Vec3) =>
  new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();

/** The closest point of `shape` to `point`, and how far it is. */
function closest(oc: Oc, point: Vec3, shape: Shape) {
  const extrema = new oc.BRepExtrema_DistShapeShape();
  extrema.LoadS1(vertexAt(oc, point));
  extrema.LoadS2(shape);
  extrema.Perform(new oc.Message_ProgressRange());
  return { distance: extrema.Value(), point: xyz(extrema.PointOnShape2(1)), extrema };
}

/** Where a ray meets one face: points on the line within OpenCascade's tolerance, by section. */
function hits(oc: Oc, face: Shape, ray: Shape): Vec3[] {
  const section = new oc.BRepAlgoAPI_Section(face, ray, true);
  if (section.HasErrors()) return [];
  return subShapes(oc, section.Shape(), "VERTEX").map((vertex) =>
    xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex))),
  );
}

export const PROBE_BUILTINS = {
  /**
   * Where a ray crosses the faces of `entities` (bodies stand for their faces): `RaycastResult`s
   * from the closest, each with the face, its parameter (relative to the face's UV box, like
   * `evFaceTangentPlane`), the point and the signed distance along the ray. Only the closest hit
   * unless `closest` is false; hits behind the origin only with `includeIntersectionsBehind`.
   */
  evRaycast: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    const ray = map(call, definition.getField("ray"), "ray");
    const origin = vector(call, ray.getField("origin"), 3, "ray.origin");
    const direction = unit(vector(call, ray.getField("direction"), 3, "ray.direction"));
    const closestOnly = untag(definition.getField("closest")) !== false;
    const behind = untag(definition.getField("includeIntersectionsBehind")) === true;
    if (closestOnly && behind)
      return call.fail("evRaycast can't include intersections behind the origin with closest.");
    const entities = resolve(call, model, oc, definition.getField("entities"));
    // Each face once, however the query names it (directly, through its body, or both).
    const faces: Entity[] = [
      ...new Map(
        entities
          .flatMap((entity) => {
            if (entity.type === "FACE") return [entity];
            if (entity.type === "BODY")
              return [...model.geometry.entities.values()].filter(
                (owned) => owned.type === "FACE" && owned.body === entity.id,
              );
            return call.unsupported(
              "evRaycast against edges and vertices is not supported locally yet.",
            );
          })
          .map((face) => [face.id, face] as const),
      ).values(),
    ];
    // A segment long enough to cross everything, both ways when hits behind count.
    const box = new oc.Bnd_Box();
    for (const face of faces) oc.BRepBndLib.Add(face.shape, box, false);
    const reach = box.IsVoid()
      ? 1
      : 2 *
        (Math.sqrt(box.SquareExtent()) +
          Math.hypot(...origin, box.GetXMax(), box.GetYMax(), box.GetZMax()));
    const segment = new oc.BRepBuilderAPI_MakeEdge(
      new oc.gp_Pnt(...(behind ? plus(origin, scaled(direction, -reach)) : origin)),
      new oc.gp_Pnt(...plus(origin, scaled(direction, reach))),
    ).Edge();
    const found = faces
      .flatMap((face) =>
        hits(oc, face.shape, segment).map((point) => ({
          face,
          point,
          along: dot(minus(point, origin), direction),
        })),
      )
      .filter((hit) => behind || hit.along >= -1e-9)
      .sort((a, b) => a.along - b.along);
    // In order along the ray; without hits behind, that's closest first.
    const ordered = closestOnly ? found.slice(0, 1) : found;
    return ordered.map(({ face, point, along }) => {
      // Projected onto the face's surface: a hit on an edge or corner has no face support for
      // BRepExtrema's face parameters, which throws there.
      const on = faceParameters(oc, face.shape, point);
      if (!on || on.off > 1e-6)
        return call.unsupported("evRaycast couldn't place a hit on its face locally.");
      return FsMap.fromEntries([
        ["entity", transient(call, face)],
        ["entityType", stdEnum(call, "query.fs", "EntityType", "FACE")],
        // A tagged Vector, as std's evFaceTangentPlane requires of the parameters it takes.
        ["parameter", unitVector(call, on.parameters)],
        ["intersection", lengthVector(call, point)],
        ["distance", length(call, along)],
      ]);
    });
  },

  /**
   * How far each point is from the closest of `topologies`: one map per point with `allDeviations`,
   * otherwise only the largest. `showDeviation` and `limit` only draw in Onshape.
   */
  evPointsDeviation: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    const topologies = resolve(call, model, oc, definition.getField("topologies"));
    if (topologies.length === 0)
      return call.fail("evPointsDeviation: topologies resolves to nothing.");
    const deviations = array(call, definition.getField("points"), "points").map((value) => {
      const point = vector(call, value, 3, "points");
      const best = topologies
        .map((topology) => closest(oc, point, topology.shape))
        .reduce((a, b) => (b.distance < a.distance ? b : a));
      return { point, best };
    });
    const chosen =
      untag(definition.getField("allDeviations")) === true
        ? deviations
        : deviations.length
          ? [deviations.reduce((a, b) => (b.best.distance > a.best.distance ? b : a))]
          : [];
    return chosen.map(({ point, best }) =>
      FsMap.fromEntries([
        ["deviation", length(call, best.distance)],
        ["pointPoint", lengthVector(call, point)],
        ["topologyPoint", lengthVector(call, best.point)],
      ]),
    );
  },

  /** Mesh geometry doesn't exist locally, so only an empty query has an answer. */
  evMeshPoints: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    if (resolve(call, model, oc, map(call, args, "definition").getField("meshes")).length === 0)
      return [];
    return call.unsupported(
      "Mesh geometry is not supported locally, so evMeshPoints has no points to read.",
    );
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
