import { edgeCurveDefinition } from "./bspline.ts";
import { faceSurfaceDefinition } from "./surfaces.ts";
import type { Entity, EntityType } from "../geometry/Model.ts";
import { faceRegion, filletRadius, onFace, reach } from "../geometry/Query.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, FsTagged, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import {
  coneOf,
  cross,
  dot,
  EdgeWalk,
  faceNormalOnEdge,
  faceParameters,
  isReversed,
  minus,
  plus,
  properties,
  reversedInFace,
  scaled,
  unit,
} from "./edges.ts";
import { kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import {
  length,
  lengthVector,
  quantity,
  regenError,
  stdCoordSystem,
  stdLine,
  stdPlane,
  stdTagged,
  stdType,
  unitVector,
} from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Geometry evaluators. Results are std's own types (`Line`, `Plane`, `ValueWithUnits`, ...), built the
 * way std builds them. Edge parameters in [0, 1] measure arc length unless a call asks for
 * `arcLengthParameterization : false`, as std documents (see `EdgeWalk`).
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

const reversed = isReversed;

/** Point and unit tangent at `t` in [0, 1] along an edge, following the edge's orientation. */
function edgeTangent(oc: Oc, edge: Shape, t: number): { point: Vec3; direction: Vec3 } {
  const walk = new EdgeWalk(oc, edge, reversed(edge));
  return walk.at(walk.parameter(t, false));
}

/**
 * How std's edge evaluators walk `edge`: in its default orientation (the one `evEdgeTangentLine`
 * uses), or, given `face`, the way that keeps the face on the left looking down its outward normal.
 */
function edgeWalk(
  call: BuiltinCall,
  input: Definition,
  edge: Entity,
  face: Entity | null,
): EdgeWalk {
  if (!face) return new EdgeWalk(input.oc, edge.shape, reversed(edge.shape), call.unsupported);
  const inFace = reversedInFace(input.oc, face.shape, edge.shape);
  if (inFace === null) return call.fail("The face isn't adjacent to the edge.");
  return new EdgeWalk(input.oc, edge.shape, inFace, call.unsupported);
}
/** std's `arcLengthParameterization` flag; true unless set to false. */
const arcLength = (definition: FsMap) =>
  untag(definition.getField("arcLengthParameterization")) !== false;

/** The axis of a line or circle edge, a cylindrical face, or a mate connector (its Z axis). */
function axisOf(call: BuiltinCall, oc: Oc, entity: Entity): { origin: Vec3; direction: Vec3 } {
  if (entity.frame) return { origin: [...entity.frame.origin], direction: [...entity.frame.zAxis] };
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

/** An infinite line or plane: two of them have a closed-form closest pair. */
type Flat =
  | { readonly type: "line"; readonly origin: Vec3; readonly direction: Vec3 }
  | { readonly type: "plane"; readonly origin: Vec3; readonly normal: Vec3; readonly x: Vec3 };

/**
 * One thing on a side of `evDistance`, and its index in the side as given. Bounded things have a
 * `shape`. Unbounded ones (std Line and Plane values, extended line edges and plane, cylinder and
 * cone faces) have `cut` instead: a finite piece holding their closest point to anything in a box
 * with the given corners. Lines and planes also have `flat` and a `reference` point on them,
 * where closed forms start when the closest pair isn't unique. `extends` is the edge or face an
 * extended thing stands in for.
 */
type DistanceItem = {
  readonly kind: "POINT" | "LINE" | "PLANE" | EntityType;
  readonly index: number;
  readonly shape?: Shape;
  readonly cut?: (corners: readonly Vec3[]) => Shape;
  readonly flat?: Flat;
  readonly reference?: Vec3;
  readonly extends?: Shape;
  /** Why an extended side's edge or face couldn't extend: it stands as it is (see `extendSide`). */
  readonly unextended?: string;
};

/** The range of `measure` over `corners`, padded. */
const spread = (corners: readonly Vec3[], measure: (p: Vec3) => number): [number, number] => {
  const values = corners.map(measure);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const pad = 0.1 * (high - low) + 1e-3;
  return [low - pad, high + pad];
};

/**
 * The parts of an infinite line or plane that matter: the closest point of an unbounded line or
 * surface to any point lies over that point, so a piece over a box's projection holds its closest
 * point to anything in the box.
 */
const lineCut =
  (oc: Oc, origin: Vec3, direction: Vec3) =>
  (corners: readonly Vec3[]): Shape => {
    const [from, to] = spread(corners, (p) => dot(minus(p, origin), direction));
    const at = (t: number) => new oc.gp_Pnt(...plus(origin, scaled(direction, t)));
    return new oc.BRepBuilderAPI_MakeEdge(at(from), at(to)).Edge();
  };

/** Either side of `evDistance`: entities from a query, a point, a Line or Plane, or an array of them. */
function distanceSide(call: BuiltinCall, input: Definition, field: string): DistanceItem[] {
  const { oc } = input;
  const value = input.definition.getField(field);
  const v = untag(value);
  /** A std Line or Plane value: always unbounded. */
  const flatItem = (map: FsMap, index: number): DistanceItem => {
    const origin = vector(call, map.getField("origin"), 3, `${field}.origin`);
    if (map.getField("normal") === undefined) {
      const direction = unit(vector(call, map.getField("direction"), 3, `${field}.direction`));
      return {
        kind: "LINE",
        index,
        flat: { type: "line", origin, direction },
        reference: origin,
        cut: lineCut(oc, origin, direction),
      };
    }
    const normal = unit(vector(call, map.getField("normal"), 3, `${field}.normal`));
    const x = unit(vector(call, map.getField("x"), 3, `${field}.x`));
    const y = cross(normal, x);
    return {
      kind: "PLANE",
      index,
      flat: { type: "plane", origin, normal, x },
      reference: origin,
      cut: (corners) => {
        const [u, w] = [x, y].map((axis) => spread(corners, (p) => dot(minus(p, origin), axis)));
        const frame = new oc.gp_Ax3(
          new oc.gp_Pnt(...origin),
          new oc.gp_Dir(...normal),
          new oc.gp_Dir(...x),
        );
        return new oc.BRepBuilderAPI_MakeFace(
          new oc.gp_Pln(frame),
          u![0],
          u![1],
          w![0],
          w![1],
        ).Face();
      },
    };
  };
  // Queries are maps too; Lines and Planes are the maps with an origin.
  const isFlat = (x: FsValue) => {
    const m = untag(x);
    return m instanceof FsMap && m.getField("origin") !== undefined;
  };
  if (isFlat(value)) return [flatItem(v as FsMap, 0)];
  if (!Array.isArray(v))
    return resolve(call, input.model, oc, value).map((entity, index) => ({
      shape: entity.shape,
      kind: entity.type,
      index,
    }));
  const items = v as FsArray;
  if (items.some(isFlat))
    return items.map((item, index) => flatItem(map(call, item, field), index));
  const onePoint = items.length === 3 && items.every((c) => !Array.isArray(untag(c)));
  return (onePoint ? [value] : items).map((p, index) => ({
    shape: new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...vector(call, p, 3, field))).Vertex(),
    kind: "POINT" as const,
    index,
  }));
}

/**
 * An `evDistance` side with `extendSide` (std: "bodies will be ignored and edges and faces extended
 * to their possibly infinite underlying surfaces"). Where the extension is unambiguous: a line or
 * circle edge becomes its whole line or circle, a plane, cylinder, cone, sphere or torus face its
 * whole surface. Lines, planes, cylinders and cones become unbounded items (see `DistanceItem`).
 * Other curves and surfaces stay as they are, marked `unextended` (Onshape doesn't document how
 * they extend): a closest pair at distance 0 still stands, since no extension gets closer, and
 * anything farther stops the run.
 */
function extendSide(
  call: BuiltinCall,
  input: Definition,
  side: readonly DistanceItem[],
): DistanceItem[] {
  const { oc } = input;
  return side
    .filter((item) => item.kind !== "BODY")
    .map((item): DistanceItem => {
      if (!item.shape || (item.kind !== "EDGE" && item.kind !== "FACE")) return item;
      const original = item.shape;
      if (item.kind === "EDGE") {
        const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(original));
        const kind = String(curve.GetType());
        const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
        if (kind === "GeomAbs_Circle")
          return {
            ...item,
            shape: new oc.BRepBuilderAPI_MakeEdge(curve.Circle()).Edge(),
            extends: original,
          };
        if (kind === "GeomAbs_Line") {
          const origin = xyz(curve.Value(first));
          const direction = unit(xyz(curve.EvalD1(first).D1));
          return {
            kind: item.kind,
            index: item.index,
            flat: { type: "line", origin, direction },
            reference: xyz(curve.Value((first + last) / 2)),
            cut: lineCut(oc, origin, direction),
            extends: original,
          };
        }
        return {
          ...item,
          unextended: `evDistance extends only line and circle edges locally, not ${kind.replace("GeomAbs_", "")} edges.`,
        };
      }
      const face = oc.TopoDS.Face(original);
      const surface = new oc.BRepAdaptor_Surface(face, false);
      const kind = String(surface.GetType());
      const geometry = oc.BRep_Tool.Surface(face);
      const piece = (u: [number, number], v: [number, number]) =>
        new oc.BRepBuilderAPI_MakeFace(geometry, u[0], u[1], v[0], v[1], 1e-7).Face();
      const turn: [number, number] = [0, 2 * Math.PI];
      const unbounded = (cut: (corners: readonly Vec3[]) => Shape, flat?: Flat): DistanceItem => {
        const box = oc.BRepTools.UVBounds(face);
        const middle = xyz(surface.Value((box.UMin + box.UMax) / 2, (box.VMin + box.VMax) / 2));
        return {
          kind: item.kind,
          index: item.index,
          cut,
          ...(flat ? { flat } : {}),
          reference: middle,
          extends: original,
        };
      };
      if (kind === "GeomAbs_Sphere")
        return { ...item, shape: piece(turn, [-Math.PI / 2, Math.PI / 2]), extends: original };
      if (kind === "GeomAbs_Torus") return { ...item, shape: piece(turn, turn), extends: original };
      if (kind === "GeomAbs_Plane") {
        const position = surface.Plane().Position();
        const [origin, normal, x, y] = [
          position.Location(),
          position.Direction(),
          position.XDirection(),
          position.YDirection(),
        ].map(xyz) as unknown as [Vec3, Vec3, Vec3, Vec3];
        return unbounded(
          (corners) =>
            piece(
              spread(corners, (p) => dot(minus(p, origin), x)),
              spread(corners, (p) => dot(minus(p, origin), y)),
            ),
          { type: "plane", origin, normal, x },
        );
      }
      if (kind === "GeomAbs_Cylinder") {
        const position = surface.Cylinder().Position();
        const [origin, z] = [position.Location(), position.Direction()].map(xyz) as unknown as [
          Vec3,
          Vec3,
        ];
        return unbounded((corners) =>
          piece(
            turn,
            spread(corners, (p) => dot(minus(p, origin), z)),
          ),
        );
      }
      if (kind === "GeomAbs_Cone") {
        // v runs along a side line from the circle at v = 0, so a foot is no farther from that
        // circle's point than the point it's the foot of. Parasolid's cone, and so Onshape's, is
        // only the half on the face's side of the apex, so v stops there.
        const [p0, pPi] = [xyz(surface.Value(0, 0)), xyz(surface.Value(Math.PI, 0))];
        const center = scaled(plus(p0, pPi), 0.5);
        const radius = Math.hypot(...minus(p0, center));
        // The signed radius r(v) is linear in v; the face's middle sets its sign, r = 0 the apex.
        const box = oc.BRepTools.UVBounds(face);
        const middle = (box.VMin + box.VMax) / 2;
        const across = (v: number) =>
          minus(xyz(surface.Value(0, v)), xyz(surface.Value(Math.PI, v)));
        const outward = unit(across(middle));
        const signed = (v: number) => dot(across(v), outward) / 2;
        const slope = signed(middle + 1) - signed(middle);
        const apex = middle - signed(middle) / slope;
        return unbounded((corners) => {
          const [, far] = spread(corners, (p) => Math.hypot(...minus(p, center)) + radius);
          return piece(
            turn,
            // (At least a sliver from the apex, for points nearest the apex itself.)
            slope > 0 ? [apex, Math.max(far, apex + 1e-3)] : [Math.min(-far, apex - 1e-3), apex],
          );
        });
      }
      return {
        ...item,
        unextended: `evDistance extends only plane, cylinder, cone, sphere and torus faces locally, not ${kind.replace("GeomAbs_", "")} faces.`,
      };
    });
}

/** Closer than this (meters, std's TOLERANCE.zeroLength) is touching. */
const ZERO_LENGTH = 1e-8;
/** Below this sine, two directions count as parallel (std's TOLERANCE.zeroAngle). */
const PARALLEL_SINE = 1e-11;

/**
 * The closest pair between two lines or planes, in closed form. Where it isn't unique, it starts
 * from a reference point: parallel lines or planes from `a`'s, a line parallel to a plane from the
 * line's, and two planes that cross from the point of their common line nearest `a`'s. Every pair
 * returned differs by the same vector as any other closest pair would, so only where along the
 * tie it sits depends on the choice.
 */
function flatPair(a: DistanceItem, b: DistanceItem): [Vec3, Vec3] {
  const [fa, fb] = [a.flat!, b.flat!];
  const foot = (p: Vec3, f: Flat): Vec3 =>
    f.type === "line"
      ? plus(f.origin, scaled(f.direction, dot(minus(p, f.origin), f.direction)))
      : minus(p, scaled(f.normal, dot(minus(p, f.origin), f.normal)));
  // Both closed forms are written with cross products (u, the common perpendicular), with no
  // 1 - k^2 or differences of near-equal dot products to lose all their digits when the
  // directions are nearly parallel.
  if (fa.type === "line" && fb.type === "line") {
    const u = cross(fa.direction, fb.direction);
    const size = dot(u, u);
    // |u| is the sine of the angle; 1 - k^2 rounds to about 2e-16 for (1, 1, 0) with itself.
    if (Math.sqrt(size) < PARALLEL_SINE) {
      const start = a.reference!;
      return [start, foot(start, fb)];
    }
    // The closest points' positions along each line: ((ob - oa) x d) . u / |u|^2.
    const between = minus(fb.origin, fa.origin);
    const s = dot(cross(between, fb.direction), u) / size;
    const t = dot(cross(between, fa.direction), u) / size;
    return [plus(fa.origin, scaled(fa.direction, s)), plus(fb.origin, scaled(fb.direction, t))];
  }
  if (fa.type === "plane" && fb.type === "plane") {
    const r = a.reference!;
    const u = cross(fa.normal, fb.normal);
    const size = dot(u, u);
    if (Math.sqrt(size) < PARALLEL_SINE) return [r, foot(r, fb)];
    // The point of both planes nearest r: r + (ea (nb x u) + eb (u x na)) / |u|^2, where ea and
    // eb are r's offsets to each plane along its normal.
    const [ea, eb] = [dot(minus(fa.origin, r), fa.normal), dot(minus(fb.origin, r), fb.normal)];
    const meet = plus(
      r,
      scaled(plus(scaled(cross(fb.normal, u), ea), scaled(cross(u, fa.normal), eb)), 1 / size),
    );
    return [meet, meet];
  }
  // A line and a plane, in either order.
  const [line, plane, lineItem] =
    fa.type === "line"
      ? [fa, fb as Flat & { type: "plane" }, a]
      : [fb as Flat & { type: "line" }, fa, b];
  const along = dot(line.direction, plane.normal);
  let onLine: Vec3;
  let onPlane: Vec3;
  if (Math.abs(along) < PARALLEL_SINE) {
    onLine = lineItem.reference!;
    onPlane = foot(onLine, plane);
  } else {
    onLine = plus(
      line.origin,
      scaled(line.direction, dot(minus(plane.origin, line.origin), plane.normal) / along),
    );
    onPlane = onLine;
  }
  return fa.type === "line" ? [onLine, onPlane] : [onPlane, onLine];
}

/**
 * The closest pair between two `evDistance` items: in closed form between two lines or planes;
 * otherwise by BRepExtrema, an unbounded item cut to the other's box (from `reach`'s upper bound).
 * Two unbounded items that aren't both lines or planes have no box and stop the run.
 */
function closestPair(
  call: BuiltinCall,
  input: Definition,
  a: DistanceItem,
  b: DistanceItem,
): { readonly distance: number; readonly points: [Vec3, Vec3] } {
  const { oc } = input;
  if (a.cut && b.cut) {
    if (!a.flat || !b.flat)
      return call.unsupported(
        "evDistance between an extended cylinder or cone and another unbounded side isn't supported locally yet.",
      );
    const points = flatPair(a, b);
    return { distance: Math.hypot(...minus(points[0], points[1])), points };
  }
  const corners = (shape: Shape): Vec3[] => {
    const reaches = (d: Vec3) => reach(oc, shape, d, call.unsupported, false);
    const [hi, lo] = [
      [reaches([1, 0, 0]), reaches([0, 1, 0]), reaches([0, 0, 1])],
      [-reaches([-1, 0, 0]), -reaches([0, -1, 0]), -reaches([0, 0, -1])],
    ];
    return [0, 1, 2, 3, 4, 5, 6, 7].map(
      (k) => [0, 1, 2].map((axis) => ((k >> axis) & 1 ? hi[axis]! : lo[axis]!)) as unknown as Vec3,
    );
  };
  const shapeA = a.cut ? a.cut(corners(b.shape!)) : a.shape!;
  const shapeB = b.cut ? b.cut(corners(shapeA)) : b.shape!;
  const extrema = new oc.BRepExtrema_DistShapeShape();
  extrema.LoadS1(shapeA);
  extrema.LoadS2(shapeB);
  extrema.Perform(new oc.Message_ProgressRange());
  if (!extrema.IsDone() || extrema.NbSolution() === 0)
    return call.unsupported("evDistance couldn't measure between these locally.");
  return {
    distance: extrema.Value(),
    points: [xyz(extrema.PointOnShape1(1)), xyz(extrema.PointOnShape2(1))],
  };
}

/**
 * Where an `evDistance` side's closest point sits, as std's `DistanceResult` gives it: on a face,
 * its two unitless parameters relative to the face's parameter box (what evFaceTangentPlane
 * takes); on an edge, its position from 0 at the start to 1 at the end, by arc length unless
 * `arcLengthParameterization` is false; 0 for points, vertices and bodies. What the query asked
 * for decides, not the shape: a sheet body can be stored as one face. On a Line value, the length
 * along it from its origin; on a Plane value, the point's 2D position in its x and y, in lengths.
 *
 * Planes get real parameters too, though std's DistanceResult says "If this face is a mesh or a
 * plane, the parameter is a 2D Vector of zeroes": std's curve pattern sweeps a thin strip along
 * its path and places each instance at the strip's tangent plane at this parameter, and along a
 * straight edge that strip is a plane here, so zeros stack every instance at one corner. Real
 * parameters on true planes only move split part's and frame trim's flip manipulators.
 */
function distanceParameter(
  call: BuiltinCall,
  input: Definition,
  { shape, kind, flat, extends: extension }: DistanceItem,
  point: Vec3,
): FsValue {
  const { oc } = input;
  if (extension) return extendedParameter(call, input, kind, extension, point);
  if (flat?.type === "line" && kind === "LINE")
    return length(call, dot(minus(point, flat.origin), flat.direction));
  if (flat?.type === "plane" && kind === "PLANE") {
    const offset = minus(point, flat.origin);
    return new FsTagged(stdType(call, "vector.fs", "Vector"), [
      length(call, dot(offset, flat.x)),
      length(call, dot(offset, cross(flat.normal, flat.x))),
    ]);
  }
  if (kind === "FACE" && shape) {
    const on = faceParameters(oc, shape, point);
    if (!on || on.off > 1e-7)
      return call.unsupported("evDistance couldn't place its closest point on the face locally.");
    return unitVector(call, on.parameters);
  }
  if (kind === "EDGE" && shape) {
    // The closest point's curve parameter: inside the edge, or at whichever end it is.
    const extrema = new oc.BRepExtrema_DistShapeShape();
    extrema.LoadS1(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex());
    extrema.LoadS2(shape);
    extrema.Perform(new oc.Message_ProgressRange());
    const walk = new EdgeWalk(oc, shape, reversed(shape), call.unsupported);
    const ends = [walk.first, walk.last];
    // (The support's type enum isn't bound; the support shape's own type says the same.)
    const u =
      String(extrema.SupportOnShape2(1).ShapeType()) === "TopAbs_EDGE"
        ? extrema.ParOnEdgeS2(1).t
        : ends.reduce((nearest, end) =>
            Math.hypot(...minus(xyz(walk.curve.Value(end)), point)) <
            Math.hypot(...minus(xyz(walk.curve.Value(nearest)), point))
              ? end
              : nearest,
          );
    return walk.fraction(u, arcLength(input.definition));
  }
  return 0;
}

/**
 * A closest point's parameter on an extended edge or face, by the same conventions as on the
 * edge or face itself, carried past its ends: on a line or circle edge (constant speed, so both
 * parameterizations agree), its position along the edge, below 0 or above 1 off it (around a
 * circle, the turn after the edge's start); on a face, its parameters relative to the face's
 * parameter box, outside 0 to 1 off it (periodic ones within a turn of the box's start).
 */
function extendedParameter(
  call: BuiltinCall,
  input: Definition,
  kind: DistanceItem["kind"],
  shape: Shape,
  point: Vec3,
): FsValue {
  const { oc } = input;
  if (kind === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(shape));
    const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
    if (String(curve.GetType()) === "GeomAbs_Circle") {
      // The turn from the edge's start to the point, walking the edge's way: along the curve,
      // or back along it on a reversed edge.
      const position = curve.Circle().Position();
      const offset = minus(point, xyz(position.Location()));
      const angle = Math.atan2(
        dot(offset, xyz(position.YDirection())),
        dot(offset, xyz(position.XDirection())),
      );
      const wrap = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return (reversed(shape) ? wrap(last - angle) : wrap(angle - first)) / (last - first);
    }
    const derivative = xyz(curve.EvalD1(first).D1);
    const u =
      first + dot(minus(point, xyz(curve.Value(first))), derivative) / dot(derivative, derivative);
    const along = (u - first) / (last - first);
    return reversed(shape) ? 1 - along : along;
  }
  const face = oc.TopoDS.Face(shape);
  const box = oc.BRepTools.UVBounds(face);
  const surface = new oc.BRepAdaptor_Surface(face, false);
  const projection = new oc.GeomAPI_ProjectPointOnSurf(
    new oc.gp_Pnt(...point),
    oc.BRep_Tool.Surface(face),
  );
  if (projection.NbPoints() === 0 || projection.LowerDistance() > 1e-7)
    return call.unsupported(
      "evDistance couldn't place its closest point on the extended face locally.",
    );
  let { U, V } = projection.LowerDistanceParameters();
  const into = (t: number, low: number, period: number) =>
    low + ((((t - low) % period) + period) % period);
  if (surface.IsUPeriodic()) U = into(U, box.UMin, surface.UPeriod());
  if (surface.IsVPeriodic()) V = into(V, box.VMin, surface.VPeriod());
  return unitVector(call, [
    (U - box.UMin) / (box.UMax - box.UMin),
    (V - box.VMin) / (box.VMax - box.VMin),
  ]);
}

/**
 * Mass properties at unit density of the highest-dimension entities in `entities`: volume for solid
 * bodies, area for faces and sheets, length for edges and wires, a count of points otherwise. The
 * inertia tensor is about the centroid, with axes parallel to the world's; its products of inertia
 * are -integral(x y), the usual tensor convention.
 */
function massProperties(oc: Oc, entities: readonly Entity[], stop: (message: string) => never) {
  const dimension = (entity: Entity): number => {
    if (entity.type === "BODY")
      return { SOLID: 3, SHEET: 2, WIRE: 1, POINT: 0, MATE_CONNECTOR: 0 }[entity.bodyType];
    return { FACE: 2, EDGE: 1, VERTEX: 0 }[entity.type];
  };
  const highest = Math.max(...entities.map(dimension));
  const chosen = entities.filter((entity) => dimension(entity) === highest);
  if (highest === 0) {
    const points = chosen.map((entity) =>
      xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(subShapes(oc, entity.shape, "VERTEX")[0]!))),
    );
    const centroid = [0, 1, 2].map(
      (axis) => points.reduce((sum, point) => sum + point[axis]!, 0) / points.length,
    ) as unknown as Vec3;
    const inertia = [0, 1, 2].map((row) =>
      [0, 1, 2].map((column) =>
        points.reduce((sum, point) => {
          const d = [0, 1, 2].map((axis) => point[axis]! - centroid[axis]!);
          const squared = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
          return sum + (row === column ? squared - d[row]! ** 2 : -d[row]! * d[column]!);
        }, 0),
      ),
    );
    return { dimension: 0, amount: points.length, centroid, inertia };
  }
  const total = new oc.GProp_GProps();
  for (const entity of chosen) total.Add(properties(oc, entity.shape, highest, stop), 1);
  // The bindings can't return gp_Mat, so build the tensor from moments about axes through the
  // centroid: I(n) = n^T I n gives the diagonal for n = x, y, z and each product from n = (x + y) / sqrt 2.
  const centroid = xyz(total.CentreOfMass());
  const about = (direction: Vec3) =>
    total.MomentOfInertia(
      new oc.gp_Ax1(new oc.gp_Pnt(...centroid), new oc.gp_Dir(...normalized(direction))),
    );
  const axes: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const diagonal = axes.map(about);
  const inertia = axes.map((a, row) =>
    axes.map((b, column) =>
      row === column
        ? diagonal[row]!
        : about([a[0] + b[0], a[1] + b[1], a[2] + b[2]]) - (diagonal[row]! + diagonal[column]!) / 2,
    ),
  );
  return { dimension: highest, amount: total.Mass(), centroid, inertia };
}

export const EVALUATOR_BUILTINS = {
  evApproximateCentroid: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const entities = resolve(call, input.model, input.oc, input.definition.getField("entities"));
    if (entities.length === 0) return call.fail("entities resolves to nothing.");
    return lengthVector(call, massProperties(input.oc, entities, call.unsupported).centroid);
  },
  evApproximateMassProperties: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    if (input.definition.getField("referenceFrame") !== undefined)
      return call.unsupported("Mass properties in a referenceFrame are not supported locally yet.");
    const entities = resolve(call, input.model, input.oc, input.definition.getField("entities"));
    if (entities.length === 0) return call.fail("entities resolves to nothing.");
    const { dimension, amount, centroid, inertia } = massProperties(
      input.oc,
      entities,
      call.unsupported,
    );
    // std's wrapper attaches units and the density.
    return FsMap.fromEntries([
      ["highestDimension", dimension],
      [["count", "length", "area", "volume"][dimension]!, amount],
      ["centroid", [...centroid]],
      ["inertia", inertia],
    ]);
  },
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
  /**
   * The box around `topology`, in `cSys`'s coordinates when given (world otherwise). Tight (the
   * default), each side is at the topology's proven extreme along that axis, or the run stops.
   * With `tight : false`, std asks only for a box "at least as big": each side is at `reach`'s
   * upper bound, which never cuts into the topology and needs no search, so it stops only on
   * offset and other curves and surfaces.
   */
  evBox: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const { oc } = input;
    const system = input.definition.getField("cSys");
    let toLocal: InstanceType<Oc["gp_Trsf"]> | null = null;
    if (system !== undefined) {
      const cSys = map(call, system, "cSys");
      toLocal = new oc.gp_Trsf();
      toLocal.SetTransformation(
        new oc.gp_Ax3(
          new oc.gp_Pnt(...vector(call, cSys.getField("origin"), 3, "cSys.origin")),
          new oc.gp_Dir(...normalized(vector(call, cSys.getField("zAxis"), 3, "cSys.zAxis"))),
          new oc.gp_Dir(...normalized(vector(call, cSys.getField("xAxis"), 3, "cSys.xAxis"))),
        ),
      );
    }
    // Proven extremes along each axis (OpenCascade's own boxes pad spline geometry by 1e-7 m).
    const shapes = resolve(call, input.model, oc, input.definition.getField("topology")).map(
      (entity) =>
        toLocal
          ? new oc.BRepBuilderAPI_Transform(entity.shape, toLocal, true, false).Shape()
          : entity.shape,
    );
    if (shapes.length === 0) return call.fail("evBox3d: topology resolves to nothing.");
    const axes: readonly (readonly [number, number, number])[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const tight = untag(input.definition.getField("tight") ?? true) !== false;
    const farthest = (direction: readonly [number, number, number]) =>
      Math.max(...shapes.map((shape) => reach(oc, shape, direction, call.unsupported, tight)));
    return FsMap.fromEntries([
      [
        "minCorner",
        lengthVector(call, axes.map((d) => -farthest([-d[0], -d[1], -d[2]])) as unknown as Vec3),
      ],
      ["maxCorner", lengthVector(call, axes.map((d) => farthest(d)) as unknown as Vec3)],
    ]);
  },
  /** The radius of the fillet that made a face; faces no fillet made are BAD_GEOMETRY. */
  evFilletRadius: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = resolve(call, input.model, input.oc, input.definition.getField("face"))[0];
    const radius =
      face?.type === "FACE"
        ? filletRadius(
            { oc: input.oc, state: input.model.geometry, unsupported: call.unsupported },
            face,
          )
        : null;
    if (radius === null) return regenError(call, "BAD_GEOMETRY");
    return length(call, radius);
  },
  evVolume: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const body of all(call, input, "bodies", "BODY")) {
      total += properties(input.oc, body.shape, 3, call.unsupported).Mass();
    }
    return quantity(call, total, "VOLUME_UNITS");
  },
  evArea: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const face of all(call, input, "faces", "FACE")) {
      total += properties(input.oc, face.shape, 2, call.unsupported).Mass();
    }
    return quantity(call, total, "AREA_UNITS");
  },
  evLength: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    let total = 0;
    for (const edge of all(call, input, "edges", "EDGE"))
      total += properties(input.oc, edge.shape, 1, call.unsupported).Mass();
    return length(call, total);
  },
  evVertexPoint: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    // A mate connector or point body is a single vertex, and Onshape evaluates it as one.
    const vertex =
      resolve(call, input.model, input.oc, input.definition.getField("vertex")).find(
        (entity) =>
          entity.type === "VERTEX" ||
          (entity.type === "BODY" &&
            (entity.bodyType === "MATE_CONNECTOR" || entity.bodyType === "POINT")),
      ) ?? call.fail("vertex resolves to no vertex.");
    return lengthVector(call, xyz(input.oc.BRep_Tool.Pnt(input.oc.TopoDS.Vertex(vertex.shape))));
  },
  evDistance: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    if (untag(input.definition.getField("maximum")) === true)
      return call.unsupported("evDistance with maximum is not supported locally yet.");
    const sides = [0, 1].map((k) => {
      const side = distanceSide(call, input, `side${k}`);
      // std: extending applies to a side given as a query.
      const extend =
        untag(input.definition.getField(`extendSide${k}`)) === true &&
        side.some((item) => item.shape && item.kind !== "POINT");
      return extend ? extendSide(call, input, side) : side;
    }) as [DistanceItem[], DistanceItem[]];
    let best: { distance: number; points: [Vec3, Vec3]; a: DistanceItem; b: DistanceItem } | null =
      null;
    for (const a of sides[0])
      for (const b of sides[1]) {
        const pair = closestPair(call, input, a, b);
        if (!best || pair.distance < best.distance) best = { ...pair, a, b };
      }
    if (!best) return call.fail("evDistance: a side resolves to nothing.");
    const unextended = sides.flat().find((item) => item.unextended)?.unextended;
    if (unextended && best.distance > ZERO_LENGTH) return call.unsupported(unextended);
    // `index` counts in the side as given, before an extended side drops its bodies.
    const side = (item: DistanceItem, point: Vec3) =>
      FsMap.fromEntries([
        ["point", lengthVector(call, point)],
        ["index", item.index],
        ["parameter", distanceParameter(call, input, item, point)],
      ]);
    return stdTagged(call, "evaluate.fs", "DistanceResult", [
      ["distance", length(call, best.distance)],
      ["sides", [side(best.a, best.points[0]), side(best.b, best.points[1])]],
    ]);
  },
  evEdgeTangentLines: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const edge = first(call, input, "edge", "EDGE");
    const face =
      input.definition.getField("face") === undefined ? null : first(call, input, "face", "FACE");
    const walk = edgeWalk(call, input, edge, face);
    const byLength = arcLength(input.definition);
    return array(call, input.definition.getField("parameters"), "parameters").map((t) => {
      const { point, direction } = walk.at(
        walk.parameter(magnitude(call, t, "parameter"), byLength),
      );
      return stdLine(call, point, direction);
    });
  },
  /**
   * Planes tangent to `face` at points along `edge`: origin on the edge, the face's outward normal,
   * and x along the edge (walked as `usingFaceOrientation` says).
   */
  evFaceTangentPlanesAtEdge: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const edge = first(call, input, "edge", "EDGE");
    const face = resolve(call, input.model, input.oc, input.definition.getField("face"))[0];
    if (face?.type !== "FACE") return regenError(call, "NO_TANGENT_PLANE");
    if (reversedInFace(input.oc, face.shape, edge.shape) === null)
      return call.fail("The face isn't adjacent to the edge.");
    const faceOriented = untag(input.definition.getField("usingFaceOrientation")) === true;
    const walk = edgeWalk(call, input, edge, faceOriented ? face : null);
    const byLength = arcLength(input.definition);
    return array(call, input.definition.getField("parameters"), "parameters").map((t) => {
      const u = walk.parameter(magnitude(call, t, "parameter"), byLength);
      const { point, direction } = walk.at(u);
      const normal = faceNormalOnEdge(input.oc, face.shape, edge.shape, u);
      // The edge's tangent lies in the face's tangent plane; this only removes rounding.
      const x = unit(minus(direction, scaled(normal, dot(direction, normal))));
      return stdPlane(call, point, normal, x);
    });
  },
  /**
   * Planes tangent to `face` at parameters relative to its parameter box. With
   * `returnUndefinedOutsideFace`, parameters off the trimmed face (`onFace`) give undefined.
   */
  evFaceTangentPlanes: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = first(call, input, "face", "FACE");
    const { oc } = input;
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face.shape));
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), true);
    const region =
      untag(input.definition.getField("returnUndefinedOutsideFace")) === true
        ? faceRegion(oc, face.shape)
        : null;
    // A periodic parameter outside the box is the same point some whole turns away: classify it
    // in the turn that starts at the box's start, as reach's peakOnFace does. On a full turn that
    // lands in the box; past a partial face's end, onFace finds it off the face.
    const underlying = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), false);
    const intoTurn = (t: number, low: number, period: number) =>
      low + ((((t - low) % period) + period) % period);
    const insideFace = (u: number, v: number) =>
      onFace(
        oc,
        region!,
        underlying.IsUPeriodic() ? intoTurn(u, bounds.UMin, underlying.UPeriod()) : u,
        underlying.IsVPeriodic() ? intoTurn(v, bounds.VMin, underlying.VPeriod()) : v,
        call.unsupported,
      );
    return array(call, input.definition.getField("parameters"), "parameters").map((uv) => {
      const [s, t] = vector(call, uv, 2, "parameter");
      const [u, v] = [
        bounds.UMin + s * (bounds.UMax - bounds.UMin),
        bounds.VMin + t * (bounds.VMax - bounds.VMin),
      ];
      if (region && !insideFace(u, v)) return undefined;
      const result = surface.EvalD1(u, v);
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
    if (kind === "GeomAbs_Cone") {
      const cone = coneOf(input.oc, face.shape);
      return stdTagged(call, "surfaceGeometry.fs", "Cone", [
        ["coordSystem", stdCoordSystem(call, cone.apex, cone.x, cone.z)],
        ["halfAngle", quantity(call, cone.halfAngle, "ANGLE_UNITS")],
      ]);
    }
    if (kind === "GeomAbs_BSplineSurface") {
      // Planes flip with their face; whether Onshape flips a B-spline for a reversed face isn't
      // documented, so only faces running with their surface are read.
      if (reversed(face.shape))
        return call.unsupported(
          "evSurfaceDefinition for a B-spline face reversed against its surface is not supported locally yet.",
        );
      return faceSurfaceDefinition(call, input.oc, face.shape);
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
    if (kind === "GeomAbs_BSplineCurve" || kind === "GeomAbs_BezierCurve")
      return edgeCurveDefinition(call, input.oc, edge.shape);
    return call.unsupported(
      `evCurveDefinition for ${kind.replace("GeomAbs_", "")} curves is not supported locally yet.`,
    );
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
