import { addBodies, replaceBodies, type Entity, type History } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { subShapes, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { array, map, number } from "./args.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { edgeSpline, occtCurve, peakOf, splineOf, type Spline } from "./bspline.ts";
import { length, lengthVector, regenError } from "./std.ts";
import { requireValid } from "./validity.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Curves built from formulas and fitted data: helices and B-spline curves. */

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** `sum` of `terms`, each a vector times a scale. */
const combine = (...terms: readonly (readonly [Vec3, number])[]): Vec3 =>
  terms.reduce<Vec3>(
    (sum, [v, k]) => [sum[0] + v[0] * k, sum[1] + v[1] * k, sum[2] + v[2] * k],
    [0, 0, 0],
  );

/** How far (in meters) an interpolated helix may stray from the true one. */
const HELIX_TOLERANCE = 1e-7;
/** The most points a helix is interpolated through; a longer or larger one stops the run. */
const MAX_HELIX_SAMPLES = 50000;

/**
 * A cubic B-spline through `point(t)` at `parameters`, matching `derivative(t)` at each, so its
 * parameter is the formula's. Between two points h apart it strays at most h^4 / 384 times the
 * largest fourth derivative (cubic Hermite interpolation).
 */
export function interpolatedCurve(
  oc: Oc,
  parameters: readonly number[],
  point: (t: number) => Vec3,
  derivative: (t: number) => Vec3,
) {
  const points = new oc.NCollection_Array1_gp_Pnt(1, parameters.length);
  const params = new oc.NCollection_Array1_double(1, parameters.length);
  const tangents = new oc.NCollection_Array1_gp_Vec(1, parameters.length);
  const flags = new oc.NCollection_Array1_bool(1, parameters.length);
  parameters.forEach((t, i) => {
    points.SetValue(i + 1, new oc.gp_Pnt(...point(t)));
    params.SetValue(i + 1, t);
    tangents.SetValue(i + 1, new oc.gp_Vec(...derivative(t)));
    flags.SetValue(i + 1, true);
  });
  const interpolate = new oc.GeomAPI_Interpolate(
    new oc.NCollection_HArray1_gp_Pnt(points),
    new oc.NCollection_HArray1_double(params),
    false,
    1e-12,
  );
  interpolate.Load(tangents, new oc.NCollection_HArray1_bool(flags), false);
  interpolate.Perform();
  return interpolate.IsDone() ? interpolate.Curve() : null;
}

/** A wire of one edge along all of `curve`. */
export function wireOf(oc: Oc, curve: InstanceType<Oc["Geom_Curve"]>): Shape {
  return new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(curve).Edge()).Wire();
}

/** The edges a path query names: edges directly, and every edge of wire or other bodies. */
function pathEdges(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const bodies = new Set(entities.filter((e) => e.type === "BODY").map((e) => e.id));
  return [...model.geometry.entities.values()].filter(
    (e) => e.type === "EDGE" && (entities.includes(e) || bodies.has(e.body)),
  );
}

/** A compound of shapes, to measure distance to all of them at once. */
function compoundOf(oc: Oc, shapes: readonly Shape[]): Shape {
  const compound = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(compound);
  for (const shape of shapes) builder.Add(compound, shape);
  return compound;
}

/** The point of `target` nearest `point`, and how far it is. */
function nearest(oc: Oc, point: Vec3, target: Shape): { distance: number; at: Vec3 } {
  const extrema = new oc.BRepExtrema_DistShapeShape();
  extrema.LoadS1(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex());
  extrema.LoadS2(target);
  extrema.Perform(new oc.Message_ProgressRange());
  return { distance: extrema.Value(), at: xyz(extrema.PointOnShape2(1)) };
}

/** The point of `from`'s edges farthest from `to`, found on each edge's exact B-spline. */
function farthest(oc: Oc, from: readonly Shape[], to: Shape) {
  let best = { distance: -1, point: [0, 0, 0] as Vec3, at: [0, 0, 0] as Vec3 };
  for (const edge of from) {
    const curve = edgeSpline(oc, edge);
    const at = (u: number) => xyz(curve.Value(u));
    const knots = Array.from({ length: curve.NbKnots() }, (_, i) => curve.Knot(i + 1));
    const { u } = peakOf(knots, curve.Degree(), (v) => nearest(oc, at(v), to).distance);
    const found = nearest(oc, at(u), to);
    if (found.distance > best.distance)
      best = { distance: found.distance, point: at(u), at: found.at };
  }
  return best;
}

/** The arc that rounds the corner at `corner` between legs toward `before` and `after`. */
function bend(corner: Vec3, before: Vec3, after: Vec3, radius: number) {
  const toward = (p: Vec3) => normalized(combine([p, 1], [corner, -1]));
  const [a, b] = [toward(before), toward(after)];
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (angle < 1e-9) return null;
  const tangent = radius / Math.tan(angle / 2);
  const bisector = normalized(combine([a, 1], [b, 1]));
  const center = combine([corner, 1], [bisector, radius / Math.sin(angle / 2)]);
  return {
    tangent,
    start: combine([corner, 1], [a, tangent]),
    middle: combine([center, 1], [bisector, -radius]),
    end: combine([corner, 1], [b, tangent]),
  };
}

/** An edge's two end points, in its own direction. */
export function endsOf(oc: Oc, edge: Shape): [Vec3, Vec3] {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [a, b] = [
    xyz(curve.Value(curve.FirstParameter())),
    xyz(curve.Value(curve.LastParameter())),
  ];
  return String(edge.Orientation()) === "TopAbs_REVERSED" ? [b, a] : [a, b];
}
export const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;

/**
 * Edges grouped into chains that meet end to end, each listed in order along the chain and with
 * whether each runs backward. Null when three or more edges meet at one point.
 */
export function chainsOf(
  oc: Oc,
  edges: readonly Shape[],
): { edge: Shape; backward: boolean }[][] | null {
  const ends = edges.map((edge) => endsOf(oc, edge));
  const touching = (point: Vec3, except: number) =>
    edges.flatMap((_, j) => (j !== except && ends[j]!.some((end) => near(end, point)) ? [j] : []));
  if (
    ends.some(
      ([a, b], i) => !near(a, b) && (touching(a, i).length > 1 || touching(b, i).length > 1),
    )
  )
    return null;
  const used = new Set<number>();
  const chains: { edge: Shape; backward: boolean }[][] = [];
  // Open chains start at an end nothing else touches; whatever's left is closed loops.
  const starts = [
    ...edges.flatMap((_, i) =>
      ends[i]!.some((end) => !near(ends[i]![0], ends[i]![1]) && touching(end, i).length === 0)
        ? [i]
        : [],
    ),
    ...edges.map((_, i) => i),
  ];
  for (const start of starts) {
    if (used.has(start)) continue;
    used.add(start);
    const backward =
      touching(ends[start]![0], start).length > 0 && touching(ends[start]![1], start).length === 0;
    const chain = [{ edge: edges[start]!, backward }];
    let tip = ends[start]![backward ? 0 : 1];
    for (;;) {
      const next = touching(tip, -1).find((j) => !used.has(j));
      if (next === undefined) break;
      used.add(next);
      const flip = !near(ends[next]![0], tip);
      chain.push({ edge: edges[next]!, backward: flip });
      tip = ends[next]![flip ? 0 : 1];
    }
    chains.push(chain);
  }
  return chains;
}

/** A standalone copy of a chain of edges as one wire, so it shares no topology with its source. */
function wireCopy(oc: Oc, chain: readonly { edge: Shape }[]): Shape {
  const wire = new oc.BRepBuilderAPI_MakeWire();
  for (const { edge } of chain) wire.Add(oc.TopoDS.Edge(edge));
  return new oc.BRepBuilderAPI_Transform(wire.Wire(), new oc.gp_Trsf(), true, false).Shape();
}

/**
 * Every chain of `edges` as a wire body created by `id`; a branching set makes one wire per edge.
 * A wire OpenCascade's checker rejects raises `error`.
 */
function addWires(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  id: FsValue,
  edges: readonly Shape[],
  error: string,
) {
  const chains = chainsOf(oc, edges) ?? edges.map((edge) => [{ edge, backward: false }]);
  model.geometry = addBodies(
    oc,
    model.geometry,
    chains.map((chain) => ({
      shape: requireValid(call, oc, wireCopy(oc, chain), error),
      bodyType: "WIRE" as const,
      createdBy: idOf(id),
    })),
  ).state;
}

/** The faces a query names, with every face of the bodies it names. */
function facesNamed(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const bodies = new Set(entities.filter((e) => e.type === "BODY").map((e) => e.id));
  return [...model.geometry.entities.values()].filter(
    (e) => e.type === "FACE" && (entities.includes(e) || bodies.has(e.body)),
  );
}

/** Edges where two sets of shapes cross, as smooth curves. */
function sectionEdges(oc: Oc, first: readonly Shape[], second: readonly Shape[]): Shape[] | null {
  const section = new oc.BRepAlgoAPI_Section(compoundOf(oc, first), compoundOf(oc, second), false);
  section.Approximation(true);
  section.Build(new oc.Message_ProgressRange());
  if (section.HasErrors()) return null;
  return subShapes(oc, section.Shape(), "EDGE");
}
/**
 * A helix with a helical pitch, exactly as the line u = 2 PI t, v = rate t across a cylinder (or a
 * cone when it also spirals), its 3D curve fitted by OpenCascade to 1e-8 m (BuildCurve3d at up to
 * degree 14) and checked against `point` to 1e-7 m. The parameter is the revolution count. Its
 * few long spans suit evaluation; sweeps add knots (see opSweep).
 */
export function helixCurve(
  call: BuiltinCall,
  oc: Oc,
  helix: {
    /** The true helix, which the fitted curve is checked against. */
    readonly point: (t: number) => Vec3;
    readonly axisStart: Vec3;
    readonly direction: Vec3;
    readonly x: Vec3;
    readonly height: number;
    readonly startRadius: number;
    readonly first: number;
    readonly last: number;
    readonly turn: number;
    readonly helicalPitch: number;
    readonly spiralPitch: number;
  },
) {
  const { axisStart, direction, x, height, startRadius, first, last, helicalPitch, spiralPitch } =
    helix;
  // A cone opens along its axis, so a descending conical helix uses the reversed axis, which
  // mirrors its turning.
  const flip = spiralPitch !== 0 && helicalPitch < 0;
  const axis: Vec3 = flip ? [-direction[0], -direction[1], -direction[2]] : direction;
  const turn = flip ? -helix.turn : helix.turn;
  const frame = new oc.gp_Ax3(
    new oc.gp_Pnt(...combine([axisStart, 1], [direction, height])),
    new oc.gp_Dir(...axis),
    new oc.gp_Dir(...x),
  );
  const surface =
    spiralPitch === 0
      ? new oc.Geom_CylindricalSurface(frame, startRadius)
      : new oc.Geom_ConicalSurface(
          frame,
          Math.atan2(spiralPitch, Math.abs(helicalPitch)),
          startRadius,
        );
  // Distance along the cylinder's axis, or along the cone's slant, per revolution.
  const rate = spiralPitch === 0 ? helicalPitch : Math.hypot(spiralPitch, helicalPitch);
  const ends = new oc.NCollection_Array1_gp_Pnt2d(1, 2);
  ends.SetValue(1, new oc.gp_Pnt2d(turn * first, rate * first));
  ends.SetValue(2, new oc.gp_Pnt2d(turn * last, rate * last));
  const knots = new oc.NCollection_Array1_double(1, 2);
  knots.SetValue(1, first);
  knots.SetValue(2, last);
  const mults = new oc.NCollection_Array1_int(1, 2);
  mults.SetValue(1, 2);
  mults.SetValue(2, 2);
  const line = new oc.Geom2d_BSplineCurve(ends, knots, mults, 1, false);
  const onSurface = new oc.BRepBuilderAPI_MakeEdge(line, surface, first, last).Edge();
  const segments = Math.ceil(4 * (last - first)) + 30;
  const unfit = () =>
    call.unsupported(
      `opHelix: ${last - first} turns couldn't be fitted within 1e-7 m of the true helix locally.`,
    );
  if (!oc.BRepLib.BuildCurve3d(onSurface, 1e-8, oc.GeomAbs_Shape.GeomAbs_C2, 14, segments))
    return unfit();
  const curve = oc.GeomConvert.CurveToBSplineCurve(oc.BRep_Tool.Curve(onSurface, 0, 0).returnValue);
  // The fit reports success even when a low segment budget leaves it far off, so check it.
  const samples = Math.min(200000, Math.max(64, Math.ceil(16 * (last - first))));
  for (let i = 0; i < samples; i++) {
    const t = first + ((last - first) * (i + 0.5)) / samples;
    const [a, b] = [xyz(curve.Value(t)), helix.point(t)];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > HELIX_TOLERANCE) return unfit();
  }
  return curve;
}

/**
 * A flat (Archimedean) spiral, which lies on no surface as a line: interpolated with exact tangents
 * at enough points per turn to stay within HELIX_TOLERANCE, and refused past MAX_HELIX_SAMPLES.
 */
function flatSpiral(
  call: BuiltinCall,
  oc: Oc,
  spiral: {
    readonly first: number;
    readonly last: number;
    readonly radius: (t: number) => number;
    readonly spiralPitch: number;
    readonly point: (t: number) => Vec3;
    readonly derivative: (t: number) => Vec3;
  },
) {
  const { first, last, radius, spiralPitch } = spiral;
  // Each coordinate's fourth derivative per revolution is at most (2 PI)^3 (2 PI r + 4 |s|).
  const largest = Math.max(radius(first), radius(last));
  const fourth = (2 * Math.PI) ** 3 * (2 * Math.PI * largest + 4 * Math.abs(spiralPitch));
  const perTurn = Math.max(128, Math.ceil((fourth / (384 * (HELIX_TOLERANCE / 2))) ** 0.25));
  const count = Math.ceil(perTurn * (last - first));
  if (count > MAX_HELIX_SAMPLES)
    return call.unsupported(
      `opHelix: a flat spiral of ${last - first} turns up to radius ${largest} m needs ${count} interpolation points to stay within 1e-7 m; over ${MAX_HELIX_SAMPLES} isn't supported locally yet.`,
    );
  const parameters = Array.from(
    { length: count + 1 },
    (_, i) => first + ((last - first) * i) / count,
  );
  return interpolatedCurve(oc, parameters, spiral.point, spiral.derivative);
}

/**
 * B-spline pieces that meet end to end, joined exactly into one: raised to a common degree, each
 * next piece's weights scaled to match at the joint, joints as knots of multiplicity `degree`
 * (position-continuous; the caller checks tangency).
 */
function joined(
  call: BuiltinCall,
  pieces: readonly InstanceType<Oc["Geom_BSplineCurve"]>[],
): Spline {
  const degree = Math.max(...pieces.map((piece) => piece.Degree()));
  const splines = pieces.map((piece) => {
    if (piece.IsPeriodic()) piece.SetNotPeriodic();
    if (piece.Degree() < degree) piece.IncreaseDegree(degree);
    return splineOf(piece);
  });
  const clamped = (spline: Spline) =>
    spline.knots.slice(0, degree + 1).every((k) => k === spline.knots[0]) &&
    spline.knots.slice(-degree - 1).every((k) => k === spline.knots.at(-1));
  if (!splines.every(clamped))
    return call.unsupported("Joining unclamped spline edges is not supported locally yet.");
  const rational = splines.some((spline) => spline.weights !== null);
  const weightsOf = (spline: Spline) => spline.weights ?? spline.points.map(() => 1);
  const [head, ...rest] = splines;
  const knots = head!.knots.slice(0, -(degree + 1));
  const points = [...head!.points];
  const weights = [...weightsOf(head!)];
  let end = head!.knots.at(-1)!;
  for (const spline of rest) {
    const shift = end - spline.knots[0]!;
    const scale = weights.at(-1)! / weightsOf(spline)[0]!;
    knots.push(...Array<number>(degree).fill(end));
    knots.push(...spline.knots.slice(degree + 1, -(degree + 1)).map((k) => k + shift));
    points.push(...spline.points.slice(1));
    weights.push(
      ...weightsOf(spline)
        .slice(1)
        .map((w) => w * scale),
    );
    end = spline.knots.at(-1)! + shift;
  }
  knots.push(...Array<number>(degree + 1).fill(end));
  return {
    degree,
    dimension: 3,
    periodic: false,
    points,
    weights: rational ? weights : null,
    knots,
  };
}

export const CURVE_BUILTINS = {
  /**
   * A helix (or spiral) as a wire: revolution `t` sits `t` helical pitches along the axis and `t`
   * spiral pitches out from the start point's radius, turned `t` revolutions about `direction`
   * (clockwise seen looking along it when `clockwise`), trimmed to `interval`, within 1e-7 m.
   */
  opHelix: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const field = (name: string) => definition.getField(name);
    const direction = normalized(vector(call, field("direction"), 3, "direction"));
    const axisStart = vector(call, field("axisStart"), 3, "axisStart");
    const startPoint = vector(call, field("startPoint"), 3, "startPoint");
    const interval = array(call, field("interval"), "interval").map((t, i) =>
      number(call, t, `interval[${i}]`),
    );
    if (interval.length !== 2) return call.fail("interval must hold two revolution counts.");
    const [first, last] = interval as [number, number];
    const turn = (untag(field("clockwise")) === true ? 1 : -1) * 2 * Math.PI;
    const helicalPitch = magnitude(call, field("helicalPitch"), "helicalPitch");
    const spiralPitch = magnitude(call, field("spiralPitch"), "spiralPitch");

    const offset = combine([startPoint, 1], [axisStart, -1]);
    const height = dot(offset, direction);
    const radial = combine([offset, 1], [direction, -height]);
    const startRadius = Math.hypot(...radial);
    const radius = (t: number) => startRadius + spiralPitch * t;
    // The start point must be off the axis, a spiral must not reach it, and with neither pitch
    // the curve would retrace one circle.
    if (
      startRadius < 1e-9 ||
      radius(first) <= 1e-9 ||
      radius(last) <= 1e-9 ||
      !(last > first) ||
      (helicalPitch === 0 && spiralPitch === 0)
    )
      return regenError(call, "HELIX_FAILED");
    const x = normalized(radial);
    const y = cross(direction, x);
    const point = (t: number): Vec3 =>
      combine(
        [axisStart, 1],
        [direction, height + helicalPitch * t],
        [x, radius(t) * Math.cos(turn * t)],
        [y, radius(t) * Math.sin(turn * t)],
      );
    const derivative = (t: number): Vec3 =>
      combine(
        [direction, helicalPitch],
        [x, spiralPitch * Math.cos(turn * t) - radius(t) * turn * Math.sin(turn * t)],
        [y, spiralPitch * Math.sin(turn * t) + radius(t) * turn * Math.cos(turn * t)],
      );
    const curve =
      helicalPitch !== 0
        ? helixCurve(call, oc, {
            point,
            axisStart,
            direction,
            x,
            height,
            startRadius,
            first,
            last,
            turn,
            helicalPitch,
            spiralPitch,
          })
        : flatSpiral(call, oc, { first, last, radius, spiralPitch, point, derivative });
    if (!curve) return regenError(call, "HELIX_FAILED");
    model.geometry = addBodies(oc, model.geometry, [
      {
        shape: requireValid(call, oc, wireOf(oc, curve), "HELIX_FAILED"),
        bodyType: "WIRE",
        createdBy: idOf(id),
      },
    ]).state;
    return undefined;
  },
  /**
   * Line segments through `points` (closed when the last repeats the first), with corner `i + 1`
   * rounded by an arc of `bendRadii[i]` tangent to both legs.
   */
  opPolyline: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    let points = array(call, definition.getField("points"), "points").map((p, i) =>
      vector(call, p, 3, `points[${i}]`),
    );
    const same = (a: Vec3, b: Vec3) => Math.hypot(...combine([a, 1], [b, -1])) < 1e-9;
    const closed = points.length > 2 && same(points[0]!, points.at(-1)!);
    if (closed) points = points.slice(0, -1);
    if (points.length < 2) return call.fail("opPolyline needs at least two points.");
    if (points.some((p, i) => i > 0 && same(p, points[i - 1]!)))
      return regenError(call, "POLYLINE_CONSECUTIVE_EQUAL_POINTS");
    // Bend radius at each point; open ends never bend.
    const radiiValue = definition.getField("bendRadii");
    const radii = points.map(() => 0);
    if (radiiValue !== undefined) {
      const given = array(call, radiiValue, "bendRadii").map((r, i) =>
        magnitude(call, r, `bendRadii[${i}]`),
      );
      if (given.length !== (closed ? points.length : points.length - 2))
        return regenError(call, "POLYLINE_BEND_RADII_INVALID_SIZE");
      given.forEach((r, i) => (radii[(i + 1) % points.length] = r));
    }
    const corners = points.map((corner, i) => {
      const radius = radii[i]!;
      if (radius <= 0 || (!closed && (i === 0 || i === points.length - 1))) return null;
      const before = points[(i - 1 + points.length) % points.length]!;
      const after = points[(i + 1) % points.length]!;
      const arc = bend(corner, before, after, radius);
      if (
        !arc &&
        Math.abs(
          dot(
            normalized(combine([before, 1], [corner, -1])),
            normalized(combine([after, 1], [corner, -1])),
          ) - 1,
        ) < 1e-9
      )
        return regenError(call, "POLYLINE_ZERO_ANGLE");
      return arc;
    });
    // Each leg runs between its corners' tangent points, which mustn't overlap.
    const legs = points.length - (closed ? 0 : 1);
    const edges: Shape[] = [];
    for (let i = 0; i < legs; i++) {
      const [j, k] = [i, (i + 1) % points.length];
      const from = corners[j]?.end ?? points[j]!;
      const to = corners[k]?.start ?? points[k]!;
      const legLength = Math.hypot(...combine([points[k]!, 1], [points[j]!, -1]));
      if ((corners[j]?.tangent ?? 0) + (corners[k]?.tangent ?? 0) > legLength + 1e-9)
        return regenError(call, "POLYLINE_INVALID_BEND");
      if (Math.hypot(...combine([to, 1], [from, -1])) > 1e-9)
        edges.push(
          new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(...from), new oc.gp_Pnt(...to)).Edge(),
        );
      const arc = corners[k];
      if (arc && (closed || k !== 0))
        edges.push(
          new oc.BRepBuilderAPI_MakeEdge(
            new oc.GC_MakeArcOfCircle(
              new oc.gp_Pnt(...arc.start),
              new oc.gp_Pnt(...arc.middle),
              new oc.gp_Pnt(...arc.end),
            ).Value(),
          ).Edge(),
        );
    }
    const wire = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of edges) wire.Add(oc.TopoDS.Edge(edge));
    if (!wire.IsDone()) return regenError(call, "POLYLINE_INVALID_BEND");
    model.geometry = addBodies(oc, model.geometry, [
      {
        shape: requireValid(call, oc, wire.Wire(), "POLYLINE_INVALID_BEND"),
        bodyType: "WIRE",
        createdBy: idOf(id),
      },
    ]).state;
    return undefined;
  },

  /**
   * The largest distance from a point on either path to the other path, with the two points it
   * runs between (std returns these as they are).
   */
  evMaxPathDeviation: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const side = (name: string) => {
      const edges = pathEdges(model, resolve(call, model, oc, definition.getField(name))).map(
        (e) => e.shape,
      );
      return edges.length ? edges : regenError(call, "CANNOT_RESOLVE_ENTITIES");
    };
    const [one, two] = [side("side1"), side("side2")];
    const fromOne = farthest(oc, one, compoundOf(oc, two));
    const fromTwo = farthest(oc, two, compoundOf(oc, one));
    const [side1Point, side2Point] =
      fromOne.distance >= fromTwo.distance
        ? [fromOne.point, fromOne.at]
        : [fromTwo.at, fromTwo.point];
    return FsMap.fromEntries([
      ["deviation", length(call, Math.max(fromOne.distance, fromTwo.distance))],
      ["side1Point", lengthVector(call, side1Point)],
      ["side2Point", lengthVector(call, side2Point)],
    ]);
  },
  /** Wire bodies where the `tools` faces cross the `targets` faces. */
  opIntersectFaces: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const faces = (name: string) =>
      facesNamed(model, resolve(call, model, oc, definition.getField(name))).map((e) => e.shape);
    const [tools, targets] = [faces("tools"), faces("targets")];
    if (tools.length === 0 || targets.length === 0)
      return regenError(call, "CANNOT_RESOLVE_ENTITIES");
    const edges = sectionEdges(oc, tools, targets);
    if (!edges) return regenError(call, "FACE_INTERSECTION_FAILED");
    if (edges.length === 0) return regenError(call, "FACE_INTERSECTION_NO_RESULT");
    addWires(call, oc, model, id, edges, "FACE_INTERSECTION_FAILED");
    return undefined;
  },

  /**
   * Edges projected onto faces, as wire bodies: along `direction` (both ways along it), or along a
   * planar target's normal. Where the swept line of each point crosses a target is the projection.
   */
  opDropCurve: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const tools = pathEdges(model, resolve(call, model, oc, definition.getField("tools"))).map(
      (e) => e.shape,
    );
    const targets = facesNamed(model, resolve(call, model, oc, definition.getField("targets"))).map(
      (e) => e.shape,
    );
    if (tools.length === 0 || targets.length === 0)
      return regenError(call, "CANNOT_RESOLVE_ENTITIES");
    const alongNormal = untag(definition.getField("projectionType")) === "NORMAL_TO_TARGET";
    const box = new oc.Bnd_Box();
    for (const shape of [...tools, ...targets]) oc.BRepBndLib.Add(shape, box, false);
    const reach = 2 * Math.sqrt(box.SquareExtent()) + 1e-3;
    const dropped = targets.flatMap((target) => {
      let direction: Vec3;
      if (alongNormal) {
        const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(target), true);
        if (String(surface.GetType()) !== "GeomAbs_Plane")
          return call.unsupported(
            "opDropCurve normal to a non-planar face is not supported locally yet.",
          );
        direction = xyz(surface.Plane().Axis().Direction());
      } else direction = normalized(vector(call, definition.getField("direction"), 3, "direction"));
      const sheets = tools.map((edge) => {
        const back = new oc.gp_Trsf();
        back.SetTranslation(new oc.gp_Vec(...combine([direction, -reach])));
        const start = new oc.BRepBuilderAPI_Transform(edge, back, true, false).Shape();
        return new oc.BRepPrimAPI_MakePrism(
          start,
          new oc.gp_Vec(...combine([direction, 2 * reach])),
          false,
          true,
        ).Shape();
      });
      return sectionEdges(oc, sheets, [target]) ?? regenError(call, "CURVE_PROJECTION_FAILED");
    });
    if (dropped.length === 0) return regenError(call, "CURVE_PROJECTION_NO_RESULT");
    addWires(call, oc, model, id, dropped, "CURVE_PROJECTION_FAILED");
    return undefined;
  },

  /** One spline exactly along a tangent-continuous chain of edges. */
  opSplineThroughEdges: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const edges = pathEdges(
      model,
      resolve(call, model, oc, map(call, value, "definition").getField("edges")),
    );
    if (edges.length === 0) return regenError(call, "SPLINE_THROUGH_EDGES_SELECT_EDGES");
    const chains = chainsOf(
      oc,
      edges.map((e) => e.shape),
    );
    if (!chains || chains.length !== 1)
      return regenError(call, "SPLINE_THROUGH_EDGES_SELECTED_EDGES_DONT_FORM_CHAIN");
    let pieces = chains[0]!.map(({ edge, backward }) => {
      const spline = edgeSpline(oc, edge);
      if (backward) spline.Reverse();
      return spline;
    });
    // Each piece must leave in the direction the last one arrived. A closed loop may have one
    // corner: the spline then starts and ends there. A piece at rest at an end (its end control
    // points coincide) still arrives or leaves along its chord there.
    const heading = (piece: (typeof pieces)[number], atEnd: boolean) => {
      const [first, last] = [piece.FirstParameter(), piece.LastParameter()];
      const u = atEnd ? last : first;
      const { Point, D1 } = piece.EvalD1(u);
      const [point, d] = [xyz(Point), xyz(D1)];
      Point.delete();
      D1.delete();
      if (Math.hypot(...d) > 0) return normalized(d);
      const other = piece.Value(u + (last - first) * 1e-6 * (atEnd ? -1 : 1));
      const [x, y, z] = xyz(other);
      other.delete();
      const chord: Vec3 = atEnd
        ? [point[0] - x, point[1] - y, point[2] - z]
        : [x - point[0], y - point[1], z - point[2]];
      return normalized(chord);
    };
    const sharp = (a: (typeof pieces)[number], b: (typeof pieces)[number]) => {
      const [arriving, leaving] = [heading(a, true), heading(b, false)];
      const cosine = dot(arriving, leaving);
      return !(Math.acos(Math.max(-1, Math.min(1, cosine))) <= 1e-6);
    };
    const closed =
      pieces.length > 1 && pieces[0]!.StartPoint().Distance(pieces.at(-1)!.EndPoint()) < 1e-7;
    // A piece at rest at a join would leave the joined spline stopping dead there.
    const resting = pieces.some((piece, i) =>
      [piece.FirstParameter(), piece.LastParameter()].some((u, end) => {
        const joins = closed || (end === 0 ? i > 0 : i < pieces.length - 1);
        const { Point, D1 } = piece.EvalD1(u);
        const still = !(D1.Magnitude() > 0);
        Point.delete();
        D1.delete();
        return joins && still;
      }),
    );
    if (resting)
      return call.unsupported(
        "opSplineThroughEdges where an edge comes to rest at a join (its derivative is zero there) is not supported locally yet.",
      );
    const corners = pieces.flatMap((piece, i) =>
      i === 0
        ? closed && sharp(pieces.at(-1)!, piece)
          ? [0]
          : []
        : sharp(pieces[i - 1]!, piece)
          ? [i]
          : [],
    );
    if (corners.length > (closed ? 1 : 0))
      return regenError(call, "SPLINE_THROUGH_EDGES_TANGENT_DISCONTINUITY_AT_EDGE_ENDS");
    if (corners.length === 1)
      pieces = [...pieces.slice(corners[0]), ...pieces.slice(0, corners[0])];
    const curve = pieces.length === 1 ? pieces[0]! : occtCurve(call, oc, joined(call, pieces));
    model.geometry = addBodies(oc, model.geometry, [
      {
        shape: requireValid(call, oc, wireOf(oc, curve), "SPLINE_THROUGH_EDGES_CANNOT_FIT_SPLINE"),
        bodyType: "WIRE",
        createdBy: idOf(id),
      },
    ]).state;
    return undefined;
  },
  /**
   * Gives a wire body the curve of `edge`, keeping the body's id: its edge and end vertices
   * continue onto the new ones.
   */
  opEditCurve: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const wire = resolve(call, model, oc, definition.getField("wire"))
      .map((entity) => model.geometry.entities.get(entity.body)!)
      .find((body) => body.bodyType === "WIRE");
    const edge = resolve(call, model, oc, definition.getField("edge")).find(
      (e) => e.type === "EDGE",
    );
    if (!wire || !edge) return regenError(call, "CANNOT_RESOLVE_ENTITIES");
    const oldEdges = subShapes(oc, wire.shape, "EDGE");
    if (oldEdges.length !== 1)
      return call.unsupported(
        "opEditCurve on a wire of several edges is not supported locally yet.",
      );
    const replacement = new oc.BRepBuilderAPI_MakeWire(
      new oc.BRepBuilderAPI_MakeEdge(edgeSpline(oc, edge.shape)).Edge(),
    ).Wire();
    const [newEdge] = subShapes(oc, replacement, "EDGE");
    const newEnds = endsOf(oc, newEdge!);
    const newVertices = subShapes(oc, replacement, "VERTEX");
    const at = (vertex: Shape) => xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex)));
    const [oldStart, oldEnd] = endsOf(oc, oldEdges[0]!);
    const history: History = {
      deleted: () => false,
      modified: (shape) => {
        if (shape.IsSame(oldEdges[0]!)) return [newEdge!];
        if (String(shape.ShapeType()) !== "TopAbs_VERTEX") return [];
        const end = near(at(shape), oldStart)
          ? newEnds[0]
          : near(at(shape), oldEnd)
            ? newEnds[1]
            : null;
        return end ? newVertices.filter((v) => near(at(v), end)) : [];
      },
      generated: () => [],
    };
    model.geometry = replaceBodies(oc, model.geometry, {
      consumed: [wire.id],
      keepIds: [wire.id],
      results: [{ shape: requireValid(call, oc, replacement, "INVALID_INPUT"), bodyType: "WIRE" }],
      history,
      createdBy: idOf(id),
    }).state;
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
