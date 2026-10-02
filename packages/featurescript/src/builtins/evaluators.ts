import type { Entity, EntityType } from "../geometry/Model.ts";
import { distance } from "../geometry/Query.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import {
  length,
  lengthVector,
  quantity,
  stdCoordSystem,
  stdLine,
  stdPlane,
  stdTagged,
} from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Geometry evaluators. Results are std's own types (`Line`, `Plane`, `ValueWithUnits`, ...), built the
 * way std builds them. Edge parameters map uniformly over the curve, which is arc length for lines
 * and circles and an approximation for other curves.
 */

type Definition = { readonly model: ModelContext; readonly oc: Oc; readonly definition: FsMap };
const open = (call: BuiltinCall, ctx: FsValue, value: FsValue): Definition => ({
  ...kernel(call, ctx),
  definition: map(call, value, "definition"),
});

/** The first entity `field` resolves to, which must have `type`. */
function first(
  call: BuiltinCall,
  { model, oc, definition }: Definition,
  field: string,
  type: EntityType,
): Entity {
  const entity = resolve(call, model, oc, definition.getField(field)).find(
    (candidate) => candidate.type === type,
  );
  if (!entity) return call.fail(`${field} resolves to no ${type.toLowerCase()}.`);
  return entity;
}
const all = (
  call: BuiltinCall,
  { model, oc, definition }: Definition,
  field: string,
  type: EntityType,
) => resolve(call, model, oc, definition.getField(field)).filter((entity) => entity.type === type);

const reversed = (shape: Shape) => String(shape.Orientation()) === "TopAbs_REVERSED";
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scaled = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/** Point and unit tangent at `t` in [0, 1] along an edge, following the edge's orientation. */
function edgeTangent(oc: Oc, edge: Shape, t: number): { point: Vec3; direction: Vec3 } {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const flip = reversed(edge);
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  const u = flip ? b - t * (b - a) : a + t * (b - a);
  const result = curve.EvalD1(u);
  const direction = normalized(xyz(result.D1));
  return { point: xyz(result.Point), direction: flip ? scaled(direction, -1) : direction };
}

/** The axis of a line or circle edge, or of a cylinder or cone face. */
function axisOf(call: BuiltinCall, oc: Oc, entity: Entity): { origin: Vec3; direction: Vec3 } {
  if (entity.type === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
    const kind = String(curve.GetType());
    if (kind === "GeomAbs_Line") {
      const { point, direction } = edgeTangent(oc, entity.shape, 0);
      return { origin: point, direction };
    }
    if (kind === "GeomAbs_Circle") {
      const axis = curve.Circle().Axis();
      return { origin: xyz(axis.Location()), direction: xyz(axis.Direction()) };
    }
  }
  if (entity.type === "FACE") {
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
    const kind = String(surface.GetType());
    if (kind === "GeomAbs_Cylinder") {
      const axis = surface.Cylinder().Axis();
      return { origin: xyz(axis.Location()), direction: xyz(axis.Direction()) };
    }
  }
  return call.fail("CANNOT_RESOLVE_AXIS: expected a line or circle edge, or a cylindrical face.");
}

/** Either side of `evDistance`: entities from a query, one point, or an array of points. */
function distanceSide(call: BuiltinCall, input: Definition, field: string): Shape[] {
  const value = input.definition.getField(field);
  const v = untag(value);
  if (!Array.isArray(v))
    return resolve(call, input.model, input.oc, value).map((entity) => entity.shape);
  const items = v as FsArray;
  const onePoint = items.length === 3 && items.every((c) => !Array.isArray(untag(c)));
  return (onePoint ? [value] : items).map((p) =>
    new input.oc.BRepBuilderAPI_MakeVertex(
      new input.oc.gp_Pnt(...vector(call, p, 3, field)),
    ).Vertex(),
  );
}

export const EVALUATOR_BUILTINS = {
  evAxis: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const entity = resolve(call, input.model, input.oc, input.definition.getField("axis"))[0];
    if (!entity) return call.fail("CANNOT_RESOLVE_AXIS: axis resolves to nothing.");
    const { origin, direction } = axisOf(call, input.oc, entity);
    return stdLine(call, origin, direction);
  },
  evLine: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const edge = first(call, input, "edge", "EDGE");
    if (
      String(new input.oc.BRepAdaptor_Curve(input.oc.TopoDS.Edge(edge.shape)).GetType()) !==
      "GeomAbs_Line"
    )
      return call.fail("CANNOT_RESOLVE_LINE: the edge isn't straight.");
    const { origin, direction } = axisOf(call, input.oc, edge);
    return stdLine(call, origin, direction);
  },
  evBox: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    if (input.definition.getField("cSys") !== undefined)
      return call.unsupported("evBox3d with a cSys is not supported locally yet.");
    const box = new input.oc.Bnd_Box();
    for (const entity of resolve(
      call,
      input.model,
      input.oc,
      input.definition.getField("topology"),
    ))
      input.oc.BRepBndLib.AddOptimal(entity.shape, box, false, false);
    if (box.IsVoid()) return call.fail("evBox3d: topology resolves to nothing.");
    return FsMap.fromEntries([
      ["minCorner", lengthVector(call, [box.GetXMin(), box.GetYMin(), box.GetZMin()])],
      ["maxCorner", lengthVector(call, [box.GetXMax(), box.GetYMax(), box.GetZMax()])],
    ]);
  },
  evVolume: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const body of all(call, input, "bodies", "BODY")) {
      const props = new input.oc.GProp_GProps();
      input.oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
      total += props.Mass();
    }
    return quantity(call, total, "VOLUME_UNITS");
  },
  evArea: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const face of all(call, input, "faces", "FACE")) {
      const props = new input.oc.GProp_GProps();
      input.oc.BRepGProp.SurfaceProperties(face.shape, props, false, false);
      total += props.Mass();
    }
    return quantity(call, total, "AREA_UNITS");
  },
  evLength: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const edge of all(call, input, "edges", "EDGE")) {
      const props = new input.oc.GProp_GProps();
      input.oc.BRepGProp.LinearProperties(edge.shape, props, false, false);
      total += props.Mass();
    }
    return length(call, total);
  },
  evVertexPoint: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const vertex = first(call, input, "vertex", "VERTEX");
    return lengthVector(call, xyz(input.oc.BRep_Tool.Pnt(input.oc.TopoDS.Vertex(vertex.shape))));
  },
  evDistance: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    if (untag(input.definition.getField("maximum")) === true)
      return call.unsupported("evDistance with maximum is not supported locally yet.");
    const side0 = distanceSide(call, input, "side0");
    const side1 = distanceSide(call, input, "side1");
    let best: { d: number; i: number; j: number } | null = null;
    side0.forEach((a, i) =>
      side1.forEach((b, j) => {
        const d = distance(input.oc, a, b);
        if (!best || d < best.d) best = { d, i, j };
      }),
    );
    if (!best) return call.fail("evDistance: a side resolves to nothing.");
    const { d, i, j } = best as { d: number; i: number; j: number };
    const extrema = new input.oc.BRepExtrema_DistShapeShape();
    extrema.LoadS1(side0[i]!);
    extrema.LoadS2(side1[j]!);
    extrema.Perform(new input.oc.Message_ProgressRange());
    // Parameters are 0 here; locating them on edges and faces isn't done locally yet.
    const side = (index: number, point: Vec3) =>
      FsMap.fromEntries([
        ["point", lengthVector(call, point)],
        ["index", index],
        ["parameter", 0],
      ]);
    return stdTagged(call, "evaluate.fs", "DistanceResult", [
      ["distance", length(call, d)],
      ["sides", [side(i, xyz(extrema.PointOnShape1(1))), side(j, xyz(extrema.PointOnShape2(1)))]],
    ]);
  },
  evEdgeTangentLines: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const edge = first(call, input, "edge", "EDGE");
    return array(call, input.definition.getField("parameters"), "parameters").map((t) => {
      const { point, direction } = edgeTangent(
        input.oc,
        edge.shape,
        magnitude(call, t, "parameter"),
      );
      return stdLine(call, point, direction);
    });
  },
  evFaceTangentPlanes: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = first(call, input, "face", "FACE");
    const { oc } = input;
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face.shape));
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), true);
    return array(call, input.definition.getField("parameters"), "parameters").map((uv) => {
      const [s, t] = vector(call, uv, 2, "parameter");
      const result = surface.EvalD1(
        bounds.UMin + s * (bounds.UMax - bounds.UMin),
        bounds.VMin + t * (bounds.VMax - bounds.VMin),
      );
      const du = normalized(xyz(result.D1U));
      const normal = normalized(cross(du, xyz(result.D1V)));
      return stdPlane(
        call,
        xyz(result.Point),
        reversed(face.shape) ? scaled(normal, -1) : normal,
        du,
      );
    });
  },
  evSurfaceDefinition: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = first(call, input, "face", "FACE");
    const surface = new input.oc.BRepAdaptor_Surface(input.oc.TopoDS.Face(face.shape), true);
    const kind = String(surface.GetType());
    const frame = (position: InstanceType<Oc["gp_Ax3"]>) =>
      stdCoordSystem(
        call,
        xyz(position.Location()),
        xyz(position.XDirection()),
        xyz(position.Direction()),
      );
    if (kind === "GeomAbs_Plane") {
      const position = surface.Plane().Position();
      const normal = xyz(position.Direction());
      return stdPlane(
        call,
        xyz(position.Location()),
        reversed(face.shape) ? scaled(normal, -1) : normal,
        xyz(position.XDirection()),
      );
    }
    if (kind === "GeomAbs_Cylinder") {
      const cylinder = surface.Cylinder();
      return stdTagged(call, "surfaceGeometry.fs", "Cylinder", [
        ["coordSystem", frame(cylinder.Position())],
        ["radius", length(call, cylinder.Radius())],
      ]);
    }
    if (kind === "GeomAbs_Sphere") {
      const sphere = surface.Sphere();
      return stdTagged(call, "surfaceGeometry.fs", "Sphere", [
        ["coordSystem", frame(sphere.Position())],
        ["radius", length(call, sphere.Radius())],
      ]);
    }
    return call.unsupported(
      `evSurfaceDefinition for ${kind.replace("GeomAbs_", "")} surfaces is not supported locally yet.`,
    );
  },
  evCurveDefinition: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const edge = first(call, input, "edge", "EDGE");
    const curve = new input.oc.BRepAdaptor_Curve(input.oc.TopoDS.Edge(edge.shape));
    const kind = String(curve.GetType());
    if (kind === "GeomAbs_Line") {
      const { origin, direction } = axisOf(call, input.oc, edge);
      return stdLine(call, origin, direction);
    }
    if (kind === "GeomAbs_Circle") {
      const circle = curve.Circle();
      const position = circle.Position();
      return stdTagged(call, "curveGeometry.fs", "Circle", [
        [
          "coordSystem",
          stdCoordSystem(
            call,
            xyz(position.Location()),
            xyz(position.XDirection()),
            xyz(position.Direction()),
          ),
        ],
        ["radius", length(call, circle.Radius())],
      ]);
    }
    return call.unsupported(
      `evCurveDefinition for ${kind.replace("GeomAbs_", "")} curves is not supported locally yet.`,
    );
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
