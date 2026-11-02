import type { Vec3 } from "../geometry/Sketch.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import type { BuiltinCall } from "../runtime/Interpreter.ts";
import { edgeSpline, splineOf } from "./bspline.ts";
import { normalized } from "./geometryArgs.ts";

/**
 * The frame a sweep carries its profile in by default: rotation-minimizing (it turns about the
 * path's tangent only as much as the tangent's own turning forces), so it depends on the path's
 * shape alone, not on how its curve is parameterized or where its knots are.
 *
 * OpenCascade's own default (a "corrected Frenet" frame) samples a fixed number of points per knot
 * span, so the same path with more knots sweeps differently. Instead the frame is computed here by
 * double reflection (Wang et al. 2008) and handed to OpenCascade as a support surface: a ruled
 * sheet through the path whose normal along it is the frame's second axis. OpenCascade's Darboux
 * mode then follows that normal exactly; no offset or intersection is involved, so a path that
 * turns sharply (a fit spline leaving its start almost at rest) is followed as well.
 *
 * The frame samples the path densely, so its curves are read out of the kernel once and evaluated
 * here: every kernel call that returns an object leaves a little behind in the kernel's heap, even
 * once the object is freed.
 */

type Curve = InstanceType<Oc["Geom_BSplineCurve"]>;
type Wire = InstanceType<Oc["TopoDS_Wire"]>;

/**
 * How far a cubic put on the sheet in place of a path of higher degree (when the frame won't fit
 * the path's own basis) may stray from it, in meters: a hundredth of the sweep's own fitting
 * tolerance.
 */
const PATH_TOLERANCE = 1e-9;
/** The most the path's tangent turns between two samples of the frame, in radians. */
const SAMPLE_TURN = 0.05;
/**
 * How far the support's normal may stray from the frame between samples, in radians: a profile
 * point 100 mm off the path moves 1e-8 m, a tenth of the sweep's own fitting tolerance.
 */
const FRAME_TOLERANCE = 1e-7;

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** `v` mirrored in the plane through the origin square to `n`. */
const reflect = (v: Vec3, n: Vec3): Vec3 => minus(v, scaled(n, (2 * dot(n, v)) / dot(n, n)));
/** `r` (square to the unit `t`) turned `angle` radians about `t`. */
const turned = (r: Vec3, t: Vec3, angle: number): Vec3 =>
  plus(scaled(r, Math.cos(angle)), scaled(cross(t, r), Math.sin(angle)));

/** Frees OpenCascade objects once used; they live outside JavaScript's garbage collector. */
const free = (...objects: readonly { delete(): void }[]) => {
  for (const object of objects) object.delete();
};

/**
 * A clamped, non-periodic B-spline in plain arrays: its degree, flat knots, poles (x, y, z in a
 * row) and weights (null when it isn't rational).
 */
interface Bspline {
  readonly degree: number;
  readonly knots: Float64Array;
  readonly poles: Float64Array;
  readonly weights: Float64Array | null;
}

/** Room for one evaluation's basis functions and their derivatives, by degree. */
const rooms = new Map<number, [Float64Array, Float64Array]>();
const room = (degree: number) => {
  let found = rooms.get(degree);
  if (!found)
    rooms.set(degree, (found = [new Float64Array(degree + 1), new Float64Array(degree + 1)]));
  return found;
};

/** An OpenCascade curve (clamped, not periodic) read into plain arrays. */
function bsplineOf(curve: Curve): Bspline {
  const spline = splineOf(curve);
  return {
    degree: spline.degree,
    knots: Float64Array.from(spline.knots),
    poles: Float64Array.from(spline.points.flat()),
    weights: spline.weights && Float64Array.from(spline.weights),
  };
}

/** The knot span holding `u`: the last index in degree..poles - 1 whose knot is at most u. */
function spanOf({ degree, knots, poles }: Bspline, u: number) {
  let [span, above] = [degree, poles.length / 3];
  while (above - span > 1) {
    const middle = (span + above) >> 1;
    if (u >= knots[middle]!) span = middle;
    else above = middle;
  }
  return span;
}

/**
 * The basis functions of `spline`'s degree not zero at `u`, from index `span - degree`, and
 * (with `slopes`) their derivatives (Piegl and Tiller A2.2, and the derivative of the last step).
 */
function basis(
  spline: Bspline,
  span: number,
  u: number,
  values: Float64Array,
  slopes?: Float64Array,
) {
  const { degree: p, knots } = spline;
  values[0] = 1;
  for (let j = 1; j <= p; j++) {
    // At the last step, `values` holds degree p - 1: what the derivatives are made of.
    if (j === p && slopes)
      for (let r = 0; r <= p; r++) {
        const i = span - p + r;
        const fromLeft = r > 0 ? values[r - 1]! / (knots[i + p]! - knots[i]!) : 0;
        const toRight = r < p ? values[r]! / (knots[i + p + 1]! - knots[i + 1]!) : 0;
        slopes[r] =
          p *
          ((Number.isFinite(fromLeft) ? fromLeft : 0) - (Number.isFinite(toRight) ? toRight : 0));
      }
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const right = knots[span + r + 1]! - u;
      const left = u - knots[span + 1 - j + r]!;
      const share = values[r]! / (right + left);
      values[r] = saved + right * share;
      saved = left * share;
    }
    values[j] = saved;
  }
}

/** Point and first derivative of `spline` at `u`. */
function derivatives(spline: Bspline, u: number): [Vec3, Vec3] {
  const { degree: p, poles, weights } = spline;
  const [values, slopes] = room(p);
  const span = spanOf(spline, u);
  basis(spline, span, u, values, slopes);
  // Homogeneous sums, then the quotient rule.
  let [x, y, z, dx, dy, dz, w, dw] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r <= p; r++) {
    const i = span - p + r;
    const weight = weights ? weights[i]! : 1;
    const [n, dn] = [values[r]! * weight, slopes[r]! * weight];
    const [px, py, pz] = [poles[3 * i]!, poles[3 * i + 1]!, poles[3 * i + 2]!];
    x += n * px;
    y += n * py;
    z += n * pz;
    dx += dn * px;
    dy += dn * py;
    dz += dn * pz;
    w += n;
    dw += dn;
  }
  const point: Vec3 = [x / w, y / w, z / w];
  return [point, [(dx - point[0] * dw) / w, (dy - point[1] * dw) / w, (dz - point[2] * dw) / w]];
}

/**
 * An upper bound on how far `spline`'s unit tangent turns over [a, b] (inside one knot span), in
 * radians; Infinity where it can't be bounded (the speed may reach zero). The turn is the integral
 * of |C' x C''| / |C'|^2, at most h M2 / (|C'(m)| - M2 h / 2) for h = b - a, midpoint m, and M2
 * bounding |C''| on the span. M2 comes from the control polygons of the homogeneous curve's
 * derivatives there (a B-spline lies in its control points' hull), with C = A / w:
 * |C'| <= (|A'| + |C| |w'|) / w and |C''| <= (|A''| + 2 |C'| |w'| + |C| |w''|) / w, measured
 * from the span's first control point.
 */
function turnBound(spline: Bspline, a: number, b: number): number {
  const { degree: p, knots, poles, weights } = spline;
  if (p < 2) return 0;
  const span = spanOf(spline, (a + b) / 2);
  // The span's control points, homogeneous and moved to the first: (w (P - O), w).
  const o = span - p;
  const origin: Vec3 = [poles[3 * o]!, poles[3 * o + 1]!, poles[3 * o + 2]!];
  const point = (i: number): number[] => {
    const w = weights ? weights[i]! : 1;
    return [0, 1, 2].map((k) => w * (poles[3 * i + k]! - origin[k]!)).concat(w);
  };
  const points = Array.from({ length: p + 1 }, (_, j) => point(o + j));
  // Differencing: Q_i = p (P_{i+1} - P_i) / (t_{i+p+1} - t_{i+1}), zero where those knots meet.
  const difference = (rows: number[][], degree: number, first: number) =>
    rows.slice(0, -1).map((row, j) => {
      const i = first + j;
      const gap = knots[i + degree + 1]! - knots[i + 1]!;
      return gap > 0
        ? row.map((x, k) => (degree * (rows[j + 1]![k]! - x)) / gap)
        : row.map(() => 0);
    });
  const firsts = difference(points, p, o);
  const seconds = difference(firsts, p - 1, o + 1);
  const most = (rows: number[][], pick: (row: number[]) => number) =>
    Math.max(0, ...rows.map(pick));
  const length = (row: number[]) => Math.hypot(row[0]!, row[1]!, row[2]!);
  const least = Math.min(...points.map((row) => row[3]!));
  if (!(least > 0)) return Infinity;
  const reach = most(points, (row) => length(row) / row[3]!);
  const [a1, w1] = [most(firsts, length), most(firsts, (row) => Math.abs(row[3]!))];
  const [a2, w2] = [most(seconds, length), most(seconds, (row) => Math.abs(row[3]!))];
  const m1 = (a1 + reach * w1) / least;
  const m2 = (a2 + 2 * m1 * w1 + reach * w2) / least;
  const h = b - a;
  const slowest = Math.hypot(...derivatives(spline, (a + b) / 2)[1]) - (m2 * h) / 2;
  return slowest > 0 ? (m2 * h) / slowest : Infinity;
}

/** A point of a path curve, its unit tangent and its speed (length per unit parameter). */
interface Station {
  readonly u: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly speed: number;
}

/** Thrown where a path doesn't move, so it has no direction; the builtins stop on it. */
class Stalled extends Error {}

/**
 * The point at `u`, the unit direction the path runs in there, and its speed. Where the derivative
 * is zero (a spline whose first control points coincide sets off from rest) the direction is the
 * chord over a millionth of the range on the side toward the middle.
 */
const station = (spline: Bspline, u: number): Station => {
  const [point, d] = derivatives(spline, u);
  const speed = Math.hypot(...d);
  if (speed > 0) return { u, point, tangent: normalized(d), speed };
  const { degree: p, knots } = spline;
  const [first, last] = [knots[p]!, knots[knots.length - p - 1]!];
  const step = (last - first) * 1e-6 * (u - first < last - u ? 1 : -1);
  const chord = scaled(minus(derivatives(spline, u + step)[0], point), Math.sign(step));
  if (!(Math.hypot(...chord) > 0)) throw new Stalled();
  return { u, point, tangent: normalized(chord), speed };
};

/** `work`, stopping the sweep as unsupported where the path has no direction. */
function moving<T>(call: BuiltinCall, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof Stalled)
      return call.unsupported(
        "opSweep along a path that stops dead somewhere (no direction there) is not supported locally yet.",
      );
    throw error;
  }
}

const pointAt = (spline: Bspline, u: number): Vec3 => derivatives(spline, u)[0];

/** A path curve, and its spline read out of the kernel to evaluate here. */
interface PathCurve {
  readonly curve: Curve;
  readonly spline: Bspline;
}

/** The curve's knots, distinct, with their multiplicities. */
const runsOf = (curve: Curve) => ({
  knots: Array.from({ length: curve.NbKnots() }, (_, i) => curve.Knot(i + 1)),
  mults: Array.from({ length: curve.NbKnots() }, (_, i) => curve.Multiplicity(i + 1)),
});

/**
 * Parameters along a path curve: four per knot span, split until the tangent turns at most
 * SAMPLE_TURN between neighbors, so the frame is sampled densely wherever it turns.
 */
function samplesOf({ curve, spline }: PathCurve): number[] {
  const { knots } = runsOf(curve);
  const split = (a: Station, b: Station, depth: number): number[] => {
    if (depth >= 50 || Math.acos(Math.min(1, dot(a.tangent, b.tangent))) <= SAMPLE_TURN)
      return [a.u, b.u];
    const middle = station(spline, (a.u + b.u) / 2);
    return [...split(a, middle, depth + 1), ...split(middle, b, depth + 1).slice(1)];
  };
  const coarse = [
    ...knots
      .slice(0, -1)
      .flatMap((a, i) => [0, 1, 2, 3].map((k) => a + ((knots[i + 1]! - a) * k) / 4)),
    knots.at(-1)!,
  ].map((u) => station(spline, u));
  return [coarse[0]!.u, ...coarse.slice(1).flatMap((b, i) => split(coarse[i]!, b, 0).slice(1))];
}

/** Where each basis function of a clamped spline peaks, roughly: its knots' averages. */
function grevilleOf({ degree: p, knots, poles }: Bspline): number[] {
  return Array.from({ length: poles.length / 3 }, (_, j) => {
    let sum = 0;
    for (let k = 1; k <= p; k++) sum += knots[j + k]!;
    return sum / p;
  });
}

/** The frame along one path curve at its samples and midway between them, and the length walked. */
interface CurveFrame extends PathCurve {
  readonly us: readonly number[];
  frames: Vec3[];
  middles: Vec3[];
  /** Path length from the spine's start to each sample, and to each midpoint. */
  readonly lengths: number[];
  readonly middleLengths: number[];
}

/**
 * Carries `frame` (square to the tangent) along a path curve through `us` by double reflection,
 * in quarter steps, recording it at each sample and midpoint. Length is integrated by Simpson's
 * rule on each half interval, from `walked` before the curve starts.
 */
function carry(path: PathCurve, us: readonly number[], frame: Vec3, walked: number): CurveFrame {
  let here = station(path.spline, us[0]!);
  let r = frame;
  const step = (u: number) => {
    const next = station(path.spline, u);
    const chord = minus(next.point, here.point);
    if (dot(chord, chord) > 0) {
      const mirrored = reflect(r, chord);
      const fix = minus(next.tangent, reflect(here.tangent, chord));
      r = dot(fix, fix) > 0 ? reflect(mirrored, fix) : mirrored;
    }
    here = next;
    return next.speed;
  };
  const result: CurveFrame = {
    ...path,
    us,
    frames: [r],
    middles: [],
    lengths: [walked],
    middleLengths: [],
  };
  let length = walked;
  us.slice(1).forEach((b, i) => {
    const a = us[i]!;
    const quarter = (b - a) / 4;
    const start = here.speed;
    const [q1, mid] = [step(a + quarter), step(a + 2 * quarter)];
    length += ((2 * quarter) / 6) * (start + 4 * q1 + mid);
    result.middles.push(r);
    result.middleLengths.push(length);
    const [q3, end] = [step(a + 3 * quarter), step(b)];
    length += ((2 * quarter) / 6) * (mid + 4 * q3 + end);
    result.frames.push(r);
    result.lengths.push(length);
  });
  return result;
}

/** One reusable point for filling OpenCascade arrays; making a point per value leaks. */
type Scratch = InstanceType<Oc["gp_Pnt"]>;

/**
 * A non-rational cubic through `values` (points) at `parameters`, repeats allowed. Its knots
 * depend on the parameters alone, so two fits at the same parameters share one basis.
 */
function interpolate(
  oc: Oc,
  scratch: Scratch,
  values: readonly Vec3[],
  parameters: readonly number[],
): Curve {
  const points = new oc.NCollection_Array1_gp_Pnt(1, values.length);
  const at = new oc.NCollection_Array1_double(1, values.length);
  values.forEach((v, i) => {
    scratch.SetCoord(...v);
    points.SetValue(i + 1, scratch);
    at.SetValue(i + 1, parameters[i]!);
  });
  const [heldPoints, heldAt] = [
    new oc.NCollection_HArray1_gp_Pnt(points),
    new oc.NCollection_HArray1_double(at),
  ];
  // Zero tolerance: a straight stretch has the same frame at every sample.
  const fit = new oc.GeomAPI_Interpolate(heldPoints, heldAt, false, 0);
  fit.Perform();
  const curve = fit.Curve();
  free(points, at, heldPoints, heldAt, fit);
  return curve;
}

/** Raises both curves to one degree and one knot vector, so their poles pair up. */
function matched(oc: Oc, a: Curve, b: Curve) {
  const degree = Math.max(a.Degree(), b.Degree());
  a.IncreaseDegree(degree);
  b.IncreaseDegree(degree);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const { knots, mults } = runsOf(from);
    const [knotArray, multArray] = [
      new oc.NCollection_Array1_double(1, knots.length),
      new oc.NCollection_Array1_int(1, knots.length),
    ];
    knots.forEach((k, i) => {
      knotArray.SetValue(i + 1, k);
      multArray.SetValue(i + 1, mults[i]!);
    });
    to.InsertKnots(knotArray, multArray, 1e-15, false);
    free(knotArray, multArray);
  }
}

/**
 * The poles of the spline in `spline`'s own basis that takes `values` at its Greville points. The
 * collocation matrix is banded and totally positive, so elimination needs no pivoting (de Boor).
 */
function collocated(spline: Bspline, values: readonly Vec3[]): Float64Array {
  const p = spline.degree;
  const n = spline.poles.length / 3;
  const at = grevilleOf(spline);
  // Row i holds columns i - p .. i + p.
  const width = 2 * p + 1;
  const band = new Float64Array(n * width);
  const row = new Float64Array(p + 1);
  at.forEach((u, i) => {
    const span = spanOf(spline, u);
    basis(spline, span, u, row);
    for (let k = 0; k <= p; k++) band[i * width + (span - p + k - i + p)] = row[k]!;
  });
  const rhs = Float64Array.from(values.flat());
  for (let i = 0; i < n; i++) {
    const pivot = band[i * width + p]!;
    for (let r = i + 1; r <= Math.min(n - 1, i + p); r++) {
      const factor = band[r * width + (i - r + p)]! / pivot;
      if (factor === 0) continue;
      for (let c = i; c <= Math.min(n - 1, i + p); c++)
        band[r * width + (c - r + p)]! -= factor * band[i * width + (c - i + p)]!;
      for (let k = 0; k < 3; k++) rhs[3 * r + k]! -= factor * rhs[3 * i + k]!;
    }
  }
  const poles = new Float64Array(3 * n);
  for (let i = n - 1; i >= 0; i--)
    for (let k = 0; k < 3; k++) {
      let sum = rhs[3 * i + k]!;
      for (let c = i + 1; c <= Math.min(n - 1, i + p); c++)
        sum -= band[i * width + (c - i + p)]! * poles[3 * c + k]!;
      poles[3 * i + k] = sum / band[i * width + p]!;
    }
  return poles;
}

/**
 * How a path curve's frame is fitted: in the curve's own basis at its Greville points (for a
 * non-rational curve above degree 3, so the support keeps the path's knots), or as a cubic
 * through samples where the tangent turns. Either way it's carried through those samples.
 */
type Fit = "own" | "cubic";

/** A support sheet and the path edge on it. */
interface Support {
  readonly face: Shape;
  readonly edge: Shape;
}

/**
 * The ruled sheet S(u, v) = C(u) + v H(u) / W(u) for path spline C (weights W) and frame spline
 * H on the same basis, with the path its v = 0 edge from `first` to `last`.
 */
function sheet(
  oc: Oc,
  scratch: Scratch,
  path: Bspline,
  lift: Float64Array,
  runs: { knots: readonly number[]; mults: readonly number[] },
  first: number,
  last: number,
): Support {
  const n = path.poles.length / 3;
  const poles = new oc.NCollection_Array2_gp_Pnt(1, n, 1, 2);
  const weights = new oc.NCollection_Array2_double(1, n, 1, 2);
  for (let i = 0; i < n; i++) {
    const w = path.weights ? path.weights[i]! : 1;
    const [x, y, z] = [path.poles[3 * i]!, path.poles[3 * i + 1]!, path.poles[3 * i + 2]!];
    scratch.SetCoord(x, y, z);
    poles.SetValue(i + 1, 1, scratch);
    scratch.SetCoord(x + lift[3 * i]! / w, y + lift[3 * i + 1]! / w, z + lift[3 * i + 2]! / w);
    poles.SetValue(i + 1, 2, scratch);
    weights.SetValue(i + 1, 1, w);
    weights.SetValue(i + 1, 2, w);
  }
  const [uKnots, uMults] = [
    new oc.NCollection_Array1_double(1, runs.knots.length),
    new oc.NCollection_Array1_int(1, runs.knots.length),
  ];
  runs.knots.forEach((k, i) => {
    uKnots.SetValue(i + 1, k);
    uMults.SetValue(i + 1, runs.mults[i]!);
  });
  const [vKnots, vMults] = [
    new oc.NCollection_Array1_double(1, 2),
    new oc.NCollection_Array1_int(1, 2),
  ];
  [0, 1].forEach((v, i) => {
    vKnots.SetValue(i + 1, v);
    vMults.SetValue(i + 1, 2);
  });
  const surface = new oc.Geom_BSplineSurface(
    poles,
    weights,
    uKnots,
    vKnots,
    uMults,
    vMults,
    path.degree,
    1,
    false,
    false,
  );
  // The path is the sheet's v = 0 edge, u running with the curve's own parameter.
  const [origin, direction] = [new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(1, 0)];
  const line = new oc.Geom2d_Line(origin, direction);
  const [makeFace, makeEdge] = [
    new oc.BRepBuilderAPI_MakeFace(surface, 1e-7),
    new oc.BRepBuilderAPI_MakeEdge(line, surface, first, last),
  ];
  const support = { face: makeFace.Face(), edge: makeEdge.Edge() };
  free(poles, weights, uKnots, uMults, vKnots, vMults, surface, origin, direction, line);
  free(makeFace, makeEdge);
  return support;
}

/** The midpoints between samples where `frame` strays from H (or the cubic from the path). */
function straying(frame: CurveFrame, h: Bspline, cubic: Bspline | null): number[] {
  const { spline, us, middles } = frame;
  return us
    .slice(1)
    .map((b, i) => (us[i]! + b) / 2)
    .filter((u, i) => {
      const along = pointAt(h, u);
      const off = Math.hypot(...cross(along, middles[i]!)) / Math.hypot(...along);
      const miss = cubic ? Math.hypot(...minus(pointAt(cubic, u), pointAt(spline, u))) : 0;
      // NaN strays too.
      return !(off <= FRAME_TOLERANCE && miss <= PATH_TOLERANCE);
    });
}

/**
 * The support for one path curve C (weights W): a ruled sheet S(u, v) = C(u) + v H(u) / W(u),
 * with H a fit of the frame, so its normal along v = 0 is C' x H, square to the frame whatever H's
 * size. The path edge lies on it at v = 0, running with u. Where H strays from the frame by more
 * than FRAME_TOLERANCE, returns those midpoints instead: to sample there too, or for an "own" fit,
 * to put knots there.
 *
 * C and H must share one basis. A cubic H fitted to a path of higher degree (a helix is fitted at
 * degree 13) would be raised to it on every knot of both, so then a cubic through the path at H's
 * samples, within PATH_TOLERANCE of it, goes on the sheet instead.
 */
function supportOf(oc: Oc, scratch: Scratch, frame: CurveFrame, fit: Fit): Support | number[] {
  const { curve, spline, us, frames } = frame;
  const [first, last] = [us[0]!, us.at(-1)!];
  if (fit === "own") {
    // The frame is carried through dense samples; the fit takes it at the Greville points among them.
    const index = new Map(us.map((u, i) => [u, i]));
    const lift = collocated(
      spline,
      grevilleOf(spline).map((u) => frames[index.get(u)!]!),
    );
    const h: Bspline = { ...spline, poles: lift, weights: null };
    const strays = straying(frame, h, null);
    if (strays.length) return strays;
    return sheet(oc, scratch, spline, lift, runsOf(curve), first, last);
  }
  const h = interpolate(oc, scratch, frames, us);
  const cubic =
    curve.Degree() > 3
      ? interpolate(
          oc,
          scratch,
          us.map((u) => pointAt(spline, u)),
          us,
        )
      : null;
  const [hSpline, cubicSpline] = [bsplineOf(h), cubic && bsplineOf(cubic)];
  const strays = straying(frame, hSpline, cubicSpline);
  if (strays.length) {
    free(h, ...(cubic ? [cubic] : []));
    return strays;
  }
  if (cubic && cubicSpline) {
    // Fitted at the same parameters, the two cubics already share one basis.
    const support = sheet(oc, scratch, cubicSpline, hSpline.poles, runsOf(cubic), first, last);
    free(cubic, h);
    return support;
  }
  const c = new oc.Geom_BSplineCurve(curve);
  matched(oc, c, h);
  const support = sheet(oc, scratch, bsplineOf(c), bsplineOf(h).poles, runsOf(c), first, last);
  free(c, h);
  return support;
}

/**
 * The spine on its supports, one support sheet per path curve; or, if any support strays, what
 * each curve's support returned instead (null where it held).
 */
function assemble(
  oc: Oc,
  frames: readonly CurveFrame[],
  fits: readonly Fit[],
): { spine: Wire; support: Shape } | (number[] | null)[] {
  const scratch = new oc.gp_Pnt(0, 0, 0);
  try {
    const supports = frames.map((carried, i) => supportOf(oc, scratch, carried, fits[i]!));
    if (supports.some((s) => Array.isArray(s)))
      return supports.map((s) => {
        if (Array.isArray(s)) return s;
        free(s.face, s.edge);
        return null;
      });
    const wire = new oc.BRepBuilderAPI_MakeWire();
    const faces = new oc.TopoDS_Compound();
    const builder = new oc.TopoDS_Builder();
    builder.MakeCompound(faces);
    for (const s of supports)
      if (!Array.isArray(s)) {
        const edge = oc.TopoDS.Edge(s.edge);
        wire.Add(edge);
        builder.Add(faces, s.face);
        free(edge, s.edge, s.face);
      }
    const spine = wire.Wire();
    free(wire, builder);
    return { spine, support: faces };
  } finally {
    scratch.delete();
  }
}

/**
 * A copy of `curve` with simple knots added until no span turns more than 45 degrees, for its frame
 * to fit in its basis: a compact helix turns about a revolution per span.
 */
function refined(oc: Oc, curve: Curve): PathCurve {
  const spline = bsplineOf(curve);
  const { knots } = runsOf(curve);
  const added = knots.slice(0, -1).flatMap((a, i) => {
    const b = knots[i + 1]!;
    const tangents = Array.from(
      { length: 17 },
      (_, k) => station(spline, a + ((b - a) * k) / 16).tangent,
    );
    const turning = tangents
      .slice(1)
      .reduce((sum, t, k) => sum + Math.acos(Math.min(1, dot(tangents[k]!, t))), 0);
    const pieces = Math.ceil(turning / (Math.PI / 4));
    return Array.from({ length: pieces - 1 }, (_, k) => a + ((b - a) * (k + 1)) / pieces);
  });
  if (added.length === 0) return { curve, spline };
  const [values, mults] = [
    new oc.NCollection_Array1_double(1, added.length),
    new oc.NCollection_Array1_int(1, added.length),
  ];
  added.forEach((u, i) => {
    values.SetValue(i + 1, u);
    mults.SetValue(i + 1, 1);
  });
  curve.InsertKnots(values, mults, 1e-12, false);
  free(values, mults);
  return { curve, spline: bsplineOf(curve) };
}

/**
 * The path `edges` rebuilt on support sheets that carry the rotation-minimizing frame, for
 * `BRepOffsetAPI_MakePipeShell.SetMode(support)`, walked from `start` setting off along
 * `heading`. On a closed path the frame generally comes back turned about the tangent; that turn
 * is spread evenly along the path's length so the sweep closes on itself.
 *
 * The sheets carry the path's own curves, so they're as large as those: the kernel never frees
 * the shapes made on them, so they're kept as small as the frame allows.
 */
export function rotationMinimizingSpine(
  call: BuiltinCall,
  oc: Oc,
  edges: readonly Shape[],
  start: Vec3,
  heading: Vec3,
): { spine: Wire; support: Shape } {
  const paths = moving(call, () => walked(call, oc, edges, start, heading, true));
  try {
    const end = pointAt(paths.at(-1)!.spline, paths.at(-1)!.curve.LastParameter());
    return moving(call, () => framedOn(call, oc, paths, Math.hypot(...minus(end, start)) < 1e-7));
  } finally {
    free(...paths.map((path) => path.curve));
  }
}

/**
 * Copies of the path `edges`' curves in walking order, from `start` setting off along `heading`,
 * each turned to run the way the path is walked; `refining` adds knots for frames in their own
 * basis. The caller frees the curves.
 */
function walked(
  call: BuiltinCall,
  oc: Oc,
  edges: readonly Shape[],
  start: Vec3,
  heading: Vec3,
  refining: boolean,
): PathCurve[] {
  const left = edges.map((edge): PathCurve => {
    const curve = edgeSpline(oc, edge);
    if (curve.IsPeriodic()) {
      // Unperiodized, its knots still run past its ends; clamp them there.
      const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
      curve.SetNotPeriodic();
      curve.Segment(first, last);
    }
    return { curve, spline: bsplineOf(curve) };
  });
  const paths: PathCurve[] = [];
  try {
    let tip: Vec3 = start;
    while (left.length) {
      const ends = left.map(({ curve, spline }) => {
        const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
        const near = (u: number) => Math.hypot(...minus(pointAt(spline, u), tip)) < 1e-7;
        // A closed curve starts and ends at the tip: it runs the way the path sets off.
        const onward = paths.length > 0 || dot(station(spline, first).tangent, heading) > 0;
        return near(first) && (onward || !near(last)) ? "start" : near(last) ? "end" : null;
      });
      const next = ends.findIndex((end) => end !== null);
      if (next < 0) return call.fail("opSweep couldn't follow its path's edges in order.");
      const [taken] = left.splice(next, 1);
      const curve = taken!.curve;
      if (ends[next] === "end") curve.Reverse();
      const path =
        refining && curve.Degree() > 3 && !curve.IsRational()
          ? refined(oc, curve)
          : ends[next] === "end"
            ? { curve, spline: bsplineOf(curve) }
            : taken!;
      paths.push(path);
      tip = pointAt(path.spline, path.curve.LastParameter());
    }
    return paths;
  } catch (error) {
    free(...paths.map((path) => path.curve));
    throw error;
  } finally {
    free(...left.map((path) => path.curve));
  }
}

/** How close a fold measure must come to zero inside the path to count as a fold. */
const FOLD_TOLERANCE = 1e-6;

/**
 * True when `measure` of the path's unit tangent changes sign, or comes within FOLD_TOLERANCE of
 * zero, anywhere inside the path (not just at its ends). The tangent is sampled where it turns,
 * knots included. A measure of a unit vector moves no faster than the tangent turns, so it can
 * only come near zero inside an interval whose two end values sum to no more than an upper bound
 * on the tangent's turn over it (turnBound) plus twice the tolerance; such intervals are halved
 * until they're cleared or the measure is found near zero.
 */
export function foldsAlong(
  call: BuiltinCall,
  oc: Oc,
  edges: readonly Shape[],
  start: Vec3,
  heading: Vec3,
  measures: readonly ((tangent: Vec3) => number)[],
): boolean {
  if (measures.length === 0) return false;
  const paths = moving(call, () => walked(call, oc, edges, start, heading, false));
  try {
    // Evaluations allowed before giving up: the bound shrinks with the interval wherever the
    // curve keeps moving, so only a near-stall (refused before this) could run past it.
    let budget = 2_000_000;
    // Tangents by path and parameter, shared by every measure: the path is walked and sampled
    // once however many profile edges are checked.
    const tangents = paths.map(() => new Map<number, Vec3>());
    const tangent = (i: number, u: number) => {
      const known = tangents[i]!.get(u);
      if (known) return known;
      if (--budget < 0)
        return call.unsupported(
          "opSweep couldn't bound how its path turns closely enough to check the profile for folds; this path is not supported locally yet.",
        );
      const found = moving(call, () => station(paths[i]!.spline, u).tangent);
      tangents[i]!.set(u, found);
      return found;
    };
    const turns = paths.map(() => new Map<string, number>());
    const turnOver = (i: number, a: number, b: number) => {
      const key = `${a}:${b}`;
      const known = turns[i]!.get(key);
      if (known !== undefined) return known;
      const found = turnBound(paths[i]!.spline, a, b);
      turns[i]!.set(key, found);
      return found;
    };
    const samples = paths.map(samplesOf);
    return measures.some((measure) => foldsFor(samples, tangent, turnOver, measure));
  } finally {
    free(...paths.map((path) => path.curve));
  }
}

/**
 * foldsAlong for one measure, over each walked path curve's `samples`, with tangents and turn
 * bounds shared between measures.
 */
function foldsFor(
  samples: readonly (readonly number[])[],
  tangent: (i: number, u: number) => Vec3,
  turnOver: (i: number, a: number, b: number) => number,
  measure: (tangent: Vec3) => number,
): boolean {
  const clear = (v: number) => Math.abs(v) > FOLD_TOLERANCE;
  return samples.some((us, i) => {
    const value = (u: number) => measure(tangent(i, u));
    const [first, last] = [us[0]!, us.at(-1)!];
    const values = us.map(value);
    // The path's own ends may sit edge-on (a quarter turn kept level ends so): only what happens
    // inside it counts. Within the last sample interval (at most SAMPLE_TURN) of an edge-on end
    // the measure nears zero with the end; there only a clear sign change counts.
    const edgeOnStart = i === 0 && !clear(values[0]!);
    const edgeOnEnd = i === samples.length - 1 && !clear(values.at(-1)!);
    /** True when the measure comes near zero inside (a, b), given its values there. */
    const meets = (
      a: number,
      b: number,
      va: number,
      vb: number,
      nearEnd: boolean,
      depth: number,
    ): boolean => {
      if (clear(va) && clear(vb) && va * vb < 0) return true;
      // Near an edge-on end only a crossing counts, so no slack for the tolerance there.
      const slack = nearEnd ? 0 : 2 * FOLD_TOLERANCE;
      if (Math.abs(va) + Math.abs(vb) > turnOver(i, a, b) + slack) return false;
      const m = (a + b) / 2;
      const vm = value(m);
      if (!clear(vm) && !nearEnd) return true;
      // Too short to halve further: the measure stays within the tolerance's reach of zero.
      if (depth >= 60 || b - a <= 1e-14 * (last - first)) return false;
      return meets(a, m, va, vm, nearEnd, depth + 1) || meets(m, b, vm, vb, nearEnd, depth + 1);
    };
    return us.some((u, k) => {
      const isFirst = i === 0 && k === 0;
      const isLast = i === samples.length - 1 && k === us.length - 1;
      if (!isFirst && !isLast && !clear(values[k]!)) return true;
      if (k + 1 === us.length) return false;
      const nearEnd = (edgeOnStart && k === 0) || (edgeOnEnd && k === us.length - 2);
      return meets(u, us[k + 1]!, values[k]!, values[k + 1]!, nearEnd, 0);
    });
  });
}

/** Adds simple knots to `path`'s curve at `at`, and reads it again. */
function knotted(oc: Oc, path: PathCurve, at: readonly number[]): PathCurve {
  const [values, mults] = [
    new oc.NCollection_Array1_double(1, at.length),
    new oc.NCollection_Array1_int(1, at.length),
  ];
  at.forEach((u, i) => {
    values.SetValue(i + 1, u);
    mults.SetValue(i + 1, 1);
  });
  path.curve.InsertKnots(values, mults, 1e-12, false);
  free(values, mults);
  return { curve: path.curve, spline: bsplineOf(path.curve) };
}

/** How many times an own fit gets knots where it strays before it's fitted as a cubic. */
const OWN_REFINEMENTS = 4;

/** The supports for `given` in walking order, `closed` when the last ends where the first starts. */
function framedOn(
  call: BuiltinCall,
  oc: Oc,
  given: readonly PathCurve[],
  closed: boolean,
): { spine: Wire; support: Shape } {
  // Own fits add knots to their curves (copies the caller frees), so read them again.
  const paths = [...given];
  const refinements = paths.map(() => 0);
  // Any frame square to the start tangent: the profile keeps its place relative to it.
  const first = station(paths[0]!.spline, paths[0]!.curve.FirstParameter()).tangent;
  const across: Vec3 = Math.abs(first[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const initial = normalized(minus(across, scaled(first, dot(across, first))));
  const fits = paths.map(
    ({ curve }): Fit => (curve.Degree() > 3 && !curve.IsRational() ? "own" : "cubic"),
  );
  const merged = (a: readonly number[], b: readonly number[]) =>
    [...new Set([...a, ...b])].sort((x, y) => x - y);
  let samples = paths.map((path, i) =>
    fits[i] === "own" ? merged(samplesOf(path), grevilleOf(path.spline)) : samplesOf(path),
  );
  // Where the path is only C2 (at a cubic's knots) the frame is only C1 and the fit converges
  // slowly there, so allow plenty of passes.
  for (let pass = 0; pass < 20; pass++) {
    let [frame, walked] = [initial, 0];
    const frames = paths.map((path, i) => {
      const carried = carry(path, samples[i]!, frame, walked);
      [frame, walked] = [carried.frames.at(-1)!, carried.lengths.at(-1)!];
      return carried;
    });
    if (closed) {
      // Turn every frame back by its share of the closing turn, by length along the path.
      const back = Math.atan2(dot(cross(frame, initial), first), dot(frame, initial));
      for (const carried of frames) {
        const share = (r: Vec3, u: number, length: number) =>
          turned(r, station(carried.spline, u).tangent, (back * length) / walked);
        carried.frames = carried.frames.map((r, i) =>
          share(r, carried.us[i]!, carried.lengths[i]!),
        );
        carried.middles = carried.middles.map((r, i) =>
          share(r, (carried.us[i]! + carried.us[i + 1]!) / 2, carried.middleLengths[i]!),
        );
      }
    }
    // The kernel throws rather than fail on geometry it can't build; that ends the attempt.
    let built: ReturnType<typeof assemble>;
    try {
      built = assemble(oc, frames, fits);
    } catch {
      break;
    }
    if (!Array.isArray(built)) return built;
    const strays = built;
    samples = samples.map((us, i) => {
      const missed = strays[i];
      if (!missed) return us;
      if (fits[i] === "cubic") return [...us, ...missed].sort((a, b) => a - b);
      // The curve's own basis doesn't hold its frame there yet: knots there, or a cubic fit.
      if (refinements[i]! < OWN_REFINEMENTS) {
        refinements[i]! += 1;
        paths[i] = knotted(oc, paths[i]!, missed);
        return merged(us, grevilleOf(paths[i]!.spline));
      }
      fits[i] = "cubic";
      return samplesOf(paths[i]!);
    });
  }
  return call.unsupported(
    "opSweep couldn't follow the path's minimum-twist frame closely enough; this path is not supported locally yet.",
  );
}

/** Where a path's curve comes to rest: at an end, inside it running on, or inside it at a corner. */
export type Stall = "end" | "inside" | "corner";

/**
 * Where each path edge's curve comes to rest (its derivative zero: coinciding control points), and
 * how. Speed is sampled 16 times per knot span and its lows refined by golden section; a stall is
 * a low under a millionth of the edge's mean speed. Inside an edge, the chords to either side of
 * it show whether the path runs on or turns a corner there.
 */
export function stallsOf(oc: Oc, edges: readonly Shape[]): Stall[] {
  return edges.flatMap((edge): Stall[] => {
    const kind = (() => {
      const adaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
      const found = String(adaptor.GetType());
      adaptor.delete();
      return found;
    })();
    // Lines, circles and the like run at a steady speed.
    if (kind !== "GeomAbs_BSplineCurve" && kind !== "GeomAbs_BezierCurve") return [];
    const curve = edgeSpline(oc, edge);
    try {
      const spline = bsplineOf(curve);
      const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
      const { knots } = runsOf(curve);
      const us = [
        ...knots
          .slice(0, -1)
          .flatMap((a, i) =>
            Array.from({ length: 16 }, (_, k) => a + ((knots[i + 1]! - a) * k) / 16),
          ),
        last,
      ];
      const speed = (u: number) => Math.hypot(...derivatives(spline, u)[1]);
      const speeds = us.map(speed);
      const length = us
        .slice(1)
        .reduce(
          (sum, u, i) => sum + Math.hypot(...minus(pointAt(spline, u), pointAt(spline, us[i]!))),
          0,
        );
      const mean = length / (last - first);
      const stalls: Stall[] = [];
      speeds.forEach((value, j) => {
        if (value > 0.1 * mean) return;
        if (j > 0 && value > speeds[j - 1]!) return;
        if (j < us.length - 1 && value > speeds[j + 1]!) return;
        // Golden section on the speed between the neighboring samples.
        const ratio = (Math.sqrt(5) - 1) / 2;
        let [lo, hi] = [us[Math.max(0, j - 1)]!, us[Math.min(us.length - 1, j + 1)]!];
        for (let i = 0; i < 100 && hi - lo > 1e-15 * (last - first); i++) {
          const [x1, x2] = [hi - ratio * (hi - lo), lo + ratio * (hi - lo)];
          if (speed(x1) < speed(x2)) hi = x2;
          else lo = x1;
        }
        const at = (lo + hi) / 2;
        if (!(Math.min(value, speed(at)) <= 1e-6 * mean)) return;
        const near = 1e-6 * (last - first);
        if (at - first <= near || last - at <= near) {
          stalls.push("end");
          return;
        }
        const step = 1e-4 * (last - first);
        const point = pointAt(spline, at);
        const before = normalized(minus(point, pointAt(spline, at - step)));
        const after = normalized(minus(pointAt(spline, at + step), point));
        stalls.push(
          Math.acos(Math.max(-1, Math.min(1, dot(before, after)))) > 1e-2 ? "corner" : "inside",
        );
      });
      return stalls;
    } finally {
      curve.delete();
    }
  });
}

/** How a sweep carries its profile along the path, for finding where it would run into itself. */
export type Carrying =
  | { readonly kind: "turning" }
  /** Following faces' normals, which aren't known here: sections are taken as round. */
  | { readonly kind: "faces" }
  | { readonly kind: "kept" }
  | { readonly kind: "locked"; readonly direction: Vec3 }
  | { readonly kind: "twisted"; readonly angle: number };

/** A station along the path: where it is, the frame carried there, and the length walked. */
interface Placed {
  readonly path: number;
  readonly u: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  /** The rotation-minimizing frame's second axis there, before any closing turn. */
  readonly turning: Vec3;
  readonly length: number;
}

/** `r` carried from `from` to `to` by one double reflection (see carry). */
function reflected(from: Station, r: Vec3, to: Station): Vec3 {
  const chord = minus(to.point, from.point);
  if (!(dot(chord, chord) > 0)) return r;
  const mirrored = reflect(r, chord);
  const fix = minus(to.tangent, reflect(from.tangent, chord));
  return dot(fix, fix) > 0 ? reflect(mirrored, fix) : mirrored;
}

/**
 * Where sweeping the profile (its edges as `polylines`, and its plane's `normal` if it has one)
 * along the path would make the body run into itself, or null. Stations run along the path at most
 * the profile's reach apart (its reach: its farthest point from the path) and where the tangent
 * turns, each with the axes `carrying` gives the profile there, and the scale.
 * - Near: between neighboring stations every profile point must move forward through the
 *   profile's plane; one moving back means the profile reaches past a bend's center.
 * - Far: stretches of path farther apart along it than 4 reaches plus twice the profile's extent
 *   along the path, coming within two reaches of each other (by a spatial hash of segments), are
 *   checked section against section: cleared where the sections' outlines stay farther apart
 *   than the stretches' walls can move, else halved, down to 16 levels, where they meet. Under
 *   "faces" the sections' turn isn't known, so stretches within two reaches count as meeting.
 */
export function crossesItself(
  call: BuiltinCall,
  oc: Oc,
  edges: readonly Shape[],
  start: Vec3,
  heading: Vec3,
  carrying: Carrying,
  polylines: readonly (readonly Vec3[])[],
  normal: Vec3 | null,
  scale: number,
): "near" | "far" | null {
  const paths = moving(call, () => walked(call, oc, edges, start, heading, false));
  try {
    const first = station(paths[0]!.spline, paths[0]!.curve.FirstParameter()).tangent;
    const across: Vec3 = Math.abs(first[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const initial = normalized(minus(across, scaled(first, dot(across, first))));
    const lockedAxes = (t: Vec3, direction: Vec3): [Vec3, Vec3, Vec3] => {
      const up = normalized(minus(direction, scaled(t, dot(direction, t))));
      return [t, cross(up, t), up];
    };
    const startAxes: [Vec3, Vec3, Vec3] =
      carrying.kind === "locked"
        ? lockedAxes(first, carrying.direction)
        : [first, initial, cross(first, initial)];
    const local = (p: Vec3): Vec3 => {
      const d = minus(p, start);
      return [dot(d, startAxes[0]), dot(d, startAxes[1]), dot(d, startAxes[2])];
    };
    const outline = polylines.map((line) => line.map(local));
    const profile = outline.flat();
    // The plane's normal turned the way the path leaves it.
    const ahead = normal && (dot(normal, first) < 0 ? scaled(normal, -1) : normal);
    const facing: Vec3 | null = ahead && [
      dot(ahead, startAxes[0]),
      dot(ahead, startAxes[1]),
      dot(ahead, startAxes[2]),
    ];
    const grown = Math.max(1, scale);
    const reach = grown * Math.max(...profile.map((q) => Math.hypot(...q)));
    if (!(reach > 0)) return null;
    // Stations: the frame's samples, split until neighbors are at most a reach apart, with the
    // frame carried by one double reflection each (enough for this check, not for fitting it).
    const spacing = reach;
    let [frame, length] = [initial, 0];
    let previous: Station | null = null;
    const placed: Placed[] = [];
    paths.forEach((path, i) => {
      const coarse = samplesOf(path);
      coarse.forEach((u, k) => {
        const before = coarse[k - 1];
        const ends =
          before === undefined ? [] : [pointAt(path.spline, before), pointAt(path.spline, u)];
        const chord = ends.length ? Math.hypot(...minus(ends[1]!, ends[0]!)) : 0;
        const pieces =
          before === undefined ? 1 : Math.min(10000, Math.max(1, Math.ceil(chord / spacing)));
        for (let j = 1; j <= pieces; j++) {
          // A curve's first sample is the last one's end.
          if (before === undefined && i > 0) continue;
          const v = before === undefined ? u : before + ((u - before) * j) / pieces;
          const here = station(path.spline, v);
          if (previous) {
            frame = reflected(previous, frame, here);
            length += Math.hypot(...minus(here.point, previous.point));
          }
          placed.push({
            path: i,
            u: v,
            point: here.point,
            tangent: here.tangent,
            turning: frame,
            length,
          });
          previous = here;
        }
      });
    });
    const total = length;
    const end = placed.at(-1)!.point;
    const closed = Math.hypot(...minus(end, start)) < 1e-7;
    // The closing turn a closed path's frame comes back with, spread by length.
    const back = closed ? Math.atan2(dot(cross(frame, initial), first), dot(frame, initial)) : 0;
    const axesOf = (at: Placed): readonly [Vec3, Vec3, Vec3] => {
      switch (carrying.kind) {
        case "kept":
          return startAxes;
        case "locked":
          return lockedAxes(at.tangent, carrying.direction);
        case "twisted": {
          const angle = (carrying.angle * at.length) / total;
          return [
            startAxes[0],
            turned(startAxes[1], startAxes[0], angle),
            turned(startAxes[2], startAxes[0], angle),
          ];
        }
        case "turning":
        case "faces": {
          const r = turned(at.turning, at.tangent, (back * at.length) / total);
          return [at.tangent, r, cross(at.tangent, r)];
        }
      }
    };
    const place = (at: Placed, q: Vec3): Vec3 => {
      const axes = axesOf(at);
      const size = 1 + ((scale - 1) * at.length) / total;
      return plus(
        at.point,
        scaled(
          plus(plus(scaled(axes[0], q[0]), scaled(axes[1], q[1])), scaled(axes[2], q[2])),
          size,
        ),
      );
    };
    // Near: every profile point keeps moving forward through the profile's plane.
    if (facing)
      for (let k = 0; k + 1 < placed.length; k++) {
        const [here, next] = [placed[k]!, placed[k + 1]!];
        if (next.length - here.length <= 0) continue;
        const axes = axesOf(here);
        const n = plus(
          plus(scaled(axes[0], facing[0]), scaled(axes[1], facing[1])),
          scaled(axes[2], facing[2]),
        );
        if (profile.some((q) => dot(minus(place(next, q), place(here, q)), n) <= 0)) return "near";
      }
    // Far.
    const midway = (a: Placed, b: Placed): Placed => {
      if (a.path !== b.path) return a;
      const u = (a.u + b.u) / 2;
      const there = station(paths[a.path]!.spline, u);
      const from: Station = { u: a.u, point: a.point, tangent: a.tangent, speed: 0 };
      return {
        path: a.path,
        u,
        point: there.point,
        tangent: there.tangent,
        turning: reflected(from, a.turning, there),
        length: (a.length + b.length) / 2,
      };
    };
    const motion = (a: Placed, b: Placed) =>
      Math.max(...profile.map((q) => Math.hypot(...minus(place(b, q), place(a, q)))));
    const outlineGap = (a: Placed, b: Placed) => {
      const [lines, others] = [a, b].map((at) =>
        outline.map((line) => line.map((q) => place(at, q))),
      );
      let least = Infinity;
      for (const line of lines!)
        for (const other of others!)
          for (let i = 0; i + 1 < line.length; i++)
            for (let j = 0; j + 1 < other.length; j++)
              least = Math.min(least, segmentGap(line[i]!, line[i + 1]!, other[j]!, other[j + 1]!));
      return least;
    };
    // How far the path can stray from the chord between two stations: an arc's sagitta, for the
    // turn between their tangents (at most SAMPLE_TURN between samples).
    const stray = (a: Placed, b: Placed) => {
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(a.tangent, b.tangent))));
      return (Math.hypot(...minus(b.point, a.point)) * Math.tan(turn / 4)) / 2;
    };
    const clear = (a0: Placed, a1: Placed, b0: Placed, b1: Placed, depth: number): boolean => {
      const margin = 2 * reach + stray(a0, a1) + stray(b0, b1);
      if (segmentGap(a0.point, a1.point, b0.point, b1.point) > margin) return true;
      if (carrying.kind === "faces") return false;
      if (outlineGap(a0, b0) > 1.1 * (motion(a0, a1) + motion(b0, b1))) return true;
      if (depth >= 16) return false;
      const [am, bm] = [midway(a0, a1), midway(b0, b1)];
      return (
        clear(a0, am, b0, bm, depth + 1) &&
        clear(a0, am, bm, b1, depth + 1) &&
        clear(am, a1, b0, bm, depth + 1) &&
        clear(am, a1, bm, b1, depth + 1)
      );
    };
    const along = grown * Math.max(...profile.map((q) => Math.abs(q[0])));
    const apart = 4 * reach + 2 * along;
    const cell = 2.1 * reach + spacing;
    const cellOf = (p: Vec3) => p.map((x) => Math.floor(x / cell));
    const grid = new Map<string, number[]>();
    placed.forEach((at, k) => {
      if (k + 1 === placed.length) return;
      const key = cellOf(at.point).join(",");
      const bucket = grid.get(key);
      if (bucket) bucket.push(k);
      else grid.set(key, [k]);
    });
    const separated = (a: number, b: number) => {
      const gap = Math.abs(placed[b]!.length - placed[a]!.length);
      return Math.min(gap, closed ? total - gap : Infinity) > apart;
    };
    for (let k = 0; k + 1 < placed.length; k++) {
      const [x, y, z] = cellOf(placed[k]!.point);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const j of grid.get(`${x! + dx},${y! + dy},${z! + dz}`) ?? []) {
              if (j <= k || !separated(k, j)) continue;
              if (!clear(placed[k]!, placed[k + 1]!, placed[j]!, placed[j + 1]!, 0)) return "far";
            }
    }
    return null;
  } finally {
    free(...paths.map((path) => path.curve));
  }
}

/** The least distance between segments ab and cd. */
function segmentGap(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const [u, v, w] = [minus(b, a), minus(d, c), minus(a, c)];
  const [uu, uv, vv, uw, vw] = [dot(u, u), dot(u, v), dot(v, v), dot(u, w), dot(v, w)];
  const det = uu * vv - uv * uv;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  // The closest pair on the lines, clamped; then each end against the other segment.
  let s = det > 1e-30 ? clamp((uv * vw - vv * uw) / det) : 0;
  let t = vv > 0 ? clamp((uv * s + vw) / vv) : 0;
  s = uu > 0 ? clamp((uv * t - uw) / uu) : 0;
  return Math.hypot(...minus(plus(a, scaled(u, s)), plus(c, scaled(v, t))));
}
