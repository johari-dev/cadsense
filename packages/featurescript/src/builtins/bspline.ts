import { addBodies } from "../geometry/Model.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { array, map, number } from "./args.ts";
import { idOf, kernel, magnitude, resolve } from "./geometryArgs.ts";
import { length, regenError, stdTagged, stdType } from "./std.ts";
import { requireValid } from "./validity.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * B-spline curves between std's `BSplineCurve` (a flat knot vector; periodic ones padded and with
 * their first `degree` control points repeated) and OpenCascade's `Geom_BSplineCurve` (distinct
 * knots with multiplicities; periodic ones store each pole once).
 */

type Point = readonly number[];

/** std's `BSplineCurve`, lengths in meters. */
export interface Spline {
  readonly degree: number;
  readonly dimension: number;
  readonly periodic: boolean;
  readonly points: readonly Point[];
  /** Null for a non-rational spline. */
  readonly weights: readonly number[] | null;
  readonly knots: readonly number[];
}

/** Reads std's `BSplineCurve` (lengths or unitless parameter-space points) into a `Spline`. */
export function readSpline(call: BuiltinCall, value: FsValue, what: string): Spline {
  const spline = map(call, value, what);
  const field = (name: string) => spline.getField(name);
  const points = array(call, field("controlPoints"), `${what}.controlPoints`).map((p, i) =>
    array(call, p, `${what}.controlPoints[${i}]`).map((c) =>
      magnitude(call, c, `${what}.controlPoints[${i}]`),
    ),
  );
  const weights = field("weights");
  return {
    degree: number(call, field("degree"), `${what}.degree`),
    dimension: points[0]?.length ?? 0,
    periodic: untag(field("isPeriodic")) === true,
    points,
    weights:
      untag(field("isRational")) === true && weights !== undefined
        ? array(call, weights, `${what}.weights`).map((w, i) =>
            number(call, w, `${what}.weights[${i}]`),
          )
        : null,
    knots: array(call, field("knots"), `${what}.knots`).map((k, i) =>
      number(call, k, `${what}.knots[${i}]`),
    ),
  };
}

/** A `Spline` as std's tagged `BSplineCurve`, its 3D control points as lengths. */
export function stdSpline(call: BuiltinCall, spline: Spline): FsTagged {
  const vectorType = stdType(call, "vector.fs", "Vector");
  return stdTagged(call, "curveGeometry.fs", "BSplineCurve", [
    ["degree", spline.degree],
    ["dimension", spline.dimension],
    ["isRational", spline.weights !== null],
    ["isPeriodic", spline.periodic],
    [
      "controlPoints",
      spline.points.map(
        (p) =>
          new FsTagged(
            vectorType,
            p.map((c) => length(call, c)),
          ),
      ),
    ],
    ...(spline.weights ? [["weights", [...spline.weights]] as const] : []),
    ["knots", new FsTagged(stdType(call, "curveGeometry.fs", "KnotArray"), [...spline.knots])],
  ]);
}

const samePoint = (a: Point, b: Point) => Math.hypot(...a.map((c, i) => c - (b[i] ?? 0))) < 1e-10;

/** OpenCascade's 1-based array of numbers. */
export function doubles(oc: Oc, values: readonly number[]) {
  const out = new oc.NCollection_Array1_double(1, values.length);
  values.forEach((v, i) => out.SetValue(i + 1, v));
  return out;
}

/** Distinct knots and their multiplicities. */
export function runs(flat: readonly number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const k of flat) {
    if (knots.length && Math.abs(k - knots.at(-1)!) < 1e-14) mults[mults.length - 1]! += 1;
    else {
      knots.push(k);
      mults.push(1);
    }
  }
  return { knots, mults };
}

/**
 * Where `f`, a function of a spline's parameter, peaks. It's sampled across every span between the
 * distinct `knots` (knots included), more densely the higher the `degree`, so a bump confined to
 * one narrow span or squeezed beside a plateau can't fall between samples. Every local maximum of
 * the samples is then refined by golden-section search between its neighbors.
 */
export function peakOf(
  knots: readonly number[],
  degree: number,
  f: (u: number) => number,
): { u: number; value: number } {
  // One coordinate of a degree p span turns at most p - 1 times; four samples per degree keep
  // each turn bracketed.
  const perSpan = 4 * (degree + 1);
  const us = [
    ...knots
      .slice(0, -1)
      .flatMap((a, i) =>
        Array.from({ length: perSpan }, (_, k) => a + ((knots[i + 1]! - a) * k) / perSpan),
      ),
    knots.at(-1)!,
  ];
  const values = us.map(f);
  let best = { u: us[0]!, value: values[0]! };
  const ratio = (Math.sqrt(5) - 1) / 2;
  us.forEach((u, k) => {
    // Above the sample before and at least the one after: one refinement per peak, even on a
    // plateau.
    const value = values[k]!;
    if (value <= (values[k - 1] ?? -Infinity) || value < (values[k + 1] ?? -Infinity)) return;
    if (value > best.value) best = { u, value };
    let [lo, hi] = [us[k - 1] ?? u, us[k + 1] ?? u];
    let [x1, x2] = [hi - ratio * (hi - lo), lo + ratio * (hi - lo)];
    let [f1, f2] = [f(x1), f(x2)];
    for (let i = 0; i < 60 && hi - lo > 1e-15; i++) {
      if (f1 > f2) {
        [hi, x2, f2] = [x2, x1, f1];
        x1 = hi - ratio * (hi - lo);
        f1 = f(x1);
      } else {
        [lo, x1, f1] = [x1, x2, f2];
        x2 = lo + ratio * (hi - lo);
        f2 = f(x2);
      }
    }
    const middle = (lo + hi) / 2;
    const refined = f(middle);
    if (refined > best.value) best = { u: middle, value: refined };
  });
  return best;
}

/**
 * The OpenCascade curve for a 3D spline, raising std's error for a definition Onshape refuses: not
 * 3D, the wrong number of knots, negative weights, a periodic spline whose repeated control points
 * don't close it, or a curve that isn't G1.
 */
export function occtCurve(call: BuiltinCall, oc: Oc, spline: Spline) {
  const { degree, points, weights, knots } = spline;
  if (spline.dimension !== 3) return regenError(call, "REQUIRE_3D_BSPLINECURVE_DATA");
  if (degree > 25) return regenError(call, "BSPLINE_DEGREE_TOO_HIGH");
  if (points.length > 10000) return regenError(call, "BSPLINE_TOO_MANY_CONTROL_POINTS");
  if (
    !Number.isInteger(degree) ||
    degree < 1 ||
    points.length <= degree ||
    knots.length !== points.length + degree + 1 ||
    knots.some((k, i) => i > 0 && k < knots[i - 1]!) ||
    (weights && weights.length !== points.length)
  )
    return regenError(call, "BAD_BSPLINECURVE_DEFINITION");
  if (weights?.some((w) => w <= 0))
    return regenError(call, "RATIONAL_BSPLINECURVE_WEIGHT_NEGATIVE");
  // A periodic spline repeats its first `degree` control points at the end.
  const unique = spline.periodic ? points.length - degree : points.length;
  if (spline.periodic) {
    const repeats = (i: number) =>
      samePoint(points[i]!, points[unique + i]!) &&
      (!weights || Math.abs(weights[i]! - weights[unique + i]!) < 1e-12);
    if (unique <= degree || !Array.from({ length: degree }, (_, i) => i).every(repeats))
      return regenError(call, "PERIODIC_BSPLINECURVE_NOT_CLOSED");
  }
  const { knots: distinct, mults } = runs(
    spline.periodic ? knots.slice(degree, degree + unique + 1) : knots,
  );
  // One period's knots start with the seam knot at its full multiplicity but end where the next
  // period starts, so the seam's repeats there fall outside the slice: both ends of a periodic
  // curve carry the seam's multiplicity.
  if (spline.periodic) mults[mults.length - 1] = mults[0]!;
  const poles = new oc.NCollection_Array1_gp_Pnt(1, unique);
  points
    .slice(0, unique)
    .forEach(([x, y, z], i) => poles.SetValue(i + 1, new oc.gp_Pnt(x!, y!, z!)));
  const knotArray = doubles(oc, distinct);
  const multArray = new oc.NCollection_Array1_int(1, mults.length);
  mults.forEach((mult, i) => multArray.SetValue(i + 1, mult));
  let curve: InstanceType<Oc["Geom_BSplineCurve"]>;
  try {
    curve = weights
      ? new oc.Geom_BSplineCurve(
          poles,
          doubles(oc, weights.slice(0, unique)),
          knotArray,
          multArray,
          degree,
          spline.periodic,
          true,
        )
      : new oc.Geom_BSplineCurve(poles, knotArray, multArray, degree, spline.periodic);
  } catch {
    return regenError(
      call,
      spline.periodic ? "PERIODIC_BSPLINECURVE_NOT_SMOOTH" : "BAD_BSPLINECURVE_DEFINITION",
    );
  }
  if (!curve.IsG1(curve.FirstParameter(), curve.LastParameter(), 1e-6))
    return regenError(call, "BSPLINECURVE_NOT_G1");
  return curve;
}

/** An OpenCascade B-spline as a `Spline`, periodic ones padded the way std's `bSplineCurve` pads them. */
export function splineOf(curve: InstanceType<Oc["Geom_BSplineCurve"]>): Spline {
  const degree = curve.Degree();
  const poles = Array.from({ length: curve.NbPoles() }, (_, i) => {
    const p = curve.Pole(i + 1);
    const point = [p.X(), p.Y(), p.Z()];
    p.delete();
    return point;
  });
  const weights = curve.IsRational()
    ? Array.from({ length: curve.NbPoles() }, (_, i) => curve.Weight(i + 1))
    : null;
  const flat = Array.from({ length: curve.NbKnots() }, (_, i) =>
    Array<number>(curve.Multiplicity(i + 1)).fill(curve.Knot(i + 1)),
  ).flat();
  if (!curve.IsPeriodic())
    return { degree, dimension: 3, periodic: false, points: poles, weights, knots: flat };
  // One period's knots are every knot but the last seam's copies (n of them for n poles); std's
  // vector repeats them periodically so that its knot `degree` is the period's first.
  const period = curve.LastParameter() - curve.FirstParameter();
  const base = flat.slice(0, flat.length - curve.Multiplicity(curve.NbKnots()));
  const n = base.length;
  const knots = Array.from({ length: n + 2 * degree + 1 }, (_, j) => {
    const turns = Math.floor((j - degree) / n);
    return base[j - degree - turns * n]! + turns * period;
  });
  return {
    degree,
    dimension: 3,
    periodic: true,
    points: [...poles, ...poles.slice(0, degree)],
    weights: weights && [...weights, ...weights.slice(0, degree)],
    knots,
  };
}

/** Binomial coefficient. */
const choose = (n: number, k: number) => {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
};

/**
 * Position and the first `n` derivatives of a spline at `u` (Piegl and Tiller A2.3, A4.2), in
 * the spline's own coordinates. Works on std's flat representation, so periodic splines need no
 * unwrapping. Null when `u` is outside the knot range.
 */
export function evaluate(spline: Spline, u: number, n: number): number[][] | null {
  const { degree: p, knots, points } = spline;
  const weights = spline.weights ?? points.map(() => 1);
  const last = points.length - 1;
  const [low, high] = [knots[p]!, knots[last + 1]!];
  if (u < low - 1e-12 || u > high + 1e-12) return null;
  const t = Math.min(Math.max(u, low), high);
  let span = p;
  while (span < last && t >= knots[span + 1]!) span++;
  // Basis functions and their derivatives over the span.
  const ndu = Array.from({ length: p + 1 }, () => Array<number>(p + 1).fill(0));
  const left = Array<number>(p + 1).fill(0);
  const right = Array<number>(p + 1).fill(0);
  ndu[0]![0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[span + 1 - j]!;
    right[j] = knots[span + j]! - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j]![r] = right[r + 1]! + left[j - r]!;
      const temp = ndu[r]![j - 1]! / ndu[j]![r]!;
      ndu[r]![j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j]![j] = saved;
  }
  const orders = Math.min(n, p);
  const ders = Array.from({ length: n + 1 }, () => Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0]![j] = ndu[j]![p]!;
  for (let r = 0; r <= p; r++) {
    let [s1, s2] = [0, 1];
    const a = [Array<number>(p + 1).fill(0), Array<number>(p + 1).fill(0)];
    a[0]![0] = 1;
    for (let k = 1; k <= orders; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2]![0] = a[s1]![0]! / ndu[pk + 1]![rk]!;
        d = a[s2]![0]! * ndu[rk]![pk]!;
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2]![j] = (a[s1]![j]! - a[s1]![j - 1]!) / ndu[pk + 1]![rk + j]!;
        d += a[s2]![j]! * ndu[rk + j]![pk]!;
      }
      if (r <= pk) {
        a[s2]![k] = -a[s1]![k - 1]! / ndu[pk + 1]![r]!;
        d += a[s2]![k]! * ndu[r]![pk]!;
      }
      ders[k]![r] = d;
      [s1, s2] = [s2, s1];
    }
  }
  let scale = p;
  for (let k = 1; k <= orders; k++) {
    for (let j = 0; j <= p; j++) ders[k]![j]! *= scale;
    scale *= p - k;
  }
  // Derivatives of the weighted (homogeneous) curve, then the quotient rule.
  const dimension = points[0]!.length;
  const weighted = ders.map((row) => {
    const out = Array<number>(dimension + 1).fill(0);
    row.forEach((basis, j) => {
      const index = span - p + j;
      const w = weights[index]!;
      for (let c = 0; c < dimension; c++) out[c]! += basis * w * points[index]![c]!;
      out[dimension]! += basis * w;
    });
    return out;
  });
  const result: number[][] = [];
  for (let k = 0; k <= n; k++) {
    const v = weighted[k]!.slice(0, dimension);
    for (let i = 1; i <= k; i++)
      for (let c = 0; c < dimension; c++)
        v[c]! -= choose(k, i) * weighted[i]![dimension]! * result[k - i]![c]!;
    result.push(v.map((c) => c / weighted[0]![dimension]!));
  }
  return result;
}

/**
 * The B-spline an edge's curve is (or converts to exactly), trimmed to the edge and in its
 * direction. A spline edge keeps its own representation, periodic ones included. Always a copy,
 * so callers may change it without changing the model.
 */
export function edgeSpline(oc: Oc, edge: Shape): InstanceType<Oc["Geom_BSplineCurve"]> {
  const topoEdge = oc.TopoDS.Edge(edge);
  const adaptor = new oc.BRepAdaptor_Curve(topoEdge);
  const [first, last] = [adaptor.FirstParameter(), adaptor.LastParameter()];
  let curve: InstanceType<Oc["Geom_BSplineCurve"]>;
  if (String(adaptor.GetType()) === "GeomAbs_BSplineCurve") {
    // BSpline() hands back the edge's own curve: copy it before segmenting or reversing.
    const own = adaptor.BSpline();
    curve = new oc.Geom_BSplineCurve(own);
    own.delete();
    const whole =
      Math.abs(first - curve.FirstParameter()) < 1e-12 &&
      Math.abs(last - curve.LastParameter()) < 1e-12;
    if (!whole) curve.Segment(first, last);
  } else {
    const found = oc.BRep_Tool.Curve(topoEdge, 0, 0);
    const trimmed = new oc.Geom_TrimmedCurve(
      found.returnValue,
      found.First,
      found.Last,
      true,
      true,
    );
    curve = oc.GeomConvert.CurveToBSplineCurve(trimmed);
    trimmed.delete();
    found.returnValue.delete();
  }
  adaptor.delete();
  topoEdge.delete();
  if (String(edge.Orientation()) === "TopAbs_REVERSED") curve.Reverse();
  return curve;
}

/**
 * A cubic non-rational spline within `tolerance` of `curve`, by least squares on samples that
 * double until the fit holds between them too.
 */
function cubicApproximation(
  oc: Oc,
  curve: InstanceType<Oc["Geom_BSplineCurve"]>,
  tolerance: number,
) {
  const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
  for (let samples = 32; samples <= 4096; samples *= 2) {
    const points = new oc.NCollection_Array1_gp_Pnt(1, samples + 1);
    const params = new oc.NCollection_Array1_double(1, samples + 1);
    for (let i = 0; i <= samples; i++) {
      const u = first + ((last - first) * i) / samples;
      points.SetValue(i + 1, curve.Value(u));
      params.SetValue(i + 1, u);
    }
    const fit = new oc.GeomAPI_PointsToBSpline(
      points,
      params,
      3,
      3,
      oc.GeomAbs_Shape.GeomAbs_C2,
      tolerance / 2,
    );
    if (!fit.IsDone()) continue;
    const result = fit.Curve();
    let worst = 0;
    for (let i = 0; i < samples * 4; i++) {
      const u = first + ((last - first) * (i + 0.5)) / (samples * 4);
      worst = Math.max(worst, result.Value(u).Distance(curve.Value(u)));
    }
    if (worst <= tolerance) return result;
  }
  return null;
}

/** Solves the symmetric positive definite system `a x = b` (Cholesky), for each column of `b`. */
function solve(a: number[][], b: number[][]): number[][] | null {
  const n = a.length;
  const l = a.map((row) => row.map(() => 0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (sum <= 0) return null;
        l[i]![i] = Math.sqrt(sum);
      } else l[i]![j] = sum / l[j]![j]!;
    }
  return b.map((column) => {
    const y = Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = column[i]!;
      for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
      y[i] = sum / l[i]![i]!;
    }
    const x = Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = y[i]!;
      for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
      x[i] = sum / l[i]![i]!;
    }
    return x;
  });
}

/**
 * Clamped splines of `degree` with `count` control points sharing one knot vector, fitted to every
 * target by least squares with the end points held (Piegl and Tiller 9.4.1, knots by eq. 9.69).
 */
function leastSquares(
  targets: readonly (readonly Point[])[],
  parameters: readonly number[],
  degree: number,
  count: number,
): Spline[] | null {
  const m = parameters.length - 1;
  const n = count - 1;
  const knots = Array<number>(degree + 1).fill(parameters[0]!);
  const d = (m + 1) / (n - degree + 1);
  for (let j = 1; j <= n - degree; j++) {
    const i = Math.floor(j * d);
    const alpha = j * d - i;
    knots.push((1 - alpha) * parameters[i - 1]! + alpha * parameters[i]!);
  }
  knots.push(...Array<number>(degree + 1).fill(parameters[m]!));
  const fitted = (points: readonly Point[]): Spline => ({
    degree,
    dimension: points[0]!.length,
    periodic: false,
    points,
    weights: null,
    knots,
  });
  if (n < 2) return targets.map((points) => fitted([points[0]!, points[m]!]));
  // Each parameter's basis values: a spline whose control points are the unit vectors.
  const identity = Array.from({ length: count }, (_, i) =>
    Array.from({ length: count }, (_, j) => (i === j ? 1 : 0)),
  );
  const rows = parameters.map((u) => evaluate(fitted(identity), u, 0)![0]!);
  const inner = n - 1;
  const normal = Array.from({ length: inner }, (_, i) =>
    Array.from({ length: inner }, (_, j) => {
      let sum = 0;
      for (let k = 1; k < m; k++) sum += rows[k]![i + 1]! * rows[k]![j + 1]!;
      return sum;
    }),
  );
  const splines: Spline[] = [];
  for (const points of targets) {
    const rhs = points[0]!.map((_, axis) =>
      Array.from({ length: inner }, (_, i) => {
        let sum = 0;
        for (let k = 1; k < m; k++)
          sum +=
            rows[k]![i + 1]! *
            (points[k]![axis]! -
              rows[k]![0]! * points[0]![axis]! -
              rows[k]![n]! * points[m]![axis]!);
        return sum;
      }),
    );
    const solved = solve(normal, rhs);
    if (!solved) return null;
    const middle = Array.from({ length: inner }, (_, i) => solved.map((column) => column[i]!));
    splines.push(fitted([points[0]!, ...middle, points[m]!]));
  }
  return splines;
}

/**
 * What `evCurveDefinition` returns for a B-spline or Bezier edge: std's `BSplineCurve`, the same
 * one `evApproximateBSplineCurve` gives. For evaluators.ts, which owns `evCurveDefinition`.
 */
export const edgeCurveDefinition = (call: BuiltinCall, oc: Oc, edge: Shape): FsTagged =>
  stdSpline(call, splineOf(edgeSpline(oc, edge)));

export const BSPLINE_BUILTINS = {
  /** A wire body along a 3D `BSplineCurve`. */
  opCreateBSplineCurve: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const curve = occtCurve(
      call,
      oc,
      readSpline(call, definition.getField("bSplineCurve"), "bSplineCurve"),
    );
    const wire = requireValid(
      call,
      oc,
      new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(curve).Edge()).Wire(),
      "BAD_BSPLINECURVE_DEFINITION",
    );
    model.geometry = addBodies(oc, model.geometry, [
      { shape: wire, bodyType: "WIRE", createdBy: idOf(id) },
    ]).state;
    return undefined;
  },

  /**
   * Positions and derivatives of a spline at parameters, as plain coordinates in meters (std's
   * wrapper adds the units): `result[k][j]` is derivative `k` at parameter `j`.
   */
  evaluateSpline: ([value], call) => {
    const definition = map(call, value, "definition");
    const spline = readSpline(call, definition.getField("spline"), "spline");
    const order =
      definition.getField("nDerivatives") === undefined
        ? 0
        : number(call, definition.getField("nDerivatives"), "nDerivatives");
    if (!Number.isInteger(order) || order < 0 || order > 10)
      return call.fail("nDerivatives must be an integer from 0 to 10.");
    const values = array(call, definition.getField("parameters"), "parameters").map((u, i) => {
      const found = evaluate(spline, number(call, u, `parameters[${i}]`), order);
      return found ?? call.fail(`parameters[${i}] is outside the spline's knot range.`);
    });
    return Array.from({ length: order + 1 }, (_, k) =>
      values.map((derivatives) => derivatives[k]!),
    );
  },

  /**
   * An edge as a B-spline: exactly (lines, conics, splines) unless `forceCubic` or
   * `forceNonRational` asks for a shape it isn't, then a cubic within `tolerance`.
   */
  evApproximateBSplineCurve: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const edge = resolve(call, model, oc, definition.getField("edge")).find(
      (e) => e.type === "EDGE",
    );
    if (!edge) return regenError(call, "CANNOT_RESOLVE_ENTITIES");
    let curve = edgeSpline(oc, edge.shape);
    const forceCubic = untag(definition.getField("forceCubic")) === true;
    const forceNonRational = untag(definition.getField("forceNonRational")) === true;
    const tolerance =
      definition.getField("tolerance") === undefined
        ? 1e-6
        : number(call, definition.getField("tolerance"), "tolerance");
    if (forceCubic && !curve.IsRational() && curve.Degree() < 3) curve.IncreaseDegree(3);
    if ((forceCubic && curve.Degree() !== 3) || (forceNonRational && curve.IsRational())) {
      const cubic = cubicApproximation(oc, curve, tolerance);
      if (!cubic) return regenError(call, "CANNOT_RESOLVE_ENTITIES");
      curve = cubic;
    }
    return stdSpline(call, splineOf(curve));
  },

  /**
   * Splines that pass within `tolerance` of each target's positions, all sharing one knot vector:
   * least squares with the ends held, adding control points until every target fits.
   */
  approximateSpline: ([ctx, value], call) => {
    kernel(call, ctx);
    const definition = map(call, value, "definition");
    const field = (name: string) => definition.getField(name);
    if (untag(field("isPeriodic")) === true)
      return call.unsupported(
        "approximateSpline for periodic splines is not supported locally yet.",
      );
    const interpolate = field("interpolateIndices");
    if (interpolate !== undefined && array(call, interpolate, "interpolateIndices").length > 0)
      return call.unsupported(
        "approximateSpline with interpolateIndices is not supported locally yet.",
      );
    const targets = array(call, field("targets"), "targets").map((target, t) => {
      const fields = map(call, target, `targets[${t}]`);
      for (const derivative of [
        "startDerivative",
        "endDerivative",
        "start2ndDerivative",
        "end2ndDerivative",
      ])
        if (fields.getField(derivative) !== undefined)
          return call.unsupported(
            `approximateSpline with a ${derivative} is not supported locally yet.`,
          );
      return array(call, fields.getField("positions"), `targets[${t}].positions`).map((p, i) =>
        array(call, p, `targets[${t}].positions[${i}]`).map((c) => magnitude(call, c, "position")),
      );
    });
    const size = targets[0]?.length ?? 0;
    if (size < 2 || targets.some((points) => points.length !== size))
      return call.fail(
        "approximateSpline needs targets with the same number (at least two) of positions.",
      );
    const tolerance = magnitude(call, field("tolerance"), "tolerance");
    const requested = number(call, field("degree"), "degree");
    const maxControlPoints =
      field("maxControlPoints") === undefined
        ? 10000
        : number(call, field("maxControlPoints"), "maxControlPoints");
    // Chord-length parameters averaged over the targets, unless given.
    const parameters =
      field("parameters") === undefined
        ? (() => {
            const totals = targets.map((points) =>
              points.map((p, i) =>
                i === 0 ? 0 : Math.hypot(...p.map((c, k) => c - points[i - 1]![k]!)),
              ),
            );
            let walked = 0;
            const average = Array.from(
              { length: size },
              (_, i) =>
                totals.reduce(
                  (sum, chords) => sum + chords[i]! / chords.reduce((a, b) => a + b, 0),
                  0,
                ) / targets.length,
            );
            return average.map((chord) => (walked += chord));
          })()
        : array(call, field("parameters"), "parameters").map((u, i) =>
            number(call, u, `parameters[${i}]`),
          );
    if (parameters.length !== size || parameters.some((u, i) => i > 0 && u <= parameters[i - 1]!))
      return call.fail("parameters must be strictly increasing, one per position.");
    const degree = Math.max(1, Math.min(requested, size - 1));
    const worstMiss = (splines: readonly Spline[]) =>
      Math.max(
        ...splines.flatMap((spline, t) =>
          parameters.map((u, i) => {
            const at = evaluate(spline, u, 0)![0]!;
            return Math.hypot(...at.map((c, k) => c - targets[t]![i]![k]!));
          }),
        ),
      );
    let fitted: Spline[] | null = null;
    for (let count = degree + 1; count <= Math.min(size, maxControlPoints); count++) {
      fitted = leastSquares(targets, parameters, degree, count);
      if (fitted && worstMiss(fitted) <= tolerance) break;
    }
    if (!fitted) return call.fail("approximateSpline couldn't fit the targets.");
    return fitted.map((spline) => stdSpline(call, spline));
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
