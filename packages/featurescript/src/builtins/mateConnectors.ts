import type { Entity } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { FsMap, untag, type FsArray } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import {
  cross,
  dot,
  EdgeWalk,
  isReversed,
  minus,
  plus,
  properties,
  scaled,
  unit,
} from "./edges.ts";
import { kernel, magnitude, resolve, vector } from "./geometryArgs.ts";
import { regenError, stdCoordSystem, stdValue, unitVector } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** The coordinate system std's Mate connector feature asks for: an origin and unit X and Z axes. */
interface Frame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly z: Vec3;
}

const WORLD_X: Vec3 = [1, 0, 0];
const WORLD_Z: Vec3 = [0, 0, 1];

/** std's `perpendicularVector`, called through std so the choice matches it exactly. */
function perpendicular(call: BuiltinCall, z: Vec3): Vec3 {
  const result = call.interpreter.callFunction(stdValue(call, "vector.fs", "perpendicularVector"), [
    unitVector(call, z),
  ]);
  return (untag(result) as FsArray).map((c) => untag(c) as number) as unknown as Vec3;
}

/** `x` made perpendicular to `z`, or std's `perpendicularVector` of `z` when it's parallel. */
function orthogonal(call: BuiltinCall, x: Vec3, z: Vec3): Vec3 {
  const projected = minus(x, scaled(z, dot(x, z)));
  return Math.hypot(...projected) > 1e-9 ? unit(projected) : perpendicular(call, z);
}

/**
 * The coordinate system an `EntityInferenceType` gives on `entity`, as std's enum documents it.
 * Where std leaves the X axis open: a planar face's surface X, a circle's or cylinder's X, and
 * std's `perpendicularVector` of an edge's tangent.
 */
function inferred(call: BuiltinCall, oc: Oc, entity: Entity, type: string): Frame {
  const failed = () => regenError(call, "MATECONNECTOR_QUERY_ORIGIN_FAILED");
  if (type === "POINT") {
    if (entity.type === "FACE")
      return call.unsupported("A mate connector at a cone's tip is not supported locally yet.");
    // A vertex, or a point body such as another mate connector.
    const vertices =
      entity.type === "VERTEX" || entity.type === "BODY"
        ? subShapes(oc, entity.shape, "VERTEX")
        : [];
    if (vertices.length !== 1) return failed();
    return {
      origin: xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertices[0]!))),
      x: WORLD_X,
      z: WORLD_Z,
    };
  }
  if (type === "CENTROID") {
    if (entity.type !== "FACE") return failed();
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
    if (String(surface.GetType()) !== "GeomAbs_Plane")
      return call.unsupported(
        "A mate connector at a curved face's centroid is not supported locally yet.",
      );
    const props = properties(oc, entity.shape, 2, call.unsupported);
    const position = surface.Plane().Position();
    const normal = xyz(position.Direction());
    return {
      origin: xyz(props.CentreOfMass()),
      x: xyz(position.XDirection()),
      z: isReversed(entity.shape) ? scaled(normal, -1) : normal,
    };
  }
  if (type === "CENTER") {
    if (entity.type === "EDGE") {
      const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
      const kind = String(curve.GetType());
      if (kind !== "GeomAbs_Circle" && kind !== "GeomAbs_Ellipse") return failed();
      const position =
        kind === "GeomAbs_Circle" ? curve.Circle().Position() : curve.Ellipse().Position();
      return {
        origin: xyz(position.Location()),
        x: xyz(position.XDirection()),
        z: xyz(position.Direction()),
      };
    }
    if (entity.type === "FACE") {
      const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
      if (String(surface.GetType()) !== "GeomAbs_Sphere") return failed();
      return { origin: xyz(surface.Sphere().Location()), x: WORLD_X, z: WORLD_Z };
    }
    return failed();
  }
  if (type === "MID_POINT") {
    if (entity.type !== "EDGE") return failed();
    const walk = new EdgeWalk(oc, entity.shape, isReversed(entity.shape), call.unsupported);
    const { point, direction } = walk.at(walk.parameter(0.5, true));
    return { origin: point, x: perpendicular(call, direction), z: direction };
  }
  if (type === "TOP_AXIS_POINT" || type === "MID_AXIS_POINT" || type === "BOTTOM_AXIS_POINT") {
    if (entity.type !== "FACE") return failed();
    const face = oc.TopoDS.Face(entity.shape);
    const surface = new oc.BRepAdaptor_Surface(face, true);
    if (String(surface.GetType()) !== "GeomAbs_Cylinder")
      return call.unsupported(
        "Mate connectors on the axis of a revolved face other than a cylinder are not supported locally yet.",
      );
    // A cylinder's V parameter is the distance along its axis from the axis' location.
    const position = surface.Cylinder().Position();
    const axis = xyz(position.Direction());
    const bounds = oc.BRepTools.UVBounds(face);
    const along =
      type === "TOP_AXIS_POINT"
        ? bounds.VMax
        : type === "BOTTOM_AXIS_POINT"
          ? bounds.VMin
          : (bounds.VMin + bounds.VMax) / 2;
    return {
      origin: plus(xyz(position.Location()), scaled(axis, along)),
      x: xyz(position.XDirection()),
      z: axis,
    };
  }
  return call.unsupported(`Mate connector inference ${type} is not supported locally yet.`);
}

/** The direction an entity defines for realigning: a line's direction, a plane's normal, an axis. */
function axisOf(call: BuiltinCall, oc: Oc, entity: Entity | undefined): Vec3 {
  const failed = () => regenError(call, "MATECONNECTOR_QUERY_AXIS_FAILED");
  if (entity?.type === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
    const kind = String(curve.GetType());
    if (kind === "GeomAbs_Line") {
      const walk = new EdgeWalk(oc, entity.shape, isReversed(entity.shape));
      return walk.at(walk.parameter(0, false)).direction;
    }
    if (kind === "GeomAbs_Circle") return xyz(curve.Circle().Axis().Direction());
    return failed();
  }
  if (entity?.type === "FACE") {
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
    const kind = String(surface.GetType());
    if (kind === "GeomAbs_Plane") {
      const normal = xyz(surface.Plane().Axis().Direction());
      return isReversed(entity.shape) ? scaled(normal, -1) : normal;
    }
    if (kind === "GeomAbs_Cylinder") return xyz(surface.Cylinder().Axis().Direction());
    return failed();
  }
  return failed();
}

/** `v` turned by `angle` about the unit `axis` (Rodrigues' formula). */
const rotated = (v: Vec3, axis: Vec3, angle: number): Vec3 =>
  plus(
    plus(scaled(v, Math.cos(angle)), scaled(cross(axis, v), Math.sin(angle))),
    scaled(axis, dot(axis, v) * (1 - Math.cos(angle))),
  );

export const MATE_CONNECTOR_BUILTINS = {
  /**
   * The coordinate system std's Mate connector feature makes from its picks. In order: the
   * inference on `originQuery`; "between entities" moves the origin midway to the nearest point of
   * `originAdditionalQuery`; `specifyNormal` and `realign` set Z and the secondary direction (X so
   * far); `flipPrimary` reverses Z; `secondaryAxisType` picks the axis that points along the
   * secondary direction; `transform` moves the origin along the resulting axes, then turns them
   * about one of them in place; a feature pattern's remaining transform moves the result.
   */
  evMateConnectorCoordSystem: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    const field = (name: string) => definition.getField(name);
    const flag = (name: string) => untag(field(name)) === true;
    // An optional query std leaves out (decal.fs passes only the origin) resolves to nothing.
    const first = (name: string) =>
      field(name) === undefined ? undefined : resolve(call, model, oc, field(name))[0];

    const originEntity = first("originQuery");
    if (!originEntity) return regenError(call, "MATECONNECTOR_QUERY_ORIGIN_FAILED");
    if (first("secondaryOriginQuery"))
      return call.unsupported(
        "Mate connector inferences with a secondaryOriginQuery are not supported locally yet.",
      );
    const inference = untag(field("entityInferenceType"));
    if (typeof inference !== "string")
      return call.fail("entityInferenceType must be an EntityInferenceType.");
    let { origin, x: secondary, z } = inferred(call, oc, originEntity, inference);

    if (untag(field("originType")) === "BETWEEN_ENTITIES") {
      const other = first("originAdditionalQuery");
      if (!other) return regenError(call, "MATECONNECTOR_QUERY_ORIGIN_FAILED");
      const extrema = new oc.BRepExtrema_DistShapeShape();
      extrema.LoadS1(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...origin)).Vertex());
      extrema.LoadS2(other.shape);
      extrema.Perform(new oc.Message_ProgressRange());
      origin = scaled(plus(origin, xyz(extrema.PointOnShape2(1))), 0.5);
    }
    if (flag("specifyNormal")) {
      z = unit([
        magnitude(call, field("nx"), "nx"),
        magnitude(call, field("ny"), "ny"),
        magnitude(call, field("nz"), "nz"),
      ]);
      secondary = orthogonal(call, secondary, z);
    }
    if (flag("realign")) {
      z = unit(axisOf(call, oc, first("primaryAxisQuery")));
      const secondaryEntity = first("secondaryAxisQuery");
      secondary = orthogonal(
        call,
        secondaryEntity ? axisOf(call, oc, secondaryEntity) : secondary,
        z,
      );
    }
    if (flag("flipPrimary")) z = scaled(z, -1);
    secondary = orthogonal(call, secondary, z);
    // The chosen axis points along the secondary direction; Y = Z x X.
    const x = {
      PLUS_X: secondary,
      MINUS_X: scaled(secondary, -1),
      PLUS_Y: cross(secondary, z),
      MINUS_Y: cross(z, secondary),
    }[String(untag(field("secondaryAxisType")) ?? "PLUS_X") as "PLUS_X"];
    let frame: Frame = { origin, x, z };

    if (flag("transform")) {
      const y = cross(frame.z, frame.x);
      const along = (name: string, axis: Vec3) =>
        scaled(axis, magnitude(call, field(name) ?? 0, name));
      frame = {
        ...frame,
        origin: plus(
          plus(plus(frame.origin, along("translationX", frame.x)), along("translationY", y)),
          along("translationZ", frame.z),
        ),
      };
      const angle =
        field("rotation") === undefined ? 0 : magnitude(call, field("rotation"), "rotation");
      const about = { ABOUT_X: frame.x, ABOUT_Y: y, ABOUT_Z: frame.z }[
        String(untag(field("rotationType")) ?? "ABOUT_Z") as "ABOUT_Z"
      ];
      frame = { ...frame, x: rotated(frame.x, about, angle), z: rotated(frame.z, about, angle) };
    }

    const remaining = untag(field("remainingTransform"));
    if (remaining instanceof FsMap) {
      const linear = array(call, remaining.getField("linear"), "linear").map((row) =>
        array(call, row, "linear").map((c) => magnitude(call, c, "linear")),
      );
      const times = (v: Vec3): Vec3 =>
        [0, 1, 2].map((i) => dot(linear[i] as unknown as Vec3, v)) as unknown as Vec3;
      frame = {
        origin: plus(
          times(frame.origin),
          vector(call, remaining.getField("translation"), 3, "translation"),
        ),
        x: unit(times(frame.x)),
        z: unit(times(frame.z)),
      };
    }
    return stdCoordSystem(call, frame.origin, frame.x, frame.z);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
