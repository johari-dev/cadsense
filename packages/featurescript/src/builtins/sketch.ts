import {
  addSketch,
  degenerate,
  Sketch,
  withGuess,
  type SketchConstraint,
  type SketchEntity,
  type SketchPlane,
  type Vec2,
} from "../geometry/Sketch.ts";
import { checkConstraint, solveConstraints } from "../geometry/SketchSolver.ts";
import type { Entity } from "../geometry/Model.ts";
import { ShapeSet, type Oc } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsBuiltin, FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { array, map, number } from "./args.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { regenError, stdPlane } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** std's `TOLERANCE.zeroLength`, meters. */
const ZERO_LENGTH = 1e-8;

interface SketchHandle {
  readonly sketch: Sketch;
  readonly model: ModelContext;
}
const sketchOf = (call: BuiltinCall, value: FsValue): SketchHandle => {
  const v = untag(value);
  if (!(v instanceof FsBuiltin) || !(v.native as SketchHandle | undefined)?.sketch)
    return call.fail("Expected a Sketch.");
  const handle = v.native as SketchHandle;
  if (handle.sketch.solved) return call.fail("This sketch is already solved.");
  return handle;
};
const sketchPlane = (call: BuiltinCall, plane: FsValue): SketchPlane => {
  const p = map(call, plane, "sketchPlane");
  return {
    origin: vector(call, p.getField("origin"), 3, "sketchPlane.origin"),
    normal: normalized(vector(call, p.getField("normal"), 3, "sketchPlane.normal")),
    x: normalized(vector(call, p.getField("x"), 3, "sketchPlane.x")),
  };
};

/**
 * An `sk*` entity builtin: `build` reads the definition (lengths with or without units) into an
 * entity, and the builtin returns the ids std documents for it, e.g. `{ startId, endId }`.
 */
const sketchEntity =
  (
    build: (
      call: BuiltinCall,
      value: FsMap,
    ) => DistributiveOmit<SketchEntity, "id" | "construction">,
  ): BuiltinImpl =>
  ([sketch, id, value], call) => {
    const { sketch: target } = sketchOf(call, sketch);
    const definition = map(call, value, "value");
    const entity: SketchEntity = {
      ...build(call, definition),
      id: String(untag(id)),
      construction: untag(definition.getField("construction")) === true,
    };
    target.entities.push(entity);
    const named = (part: string) => `${entity.id}.${part}`;
    switch (entity.kind) {
      case "point":
        return FsMap.fromEntries([["pointId", entity.id]]);
      case "line":
      case "arc":
      case "ellipticalArc":
        return FsMap.fromEntries([
          ["startId", named("start")],
          ["endId", named("end")],
        ]);
      case "circle":
      case "ellipse":
        return FsMap.fromEntries([["centerId", named("center")]]);
      default:
        return undefined;
    }
  };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A 2D position, or the origin when the definition leaves it out. Points, lines, circles and
 * ellipses may be drawn empty (std allows it, for initial-guess data) and placed by
 * `skSetInitialGuess` or sized by constraints; one left degenerate fails when the sketch solves.
 */
const position = (call: BuiltinCall, value: FsMap, field: string): Vec2 => {
  const given = value.getField(field);
  return given === undefined ? [0, 0] : vector(call, given, 2, field);
};
const optional = (call: BuiltinCall, value: FsMap, field: string, fallback: number) => {
  const given = value.getField(field);
  return given === undefined ? fallback : magnitude(call, given, field);
};
const points = (call: BuiltinCall, value: FsMap, field: string): Vec2[] =>
  [...array(call, value.getField(field), field)].map((point, i) =>
    vector(call, point, 2, `${field}[${i}]`),
  );

/** An ellipse's center, unit major axis and radii; std accepts the axis as a direction or a point. */
function ellipseOf(call: BuiltinCall, value: FsMap) {
  const [x, y] =
    value.getField("majorAxis") === undefined ? [1, 0] : position(call, value, "majorAxis");
  const length = Math.hypot(x, y);
  if (length === 0) return regenError(call, "SKETCH_ELLIPSE_ZERO_AXIS");
  return {
    center: position(call, value, "center"),
    majorAxis: [x / length, y / length] as const,
    majorRadius: optional(call, value, "majorRadius", 0),
    minorRadius: optional(call, value, "minorRadius", 0),
  };
}

/** A fit spline's points, parameters and end derivatives, checked the way std's docs describe. */
function fitSplineOf(call: BuiltinCall, value: FsMap) {
  const through = points(call, value, "points");
  const [first, last] = [through[0]!, through.at(-1)!];
  const closed =
    through.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < ZERO_LENGTH;
  if (closed && through.length < 4) return regenError(call, "SKETCH_SPLINE_TOO_FEW_POINTS");
  const given = value.getField("parameters");
  if (given !== undefined && closed)
    return call.unsupported(
      "skFitSpline parameters on a closed spline are not supported locally yet.",
    );
  const parameters =
    given === undefined
      ? null
      : [...array(call, given, "parameters")].map((t, i) => number(call, t, `parameters[${i}]`));
  if (parameters && parameters.length !== through.length)
    return call.fail("skFitSpline needs one parameter per point.");
  // std: the end derivatives are "Ignored if spline is closed."
  const derivative = (field: string) =>
    closed || value.getField(field) === undefined ? null : position(call, value, field);
  return {
    kind: "fitSpline" as const,
    points: through,
    parameters,
    startDerivative: derivative("startDerivative"),
    endDerivative: derivative("endDerivative"),
  };
}

/**
 * The arc through three points, stored counterclockwise as Onshape does: a clockwise arc's
 * `start` and `end` swap, so `"arc.start"` names the drawn end. Collinear points make no arc.
 */
function arcThrough(call: BuiltinCall, start: Vec2, mid: Vec2, end: Vec2) {
  const [[ax, ay], [bx, by], [cx, cy]] = [start, mid, end];
  const turn = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
  if (Math.abs(turn) <= ZERO_LENGTH * Math.hypot(cx - ax, cy - ay))
    return regenError(call, "SKETCH_ARC_FAILED");
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const [a2, b2, c2] = [ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy];
  const center: Vec2 = [
    (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  ];
  const radius = Math.hypot(ax - center[0], ay - center[1]);
  return turn > 0
    ? { kind: "arc" as const, center, radius, start, end }
    : { kind: "arc" as const, center, radius, start: end, end: start };
}

/**
 * The plane of the sketch that made each shape, per context, for `evOwnerSketchPlane`. Shapes are
 * matched by identity, so geometry an operation has since moved or rebuilt isn't found.
 */
const ownerPlanes = new WeakMap<ModelContext, ShapeSet<SketchPlane>>();

/**
 * The plane of the sketch that made `entity`; null if no sketch did. A sketch entity whose shape
 * changed since (a transformed copy) stops the run: Onshape moves the plane with it, and we don't.
 */
export function ownerPlane(
  call: BuiltinCall,
  model: ModelContext,
  entity: Entity,
): SketchPlane | null {
  const plane = ownerPlanes.get(model)?.get(entity.shape);
  if (plane) return plane;
  if (entity.sketch)
    return call.unsupported(
      "evOwnerSketchPlane on sketch geometry that has moved since its sketch was solved is not supported locally yet.",
    );
  return null;
}

/** Planes that are the same plane, whichever way their normals and axes point. */
function coplanar(p: SketchPlane, q: SketchPlane): boolean {
  const [a, b] = [p.normal, q.normal];
  const turned = Math.hypot(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
  const offset = [0, 1, 2].reduce((sum, i) => sum + (q.origin[i]! - p.origin[i]!) * a[i]!, 0);
  return turned < 1e-9 && Math.abs(offset) < ZERO_LENGTH;
}

/** Records the plane of a just-solved sketch for every entity it added. */
function recordOwnerPlane(
  oc: Oc,
  model: ModelContext,
  before: ReadonlyMap<string, Entity>,
  plane: SketchPlane,
) {
  let planes = ownerPlanes.get(model);
  if (!planes) ownerPlanes.set(model, (planes = new ShapeSet<SketchPlane>(oc)));
  for (const [id, entity] of model.geometry.entities)
    if (!before.has(id)) planes.set(entity.shape, plane);
}

const DIRECTIONS = ["MINIMUM", "HORIZONTAL", "VERTICAL"] as const;
const ALIGNMENTS = ["UNSPECIFIED", "ALIGNED", "ANTI_ALIGNED"] as const;
/** References `skConstraint` resolves; any other `local*` or `external*` field stops the run. */
const REFERENCE_FIELDS = ["localFirst", "localSecond", "localMirror"] as const;

/** Reads an `skConstraint` definition, resolving its references against the sketch's entities. */
function constraintOf(
  call: BuiltinCall,
  sketch: Sketch,
  id: string,
  definition: FsMap,
): SketchConstraint {
  for (const [key] of definition.entries()) {
    const name = String(untag(key));
    if (name.startsWith("external"))
      return call.unsupported(
        `Sketch constraints on external references (${name}) are not supported locally yet.`,
      );
    if (name.startsWith("local") && !REFERENCE_FIELDS.some((field) => field === name))
      return call.unsupported(`The sketch constraint field ${name} is not supported locally yet.`);
  }
  const ref = (field: (typeof REFERENCE_FIELDS)[number]) => {
    const name = untag(definition.getField(field));
    if (name === undefined) return null;
    return sketch.ref(String(name)) ?? regenError(call, "SKETCH_MISSING_ENTITY");
  };
  const value = (field: string) => {
    const given = definition.getField(field);
    return given === undefined ? null : magnitude(call, given, field);
  };
  const choice = <T extends string>(field: string, options: readonly T[]): T => {
    const given = untag(definition.getField(field)) ?? options[0];
    const known = options.find((option) => option === given);
    return known ?? call.fail(`${field} must be one of ${options.join(", ")}.`);
  };
  return {
    id,
    type: String(untag(definition.getField("constraintType"))),
    first: ref("localFirst"),
    second: ref("localSecond"),
    mirror: ref("localMirror"),
    length: value("length"),
    angle: value("angle"),
    direction: choice("direction", DIRECTIONS),
    alignment: choice("alignment", ALIGNMENTS),
  };
}

export const SKETCH_BUILTINS = {
  newSketch: ([ctx, id, value], call) => {
    const { model } = kernel(call, ctx);
    const plane = map(call, value, "value").getField("sketchPlane");
    if (untag(plane) instanceof FsMap === false)
      return call.unsupported(
        "Sketching on a face query is not supported locally yet; pass a Plane (e.g. from evPlane).",
      );
    return new FsBuiltin<SketchHandle>({
      sketch: new Sketch(idOf(id), sketchPlane(call, plane)),
      model,
    });
  },
  isSketch: ([value]) =>
    value instanceof FsBuiltin &&
    (value.native as SketchHandle | undefined)?.sketch instanceof Sketch,
  skLineSegment: sketchEntity((call, value) => ({
    kind: "line",
    start: position(call, value, "start"),
    end: position(call, value, "end"),
  })),
  skCircle: sketchEntity((call, value) => ({
    kind: "circle",
    center: position(call, value, "center"),
    radius: optional(call, value, "radius", 0),
  })),
  skArc: sketchEntity((call, value) =>
    arcThrough(
      call,
      vector(call, value.getField("start"), 2, "start"),
      vector(call, value.getField("mid"), 2, "mid"),
      vector(call, value.getField("end"), 2, "end"),
    ),
  ),
  skPoint: sketchEntity((call, value) => ({
    kind: "point",
    position: position(call, value, "position"),
  })),
  skEllipse: sketchEntity((call, value) => ({ kind: "ellipse", ...ellipseOf(call, value) })),
  skEllipticalArc: sketchEntity((call, value) => ({
    kind: "ellipticalArc",
    ...ellipseOf(call, value),
    startParameter: optional(call, value, "startParameter", 0),
    endParameter: optional(call, value, "endParameter", 0),
  })),
  skBezier: sketchEntity((call, value) => ({
    kind: "bezier",
    poles: points(call, value, "points"),
  })),
  skConicSegment: sketchEntity((call, value) => {
    for (const field of ["lowParameter", "highParameter"])
      if (value.getField(field) !== undefined)
        return call.unsupported(`skConicSegment ${field} is not supported locally yet.`);
    const rho = untag(value.getField("rho"));
    if (typeof rho !== "number" || !(rho > 0 && rho < 1))
      return regenError(call, "SKETCH_CONIC_FAILED");
    return {
      kind: "conic",
      start: position(call, value, "start"),
      control: position(call, value, "controlPoint"),
      end: position(call, value, "end"),
      rho,
    };
  }),
  skFitSpline: sketchEntity(fitSplineOf),
  /** Onshape's own numbers for entities, by id; read when the sketch solves (see `withGuess`). */
  skSetInitialGuess: ([sketch, guess], call) => {
    const { sketch: target } = sketchOf(call, sketch);
    for (const [key, values] of map(call, guess, "initialGuess").entries())
      target.guesses.set(
        String(untag(key)),
        [...array(call, values, "initial guess")].map((n, i) =>
          number(call, n, `initial guess[${i}]`),
        ),
      );
    return undefined;
  },
  skConstraint: ([sketch, id, value], call) => {
    const { sketch: target } = sketchOf(call, sketch);
    const constraint = constraintOf(call, target, String(untag(id)), map(call, value, "value"));
    const problem = checkConstraint(target.entities, constraint);
    if (problem)
      return "error" in problem
        ? regenError(call, problem.error)
        : call.unsupported(problem.unsupported);
    target.constraints.push(constraint);
    return undefined;
  },
  skSolve: ([sketch], call) => {
    const { sketch: target, model } = sketchOf(call, sketch);
    const entities = target.entities.map((entity) => {
      const guess = target.guesses.get(entity.id);
      const placed = guess ? withGuess(entity, guess) : entity;
      return typeof placed === "string" ? call.unsupported(placed) : placed;
    });
    const solved = solveConstraints(entities, target.constraints, call.unsupported);
    if (!solved) return regenError(call, "SKETCH_SOLVE_FAILED");
    // Checked on the solved geometry: constraints may size what was drawn empty.
    if (solved.some(degenerate)) return regenError(call, "SKETCH_INPUT_INVALID");
    const oc = model.oc!;
    const before = model.geometry.entities;
    model.geometry = addSketch(oc, model.geometry, target, solved);
    recordOwnerPlane(oc, model, before, target.plane);
    target.solved = true;
    return undefined;
  },
  // With checkAllEntities, every entity's sketch must lie in the first one's plane; otherwise only
  // the first entity counts. Either way the first entity's sketch plane comes back.
  evOwnerSketchPlane: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "arg");
    const entities = resolve(call, model, oc, definition.getField("entity"));
    const checked =
      untag(definition.getField("checkAllEntities")) === true ? entities : entities.slice(0, 1);
    const planes = checked.map((entity) => ownerPlane(call, model, entity));
    const [first, ...rest] = planes;
    if (!first || rest.some((plane) => !plane || !coplanar(first, plane)))
      return regenError(call, "CANNOT_RESOLVE_PLANE");
    return stdPlane(call, first.origin, first.normal, first.x);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
