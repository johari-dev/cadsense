import type { SketchConstraint, SketchEntity, SketchPart, SketchRef, Vec2 } from "./Sketch.ts";
import { describe, ellipsePoint } from "./Sketch.ts";

/**
 * A 2D constraint solver for FeatureScript sketches. Each entity's geometry becomes a few unknowns
 * (a line's two endpoints, a circle's center and radius, an arc's center, radius and endpoints),
 * each constraint becomes equations in them, and a damped Gauss-Newton iteration takes
 * minimum-norm steps from the drawn positions. That moves the geometry about as little as the
 * constraints allow, as Onshape's solver does: geometry that already satisfies its constraints
 * doesn't move at all, and unconstrained geometry never moves.
 *
 * Discrete choices a dimension leaves open (which side of a line a point stays on, internal or
 * external tangency, an angle or its supplement) are taken from the drawing, like Onshape does
 * when it solves from the given positions.
 */

type Vars = Float64Array;

/** A sketch point as a function of the unknowns. */
interface Point {
  readonly deps: readonly number[];
  readonly at: (x: Vars) => Vec2;
  /** Index of the first of the two unknowns that hold it, or null for a derived point. */
  readonly index: number | null;
}

/** What a reference resolves to, for building equations. */
type Geometry = { readonly owner: string; readonly part: SketchPart | null } & (
  | { readonly kind: "point"; readonly point: Point }
  | { readonly kind: "line"; readonly start: Point; readonly end: Point }
  | {
      readonly kind: "circle";
      readonly center: Point;
      /** Unknown holding the radius. */
      readonly radius: number;
      /** An arc's endpoints, counterclockwise. */
      readonly ends: readonly [Point, Point] | null;
    }
  | {
      readonly kind: "ellipse";
      readonly center: Point;
      /** Unknowns: the major axis's angle, and the radii along and across it. */
      readonly axis: number;
      readonly major: number;
      readonly minor: number;
      /** An elliptical arc's endpoints, counterclockwise. */
      readonly ends: readonly [Point, Point] | null;
    }
  /** A curve the solver can't move (Bézier, conic, fit spline), or one of its points. */
  | { readonly kind: "curve"; readonly description: string }
);
type LineGeometry = Extract<Geometry, { kind: "line" }>;
/** Two points a solution must keep apart: a line's or an arc's ends. */
interface Span {
  readonly start: Point;
  readonly end: Point;
}
type CircleGeometry = Extract<Geometry, { kind: "circle" }>;
type EllipseGeometry = Extract<Geometry, { kind: "ellipse" }>;

/**
 * One equation `f(x) = 0`, in meters, and the unknowns it reads. An angle equation also gives its
 * error in radians, checked against `TOLERANCE.zeroAngle` once solved, and the finest angle its
 * lines' own coordinates can hold: a 0.001 mm line half a meter from the sketch origin can't point
 * closer than about 1e-10 rad, whatever the solver does.
 */
interface Residual {
  readonly deps: readonly number[];
  readonly f: (x: Vars) => number;
  readonly angle?: { readonly error: (x: Vars) => number; readonly floor: (x: Vars) => number };
}

/** std's `TOLERANCE.zeroLength` (meters) and `zeroAngle` (radians): when an equation holds. */
const ZERO_LENGTH = 1e-8;
const ZERO_ANGLE = 1e-11;
/**
 * True when every equation holds to `fraction` of std's tolerance, each in its own units. No other
 * geometry enters the check, so a far-off point can't loosen it.
 */
const holds = (residuals: readonly Residual[], x: Vars, fraction: number) =>
  residuals.every((r) =>
    r.angle
      ? Math.abs(r.angle.error(x)) <= Math.max(ZERO_ANGLE * fraction, r.angle.floor(x))
      : Math.abs(r.f(x)) <= ZERO_LENGTH * fraction,
  );

/** Why a constraint can't be added: an `ErrorStringEnum` member Onshape reports, or a case not solved locally. */
export type ConstraintProblem = { readonly error: string } | { readonly unsupported: string };

interface Compiled {
  readonly residuals: readonly Residual[];
  /** Unknowns the constraint holds where they are (FIX). */
  readonly fixed: readonly number[];
  /**
   * Branches the drawing doesn't choose between (a tie), in an order that doesn't depend on how
   * the constraint names its entities: one of them must hold, and the solve picks which.
   */
  readonly either?: readonly (readonly Residual[])[];
  /** A sided equation's other branches, farther from the drawing than the one in `residuals`. */
  readonly others?: readonly (readonly Residual[])[];
}

/** One way a sided equation can hold, and how far the drawing is from it (in its own units). */
interface Branch {
  readonly residuals: readonly Residual[];
  readonly off: number;
}

/**
 * The drawing's nearest branch, or on a true tie (within `tie`) every nearest one, for the solve
 * to choose between (`Compiled.either`). Callers list branches in an order that doesn't depend on
 * how the constraint names its entities, so a tie resolves the same way either way round. A branch
 * the drawing can't measure (a side of a line drawn with no length) is as near as any.
 */
function nearest(branches: readonly Branch[], tie = ZERO_LENGTH): Compiled {
  const measured = (branch: Branch) => Number.isFinite(branch.off);
  const best = Math.min(...branches.filter(measured).map((branch) => branch.off));
  const kept = branches.filter((branch) => !measured(branch) || branch.off - best <= tie);
  const others = branches.filter((branch) => !kept.includes(branch)).map((b) => b.residuals);
  return kept.length === 1
    ? { residuals: kept[0]!.residuals, fixed: [], others }
    : { residuals: [], fixed: [], either: kept.map((branch) => branch.residuals) };
}

/**
 * A sided equation `f(x, side) = 0`: one branch with the side +1 (a line's left), one with -1.
 * With `offset`, the constant the side multiplies, an offset of zero makes both sides the same
 * equation, so there's one branch, not a tie.
 */
const sides = (
  parts: readonly (Point | number)[],
  f: (x: Vars, side: number) => number,
  x0: Vars,
  offset?: number,
) =>
  (offset === 0 ? [1] : [1, -1]).map((side) => ({
    residuals: [residual(parts, (x) => f(x, side))],
    off: Math.abs(f(x0, side)),
  }));

// ------------------------------------------------------------------ plane geometry

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Vec2) => Math.hypot(a[0], a[1]);
const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const direction = (a: Vec2) => Math.atan2(a[1], a[0]);
/** An angle wrapped into [-pi, pi]. */
const wrap = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
/** Signed distance from `p` to the infinite line through `s` and `e`, positive on its left. */
const side = (p: Vec2, s: Vec2, e: Vec2) => cross(sub(e, s), sub(p, s)) / norm(sub(e, s));
/** Where `p` lands mirrored across the line through `s` and `e`. */
function reflect(p: Vec2, s: Vec2, e: Vec2): Vec2 {
  const d = sub(e, s);
  const t = dot(sub(p, s), d) / dot(d, d);
  const foot: Vec2 = [s[0] + t * d[0], s[1] + t * d[1]];
  return [2 * foot[0] - p[0], 2 * foot[1] - p[1]];
}
/** The point halfway round an arc (counterclockwise from `s` to `e`). */
function arcMidpoint(center: Vec2, radius: number, s: Vec2, e: Vec2): Vec2 {
  const from = direction(sub(s, center));
  let sweep = direction(sub(e, center)) - from;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const half = from + sweep / 2;
  return [center[0] + radius * Math.cos(half), center[1] + radius * Math.sin(half)];
}

const residual = (parts: readonly (Point | number)[], f: (x: Vars) => number): Residual => ({
  deps: [...new Set(parts.flatMap((part) => (typeof part === "number" ? [part] : part.deps)))],
  f,
});
const lineParts = (line: LineGeometry) => [line.start, line.end];
const circleParts = (circle: CircleGeometry) => [circle.center, circle.radius];

// ------------------------------------------------------------------ unknowns

/** An entity's own size, meters: a line's length, a curve's radius; 0 for a point. */
function sizeOf(entity: SketchEntity): number {
  switch (entity.kind) {
    case "point":
      return 0;
    case "line":
    case "conic":
      return norm(sub(entity.end, entity.start));
    case "circle":
    case "arc":
      return entity.radius;
    case "ellipse":
    case "ellipticalArc":
      return Math.max(entity.majorRadius, entity.minorRadius);
    case "bezier":
      return norm(sub(entity.poles.at(-1)!, entity.poles[0]!));
    case "fitSpline":
      return norm(sub(entity.points.at(-1)!, entity.points[0]!));
  }
}

/** The unknowns for a sketch's entities, their drawn values, and how to read solved entities back. */
class Layout {
  readonly x0: number[] = [];
  /**
   * Typical size of each unknown, for finite-difference steps: a length's is its own entity's size
   * (never the whole sketch's, so unrelated geometry can't coarsen the steps); an angle's is 1.
   */
  readonly scale: number[] = [];
  /** Which unknowns are angles or curve parameters rather than lengths. */
  readonly angular: boolean[] = [];
  /** Unknowns that are radii (a circle's or arc's, an ellipse's two); each must stay positive. */
  readonly radii: number[] = [];
  /** An arc's endpoints stay on its circle: equations that come with the arc, by entity id. */
  readonly implicit = new Map<string, Residual[]>();
  /** The size of the entity whose unknowns are being added. */
  private size = 1e-3;
  private readonly geometry = new Map<string, Geometry>();
  /** How to read each entity back from the unknowns, in sketch order. */
  private readonly readers: ((x: Vars) => SketchEntity)[] = [];

  constructor(entities: readonly SketchEntity[]) {
    for (const entity of entities) {
      const owner = entity.id;
      this.size = Math.max(sizeOf(entity), 1e-4);
      const set = (
        part: SketchPart | null,
        geometry: DistributiveOmit<Geometry, "owner" | "part">,
      ) => this.geometry.set(part ? `${owner}.${part}` : owner, { ...geometry, owner, part });
      const setEnds = (ends: readonly [Point, Point]) => {
        set("start", { kind: "point", point: ends[0] });
        set("end", { kind: "point", point: ends[1] });
      };
      switch (entity.kind) {
        case "point": {
          const point = this.point(entity.position);
          set(null, { kind: "point", point });
          this.readers.push((x) => ({ ...entity, position: point.at(x) }));
          break;
        }
        case "line": {
          const [start, end] = [this.point(entity.start), this.point(entity.end)];
          set(null, { kind: "line", start, end });
          setEnds([start, end]);
          this.readers.push((x) => ({ ...entity, start: start.at(x), end: end.at(x) }));
          break;
        }
        case "circle":
        case "arc": {
          const center = this.point(entity.center);
          const radius = this.number(entity.radius);
          this.radii.push(radius);
          const ends =
            entity.kind === "arc"
              ? ([this.point(entity.start), this.point(entity.end)] as const)
              : null;
          set(null, { kind: "circle", center, radius, ends });
          set("center", { kind: "point", point: center });
          const circle = (x: Vars) => ({ center: center.at(x), radius: x[radius]! });
          if (entity.kind === "circle") this.readers.push((x) => ({ ...entity, ...circle(x) }));
          else {
            const [start, end] = ends!;
            setEnds([start, end]);
            this.implicit.set(
              owner,
              [start, end].map((p) =>
                residual([p, center, radius], (x) => norm(sub(p.at(x), center.at(x))) - x[radius]!),
              ),
            );
            this.readers.push((x) => ({
              ...entity,
              ...circle(x),
              start: start.at(x),
              end: end.at(x),
            }));
          }
          break;
        }
        case "ellipse":
        case "ellipticalArc": {
          const center = this.point(entity.center);
          const axis = this.number(Math.atan2(entity.majorAxis[1], entity.majorAxis[0]), true);
          const major = this.number(entity.majorRadius);
          const minor = this.number(entity.minorRadius);
          this.radii.push(major, minor);
          const shape = (x: Vars) => ({
            center: center.at(x),
            majorAxis: [Math.cos(x[axis]!), Math.sin(x[axis]!)] as const,
            majorRadius: x[major]!,
            minorRadius: x[minor]!,
          });
          if (entity.kind === "ellipse") {
            set(null, { kind: "ellipse", center, axis, major, minor, ends: null });
            this.readers.push((x) => ({ ...entity, ...shape(x) }));
          } else {
            // The ends follow the arc's parameters, which are unknowns of their own.
            const [from, to] = [
              this.number(entity.startParameter, true),
              this.number(entity.endParameter, true),
            ];
            const end = (parameter: number): Point => ({
              deps: [...center.deps, axis, major, minor, parameter],
              at: (x) => ellipsePoint(shape(x), x[parameter]!),
              index: null,
            });
            const ends = [end(from), end(to)] as const;
            set(null, { kind: "ellipse", center, axis, major, minor, ends });
            setEnds(ends);
            this.readers.push((x) => ({
              ...entity,
              ...shape(x),
              startParameter: x[from]!,
              endParameter: x[to]!,
            }));
          }
          set("center", { kind: "point", point: center });
          break;
        }
        default: {
          const curve = { kind: "curve", description: describe(entity) } as const;
          set(null, curve);
          set("start", curve);
          set("end", curve);
          this.readers.push(() => entity);
        }
      }
    }
  }

  private number(value: number, angular = false): number {
    this.x0.push(value);
    this.scale.push(angular ? 1 : this.size);
    this.angular.push(angular);
    return this.x0.length - 1;
  }
  private point([u, v]: Vec2): Point {
    const index = this.number(u);
    this.number(v);
    return { deps: [index, index + 1], at: (x) => [x[index]!, x[index + 1]!], index };
  }

  /** Every arc's and elliptical arc's two ends. */
  arcEnds(): Span[] {
    return [...this.geometry.values()].flatMap((g) =>
      (g.kind === "circle" || g.kind === "ellipse") && g.part === null && g.ends
        ? [{ start: g.ends[0], end: g.ends[1] }]
        : [],
    );
  }

  /** Every line entity's geometry. */
  lines(): LineGeometry[] {
    return [...this.geometry.values()].filter(
      (g): g is LineGeometry => g.kind === "line" && g.part === null,
    );
  }

  resolve(ref: SketchRef): Geometry | undefined {
    return this.geometry.get(ref.part ? `${ref.entity}.${ref.part}` : ref.entity);
  }

  /** The entities with the solved values of `x`. */
  read(x: Vars): SketchEntity[] {
    return this.readers.map((read) => read(x));
  }
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ------------------------------------------------------------------ constraints

/** Both orders of a pair, typed by kind: `pair(a, b, "point", "line")` matches (line, point) too. */
function pair<A extends Geometry["kind"], B extends Geometry["kind"]>(
  a: Geometry,
  b: Geometry,
  first: A,
  second: B,
): [Extract<Geometry, { kind: A }>, Extract<Geometry, { kind: B }>] | null {
  const is = <K extends Geometry["kind"]>(
    g: Geometry,
    kind: K,
  ): g is Extract<Geometry, { kind: K }> => g.kind === kind;
  if (is(a, first) && is(b, second)) return [a, b];
  if (is(b, first) && is(a, second)) return [b, a];
  return null;
}

const DIMENSIONS = new Set([
  "DISTANCE",
  "LENGTH",
  "RADIUS",
  "DIAMETER",
  "MAJOR_DIAMETER",
  "MINOR_DIAMETER",
]);
const TWO_ENTITY_ERRORS: Readonly<Record<string, string>> = {
  COINCIDENT: "SKETCH_CONSTRAINT_COINCIDENT_TWO_ENTITIES",
  CONCENTRIC: "SKETCH_CONSTRAINT_CONCENTRIC_TWO_ENTITIES",
  EQUAL: "SKETCH_CONSTRAINT_EQUAL_TWO_ENTITIES",
  MIDPOINT: "SKETCH_CONSTRAINT_MIDPOINT_TWO_ENTITIES",
  DISTANCE: "SKETCH_DIMENSION_TWO_ENTITIES",
  ANGLE: "SKETCH_ANGLE_TWO_LINES",
};
/** Constraint types the solver handles; anything else in `ConstraintType` stops the run. */
const SUPPORTED = new Set([
  "COINCIDENT",
  "HORIZONTAL",
  "VERTICAL",
  "PARALLEL",
  "PERPENDICULAR",
  "TANGENT",
  "EQUAL",
  "CONCENTRIC",
  "MIDPOINT",
  "MIRROR",
  "FIX",
  "DISTANCE",
  "ANGLE",
  "LENGTH",
  "RADIUS",
  "DIAMETER",
  "MAJOR_DIAMETER",
  "MINOR_DIAMETER",
  "NORMAL",
]);

/** Which sketch points (`"line1.end"`) other constraints hold coincident. */
type Joined = (p: string, q: string) => boolean;

/**
 * The equations for one constraint, or why it can't be added. Discrete choices (sides, branches)
 * come from the drawn positions `x0`.
 */
function compile(
  layout: Layout,
  constraint: SketchConstraint,
  x0: Vars,
  joined: Joined = () => false,
): Compiled | ConstraintProblem {
  const { type } = constraint;
  if (type === "NONE") return { error: "SKETCH_CONSTRAINT_UNKNOWN" };
  if (!SUPPORTED.has(type))
    return { unsupported: `Sketch constraint ${type} is not supported locally yet.` };
  const error = (name: string) => ({ error: name });
  const a = constraint.first ? layout.resolve(constraint.first) : undefined;
  const b = constraint.second ? layout.resolve(constraint.second) : undefined;
  const only = (...residuals: Residual[]): Compiled => ({ residuals, fixed: [] });

  // Values the dimension needs; std leaves them undefined when their units are wrong.
  const length = constraint.length;
  if (DIMENSIONS.has(type) || type === "ANGLE") {
    const value = type === "ANGLE" ? constraint.angle : length;
    if (value === null)
      return error(type === "ANGLE" ? "SKETCH_DIMENSION_FAILED" : "SKETCH_DIMENSION_DIST_ERROR");
    if (!Number.isFinite(value)) return error("SKETCH_DIMENSION_INFINITY");
  }

  // Bézier curves, conics and fit splines keep their shape; nothing here can move them.
  for (const g of [a, b])
    if (g?.kind === "curve")
      return {
        unsupported: `Sketch constraints on ${g.owner} (${g.description}) are not supported locally yet.`,
      };

  // std's DimensionAlignment orients coincident and parallel axes, and directional distances.
  // Anywhere else we'd have to guess what it means, so it stops rather than being dropped.
  const lines = a?.kind === "line" && b?.kind === "line";
  const aligns =
    type === "PARALLEL" ||
    (type === "COINCIDENT" && lines) ||
    (type === "DISTANCE" &&
      (lines ||
        (a?.kind === "point" && b?.kind === "point" && constraint.direction !== "MINIMUM")));
  if (constraint.alignment !== "UNSPECIFIED" && !aligns)
    return {
      unsupported: `A ${type} sketch constraint with an alignment is not supported locally yet.`,
    };

  if (type === "FIX") {
    if (!a || b) return error("SKETCH_FIX_ONE_ENT");
    return fix(a, x0);
  }
  if (type === "MAJOR_DIAMETER" || type === "MINOR_DIAMETER") {
    if (!a || b || a.kind !== "ellipse") return error("SKETCH_ELLIPSE_RADIUS_INPUT_ERROR");
    const radius = type === "MAJOR_DIAMETER" ? a.major : a.minor;
    return only(residual([radius], (x) => 2 * x[radius]! - length!));
  }
  if (type === "LENGTH") {
    if (!a || b) return error("SKETCH_LENGTH_DIM_INPUT_ERROR");
    if (a.kind !== "line") return error("SKETCH_LENGTH_DIM_INPUT_ERROR");
    return only(residual(lineParts(a), (x) => lengthOf(a, x) - length!));
  }
  if (type === "RADIUS" || type === "DIAMETER") {
    if (!a || b || a.kind !== "circle") return error("SKETCH_RADIUS_INPUT_ERROR");
    const scale = type === "DIAMETER" ? 2 : 1;
    return only(residual([a.radius], (x) => scale * x[a.radius]! - length!));
  }
  if (type === "HORIZONTAL" || type === "VERTICAL") {
    const axis = type === "HORIZONTAL" ? 1 : 0;
    if (a?.kind === "line" && !b)
      return only(residual(lineParts(a), (x) => a.end.at(x)[axis] - a.start.at(x)[axis]));
    if (a?.kind === "point" && b?.kind === "point")
      return only(residual([a.point, b.point], (x) => b.point.at(x)[axis] - a.point.at(x)[axis]));
    // An ellipse's major axis along x (or y).
    if (a?.kind === "ellipse" && !b) {
      // Near the solution the sine (or cosine) is the axis's angle off x (or y), in radians.
      const off = (x: Vars) => (axis === 1 ? Math.sin(x[a.axis]!) : Math.cos(x[a.axis]!));
      return only({
        ...residual([a.axis, a.major], (x) => x[a.major]! * off(x)),
        angle: { error: off, floor: () => 0 },
      });
    }
    return error("SKETCH_DIR_INPUT");
  }

  // Everything else relates two entities.
  if (!a || !b) return error(TWO_ENTITY_ERRORS[type] ?? "SKETCH_CONSTRAINT_TWO_ENTITIES");
  if (a.owner === b.owner && a.part === b.part) return error("SKETCH_CONSTRAINT_DIFF_ENTITIES");
  // Ellipses take a point on them or a shared center; the rest isn't solved here yet.
  const ellipse = pair(a, b, "point", "ellipse");
  if (ellipse && type === "COINCIDENT") return only(onEllipse(ellipse[0].point, ellipse[1]));
  if ((a.kind === "ellipse" || b.kind === "ellipse") && type !== "CONCENTRIC")
    return { unsupported: `Sketch constraint ${type} on ellipses is not supported locally yet.` };

  switch (type) {
    case "COINCIDENT": {
      const points = pair(a, b, "point", "point");
      if (points) {
        const [p, q] = points;
        if (p.owner === q.owner) return error("SKETCH_COINCIDENT_DIFF_POINTS");
        return only(...coincide(p.point, q.point));
      }
      const onLine = pair(a, b, "point", "line");
      if (onLine) {
        const [{ point }, line] = onLine;
        return only(
          residual([point, ...lineParts(line)], (x) =>
            side(point.at(x), line.start.at(x), line.end.at(x)),
          ),
        );
      }
      const onCircle = pair(a, b, "point", "circle");
      if (onCircle) {
        const [{ point }, circle] = onCircle;
        return only(
          residual(
            [point, ...circleParts(circle)],
            (x) => norm(sub(point.at(x), circle.center.at(x))) - x[circle.radius]!,
          ),
        );
      }
      const lines = pair(a, b, "line", "line");
      if (lines) {
        const [l, m] = lines;
        return only(
          ...[m.start, m.end].map((p) =>
            residual([p, ...lineParts(l)], (x) => side(p.at(x), l.start.at(x), l.end.at(x))),
          ),
          ...aligned(l, m, constraint, x0),
        );
      }
      const circles = pair(a, b, "circle", "circle");
      if (circles) {
        const [c, d] = circles;
        return only(
          ...coincide(c.center, d.center),
          residual([c.radius, d.radius], (x) => x[c.radius]! - x[d.radius]!),
        );
      }
      return error("SKETCH_COINCIDENT_INPUT_ERROR");
    }
    case "PARALLEL":
    case "PERPENDICULAR": {
      const lines = pair(a, b, "line", "line");
      if (!lines)
        return error(
          type === "PARALLEL" ? "SKETCH_PARALLEL_INPUT_ERROR" : "SKETCH_PERPENDICULAR_INPUT_ERROR",
        );
      const [l, m] = lines;
      const targets =
        type === "PERPENDICULAR" ? [Math.PI / 2, -Math.PI / 2] : ALIGNMENTS[constraint.alignment];
      return nearest(angleBetween(l, m, targets, x0), ZERO_ANGLE);
    }
    case "ANGLE": {
      // Measured from the first line to the second; the drawing picks the quadrant.
      const lines = pair(a, b, "line", "line");
      if (!lines) return error("SKETCH_ANGLE_TWO_LINES");
      const [l, m] = lines;
      const angle = constraint.angle!;
      return nearest(
        angleBetween(l, m, [angle, -angle, Math.PI - angle, angle - Math.PI], x0),
        ZERO_ANGLE,
      );
    }
    case "TANGENT": {
      const lineCircle = pair(a, b, "line", "circle");
      if (lineCircle) {
        const [line, circle] = lineCircle;
        // Where the line ends on the arc, its distance from the center is r only as a double root;
        // there, tangency is the line meeting the radius at a right angle, which solves cleanly.
        const touching = sharedEnd(line, circle, joined);
        if (touching)
          return only(
            residual([...lineParts(line), circle.center], (x) => {
              const along = sub(line.end.at(x), line.start.at(x));
              return dot(along, sub(touching.at(x), circle.center.at(x))) / norm(along);
            }),
          );
        // The center is a radius off the line, on one side or the other.
        return nearest(
          sides(
            [...lineParts(line), ...circleParts(circle)],
            (x, s) =>
              side(circle.center.at(x), line.start.at(x), line.end.at(x)) - s * x[circle.radius]!,
            x0,
          ),
        );
      }
      const circles = pair(a, b, "circle", "circle");
      if (!circles) return error("SKETCH_TANGENT_INPUT_ERROR");
      const [c, d] = circles;
      // Arcs that meet end to end are tangent when the meeting point lines up with both centers.
      const meeting = sharedEnd(c, d, joined);
      if (meeting)
        return only(
          residual([meeting, c.center, d.center], (x) => {
            const [toC, toD] = [
              sub(c.center.at(x), meeting.at(x)),
              sub(d.center.at(x), meeting.at(x)),
            ];
            return cross(toC, toD) / norm(toC);
          }),
        );
      const apart = (x: Vars) => norm(sub(c.center.at(x), d.center.at(x)));
      const parts = [...circleParts(c), ...circleParts(d)];
      // Outside each other, or one holding the other, whichever the drawing is nearest. A tie
      // (two circles drawn the same size, say) keeps every nearest branch for the solve to pick.
      const holding = (outer: CircleGeometry, inner: CircleGeometry) => ({
        key: outer.owner,
        f: (x: Vars) => apart(x) - (x[outer.radius]! - x[inner.radius]!),
      });
      return nearest(
        [
          { key: "", f: (x: Vars) => apart(x) - x[c.radius]! - x[d.radius]! },
          holding(c, d),
          holding(d, c),
        ]
          .sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0))
          .map(({ f }) => ({ residuals: [residual(parts, f)], off: Math.abs(f(x0)) })),
      );
    }
    case "EQUAL": {
      const lines = pair(a, b, "line", "line");
      if (lines) {
        const [l, m] = lines;
        return only(
          residual([...lineParts(l), ...lineParts(m)], (x) => lengthOf(l, x) - lengthOf(m, x)),
        );
      }
      const circles = pair(a, b, "circle", "circle");
      if (circles) {
        const [c, d] = circles;
        return only(residual([c.radius, d.radius], (x) => x[c.radius]! - x[d.radius]!));
      }
      return error("SKETCH_EQUAL_INPUT_ERROR");
    }
    case "CONCENTRIC": {
      const center = (g: Geometry) =>
        g.kind === "circle" || g.kind === "ellipse"
          ? g.center
          : g.kind === "point"
            ? g.point
            : null;
      const [p, q] = [center(a), center(b)];
      if (!p || !q || (a.kind === "point" && b.kind === "point"))
        return error("SKETCH_CONCENTRIC_INPUT_ERROR");
      return only(...coincide(p, q));
    }
    case "MIDPOINT": {
      const onLine = pair(a, b, "point", "line");
      if (onLine) {
        const [{ point, owner }, line] = onLine;
        if (owner === line.owner) return error("SKETCH_MIDPOINT_NEED_DIFF_POINT");
        const middle: Point = {
          deps: [...line.start.deps, ...line.end.deps],
          at: (x) => midpoint(line.start.at(x), line.end.at(x)),
          index: null,
        };
        return only(...coincide(point, middle));
      }
      const onArc = pair(a, b, "point", "circle");
      if (onArc && onArc[1].ends) {
        const [{ point, owner }, arc] = onArc;
        if (owner === arc.owner) return error("SKETCH_MIDPOINT_NEED_DIFF_POINT");
        const [s, e] = arc.ends!;
        const middle: Point = {
          deps: [...arc.center.deps, arc.radius, ...s.deps, ...e.deps],
          at: (x) => arcMidpoint(arc.center.at(x), x[arc.radius]!, s.at(x), e.at(x)),
          index: null,
        };
        return only(...coincide(point, middle));
      }
      return error("SKETCH_MIDPOINT_INPUT_ERROR");
    }
    case "MIRROR": {
      const mirror = constraint.mirror ? layout.resolve(constraint.mirror) : undefined;
      if (mirror?.kind !== "line") return error("SKETCH_MIRROR_CONSTRAINT_FAILED");
      return mirrored(a, b, mirror) ?? error("SKETCH_MIRROR_CONSTRAINT_FAILED");
    }
    case "NORMAL": {
      // A line normal to a circle or arc passes through its center.
      const lineCircle = pair(a, b, "line", "circle");
      if (!lineCircle) return error("SKETCH_NORMAL_INPUT_NEEDED");
      const [line, circle] = lineCircle;
      return only(
        residual([...lineParts(line), circle.center], (x) =>
          side(circle.center.at(x), line.start.at(x), line.end.at(x)),
        ),
      );
    }
    case "DISTANCE":
      return distance(a, b, constraint, x0) ?? error("SKETCH_DIMENSION_INPUT_ERROR");
  }
  return { unsupported: `Sketch constraint ${type} is not supported locally yet.` };
}

/** An end of `curve` held coincident with an end of `arc`, if any: the point where they meet. */
function sharedEnd(curve: LineGeometry | CircleGeometry, arc: CircleGeometry, joined: Joined) {
  if (!arc.ends) return null;
  const ends = curve.kind === "line" ? [curve.start, curve.end] : curve.ends;
  for (const [i, end] of (ends ?? []).entries())
    for (const part of ["start", "end"])
      if (joined(`${curve.owner}.${i === 0 ? "start" : "end"}`, `${arc.owner}.${part}`)) return end;
  return null;
}

/** The angles between two axes each `DimensionAlignment` allows: same way, opposite, either. */
const ALIGNMENTS: Readonly<Record<SketchConstraint["alignment"], readonly number[]>> = {
  ALIGNED: [0],
  ANTI_ALIGNED: [Math.PI],
  UNSPECIFIED: [0, Math.PI],
};
/** Holds two lines the way an ALIGNED or ANTI_ALIGNED alignment says; nothing when unspecified. */
const aligned = (l: LineGeometry, m: LineGeometry, constraint: SketchConstraint, x0: Vars) =>
  constraint.alignment === "UNSPECIFIED"
    ? []
    : angleBetween(l, m, ALIGNMENTS[constraint.alignment], x0)[0]!.residuals;

const coincide = (p: Point, q: Point): Residual[] =>
  [0, 1].map((axis) => residual([p, q], (x) => p.at(x)[axis]! - q.at(x)[axis]!));

/**
 * The signed angle from `l` to `m` held at each of `targets`, one branch apiece, as a length (the
 * angle error times the lines' mean length) so it weighs like the other equations.
 */
function angleBetween(
  l: LineGeometry,
  m: LineGeometry,
  targets: readonly number[],
  x0: Vars,
): Branch[] {
  const angle = (x: Vars) =>
    direction(sub(m.end.at(x), m.start.at(x))) - direction(sub(l.end.at(x), l.start.at(x)));
  // Targets that are the same angle (ANGLE 90's 90 and -90 + 180) are one branch, not a tie. So
  // are targets within zeroAngle of each other, the tolerance branches tie within: two such would
  // tie from any drawing, though either holds the other to zeroAngle.
  const distinct = targets.filter(
    (target, i) => targets.findIndex((other) => Math.abs(wrap(target - other)) <= ZERO_ANGLE) === i,
  );
  return distinct.map((target) => ({
    residuals: [heldAngle(l, m, (x) => wrap(angle(x) - target))],
    off: Math.abs(wrap(angle(x0) - target)),
  }));
}

/**
 * An angle error between two lines as an equation, with the precision the lines can hold. `extra`
 * lists other points the error reads (a mirror line).
 */
function heldAngle(
  l: LineGeometry,
  m: LineGeometry,
  error: (x: Vars) => number,
  extra: readonly Point[] = [],
): Residual {
  // The finest angle the geometry can hold. A line's ends sit on the double-precision grid, one
  // rounding step (machine epsilon times the coordinates' size) from where an exact solution
  // would put them, which turns the line by that step over its length. The bound is the coarser
  // of the two lines', with no safety factor. A line too short to measure (below zeroLength)
  // fails the solve separately, so it never stands in here.
  const floor = (x: Vars) =>
    Math.max(
      ...[l, m].map((line) => {
        const [s, e] = [line.start.at(x), line.end.at(x)];
        const reach = Math.max(...[...s, ...e].map(Math.abs));
        return (Number.EPSILON * reach) / Math.max(norm(sub(e, s)), ZERO_LENGTH);
      }),
    );
  return {
    ...residual([...lineParts(l), ...lineParts(m), ...extra], (x) => {
      const size = (lengthOf(l, x) + lengthOf(m, x)) / 2;
      return error(x) * size;
    }),
    angle: { error, floor },
  };
}
const lengthOf = (line: LineGeometry, x: Vars) => norm(sub(line.end.at(x), line.start.at(x)));

/**
 * Signed distance from (u, v) to the ellipse u^2/a^2 + v^2/b^2 = 1 (negative inside), exactly, by
 * D. Eberly's "Distance from a Point to an Ellipse": bisection on the closest point's parameter.
 */
function ellipseDistance(u: number, v: number, a: number, b: number): number {
  // Work in the first quadrant with the longer radius first.
  const [e0, e1, y0, y1] =
    a >= b ? [a, b, Math.abs(u), Math.abs(v)] : [b, a, Math.abs(v), Math.abs(u)];
  const inside = (y0 / e0) ** 2 + (y1 / e1) ** 2 < 1;
  let distance: number;
  if (y1 > 0) {
    if (y0 > 0) {
      const [z0, z1] = [y0 / e0, y1 / e1];
      const g = z0 * z0 + z1 * z1 - 1;
      if (g === 0) return 0;
      const r0 = (e0 / e1) ** 2;
      const n0 = r0 * z0;
      let [s0, s1] = [z1 - 1, g < 0 ? 0 : Math.hypot(n0, z1) - 1];
      let sbar = 0;
      for (let i = 0; i < 200; i++) {
        sbar = (s0 + s1) / 2;
        if (sbar === s0 || sbar === s1) break;
        const value = (n0 / (sbar + r0)) ** 2 + (z1 / (sbar + 1)) ** 2 - 1;
        if (value > 0) s0 = sbar;
        else if (value < 0) s1 = sbar;
        else break;
      }
      distance = Math.hypot((r0 * y0) / (sbar + r0) - y0, y1 / (sbar + 1) - y1);
    } else distance = Math.abs(y1 - e1);
  } else {
    const [numer, denom] = [e0 * y0, e0 * e0 - e1 * e1];
    if (numer < denom) {
      const xde = numer / denom;
      distance = Math.hypot(e0 * xde - y0, e1 * Math.sqrt(1 - xde * xde));
    } else distance = Math.abs(y0 - e0);
  }
  return inside ? -distance : distance;
}

/**
 * A point on an ellipse: its signed distance from the curve, exactly, so neither a slender
 * ellipse's minor radius nor a first-order estimate shrinks a real gap under the tolerance.
 */
function onEllipse(p: Point, ellipse: EllipseGeometry): Residual {
  const { center, axis, major, minor } = ellipse;
  return residual([p, center, axis, major, minor], (x) => {
    const [dx, dy] = sub(p.at(x), center.at(x));
    const [c, s] = [Math.cos(x[axis]!), Math.sin(x[axis]!)];
    return ellipseDistance(dx * c + dy * s, dy * c - dx * s, x[major]!, x[minor]!);
  });
}

/**
 * FIX takes an entity's unknowns out of the solve at their drawn values, so no solve can move
 * what it holds: a point, both ends of a line, a circle's center and radius, an ellipse's center,
 * axis and radii. An arc keeps its ends free to slide around its fixed circle, and an elliptical
 * arc its parameters, as std's hem documents ("This does not fix the end position of the arc").
 * An elliptical arc's end has no unknowns of its own (it's computed from the ellipse), so fixing
 * one pins it to where it was drawn by equation.
 */
function fix(g: Geometry, x0: Vars): Compiled {
  const held = (p: Point) =>
    p.index === null
      ? { residuals: coincideWith(p, p.at(x0)), fixed: [] }
      : { residuals: [], fixed: [p.index, p.index + 1] };
  switch (g.kind) {
    case "point":
      return held(g.point);
    case "line": {
      const [start, end] = [held(g.start), held(g.end)];
      return {
        residuals: [...start.residuals, ...end.residuals],
        fixed: [...start.fixed, ...end.fixed],
      };
    }
    case "circle": {
      const center = held(g.center);
      return { residuals: center.residuals, fixed: [...center.fixed, g.radius] };
    }
    case "ellipse": {
      const center = held(g.center);
      return { residuals: center.residuals, fixed: [...center.fixed, g.axis, g.major, g.minor] };
    }
    case "curve":
      return { residuals: [], fixed: [] };
  }
}
const coincideWith = (p: Point, where: Vec2): Residual[] =>
  [0, 1].map((axis) => residual([p], (x) => p.at(x)[axis]! - where[axis]!));

/** MIRROR: a point's reflection across `mirror` is its partner; lines and arcs mirror by their underlying curves. */
function mirrored(a: Geometry, b: Geometry, mirror: LineGeometry): Compiled | null {
  const symmetric = (p: Point, q: Point): Residual[] => {
    const parts = [p, q, ...lineParts(mirror)];
    return [
      // The midpoint lies on the mirror line, and the pair is perpendicular to it.
      residual(parts, (x) =>
        side(midpoint(p.at(x), q.at(x)), mirror.start.at(x), mirror.end.at(x)),
      ),
      residual(parts, (x) => {
        const d = sub(mirror.end.at(x), mirror.start.at(x));
        return dot(d, sub(q.at(x), p.at(x))) / norm(d);
      }),
    ];
  };
  if (a.kind === "point" && b.kind === "point")
    return { residuals: symmetric(a.point, b.point), fixed: [] };
  // Lines mirror by their underlying lines (Onshape's Symmetric docs): one line's start, reflected,
  // lies on the other line, and the reflected line runs along it (as undirected lines, to the
  // angle the lines can hold, so a short segment's ends can't pass a turned line).
  if (a.kind === "line" && b.kind === "line") {
    const across = (p: Point, x: Vars) => reflect(p.at(x), mirror.start.at(x), mirror.end.at(x));
    const turn = (x: Vars) => {
      const between =
        direction(sub(across(a.end, x), across(a.start, x))) -
        direction(sub(b.end.at(x), b.start.at(x)));
      return wrap(2 * between) / 2;
    };
    return {
      residuals: [
        residual([a.start, ...lineParts(b), ...lineParts(mirror)], (x) =>
          side(across(a.start, x), b.start.at(x), b.end.at(x)),
        ),
        heldAngle(a, b, turn, lineParts(mirror)),
      ],
      fixed: [],
    };
  }
  // Arcs mirror by their underlying circles, not their ends (Onshape's Symmetric docs).
  if (a.kind === "circle" && b.kind === "circle" && !a.ends === !b.ends)
    return {
      residuals: [
        ...symmetric(a.center, b.center),
        residual([a.radius, b.radius], (x) => x[a.radius]! - x[b.radius]!),
      ],
      fixed: [],
    };
  return null;
}

/**
 * DISTANCE between points (along `direction`, signed by `alignment`), a point and a line, two
 * parallel lines, or a point or line and a circle's curve. Other pairs return null.
 */
function distance(
  a: Geometry,
  b: Geometry,
  constraint: SketchConstraint,
  x0: Vars,
): Compiled | ConstraintProblem | null {
  const length = constraint.length!;
  const only = (...residuals: Residual[]): Compiled => ({ residuals, fixed: [] });
  if (a.owner === b.owner && (a.part === null || b.part === null)) return null;
  if (a.kind === "point" && b.kind === "point") {
    const [p, q] = [a.point, b.point];
    if (constraint.direction === "MINIMUM")
      return only(residual([p, q], (x) => norm(sub(q.at(x), p.at(x))) - length));
    const axis = constraint.direction === "HORIZONTAL" ? 0 : 1;
    const along = (x: Vars) => q.at(x)[axis] - p.at(x)[axis];
    const branches = sides([p, q], (x, s) => along(x) - s * length, x0, length);
    // An alignment says which way; without one the drawing does.
    return constraint.alignment === "UNSPECIFIED"
      ? nearest(branches)
      : only(...branches[constraint.alignment === "ALIGNED" ? 0 : 1]!.residuals);
  }
  if (constraint.direction !== "MINIMUM")
    return {
      unsupported: `A ${constraint.direction} sketch distance between a ${a.kind} and a ${b.kind} is not supported locally yet; only between two points.`,
    };
  const pointLine = pair(a, b, "point", "line");
  if (pointLine) {
    const [{ point }, line] = pointLine;
    const offset = (x: Vars) => side(point.at(x), line.start.at(x), line.end.at(x));
    return nearest(
      sides([point, ...lineParts(line)], (x, s) => offset(x) - s * length, x0, length),
    );
  }
  const lines = pair(a, b, "line", "line");
  if (lines) {
    // Distance between lines holds them parallel: both ends of one at that offset from the other.
    const [l, m] = lines;
    const middle = side(midpoint(m.start.at(x0), m.end.at(x0)), l.start.at(x0), l.end.at(x0));
    // At distance 0 both sides are the same equation: one branch.
    return nearest(
      (length === 0 ? [1] : [1, -1]).map((s) => ({
        residuals: [
          ...[m.start, m.end].map((p) =>
            residual(
              [p, ...lineParts(l)],
              (x) => side(p.at(x), l.start.at(x), l.end.at(x)) - s * length,
            ),
          ),
          ...aligned(l, m, constraint, x0),
        ],
        off: Math.abs(middle - s * length),
      })),
    );
  }
  const pointCircle = pair(a, b, "point", "circle");
  if (pointCircle) {
    const [{ point }, circle] = pointCircle;
    const gap = (x: Vars) => norm(sub(point.at(x), circle.center.at(x))) - x[circle.radius]!;
    // Outside the circle or inside it.
    return nearest(
      sides([point, ...circleParts(circle)], (x, s) => gap(x) - s * length, x0, length),
    );
  }
  const lineCircle = pair(a, b, "line", "circle");
  if (lineCircle) {
    const [line, circle] = lineCircle;
    const offset = (x: Vars) => side(circle.center.at(x), line.start.at(x), line.end.at(x));
    return nearest(
      sides(
        [...lineParts(line), ...circleParts(circle)],
        (x, s) => offset(x) - s * (x[circle.radius]! + length),
        x0,
      ),
    );
  }
  if (a.kind === "circle" && b.kind === "circle")
    return {
      unsupported: "A sketch distance between two circles or arcs is not supported locally yet.",
    };
  return null;
}

// ------------------------------------------------------------------ solving

/** Checks a constraint against the sketch's entities when it's added. */
export function checkConstraint(
  entities: readonly SketchEntity[],
  constraint: SketchConstraint,
): ConstraintProblem | null {
  const layout = new Layout(entities);
  const compiled = compile(layout, constraint, Float64Array.from(layout.x0));
  return "residuals" in compiled ? null : compiled;
}

/**
 * Moves `entities` the least it can to satisfy `constraints` (each already checked). Returns the
 * solved entities, or null when the constraints conflict or the solve doesn't converge.
 *
 * Every constraint compiles once, from the drawing. FIX takes what it holds out of the solve at
 * its drawn values. A sided equation (a tangency, a distance from a line) takes the side the
 * drawing is nearest; only an exact tie forks, and the solve keeps the tied branch that moves the
 * drawing least (`nearest`). If two tied branches give different solutions that move it equally,
 * nothing but the way the sketch is written would choose, so the run stops (`unsupported`). Equations that share no unknowns are solved apart (`groups`), each
 * first from the drawing as it is. A group whose drawing is degenerate (a collapsed rectangle, a
 * point at a circle's center) can leave an equation with no slope to follow; it gets a few more
 * tries from deterministic pseudo-random perturbations of its free unknowns (`perturbed`), and a
 * solution found that way slides back toward the drawing (`pullBack`), so what the perturbation
 * didn't have to move ends where it was drawn.
 *
 * A solution must not collapse a line or arc drawn with its ends apart; a line a direction
 * constraint uses must end at least zeroLength long (it has no direction to hold otherwise); and
 * no radius drawn with a size may reach zero, nor any go negative. A line or arc whose ends sit
 * in different groups is judged once they're assembled; if it collapses, those groups solve
 * again as one.
 *
 * A group that fails with every sided equation on the drawing's side tries each one still
 * violated flipped to its other side, one at a time, with one plain solve each; if a single flip
 * solves, the run stops (`unsupported`) naming that constraint, since Onshape might pick that side
 * and solve. Each flip gets its own allowance, twice the work the group's own plain solve took
 * (TRY_WORK at least), so a failing group costs its failure plus at most its flips times that,
 * and the outcome doesn't depend on how many flips fail before the one that solves. When no flip
 * solves, it's a plain failure. Likewise, where equations fail with a FIXed line's ends pinned,
 * one more solve per fixed line (TRY_WORK each) lets its ends slide along it in drawn order
 * (Onshape may hold a fixed line the way std documents for a fixed arc); if that solves, the run
 * stops saying so. `unsupported` also stops the run for a group with more than COMBINATIONS tied
 * branch combinations.
 */
export function solveConstraints(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  unsupported: (message: string) => never = (message) => {
    throw new Error(message);
  },
): SketchEntity[] | null {
  if (constraints.length === 0) return [...entities];
  const layout = new Layout(entities);
  const x0 = Float64Array.from(layout.x0);
  const joined = coincidentPoints(layout, constraints);
  const residuals: Residual[] = [];
  const fixed = new Set<number>();
  /** The FIX constraints holding each fixed unknown. */
  const fixedBy = new Map<number, SketchConstraint[]>();
  const forks: (readonly (readonly Residual[])[])[] = [];
  /** The constraint each fork came from, to name it. */
  const forkOf = new Map<readonly (readonly Residual[])[], SketchConstraint>();
  // Sided equations solved on the drawing's side, with the branches they could flip to.
  const sided: {
    constraint: SketchConstraint;
    drawn: ReadonlySet<Residual>;
    others: readonly (readonly Residual[])[];
  }[] = [];
  for (const constraint of constraints) {
    const compiled = compile(layout, constraint, x0, joined);
    if (!("residuals" in compiled)) return null;
    residuals.push(...compiled.residuals);
    for (const index of compiled.fixed) {
      fixed.add(index);
      fixedBy.set(index, [...(fixedBy.get(index) ?? []), constraint]);
    }
    if (compiled.either) {
      forks.push(compiled.either);
      forkOf.set(compiled.either, constraint);
    }
    if (compiled.others?.length)
      sided.push({ constraint, drawn: new Set(compiled.residuals), others: compiled.others });
  }
  // For grouping, each fork stands in as one equation that reads what its branches read.
  const standIns = new Map(
    forks.map((fork) => [
      { deps: [...new Set(fork.flat().flatMap((r) => r.deps))], f: () => 0 } as Residual,
      fork,
    ]),
  );
  // An arc that moves at all keeps its ends on its circle.
  const touched = new Set([...residuals, ...standIns.keys()].flatMap((r) => r.deps));
  for (const equations of layout.implicit.values())
    if (equations.some((r) => r.deps.some((dep) => touched.has(dep)))) residuals.push(...equations);

  // Ends that must stay apart: a line a direction constraint uses, and any line or arc drawn
  // with its ends apart (an arc whose ends meet would silently become a full circle).
  const gap = (span: Span, x: Vars) => norm(sub(span.end.at(x), span.start.at(x)));
  const directed = new Set(directedLines(layout, constraints));
  const kept: Span[] = [
    ...layout.lines().filter((line) => directed.has(line) || gap(line, x0) >= ZERO_LENGTH),
    ...layout.arcEnds().filter((ends) => gap(ends, x0) >= ZERO_LENGTH),
  ];
  const measurable = (x: Vars, spans: readonly Span[]) =>
    spans.every((span) => gap(span, x) >= ZERO_LENGTH);
  const reads = (span: Span) => [...span.start.deps, ...span.end.deps];
  // No solution takes a radius drawn with a size to zero or below, or any radius below zero: the
  // tangency and distance equations would accept one (a circle "tangent" from the wrong side),
  // and it isn't a circle. A radius drawn zero that nothing sizes stays zero, and fails as an
  // entity drawn without one (SKETCH_INPUT_INVALID), not as a conflict.
  const positive = (x: Vars, radii: readonly number[]) =>
    radii.every((index) =>
      x0[index]! >= ZERO_LENGTH ? x[index]! >= ZERO_LENGTH : x[index]! > -ZERO_LENGTH,
    );
  // Perturbations scale with the smallest dimension, or stay just above zeroLength without one.
  const sizes = constraints.flatMap(({ length }) =>
    length !== null && length > 0 ? [length] : [],
  );
  const reach = sizes.length ? Math.min(...sizes) * 1e-3 : ZERO_LENGTH * 100;

  // FIX on a whole line pins its ends. Onshape may instead hold a fixed line the way std
  // documents for a fixed arc (the curve fixed, its ends free along it). Where equations fail from
  // `start`, each fixed line they read gets one plain solve (TRY_WORK) of the whole group its ends
  // then join: only what that FIX alone holds is set free, to slide along the line in drawn order,
  // and every other equation and FIX stays, including a FIX on one of its ends on its own (ties
  // take their first branch). If that solves, the run stops saying so.
  const fixedLines = constraints.flatMap((constraint) => {
    const g =
      constraint.type === "FIX" && constraint.first ? layout.resolve(constraint.first) : null;
    return g?.kind === "line" ? [{ constraint, line: g }] : [];
  });
  const slides = (failing: readonly Residual[], start: Vars) => {
    for (const { constraint, line } of fixedLines) {
      const released = new Set(
        [...line.start.deps, ...line.end.deps].filter((index) =>
          fixedBy.get(index)?.every((by) => by === constraint),
        ),
      );
      if (!failing.some((r) => r.deps.some((dep) => released.has(dep)))) continue;
      // Both ends stay on the drawn line, and the line keeps its drawn heading as an angle (held
      // to zeroAngle): ends slid close together can't tilt it within zeroLength of the line, and
      // can't pass each other.
      const [s0, e0] = [line.start.at(x0), line.end.at(x0)];
      const heading = direction(sub(e0, s0));
      const along = [
        ...[line.start, line.end].map((p) => residual([p], (x) => side(p.at(x), s0, e0))),
        heldAngle(line, line, (x) =>
          wrap(direction(sub(line.end.at(x), line.start.at(x))) - heading),
        ),
      ];
      const loose = new Set([...fixed].filter((index) => !released.has(index)));
      const joined = groups(
        [
          ...residuals.filter((r) => !standIns.has(r)),
          ...forks.flatMap((fork) => fork[0]!),
          ...along,
        ],
        loose,
      ).filter((group) => [...released].some((index) => group.unknowns.has(index)));
      const unknowns = new Set(joined.flatMap((group) => [...group.unknowns]));
      const equations = new Set([...failing, ...joined.flatMap((group) => group.residuals)]);
      const tried = settle(start, [...equations], loose, layout, {
        done: 0,
        limit: TRY_WORK,
        plain: true,
      });
      const spans = kept.filter((span) => reads(span).some((dep) => unknowns.has(dep)));
      const radii = layout.radii.filter((index) => unknowns.has(index));
      if (tried.held && measurable(tried.x, spans) && positive(tried.x, radii))
        unsupported(
          `The sketch only solves if the fixed line ${line.owner}'s ends slide along it (FIX ${constraint.id}); Onshape's rule for fixed lines isn't known locally.`,
        );
    }
  };

  // Independent groups solve apart. A span (a line's or arc's ends) whose ends all sit in one
  // group is judged with it; one spanning groups is judged once they're assembled, and if it
  // collapses there, just the groups it spans solve again as one, until nothing collapses.
  const x = Float64Array.from(x0);
  let pieces = groups([...residuals, ...standIns.keys()], fixed);
  const free = new Set(pieces.flatMap((group) => [...group.unknowns]));
  // Spans by the free unknowns they read, so a group finds its own without scanning the sketch's;
  // one that reads none never moves and is judged with every group.
  const spansOf = new Map<number, Span[]>();
  const anchored: Span[] = [];
  for (const span of kept) {
    const moving = reads(span).filter((dep) => free.has(dep));
    if (moving.length === 0) anchored.push(span);
    for (const dep of moving) spansOf.set(dep, [...(spansOf.get(dep) ?? []), span]);
  }
  const solveGroup = (group: Group) => {
    const near = new Set([...group.unknowns].flatMap((dep) => spansOf.get(dep) ?? []));
    const own = [
      ...anchored,
      ...[...near].filter((span) =>
        reads(span).every((dep) => !free.has(dep) || group.unknowns.has(dep)),
      ),
    ];
    const base = group.residuals.filter((r) => !standIns.has(r));
    const choices = group.residuals.flatMap((r) => {
      const fork = standIns.get(r);
      return fork ? [fork] : [];
    });
    const radii = layout.radii.filter((index) => group.unknowns.has(index));
    const accept = (solved: Vars | null) =>
      solved && measurable(solved, own) && positive(solved, radii) ? solved : null;
    // One plain solve from the drawing and, if that fails, one from each perturbation of it, each
    // within `limit` work. Gives the accepted solution, if any, and where the plain solve stopped.
    const attempt = (equations: readonly Residual[], limit = Infinity, flip = false) => {
      const spent: Work = { done: 0, limit, plain: flip };
      const plain = { ...settle(x0, equations, fixed, layout, spent), work: spent.done };
      let solved = accept(plain.held ? plain.x : null);
      for (let seed = 1; !solved && seed <= SEEDS; seed++) {
        const work: Work = { done: 0, limit, plain: flip };
        const start = perturbed(x0, group.unknowns, seed, reach, layout);
        const found = leastMovement(start, equations, fixed, layout, work);
        solved = accept(found && pullBack(found, x0, equations, fixed, layout, work));
      }
      return { solved, plain };
    };
    // Each combination of the group's tied branches; the one that moves the drawing least wins.
    // Two different solutions that move it equally leave nothing to choose by but the order of
    // the constraints or the way they're written, so the run stops naming the forks that differ.
    const count = choices.reduce((product, fork) => product * fork.length, 1);
    if (count > COMBINATIONS)
      return unsupported(
        `A sketch with ${count} combinations of tied branches (tangencies or distances drawn exactly between two sides) in one connected part is not supported locally yet; at most ${COMBINATIONS} are tried. Draw some of them nearer the side they should take.`,
      );
    const movement = (v: Vars) =>
      [...group.unknowns].reduce((sum, index) => sum + (v[index]! - x0[index]!) ** 2, 0);
    const found: { v: Vars; moved: number; picks: readonly (readonly Residual[])[] }[] = [];
    // Where the first plain solve stopped, whether its equations held there (if they did, the
    // solution was refused: a collapse or a non-positive radius), and the work it took. Flips
    // start there.
    let stopped: { x: Vars; held: boolean; work: number } | undefined;
    for (const picks of combinations(choices)) {
      const { solved: v, plain } = attempt([...base, ...picks.flat()]);
      stopped ??= plain;
      if (v) found.push({ v, moved: Math.sqrt(movement(v)), picks });
    }
    found.sort((p, q) => p.moved - q.moved);
    const [best] = found;
    if (best) {
      // Every combination that moves the drawing as little as the best but lands elsewhere, not
      // just the runner-up: ties that solve the same either way can sort between them. Named are
      // the forks the nearest such rivals (those differing from the best in fewest forks) pick
      // otherwise: a tie that solves the same either way isn't named alongside one that doesn't.
      const apart = (p: Vars, q: Vars) =>
        [...group.unknowns].some((index) => Math.abs(p[index]! - q[index]!) > ZERO_LENGTH);
      const rivals = found
        .filter((other) => other.moved - best.moved <= ZERO_LENGTH && apart(best.v, other.v))
        .map((other) => choices.filter((_, k) => best.picks[k] !== other.picks[k]));
      if (rivals.length) {
        const fewest = Math.min(...rivals.map((forks) => forks.length));
        const nearest = new Set(rivals.filter((forks) => forks.length === fewest).flat());
        const named = choices
          .filter((fork) => nearest.has(fork))
          .map((fork) => forkOf.get(fork)!)
          .map(({ type, id }) => `${type} ${id}`);
        return unsupported(
          `The sketch solves equally well with ${named.join(", ")} on either side; Onshape's choice isn't known locally.`,
        );
      }
      for (const index of group.unknowns) x[index] = best.v[index]!;
      return true;
    }
    // Failing with every sided equation on the drawing's side, the group might still solve with
    // one on the other side, which Onshape might choose. Each sided equation still violated where
    // the solve stopped (a satisfied one can't be the cause; but if every equation held and the
    // solution was refused, any of them can) is flipped alone, with one plain solve from there
    // and the first combination of any ties, within twice the work that solve took (TRY_WORK at
    // least). If one solves, stop and say so rather than report a plain failure.
    const at = stopped?.x ?? x0;
    const refused = stopped?.held ?? false;
    const ties = combinations(choices)[0]!.flat();
    // Where the drawing or that stop leaves the solve nothing to follow (`stuck`), a flip from the
    // stop can stall the same way, so each flip runs as a plain solve does instead: from the
    // drawing, then its perturbations, each solve within the same allowance.
    const degenerate = [x0, at].some((v) => stuck(v, [...base, ...ties], fixed, layout));
    const allowance = Math.max(TRY_WORK, 2 * (stopped?.work ?? 0));
    const flip = (equations: readonly Residual[]) => {
      if (degenerate) return attempt(equations, allowance, true).solved;
      const tried = settle(at, equations, fixed, layout, {
        done: 0,
        limit: allowance,
        plain: true,
      });
      return tried.held ? accept(tried.x) : null;
    };
    const flippable = sided.filter(
      ({ drawn }) => base.some((r) => drawn.has(r)) && (refused || !holds([...drawn], at, 1)),
    );
    for (const { constraint, drawn, others } of flippable)
      for (const branch of others)
        if (flip([...base.filter((r) => !drawn.has(r)), ...branch, ...ties]))
          return unsupported(
            `The sketch only solves with ${constraint.type} ${constraint.id} on the other side from where it's drawn; Onshape's choice isn't known locally.`,
          );
    const start = Float64Array.from(x);
    for (const index of group.unknowns) start[index] = at[index]!;
    slides([...base, ...ties], start);
    return false;
  };
  for (const group of pieces) if (!solveGroup(group)) return null;
  for (let round = 0; round < pieces.length; round++) {
    const collapsed = kept.filter((span) => gap(span, x) < ZERO_LENGTH);
    if (collapsed.length === 0) break;
    // Merge the groups each collapsed span reaches, and solve each merged group again.
    const owner = (dep: number) => pieces.findIndex((group) => group.unknowns.has(dep));
    const reached = groups(
      collapsed.map((span) => ({ deps: reads(span).filter((dep) => free.has(dep)), f: () => 0 })),
      new Set(),
    ).map((link) => new Set([...link.unknowns].map(owner)));
    const merging = reached.filter((indices) => indices.size > 1);
    // A collapsed span within one group was already judged there; nothing is left to try.
    if (merging.length === 0) return null;
    const rejoined = merging.map((indices) => {
      const parts = [...indices].map((i) => pieces[i]!);
      return {
        residuals: parts.flatMap((part) => part.residuals),
        unknowns: new Set(parts.flatMap((part) => [...part.unknowns])),
      };
    });
    for (const group of rejoined) if (!solveGroup(group)) return null;
    const replaced = new Set(merging.flatMap((indices) => [...indices]));
    pieces = [...pieces.filter((_, i) => !replaced.has(i)), ...rejoined];
  }
  // Equations with every unknown fixed hold as drawn or not at all; so must one branch of a fork.
  const pinned = residuals.filter((r) => r.deps.every((dep) => fixed.has(dep)));
  if (!holds(pinned, x, 1)) {
    slides(pinned, x);
    return null;
  }
  if (!holds(residuals, x, 1) || !measurable(x, kept)) return null;
  if (!forks.every((fork) => fork.some((branch) => holds(branch, x, 1)))) return null;
  return layout.read(x);
}

/** At most this many combinations of a group's tied branches are tried; more stops the run. */
const COMBINATIONS = 16;
/**
 * The least solver work (Jacobians built plus damped steps tried) one flip or slide gets. Every
 * flip that solved in the tests and round 8 probes took 4 to 32. A long chain swung round takes
 * more, and its group's own plain solve takes long too: 50 lines need 94 where the plain solve
 * takes 99, 80 lines 294 where it takes 183. So a flip gets twice the plain solve's work when
 * that's more. One that hasn't converged within its allowance counts as not solving; a conflict
 * would otherwise creep on for the full hundred iterations.
 */
const TRY_WORK = 60;

/** Every way to pick one branch from each fork, first branches first. */
function combinations<T>(forks: readonly (readonly T[])[]): T[][] {
  let picks: T[][] = [[]];
  for (const fork of forks)
    picks = picks.flatMap((pick) => fork.map((branch) => [...pick, branch]));
  return picks;
}

/** Perturbed starts a degenerate group gets after its plain solve fails. */
const SEEDS = 4;

/** Equations that share no free unknowns with any other group's. */
interface Group {
  readonly residuals: Residual[];
  readonly unknowns: Set<number>;
}

/**
 * Splits equations into groups that share no free unknowns. Each group's least movement doesn't
 * depend on the others', so they solve apart, and a conflict in one costs only its own size.
 */
function groups(residuals: readonly Residual[], fixed: ReadonlySet<number>): Group[] {
  const parent = new Map<number, number>();
  const root = (index: number): number => {
    const up = parent.get(index) ?? index;
    return up === index ? index : root(up);
  };
  const free = (r: Residual) => r.deps.filter((dep) => !fixed.has(dep));
  for (const deps of residuals.map(free)) {
    const [first, ...rest] = deps;
    for (const dep of rest) parent.set(root(dep), root(first!));
  }
  const byRoot = new Map<number, Group>();
  for (const r of residuals) {
    const deps = free(r);
    if (deps.length === 0) continue;
    const key = root(deps[0]!);
    const group = byRoot.get(key) ?? { residuals: [], unknowns: new Set<number>() };
    group.residuals.push(r);
    for (const dep of deps) group.unknowns.add(dep);
    byRoot.set(key, group);
  }
  return [...byRoot.values()];
}

/**
 * `x0` with every unknown in `unknowns` moved by a pseudo-random amount up to `reach` (lengths) or
 * a thousandth of a radian (angles and curve parameters), the same for the same seed every time.
 * The first seed moves everything up, the second everything down, later seeds either way.
 * `pullBack` then slides what nothing else places back onto where it was drawn, so a seed decides
 * which way collapsed geometry opens, not where it ends up (a collapsed rectangle ends centered
 * on the point it was drawn at). Fixed unknowns aren't in `unknowns`, so FIX and pinned values
 * never move.
 */
function perturbed(
  x0: Vars,
  unknowns: ReadonlySet<number>,
  seed: number,
  reach: number,
  layout: Layout,
): Vars {
  const next = mulberry32(seed);
  const x = Float64Array.from(x0);
  for (const index of [...unknowns].sort((p, q) => p - q)) {
    const offset = seed === 1 ? 0.5 + next() / 2 : seed === 2 ? -0.5 - next() / 2 : 2 * next() - 1;
    x[index] = x[index]! + offset * (layout.angular[index] ? 1e-3 : reach);
  }
  return x;
}

/** A small deterministic generator of numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Slides a solution found from a perturbed start back toward the drawing `x0`, staying on the
 * equations: each round moves along the part of the way back that the equations don't resist
 * (the null space of their Jacobian), then settles back onto them. Whatever the perturbation
 * didn't need to move returns where it was drawn, and a line nothing lengthens shrinks back to
 * nothing.
 */
function pullBack(
  solved: Vars,
  x0: Vars,
  residuals: readonly Residual[],
  fixed: ReadonlySet<number>,
  layout: Layout,
  work?: Work,
): Vars {
  const unknowns = unknownsOf(residuals, fixed);
  const gap = (x: Vars) => Math.hypot(...unknowns.map((index) => x[index]! - x0[index]!));
  let x = solved;
  for (let round = 0; round < 50 && gap(x) > 0; round++) {
    const J = jacobian(x, residuals, unknowns, layout);
    const back = Float64Array.from(unknowns, (index) => x0[index]! - x[index]!);
    const resisted = times(J, back);
    // dampedStep gives minus the part of `back` the equations resist.
    const along = dampedStep(J, normalMatrix(J), resisted, 1e-12);
    if (!along) break;
    let moved: Vars | null = null;
    for (let fraction = 1; !moved && fraction > 1e-6; fraction /= 2) {
      const trial = Float64Array.from(x);
      unknowns.forEach(
        (index, j) => (trial[index] = x[index]! + fraction * (back[j]! + along[j]!)),
      );
      const settled = leastMovement(trial, residuals, fixed, layout, work);
      if (settled && gap(settled) < gap(x) * (1 - 1e-9)) moved = settled;
    }
    if (!moved) break;
    x = moved;
  }
  return x;
}

/**
 * Lines whose direction some constraint uses: horizontal, vertical, parallel, perpendicular,
 * angle, tangent, normal, a mirror line, a coincidence or distance involving the line. Each must
 * end at least zeroLength long.
 */
function directedLines(layout: Layout, constraints: readonly SketchConstraint[]): LineGeometry[] {
  const directed = new Set<LineGeometry>();
  const resolve = (ref: SketchRef | null) => (ref ? layout.resolve(ref) : undefined);
  for (const constraint of constraints) {
    const uses =
      constraint.type === "MIRROR"
        ? [resolve(constraint.mirror)]
        : ["FIX", "MIDPOINT", "LENGTH", "EQUAL"].includes(constraint.type)
          ? []
          : [resolve(constraint.first), resolve(constraint.second)];
    for (const g of uses) if (g?.kind === "line") directed.add(g);
  }
  return [...directed];
}

/**
 * Groups the points COINCIDENT constraints hold on each other, directly or through other points.
 * Only point-to-point coincidences join: two points that each lie on the same curve aren't joined.
 */
function coincidentPoints(layout: Layout, constraints: readonly SketchConstraint[]): Joined {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    const up = parent.get(key);
    return up === undefined || up === key ? key : root(up);
  };
  const point = (ref: SketchRef | null) =>
    ref && layout.resolve(ref)?.kind === "point"
      ? ref.part
        ? `${ref.entity}.${ref.part}`
        : ref.entity
      : null;
  for (const constraint of constraints) {
    const [p, q] = [point(constraint.first), point(constraint.second)];
    if (constraint.type === "COINCIDENT" && p && q) parent.set(root(p), root(q));
  }
  return (p, q) => root(p) === root(q);
}

/**
 * Damped Gauss-Newton (Levenberg-Marquardt) in minimum-norm form: each step is the smallest change
 * to the free unknowns that zeroes the linearized equations, so the solution stays near `x0`.
 * Redundant but consistent equations (std's rectangle) are fine (`settle` sets aside the nearly
 * dependent ones first); conflicting ones never reach zero.
 */
function leastMovement(
  x0: Vars,
  residuals: readonly Residual[],
  fixed: ReadonlySet<number>,
  layout: Layout,
  work?: Work,
): Vars | null {
  const { x, held } = settle(x0, residuals, fixed, layout, work);
  return held ? x : null;
}

/** Solver work done so far, counted in Jacobians built and damped steps tried, and its limit. */
interface Work {
  done: number;
  readonly limit: number;
  /**
   * Plain steps on every equation from the start, without `settle`'s first pass: flips and slides
   * only ask whether some solution exists, and the first pass can spend their allowance on a way
   * that leads Gauss-Newton astray before plain steps get to try.
   */
  readonly plain?: boolean;
}

/**
 * `leastMovement`'s iteration: where it ended, whether the equations hold there.
 *
 * Each step first goes only along the equations independent of the rest where it stands
 * (`independentRows`). A redundant constraint, which at a drawing that doesn't satisfy it is
 * only nearly dependent on the others, is left out of that step: a minimum-norm step would
 * divide its small mismatch by a slope near zero along a direction nothing else constrains, and
 * fling the geometry along it (a rectangle drawn 31 mm wide solved 0.13 mm wide). Redundant
 * equations hold wherever the others do, so this usually ends solved. Which of a dependent group
 * to leave out is a choice, though (angle equations first, or the others first), and at a
 * drawing far from its constrained shape the two choices can land on different solutions; when
 * the first ends solved, the second is tried too, and the one nearer `x0` wins. If the first
 * doesn't end solved, the left-out equations weren't redundant (a conflict, or two equations that
 * really are nearly parallel), or leaving them out led Gauss-Newton astray, so plain steps on
 * every equation start over from `x0`, the way the solve ran before equations were ever left out.
 */
function settle(
  x0: Vars,
  residuals: readonly Residual[],
  fixed: ReadonlySet<number>,
  layout: Layout,
  work: Work = { done: 0, limit: Infinity },
): { x: Vars; held: boolean } {
  if (!work.plain) {
    const first = iterate(x0, residuals, fixed, layout, work, true);
    if (!first.leftOut) return first;
    if (first.held) {
      // Leaving out the other equations before angles is just as valid; keep whichever lands
      // nearer the start.
      const other = iterate(x0, residuals, fixed, layout, work, true, true);
      const unknowns = unknownsOf(residuals, fixed);
      const moved = (x: Vars) => unknowns.reduce((sum, i) => sum + (x[i]! - x0[i]!) ** 2, 0);
      return other.held && moved(other.x) < moved(first.x) ? other : first;
    }
  }
  return iterate(x0, residuals, fixed, layout, work, false);
}

/**
 * Under this, an equation's slope beyond what the others' explain is nearly none, as a fraction
 * of its own (squared): it's redundant where the solve stands. The redundant row of a 30 x 20
 * rectangle drawn 1 to 9 mm skewed sits at 1e-6 to 6e-3 at the drawing and falls toward zero as
 * it solves, and the rows a step needs sit at 0.15 and up. Two equations whose slopes are within
 * 13 degrees of each other fall under it too; if they aren't really redundant, `settle` finishes
 * with plain steps.
 */
const NEARLY_DEPENDENT = 0.05;

/**
 * The rows of `J` a step can take at once: all but those nearly dependent on the others. A first
 * pass, inside the Gram matrix's envelope, finds the rows dependent on those kept before them
 * (slope beyond what those explain under NEARLY_DEPENDENT of its own, squared), and from the same
 * factor, the combination of earlier rows each one nearly equals. Which rows of a dependent group
 * go shouldn't depend on which came last, so the core of each combination (merged where cores
 * overlap) is chosen again by size (`choose`). Angle equations go before the others both times:
 * where a closed shape's equations depend on each other, every one of them is nearly dependent,
 * but only the angles are implied by the rest (three right angles and the closed corners make the
 * fourth; the corners aren't implied by the angles). Rows in `out` stay out. A row with no slope
 * at all stays in; it's stuck, not redundant.
 */
function independentRows(J: Jacobian, angular: Uint8Array, out: ReadonlySet<number>): number[] {
  const m = J.offsets.length - 1;
  const unit = unitGram(J);
  const L = Float64Array.from(unit);
  const first = Int32Array.from({ length: m }, (_, i) => {
    let j = 0;
    while (j < i && L[i * m + j] === 0) j++;
    return j;
  });
  // Each column's rows below the diagonal, inside the envelope.
  const below = Array.from({ length: m }, (): number[] => []);
  for (let i = 0; i < m; i++) for (let c = first[i]!; c < i; c++) below[c]!.push(i);
  const used = new Uint8Array(m);
  const left: number[] = [];
  for (let j = 0; j < m; j++) {
    if (out.has(j)) continue;
    let rest = 1;
    for (let k = first[j]!; k < j; k++) if (used[k]) rest -= L[j * m + k]! ** 2;
    if (!(rest > NEARLY_DEPENDENT)) {
      left.push(j);
      continue;
    }
    const pivot = Math.sqrt(rest);
    L[j * m + j] = pivot;
    for (const i of below[j]!) {
      let sum = L[i * m + j]!;
      for (let k = Math.max(first[i]!, first[j]!); k < j; k++)
        if (used[k]) sum -= L[i * m + k]! * L[j * m + k]!;
      L[i * m + j] = sum / pivot;
    }
    used[j] = 1;
  }
  const rows = Array.from({ length: m }, (_, i) => i).filter((i) => !out.has(i));
  if (left.length === 0) return rows;
  // A left-out row d nearly equals the kept rows before it weighted by c, where L^T c holds its
  // own factor entries. The rows weighing over a tenth of the most (or of d's own 1) are the core
  // of its dependence; overlapping cores merge into groups.
  const parent = new Map<number, number>();
  const root = (i: number): number => {
    const up = parent.get(i) ?? i;
    return up === i ? i : root(up);
  };
  // Every row each dependence touches at all (over a thousandth): what its core is judged in.
  const touches = new Map<number, number[]>();
  for (const d of left) {
    const c = new Float64Array(d);
    for (let k = d - 1; k >= 0; k--) {
      if (!used[k]) continue;
      let sum = k >= first[d]! ? L[d * m + k]! : 0;
      for (const i of below[k]!) if (i < d && used[i]) sum -= L[i * m + k]! * c[i]!;
      c[k] = sum / L[k * m + k]!;
    }
    const largest = Math.max(1, ...c.map(Math.abs));
    for (let k = 0; k < d; k++) if (Math.abs(c[k]!) >= 0.1 * largest) parent.set(root(k), root(d));
    touches.set(
      d,
      Array.from({ length: d }, (_, k) => k).filter((k) => Math.abs(c[k]!) >= 1e-3 * largest),
    );
  }
  const groups = new Map<number, number[]>();
  for (const i of new Set([...parent.keys(), ...left]))
    groups.set(root(i), [...(groups.get(root(i)) ?? []), i]);
  const dropped = new Set<number>();
  for (const group of groups.values()) {
    const members = group.sort((p, q) => p - q);
    const context = [
      ...new Set(group.flatMap((d) => touches.get(d) ?? []).filter((k) => !group.includes(k))),
    ];
    const dependent = group.filter((j) => left.includes(j)).length;
    const kept = new Set(choose(unit, m, members, context, angular, members.length - dependent));
    for (const i of members) if (!kept.has(i)) dropped.add(i);
  }
  return rows.filter((i) => !dropped.has(i));
}

/**
 * The rows of a dependent group to keep, chosen by size: each one's slope is first projected off
 * the `context` rows its dependence also runs through (which are independent, and stay), then a
 * Cholesky takes the most independent row next (other equations before angle equations), each
 * judged against those taken before it, until it has `keep` of them or the rest are under
 * NEARLY_DEPENDENT of their own. Only exact ties fall back on order.
 */
function choose(
  unit: Vars,
  m: number,
  rows: readonly number[],
  context: readonly number[],
  angular: Uint8Array,
  keep: number,
): number[] {
  const f = context.length;
  const G = new Float64Array(f * f);
  context.forEach((i, p) =>
    context.forEach((j, q) => (G[p * f + q] = unit[i * m + j]! + (p === q ? 1e-12 : 0))),
  );
  const factored = f > 0 ? factor(G, f) : null;
  // The rows' Gram, less what the context explains (the Schur complement).
  const size = rows.length;
  const columns = rows.map((s) => Float64Array.from(context, (i) => unit[s * m + i]!));
  const projected = factored ? columns.map((c) => substitute(factored, c)) : null;
  const M = new Float64Array(size * size);
  rows.forEach((s, a) =>
    rows.forEach((t, b) => {
      let value = unit[s * m + t]!;
      if (projected) for (let p = 0; p < f; p++) value -= columns[a]![p]! * projected[b]![p]!;
      M[a * size + b] = value;
    }),
  );
  const rest = Float64Array.from({ length: size }, (_, a) => M[a * size + a]!);
  const L = new Float64Array(size * size);
  const taken: number[] = [];
  const waiting = new Set(rows.keys());
  while (taken.length < keep) {
    let best = -1;
    for (const a of waiting)
      if (
        rest[a]! > NEARLY_DEPENDENT &&
        (best < 0 ||
          angular[rows[a]!]! < angular[rows[best]!]! ||
          (angular[rows[a]!] === angular[rows[best]!] && rest[a]! > rest[best]!))
      )
        best = a;
    if (best < 0) break;
    const pivot = Math.sqrt(rest[best]!);
    waiting.delete(best);
    for (const a of waiting) {
      let sum = M[a * size + best]!;
      for (const k of taken) sum -= L[a * size + k]! * L[best * size + k]!;
      L[a * size + best] = sum / pivot;
      rest[a] = rest[a]! - L[a * size + best]! ** 2;
    }
    taken.push(best);
  }
  return taken.map((a) => rows[a]!);
}

/** `A^-1 b`, given `A`'s Cholesky factor from `factor`. */
function substitute({ A, first }: { A: Vars; first: Int32Array }, b: Vars): Vars {
  const size = first.length;
  const y = Float64Array.from(b);
  for (let i = 0; i < size; i++) {
    for (let k = first[i]!; k < i; k++) y[i] = y[i]! - A[i * size + k]! * y[k]!;
    y[i] = y[i]! / A[i * size + i]!;
  }
  for (let i = size - 1; i >= 0; i--) {
    for (let k = i + 1; k < size; k++) if (first[k]! <= i) y[i] = y[i]! - A[k * size + i]! * y[k]!;
    y[i] = y[i]! / A[i * size + i]!;
  }
  return y;
}

/**
 * `J J^T` scaled to a unit diagonal, so each entry is how far two rows point the same way. A
 * row with no slope keeps a 1 on the diagonal and nothing else: it's independent of everything.
 */
function unitGram(J: Jacobian): Vars {
  const m = J.offsets.length - 1;
  const { A } = normalMatrix(J, true);
  const scale = Float64Array.from({ length: m }, (_, i) => {
    const own = A[i * m + i]!;
    return own > 0 ? 1 / Math.sqrt(own) : 0;
  });
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) A[i * m + j] = A[i * m + j]! * scale[i]! * scale[j]!;
  for (let i = 0; i < m; i++) A[i * m + i] = 1;
  return A;
}

/**
 * One damped Gauss-Newton run over `residuals` (see `settle`): with `independent`, each step
 * leaves out the rows `independentRows` finds nearly dependent (`swap`: leaving out the other
 * equations before angle equations), and `leftOut` says whether any were.
 */
function iterate(
  x0: Vars,
  residuals: readonly Residual[],
  fixed: ReadonlySet<number>,
  layout: Layout,
  work: Work,
  independent: boolean,
  swap = false,
): { x: Vars; held: boolean; leftOut: boolean } {
  const unknowns = unknownsOf(residuals, fixed);
  const evaluate = (x: Vars) => Float64Array.from(residuals, (r) => r.f(x));
  const squared = (f: Vars) => f.reduce((sum, value) => sum + value * value, 0);
  const angular = Uint8Array.from(residuals, (r) => Number(!r.angle === swap));
  const out = new Set<number>();

  let x = Float64Array.from(x0);
  let f = evaluate(x);
  let leftOut = false;
  if (f.some((value) => !Number.isFinite(value))) return { x, held: false, leftOut };
  // With every unknown fixed, the equations hold or they don't.
  if (unknowns.length === 0) return { x, held: holds(residuals, x, 1), leftOut };
  let damping = 1e-9;
  for (let iteration = 0; iteration < 100 && !holds(residuals, x, 1e-4); iteration++) {
    if (++work.done > work.limit) break;
    const full = jacobian(x, residuals, unknowns, layout);
    // Once left out, an equation stays out of this run: taking it back as soon as it looks
    // independent again would switch the steps' direction back and forth.
    const rows = independent ? independentRows(full, angular, out) : null;
    if (rows) for (const i of residuals.keys()) if (!rows.includes(i)) out.add(i);
    const some = rows && rows.length < residuals.length ? rows : null;
    if (some) leftOut = true;
    const J = some ? rowsOf(full, some) : full;
    const target = some ? Float64Array.from(some, (i) => f[i]!) : f;
    // Damping retries reuse the Jacobian, so they share its normal matrix too.
    const normal = normalMatrix(J);
    let improved = false;
    while (!improved && damping < 1e8 && ++work.done <= work.limit) {
      const step = dampedStep(J, normal, target, damping);
      if (!step) {
        damping *= 10;
        continue;
      }
      const trial = Float64Array.from(x);
      unknowns.forEach((index, j) => (trial[index] = trial[index]! + step[j]!));
      const g = evaluate(trial);
      if (g.every(Number.isFinite) && squared(g) < squared(f)) {
        [x, f] = [trial, g];
        damping = Math.max(damping / 10, 1e-15);
        improved = true;
      } else damping *= 10;
    }
    if (!improved) break;
  }
  return { x, held: holds(residuals, x, 1), leftOut };
}

/**
 * Whether the equations give a solve at `x` nothing to follow: one is undefined there (a point on
 * a line drawn with no length is on no side of it), one is off with no slope along any of its
 * free unknowns (a point drawn on the point it's measured from), or an unknown an off equation
 * reads has no slope in any equation (a point drawn at the center of circles it's on and measured
 * from: its equations only slope along the radii, which others dimension).
 */
function stuck(
  x: Vars,
  residuals: readonly Residual[],
  fixed: ReadonlySet<number>,
  layout: Layout,
): boolean {
  const J = jacobian(x, residuals, unknownsOf(residuals, fixed), layout);
  const sloped = new Uint8Array(J.n);
  const offRead = new Uint8Array(J.n);
  const row = (i: number) => J.slopes.subarray(J.offsets[i]!, J.offsets[i + 1]!);
  for (const [i, r] of residuals.entries()) {
    if (!Number.isFinite(r.f(x))) return true;
    const off = !holds([r], x, 1);
    if (off && row(i).length > 0 && row(i).every((s) => s === 0)) return true;
    for (let e = J.offsets[i]!; e < J.offsets[i + 1]!; e++) {
      if (J.slopes[e] !== 0) sloped[J.columns[e]!] = 1;
      if (off) offRead[J.columns[e]!] = 1;
    }
  }
  return offRead.some((read, c) => read === 1 && sloped[c] === 0);
}

/** The free unknowns a set of equations reads, in order. */
const unknownsOf = (residuals: readonly Residual[], fixed: ReadonlySet<number>) =>
  [...new Set(residuals.flatMap((r) => r.deps))]
    .filter((index) => !fixed.has(index))
    .sort((p, q) => p - q);

/**
 * A Jacobian by rows (compressed sparse rows). An equation reads only a few unknowns (at most eight
 * here), so each row keeps just its slopes along those: row i's are `slopes[offsets[i]]` up to
 * `slopes[offsets[i + 1]]`, at `columns` of the same entries.
 */
interface Jacobian {
  /** How many unknowns (columns) the solve has. */
  readonly n: number;
  readonly offsets: Int32Array;
  readonly columns: Int32Array;
  readonly slopes: Float64Array;
}

/** The equations' Jacobian over `unknowns`, by central differences over each one's own unknowns. */
function jacobian(
  x: Vars,
  residuals: readonly Residual[],
  unknowns: readonly number[],
  layout: Layout,
): Jacobian {
  const column = new Map(unknowns.map((index, j) => [index, j]));
  const offsets = new Int32Array(residuals.length + 1);
  residuals.forEach((r, i) => {
    const read = r.deps.reduce((count, dep) => count + (column.has(dep) ? 1 : 0), 0);
    offsets[i + 1] = offsets[i]! + read;
  });
  const columns = new Int32Array(offsets[residuals.length]!);
  const slopes = new Float64Array(columns.length);
  const at = Float64Array.from(x);
  residuals.forEach((r, i) => {
    let entry = offsets[i]!;
    for (const dep of r.deps) {
      const j = column.get(dep);
      if (j === undefined) continue;
      const h = 1e-7 * layout.scale[dep]! + 1e-12 * Math.abs(at[dep]!);
      const keep = at[dep]!;
      at[dep] = keep + h;
      const up = r.f(at);
      at[dep] = keep - h;
      const down = r.f(at);
      at[dep] = keep;
      columns[entry] = j;
      slopes[entry++] = (up - down) / (2 * h);
    }
  });
  return { n: unknowns.length, offsets, columns, slopes };
}

/** `J v`, one entry per equation. */
function times(J: Jacobian, v: Vars): Vars {
  const out = new Float64Array(J.offsets.length - 1);
  for (let i = 0; i < out.length; i++)
    for (let e = J.offsets[i]!; e < J.offsets[i + 1]!; e++)
      out[i] = out[i]! + J.slopes[e]! * v[J.columns[e]!]!;
  return out;
}

/** `J^T v`, one entry per unknown. */
function transposed(J: Jacobian, v: Vars): Vars {
  const out = new Float64Array(J.n);
  for (let i = 0; i < J.offsets.length - 1; i++)
    for (let e = J.offsets[i]!; e < J.offsets[i + 1]!; e++)
      out[J.columns[e]!] = out[J.columns[e]!]! + J.slopes[e]! * v[i]!;
  return out;
}

/** The rows `rows` of `J`, in that order. */
function rowsOf(J: Jacobian, rows: readonly number[]): Jacobian {
  const offsets = new Int32Array(rows.length + 1);
  rows.forEach((i, r) => (offsets[r + 1] = offsets[r]! + J.offsets[i + 1]! - J.offsets[i]!));
  const columns = new Int32Array(offsets[rows.length]!);
  const slopes = new Float64Array(columns.length);
  rows.forEach((i, r) => {
    columns.set(J.columns.subarray(J.offsets[i]!, J.offsets[i + 1]!), offsets[r]!);
    slopes.set(J.slopes.subarray(J.offsets[i]!, J.offsets[i + 1]!), offsets[r]!);
  });
  return { n: J.n, offsets, columns, slopes };
}

/**
 * A damped step's normal matrix: `J J^T` when there are no more equations than unknowns, else
 * `J^T J`, with its mean diagonal to scale the damping by. It's formed once per Jacobian from each
 * row's few slopes (two rows meet only in the columns they share) and reused across damping
 * retries.
 */
interface Normal {
  readonly A: Vars;
  readonly size: number;
  readonly wide: boolean;
  readonly mean: number;
}
function normalMatrix(J: Jacobian, rows = false): Normal {
  const m = J.offsets.length - 1;
  const wide = rows || m <= J.n;
  const size = wide ? m : J.n;
  const A = new Float64Array(size * size);
  if (wide) {
    // The same entries by column, to pair up the rows that share each one.
    const starts = new Int32Array(J.n + 1);
    for (const c of J.columns) starts[c + 1] = starts[c + 1]! + 1;
    for (let c = 0; c < J.n; c++) starts[c + 1] = starts[c + 1]! + starts[c]!;
    const filled = Int32Array.from(starts);
    const rows = new Int32Array(J.columns.length);
    const slopes = new Float64Array(J.columns.length);
    for (let i = 0; i < m; i++)
      for (let e = J.offsets[i]!; e < J.offsets[i + 1]!; e++) {
        const at = filled[J.columns[e]!]!++;
        rows[at] = i;
        slopes[at] = J.slopes[e]!;
      }
    for (let c = 0; c < J.n; c++)
      for (let p = starts[c]!; p < starts[c + 1]!; p++)
        for (let q = starts[c]!; q < starts[c + 1]!; q++)
          A[rows[p]! * size + rows[q]!] = A[rows[p]! * size + rows[q]!]! + slopes[p]! * slopes[q]!;
  } else
    for (let i = 0; i < m; i++)
      for (let p = J.offsets[i]!; p < J.offsets[i + 1]!; p++)
        for (let q = J.offsets[i]!; q < J.offsets[i + 1]!; q++)
          A[J.columns[p]! * size + J.columns[q]!] =
            A[J.columns[p]! * size + J.columns[q]!]! + J.slopes[p]! * J.slopes[q]!;
  let trace = 0;
  for (let p = 0; p < size; p++) trace += A[p * size + p]!;
  return { A, size, wide, mean: Math.max(trace / size, 1e-300) };
}

/**
 * The step `-J^T (J J^T + lambda I)^-1 f` (or the equal `-(J^T J + lambda I)^-1 J^T f` when there
 * are more equations than unknowns), with lambda relative to the system's scale.
 */
function dampedStep(J: Jacobian, normal: Normal, f: Vars, damping: number): Vars | null {
  const { size, wide } = normal;
  const A = Float64Array.from(normal.A);
  const lambda = damping * normal.mean;
  for (let p = 0; p < size; p++) A[p * size + p] = A[p * size + p]! + lambda;
  const y = cholesky(A, wide ? f : transposed(J, f), size);
  if (!y) return null;
  return (wide ? transposed(J, y) : y).map((value) => -value);
}

/**
 * Solves `A y = b` for a symmetric positive definite `A` (overwritten), or null if it isn't. The
 * factor stays inside `A`'s envelope (each row from its first nonzero on), so the work follows
 * how far each equation reaches back, not the whole matrix: a row of joined rectangles costs a
 * band, not a cube.
 */
function cholesky(A: Vars, b: Vars, size: number): Vars | null {
  const factored = factor(A, size);
  return factored && substitute(factored, b);
}

/**
 * The Cholesky factor of a symmetric positive definite `A`, in place in its lower triangle, with
 * each row's first nonzero column (its envelope); null if `A` isn't positive definite.
 */
function factor(A: Vars, size: number): { A: Vars; first: Int32Array } | null {
  const first = Int32Array.from({ length: size }, (_, i) => {
    let j = 0;
    while (j < i && A[i * size + j] === 0) j++;
    return j;
  });
  for (let j = 0; j < size; j++) {
    let diagonal = A[j * size + j]!;
    for (let k = first[j]!; k < j; k++) diagonal -= A[j * size + k]! ** 2;
    if (!(diagonal > 0)) return null;
    const pivot = Math.sqrt(diagonal);
    A[j * size + j] = pivot;
    for (let i = j + 1; i < size; i++) {
      if (first[i]! > j) continue;
      let sum = A[i * size + j]!;
      for (let k = Math.max(first[i]!, first[j]!); k < j; k++)
        sum -= A[i * size + k]! * A[j * size + k]!;
      A[i * size + j] = sum / pivot;
    }
  }
  return { A, first };
}
