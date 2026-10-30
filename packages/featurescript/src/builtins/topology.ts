import type { Entity } from "../geometry/Model.ts";
import { distance } from "../geometry/Query.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { versionOrder, type ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { map } from "./args.ts";
import { cross, dot, edgeConvexity, minus, plus, properties, scaled, unit } from "./edges.ts";
import { kernel, resolve, transient } from "./geometryArgs.ts";
import { regenError, stdEnum, stdPlane } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Evaluators that read how topology fits together: edge convexity, planar edges, corners and
 * collisions.
 */

const input = (call: BuiltinCall, ctx: FsValue, args: FsValue, field: string) => {
  const { model, oc } = kernel(call, ctx);
  return {
    model,
    oc,
    entities: resolve(call, model, oc, map(call, args, "definition").getField(field)),
  };
};
const bodyOf = (model: ModelContext, entity: Entity): Entity =>
  model.geometry.entities.get(entity.body)!;

/**
 * Points that decide whether an edge is planar: samples along it, plus a spline's control points.
 * A B-spline or Bezier curve lies in a plane exactly when all its control points do (its basis
 * functions are independent), which catches wiggles between the samples. Curves of other kinds
 * than lines, conics and splines stop the run.
 */
const planarityPoints = (call: BuiltinCall, oc: Oc, edge: Shape): Vec3[] => {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const kind = String(curve.GetType()).replace("GeomAbs_", "");
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  const sampled = Array.from({ length: 17 }, (_, i) => xyz(curve.EvalD0(a + ((b - a) * i) / 16)));
  if (["Line", "Circle", "Ellipse", "Hyperbola", "Parabola"].includes(kind)) return sampled;
  if (kind !== "BSplineCurve" && kind !== "BezierCurve")
    return call.unsupported(`evPlanarEdge on ${kind} curves is not supported locally yet.`);
  // The adaptor's spline is already placed where the edge is (its location applied).
  const spline = kind === "BSplineCurve" ? curve.BSpline() : curve.Bezier();
  const poles = Array.from({ length: spline.NbPoles() }, (_, i) => xyz(spline.Pole(i + 1)));
  return [...sampled, ...poles];
};
/** How far points may sit off a plane that contains them: OpenCascade's confusion tolerance. */
const PLANE_TOLERANCE = 1e-7;

/**
 * A plane all `edges` lie in, or null. A circle or ellipse gives its own plane: origin at its
 * center, normal its axis, x its x axis. Otherwise the plane goes through the centroid of the
 * edges' planarity points, its normal from the widest triangle of them, its x along the first chord. A
 * line alone, or collinear edges, lies in no single plane.
 */
function planeOfEdges(
  call: BuiltinCall,
  oc: Oc,
  edges: readonly Shape[],
): { origin: Vec3; normal: Vec3; x: Vec3 } | null {
  const points = edges.flatMap((edge) => planarityPoints(call, oc, edge));
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edges[0]!));
  const kind = String(curve.GetType());
  let plane: { origin: Vec3; normal: Vec3; x: Vec3 } | null = null;
  if (kind === "GeomAbs_Circle" || kind === "GeomAbs_Ellipse") {
    const position =
      kind === "GeomAbs_Circle" ? curve.Circle().Position() : curve.Ellipse().Position();
    plane = {
      origin: xyz(position.Location()),
      normal: xyz(position.Direction()),
      x: xyz(position.XDirection()),
    };
  } else {
    const start = points[0]!;
    const far = points.reduce((best, p) =>
      Math.hypot(...minus(p, start)) > Math.hypot(...minus(best, start)) ? p : best,
    );
    const chord = minus(far, start);
    if (Math.hypot(...chord) === 0) return null;
    const off = points.reduce((best, p) =>
      Math.hypot(...cross(chord, minus(p, start))) > Math.hypot(...cross(chord, minus(best, start)))
        ? p
        : best,
    );
    const normal = cross(chord, minus(off, start));
    if (Math.hypot(...normal) <= PLANE_TOLERANCE * Math.hypot(...chord)) return null;
    plane = {
      origin: scaled(points.reduce(plus, [0, 0, 0] as Vec3), 1 / points.length),
      normal: unit(normal),
      x: unit(chord),
    };
  }
  const { origin, normal } = plane;
  return points.every((p) => Math.abs(dot(minus(p, origin), normal)) <= PLANE_TOLERANCE)
    ? plane
    : null;
}

/** 3 for solids, 2 for faces and sheets, 1 for edges and wires, 0 for vertices and points. */
const dimension = (entity: Entity): number =>
  entity.type === "BODY"
    ? { SOLID: 3, SHEET: 2, WIRE: 1, POINT: 0, MATE_CONNECTOR: 0 }[entity.bodyType]
    : { FACE: 2, EDGE: 1, VERTEX: 0 }[entity.type];

/** Length, area or volume of a shape of `dimension`, or its vertex count for points. */
function measure(call: BuiltinCall, oc: Oc, shape: Shape, dimension: number): number {
  if (dimension === 0) return subShapes(oc, shape, "VERTEX").length;
  return properties(oc, shape, dimension, call.unsupported).Mass();
}

const facesOf = (oc: Oc, solid: Shape): Shape => {
  const compound = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(compound);
  for (const face of subShapes(oc, solid, "FACE")) builder.Add(compound, face);
  return compound;
};

/** Closer than this (meters, std's `TOLERANCE.zeroLength`) counts as touching. */
const TOUCHING = 1e-8;
/** A common part smaller than this fraction of the smaller entity counts as none. */
const RELATIVE_OVERLAP = 1e-9;

/**
 * How `tool` and `target` clash, as std's `ClashType`, or null when they don't touch. For solids
 * this follows what Onshape reports (from forum reports, not documented): overlap and containment
 * that touches the boundary are INTERFERE, strict containment is TOOL_IN_TARGET or
 * TARGET_IN_TOOL, contact without overlap is ABUT_NO_CLASS. A curve, point or face against a solid
 * is classified the same way by the part of it inside the solid; two curves that meet are EXISTS.
 */
function clash(call: BuiltinCall, oc: Oc, tool: Entity, target: Entity): string | null {
  const [toolDimension, targetDimension] = [dimension(tool), dimension(target)];
  if (toolDimension === 1 && targetDimension === 1)
    return distance(oc, tool.shape, target.shape) <= TOUCHING ? "EXISTS" : null;
  if (toolDimension !== 3 && targetDimension !== 3)
    return call.unsupported(
      "evCollision between faces, sheets, curves and points (without a solid) is not supported locally yet; only solids against anything and curves against curves are.",
    );
  if (distance(oc, tool.shape, target.shape) > TOUCHING) return null;
  // `outer` is a solid; `other` is the other side, of any dimension.
  const [outer, other] = toolDimension === 3 ? [tool, target] : [target, tool];
  const otherDimension = dimension(other);
  const common = new oc.BRepAlgoAPI_Common(
    outer.shape,
    other.shape,
    new oc.Message_ProgressRange(),
  );
  if (common.HasErrors())
    return call.unsupported("evCollision couldn't intersect these bodies locally.");
  const inside = measure(call, oc, common.Shape(), otherDimension);
  const total = measure(call, oc, other.shape, otherDimension);
  const outerTotal = measure(call, oc, outer.shape, 3);
  const scale = otherDimension === 3 ? Math.min(total, outerTotal) : total;
  const tolerance = otherDimension === 0 ? 0.5 : RELATIVE_OVERLAP * scale;
  // Against a solid, distance is zero anywhere inside it; boundaries have to meet.
  const otherBoundary = otherDimension === 3 ? facesOf(oc, other.shape) : other.shape;
  const touchesBoundary = distance(oc, facesOf(oc, outer.shape), otherBoundary) <= TOUCHING;
  if (inside <= tolerance) return touchesBoundary ? "ABUT_NO_CLASS" : null;
  const otherInside = Math.abs(inside - total) <= tolerance;
  const outerInside = otherDimension === 3 && Math.abs(inside - outerTotal) <= tolerance;
  if (touchesBoundary || (!otherInside && !outerInside)) return "INTERFERE";
  // Containment: say which of tool and target is inside the other.
  const toolInside = otherInside ? other === tool : outer === tool;
  return toolInside ? "TOOL_IN_TARGET" : "TARGET_IN_TOOL";
}

export const TOPOLOGY_BUILTINS = {
  /**
   * Clashes between each tool and each target entity, in target then tool order: maps with the
   * `ClashType` `type`, the clashing `tool` and `target`, and their owning bodies. Pairs within one
   * body are skipped.
   */
  evCollisionDetection: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    if (untag(definition.getField("owners")) === true)
      return call.unsupported("evCollision with passOwners is not supported locally yet.");
    const tools = resolve(call, model, oc, definition.getField("tools"));
    const targets = resolve(call, model, oc, definition.getField("targets"));
    return targets.flatMap((target) =>
      tools.flatMap((tool) => {
        if (tool.body === target.body) return [];
        const type = clash(call, oc, tool, target);
        if (type === null) return [];
        return [
          FsMap.fromEntries([
            ["type", stdEnum(call, "clashtype.gen.fs", "ClashType", type)],
            ["tool", transient(call, tool)],
            ["toolBody", transient(call, bodyOf(model, tool))],
            ["target", transient(call, target)],
            ["targetBody", transient(call, bodyOf(model, target))],
          ]),
        ];
      }),
    );
  },

  evEdgeConvexity: ([ctx, args], call) => {
    const { model, oc, entities } = input(call, ctx, args, "edge");
    if (entities.length > 1) return regenError(call, "TOO_MANY_ENTITIES_SELECTED");
    const edge = entities[0];
    if (edge?.type !== "EDGE") return regenError(call, "BAD_GEOMETRY");
    return edgeConvexity(oc, bodyOf(model, edge), edge.shape, call.unsupported);
  },

  evPlanarEdge: ([ctx, args], call) => {
    const { oc, entities } = input(call, ctx, args, "edge");
    const edge = entities[0];
    const plane = edge?.type === "EDGE" ? planeOfEdges(call, oc, [edge.shape]) : null;
    if (!plane) return regenError(call, "CANNOT_RESOLVE_PLANE");
    return stdPlane(call, plane.origin, plane.normal, plane.x);
  },
  evPlanarEdges: ([ctx, args], call) => {
    const { oc, entities } = input(call, ctx, args, "edges");
    const edges = entities.filter((entity) => entity.type === "EDGE");
    const plane =
      edges.length > 0
        ? planeOfEdges(
            call,
            oc,
            edges.map((edge) => edge.shape),
          )
        : null;
    if (!plane) return regenError(call, "CANNOT_RESOLVE_PLANE");
    return stdPlane(call, plane.origin, plane.normal, plane.x);
  },

  /**
   * Sheet metal corner classification. There's no sheet metal locally, so no vertex belongs to a
   * corner: every vertex is `NOT_A_CORNER`, its own primary vertex. Before V488 std's wrapper
   * expects the corner type alone, so a held-back feature gets that.
   */
  evCornerType: ([ctx, args], call) => {
    const { model, entities } = input(call, ctx, args, "vertex");
    if (entities.length !== 1 || entities[0]!.type !== "VERTEX")
      return regenError(call, "BAD_GEOMETRY");
    const returnsMap = stdEnum(
      call,
      "featurescriptversionnumber.gen.fs",
      "FeatureScriptVersionNumber",
      "V488_CLASSIFY_CORNER_RETURNS_MAP",
    );
    if (versionOrder(model.activeVersion) < versionOrder(returnsMap)) return "NOT_A_CORNER";
    return FsMap.fromEntries([
      ["cornerType", "NOT_A_CORNER"],
      ["primaryVertex", entities[0]!.id],
      ["allVertices", [entities[0]!.id]],
    ]);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
