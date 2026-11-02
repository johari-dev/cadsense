import type { Entity } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc, type Shape } from "../geometry/occt.ts";

/** Edge and face math shared by the evaluators: parameters along edges, face normals, adjacency. */

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const scaled = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = (v: Vec3): Vec3 => scaled(v, 1 / Math.hypot(...v));

export const isReversed = (shape: Shape) => String(shape.Orientation()) === "TopAbs_REVERSED";

// Gauss-Legendre nodes and weights on [-1, 1], five points.
const NODES: readonly number[] = [
  0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664,
];
const WEIGHTS: readonly number[] = [
  0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908,
  0.23692688505618908,
];
/** Arc length is found to this fraction of each piece's length, or the run stops. */
const LENGTH_TOLERANCE = 1e-12;
/** Pieces each continuity interval starts as, before adaptive refinement. */
const MIN_PIECES = 8;
/** Halvings of a piece before arc length gives up. */
const MAX_DEPTH = 40;

/**
 * A point's parameters on a face's surface relative to the face's parameter box (0 to 1 across
 * it, as std's face evaluators take them), and how far the point is from the surface. Found by
 * projecting onto the surface within the box, so it works wherever on the face the point is,
 * edges and corners included.
 */
export function faceParameters(
  oc: Oc,
  shape: Shape,
  point: Vec3,
): { readonly parameters: readonly [number, number]; readonly off: number } | null {
  const face = oc.TopoDS.Face(shape);
  const box = oc.BRepTools.UVBounds(face);
  const projection = new oc.GeomAPI_ProjectPointOnSurf(
    new oc.gp_Pnt(...point),
    oc.BRep_Tool.Surface(face),
    box.UMin,
    box.UMax,
    box.VMin,
    box.VMax,
  );
  if (projection.NbPoints() === 0) return null;
  const { U, V } = projection.LowerDistanceParameters();
  return {
    parameters: [(U - box.UMin) / (box.UMax - box.UMin), (V - box.VMin) / (box.VMax - box.VMin)],
    off: projection.LowerDistance(),
  };
}

/**
 * Positions along an edge for parameters in [0, 1], as std's edge evaluators take them: by arc
 * length (std's default, so 0.5 is the midpoint) or uniformly in the curve's own parameter. 0 is
 * the start in the chosen direction: the edge's own orientation, or reversed.
 *
 * Arc length integrates the curve's speed with adaptive Gauss-Legendre quadrature, starting from
 * the curve's own C3 breaks (every knot of a cubic spline), and inverts it with a bracketed
 * Newton search. `stop` ends the run if the length can't be found to `LENGTH_TOLERANCE`.
 */
export class EdgeWalk {
  readonly curve: InstanceType<Oc["BRepAdaptor_Curve"]>;
  readonly first: number;
  readonly last: number;
  readonly reversed: boolean;
  private readonly oc: Oc;
  private readonly stop: (message: string) => never;
  /** Converged pieces: their start parameters (plus the end) and the length up to each. */
  private table: { readonly u: number[]; readonly s: number[] } | undefined;

  constructor(
    oc: Oc,
    edge: Shape,
    reversed: boolean,
    stop: (message: string) => never = (message) => {
      throw new Error(message);
    },
  ) {
    this.oc = oc;
    this.curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    this.first = this.curve.FirstParameter();
    this.last = this.curve.LastParameter();
    this.reversed = reversed;
    this.stop = stop;
  }

  private speed(u: number): number {
    return Math.hypot(...xyz(this.curve.EvalD1(u).D1));
  }
  private gauss(a: number, b: number): number {
    const half = (b - a) / 2;
    const middle = (a + b) / 2;
    return NODES.reduce((sum, x, i) => sum + WEIGHTS[i]! * this.speed(middle + half * x), 0) * half;
  }

  /** The pieces' boundaries and cumulative lengths, built on first use. */
  private lengths(): { readonly u: number[]; readonly s: number[] } {
    if (this.table) return this.table;
    const shape = this.oc.GeomAbs_Shape.GeomAbs_C3;
    const count = this.curve.NbIntervals(shape);
    const breaks = new this.oc.NCollection_Array1_double(1, count + 1);
    this.curve.Intervals(breaks, shape);
    const u: number[] = [];
    const s: number[] = [0];
    const refine = (a: number, b: number, whole: number, depth: number) => {
      const middle = (a + b) / 2;
      const [left, right] = [this.gauss(a, middle), this.gauss(middle, b)];
      if (Math.abs(left + right - whole) <= LENGTH_TOLERANCE * Math.max(left + right, 1e-300)) {
        u.push(a, middle);
        s.push(s.at(-1)! + left, s.at(-1)! + left + right);
        return;
      }
      if (depth >= MAX_DEPTH)
        return this.stop("Arc length along this edge can't be found accurately enough locally.");
      refine(a, middle, left, depth + 1);
      refine(middle, b, right, depth + 1);
    };
    for (let i = 1; i <= count; i++) {
      const [a, b] = [breaks.Value(i), breaks.Value(i + 1)];
      for (let k = 0; k < MIN_PIECES; k++) {
        const [p, q] = [a + ((b - a) * k) / MIN_PIECES, a + ((b - a) * (k + 1)) / MIN_PIECES];
        refine(p, q, this.gauss(p, q), 0);
      }
    }
    u.push(this.last);
    this.table = { u, s };
    return this.table;
  }

  get length(): number {
    return this.lengths().s.at(-1)!;
  }

  /**
   * Where curve parameter `u` sits along this walk, from 0 at its start to 1 at its end: by arc
   * length, or uniformly in the curve's own parameter. The inverse of `parameter` on the edge.
   */
  fraction(u: number, arcLength: boolean): number {
    let along: number;
    if (!arcLength) along = (u - this.first) / (this.last - this.first);
    else {
      const { u: breaks, s } = this.lengths();
      // The piece holding u, by binary search; its length up to u by one Gauss rule.
      let lo = 0;
      let hi = breaks.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (breaks[mid]! <= u) lo = mid;
        else hi = mid;
      }
      along = (s[lo]! + this.gauss(breaks[lo]!, u)) / s.at(-1)!;
    }
    return this.reversed ? 1 - along : along;
  }

  /** The curve parameter at `t`, measured from this walk's start. */
  parameter(t: number, arcLength: boolean): number {
    const along = this.reversed ? 1 - t : t;
    if (!arcLength) return this.first + along * (this.last - this.first);
    const { u, s } = this.lengths();
    const total = s.at(-1)!;
    const target = along * total;
    if (target <= 0) return this.first + target / Math.max(this.speed(this.first), 1e-300);
    if (target >= total)
      return this.last + (target - total) / Math.max(this.speed(this.last), 1e-300);
    // The piece holding the target length, by binary search.
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]! <= target) lo = mid;
      else hi = mid;
    }
    // Newton on length(u[lo]..x) = target - s[lo], kept inside the piece, bisecting when it strays.
    let [low, high] = [u[lo]!, u[hi]!];
    let x = low + ((target - s[lo]!) / (s[hi]! - s[lo]! || 1)) * (high - low);
    for (let i = 0; i < 60; i++) {
      const error = s[lo]! + this.gauss(u[lo]!, x) - target;
      if (Math.abs(error) <= LENGTH_TOLERANCE * total) return x;
      if (error > 0) high = x;
      else low = x;
      const step = x - error / Math.max(this.speed(x), 1e-300);
      x = step > low && step < high ? step : (low + high) / 2;
      if (high - low <= 1e-15 * Math.max(1, Math.abs(x))) return x;
    }
    return this.stop("Arc length along this edge can't be inverted accurately enough locally.");
  }

  /** Point and unit tangent (in the walk's direction) at curve parameter `u`. */
  at(u: number): { point: Vec3; direction: Vec3 } {
    const result = this.curve.EvalD1(u);
    const direction = unit(xyz(result.D1));
    return {
      point: xyz(result.Point),
      direction: this.reversed ? scaled(direction, -1) : direction,
    };
  }
}

/**
 * Whether `face` uses `edge` against its curve's direction. Walking the edge the way the face uses
 * it keeps the face on the left, looking down the face's outward normal. Null when the face doesn't
 * bound the edge. The face must come from its body, so its orientation is the body's.
 */
export function reversedInFace(oc: Oc, face: Shape, edge: Shape): boolean | null {
  const inFace = subShapes(oc, face, "EDGE").find((candidate) => candidate.IsSame(edge));
  return inFace ? isReversed(inFace) : null;
}

/** A face's outward unit normal (following the face's orientation) at surface parameters (u, v). */
export function faceNormal(oc: Oc, face: Shape, u: number, v: number): Vec3 {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const result = surface.EvalD1(u, v);
  const normal = unit(cross(xyz(result.D1U), xyz(result.D1V)));
  return isReversed(face) ? scaled(normal, -1) : normal;
}

/** The outward normal of `face` where it meets `edge`, at the edge's curve parameter `u`. */
export function faceNormalOnEdge(oc: Oc, face: Shape, edge: Shape, u: number): Vec3 {
  const uv = new oc.BRepAdaptor_Curve2d(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face)).Value(u);
  return faceNormal(oc, face, uv.X(), uv.Y());
}

/** The faces of `body` that `edge` bounds, in the body's own orientation. */
export const facesAround = (oc: Oc, body: Entity, edge: Shape): Shape[] =>
  subShapes(oc, body.shape, "FACE").filter((face) =>
    subShapes(oc, face, "EDGE").some((candidate) => candidate.IsSame(edge)),
  );

/** The edge's two faces turn by less than this (radians) where std calls the edge smooth. */
const SMOOTH_ANGLE = 1e-7;
/** Points of an edge where convexity is sampled, as fractions of its parameter range. */
const CONVEXITY_SAMPLES = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];

/**
 * The interior angle between an edge's two faces, sampled along it. With t the edge's direction
 * as the first face uses it (that face on the left) and n1, n2 the outward normals, (n1 x n2) . t
 * is the sine of the turn: positive where the edge is convex. Edges without two faces, and faces
 * folding back onto each other, `stop` the run.
 */
export function edgeConvexity(
  oc: Oc,
  body: Entity,
  edge: Shape,
  stop: (message: string) => never,
): string {
  const faces = facesAround(oc, body, edge);
  if (faces.length !== 2)
    return stop(
      `evEdgeConvexity on an edge with ${faces.length} face${faces.length === 1 ? "" : "s"} (a sheet's boundary or a wire) is not supported locally yet.`,
    );
  const [first, second] = faces as [Shape, Shape];
  const walk = new EdgeWalk(oc, edge, reversedInFace(oc, first, edge)!);
  const kinds = new Set(
    CONVEXITY_SAMPLES.map((t) => {
      const u = walk.parameter(t, false);
      const n1 = faceNormalOnEdge(oc, first, edge, u);
      const n2 = faceNormalOnEdge(oc, second, edge, u);
      const turn = dot(cross(n1, n2), walk.at(u).direction);
      if (Math.abs(turn) < SMOOTH_ANGLE)
        return dot(n1, n2) > 0
          ? "SMOOTH"
          : stop(
              "evEdgeConvexity where two faces fold back onto each other is not supported locally yet.",
            );
      return turn > 0 ? "CONVEX" : "CONCAVE";
    }),
  );
  return kinds.size === 1 ? [...kinds][0]! : "VARIABLE";
}

/**
 * A conical face as std's `Cone` describes it: frame at the apex, Z into the cone, the half angle
 * between Z and the surface. Read from the surface itself (this build has no gp_Cone): opposite
 * rulings at u = 0 and PI give the axis, the radius and how it grows.
 */
export function coneOf(oc: Oc, face: Shape) {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  const v = (bounds.VMin + bounds.VMax) / 2;
  const [at0, atPi] = [surface.EvalD1(0, v), surface.EvalD1(Math.PI, v)];
  const [p0, pPi] = [xyz(at0.Point), xyz(atPi.Point)];
  const [d0, dPi] = [xyz(at0.D1V), xyz(atPi.D1V)];
  const across = minus(p0, pPi);
  const x = unit(across);
  const radius = Math.hypot(...across) / 2;
  // Along a ruling (per unit v): cos(angle) along the axis, sin(angle) outward along x.
  const axial = scaled([d0[0] + dPi[0], d0[1] + dPi[1], d0[2] + dPi[2]], 0.5);
  const cos = Math.hypot(...axial);
  const sin = dot(scaled(minus(d0, dPi), 0.5), x);
  const axis = scaled(axial, 1 / cos);
  const center = scaled([p0[0] + pPi[0], p0[1] + pPi[1], p0[2] + pPi[2]], 0.5);
  // The radius reaches zero `radius * cos / sin` back along the axis.
  const apex = minus(center, scaled(axis, (radius * cos) / sin));
  return {
    apex,
    x,
    z: sin > 0 ? axis : scaled(axis, -1),
    halfAngle: Math.atan2(Math.abs(sin), cos),
  };
}

/**
 * A face's curvature across an edge at the edge's curve parameter `u`, with std's sign (positive
 * where the face bends away from its outward normal, like an exterior fillet): the normal
 * curvature in the face's tangent plane, square to the edge.
 */
function curvatureAcross(oc: Oc, face: Shape, edge: Shape, u: number, tangent: Vec3): number {
  const uv = new oc.BRepAdaptor_Curve2d(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face)).Value(u);
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const r = surface.EvalD2(uv.X(), uv.Y());
  const [su, sv] = [xyz(r.D1U), xyz(r.D1V)];
  const n = scaled(unit(cross(su, sv)), isReversed(face) ? -1 : 1);
  const w = cross(n, tangent);
  const [e, f, g] = [dot(su, su), dot(su, sv), dot(sv, sv)];
  const [wu, wv] = [dot(w, su), dot(w, sv)];
  const det = e * g - f * f;
  const [a, b] = [(g * wu - f * wv) / det, (e * wv - f * wu) / det];
  const second =
    dot(xyz(r.D2U), n) * a * a + 2 * dot(xyz(r.D2UV), n) * a * b + dot(xyz(r.D2V), n) * b * b;
  const first = e * a * a + 2 * f * a * b + g * b * b;
  return -second / first;
}

/** Curvatures below this (1/m) count as flat for std's convex and concave edge rules. */
const FLAT = 1e-6;

/**
 * How an edge joins its two faces along its whole length, as std's qTangentConnectedFaces,
 * qConvexConnectedFaces and qConcaveConnectedFaces define it. Tangent: the faces' normals agree
 * (within `tangentAngle` radians, default `SMOOTH_ANGLE`). Convex: the faces turn outward, or meet
 * tangentially where one face bends away from its normal and the other is flat or bends away too
 * (an exterior fillet's edges); concave the reverse. An edge without two faces joins nothing.
 */
export function edgeJoint(
  oc: Oc,
  body: Entity,
  edge: Shape,
  tangentAngle = SMOOTH_ANGLE,
): { tangent: boolean; convex: boolean; concave: boolean } {
  const faces = facesAround(oc, body, edge);
  if (faces.length !== 2) return { tangent: false, convex: false, concave: false };
  const [first, second] = faces as [Shape, Shape];
  const walk = new EdgeWalk(oc, edge, reversedInFace(oc, first, edge)!);
  const samples = CONVEXITY_SAMPLES.map((t) => {
    const u = walk.parameter(t, false);
    const n1 = faceNormalOnEdge(oc, first, edge, u);
    const n2 = faceNormalOnEdge(oc, second, edge, u);
    const direction = walk.at(u).direction;
    const turn = dot(cross(n1, n2), direction);
    const angle = Math.atan2(Math.hypot(...cross(n1, n2)), dot(n1, n2));
    const smooth = Math.abs(turn) < SMOOTH_ANGLE && dot(n1, n2) > 0;
    const bends = smooth
      ? [
          curvatureAcross(oc, first, edge, u, direction),
          curvatureAcross(oc, second, edge, u, direction),
        ]
      : [0, 0];
    return { turn, angle, smooth, bends };
  });
  const out = (k: readonly number[]) => Math.max(...k) > FLAT && Math.min(...k) >= -FLAT;
  const into = (k: readonly number[]) => Math.min(...k) < -FLAT && Math.max(...k) <= FLAT;
  return {
    tangent: samples.every((sample) => sample.angle <= tangentAngle),
    convex: samples.every((sample) => (sample.smooth ? out(sample.bends) : sample.turn > 0)),
    concave: samples.every((sample) => (sample.smooth ? into(sample.bends) : sample.turn < 0)),
  };
}

/** Areas, volumes and their moments are integrated to this relative accuracy where needed. */
const PROPERTY_ACCURACY = 1e-12;
/** Surfaces, and boundary curves in their parameter plane, that fixed-order integration gets exact. */
const FIXED_ORDER_SURFACES = new Set([
  "GeomAbs_Plane",
  "GeomAbs_Cylinder",
  "GeomAbs_Cone",
  "GeomAbs_Sphere",
  "GeomAbs_Torus",
]);
const FIXED_ORDER_BOUNDARIES = new Set(["GeomAbs_Line", "GeomAbs_Circle", "GeomAbs_Ellipse"]);

/**
 * Whether OpenCascade's fixed-order integration is exact (to rounding) on a face: an elementary
 * surface bounded by lines, circles and ellipses in its parameter plane. It integrates along those
 * boundary curves, so a spline there is as bad as a spline surface: 2e-5 off on a cylinder cut by
 * another, 1e-7 on a sphere cut by a slanted plane, 0.17% on a rational cylinder.
 */
function fixedOrderExact(oc: Oc, shape: Shape): boolean {
  const face = oc.TopoDS.Face(shape);
  if (!FIXED_ORDER_SURFACES.has(String(new oc.BRepAdaptor_Surface(face, false).GetType())))
    return false;
  return subShapes(oc, shape, "EDGE").every((edge) =>
    FIXED_ORDER_BOUNDARIES.has(
      String(new oc.BRepAdaptor_Curve2d(oc.TopoDS.Edge(edge), face).GetType()),
    ),
  );
}

/**
 * Curves whose length and moments fixed-order integration gets to rounding: their speed is
 * constant. An ellipse's isn't (fixed order is 3.9e-4 off on an arc).
 */
const FIXED_ORDER_CURVES = new Set(["GeomAbs_Line", "GeomAbs_Circle"]);

/**
 * An edge's length, centroid and moments. Lines and circles take OpenCascade's fixed-order rule
 * whole; other curves take it on pieces (from the curve's C3 breaks, `MIN_PIECES` each), each
 * halved until its length agrees with its halves' to `LENGTH_TOLERANCE`. In one piece, fixed order
 * is 4.5e-4 short on a quadratic spline bent 90 degrees. `stop` ends the run if a piece won't
 * settle.
 */
function edgeProperties(
  oc: Oc,
  edge: Shape,
  stop: (message: string) => never,
): InstanceType<Oc["GProp_GProps"]> {
  const props = new oc.GProp_GProps();
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  if (
    oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)) ||
    FIXED_ORDER_CURVES.has(String(curve.GetType()))
  ) {
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    return props;
  }
  // The edge's own curve, placed; each piece is an edge on it.
  const geometry = oc.BRep_Tool.Curve(oc.TopoDS.Edge(edge), 0, 0).returnValue;
  const piece = (a: number, b: number) => {
    const one = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(
      new oc.BRepBuilderAPI_MakeEdge(geometry, a, b).Edge(),
      one,
      false,
      false,
    );
    return one;
  };
  const refine = (a: number, b: number, whole: InstanceType<Oc["GProp_GProps"]>, depth: number) => {
    const middle = (a + b) / 2;
    const [left, right] = [piece(a, middle), piece(middle, b)];
    const sum = left.Mass() + right.Mass();
    if (Math.abs(sum - whole.Mass()) <= LENGTH_TOLERANCE * Math.max(sum, 1e-300)) {
      props.Add(left, 1);
      props.Add(right, 1);
      return;
    }
    if (depth >= MAX_DEPTH)
      return stop("An edge's length can't be found accurately enough locally.");
    refine(a, middle, left, depth + 1);
    refine(middle, b, right, depth + 1);
  };
  const shape = oc.GeomAbs_Shape.GeomAbs_C3;
  const count = curve.NbIntervals(shape);
  const breaks = new oc.NCollection_Array1_double(1, count + 1);
  curve.Intervals(breaks, shape);
  for (let i = 1; i <= count; i++) {
    const [a, b] = [breaks.Value(i), breaks.Value(i + 1)];
    for (let k = 0; k < MIN_PIECES; k++) {
      const [p, q] = [a + ((b - a) * k) / MIN_PIECES, a + ((b - a) * (k + 1)) / MIN_PIECES];
      refine(p, q, piece(p, q), 0);
    }
  }
  return props;
}

/**
 * Mass properties at unit density for a dimension (3 volume, 2 area, 1 length). Faces where fixed
 * order is exact use it; the rest are integrated adaptively to `PROPERTY_ACCURACY`, which costs 5x
 * to 26x more. Areas add up face by face; a volume is adaptive when any of its faces needs it.
 * Lengths add up edge by edge (`edgeProperties`). `stop` ends the run when an edge's length
 * won't settle.
 */
export function properties(
  oc: Oc,
  shape: Shape,
  dimension: number,
  stop: (message: string) => never,
): InstanceType<Oc["GProp_GProps"]> {
  const props = new oc.GProp_GProps();
  if (dimension === 1)
    for (const edge of subShapes(oc, shape, "EDGE")) props.Add(edgeProperties(oc, edge, stop), 1);
  else if (dimension === 3) {
    if (subShapes(oc, shape, "FACE").every((face) => fixedOrderExact(oc, face)))
      oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
    else oc.BRepGProp.VolumeProperties(shape, props, PROPERTY_ACCURACY, false, false);
  } else
    for (const face of subShapes(oc, shape, "FACE")) {
      const one = new oc.GProp_GProps();
      if (fixedOrderExact(oc, face)) oc.BRepGProp.SurfaceProperties(face, one, false, false);
      else oc.BRepGProp.SurfaceProperties(face, one, PROPERTY_ACCURACY, false);
      props.Add(one, 1);
    }
  return props;
}
