import { addBodies, type EntityType, type GeometryState } from "./Model.ts";
import { subShapes, toList, xyz, type Oc, type Shape } from "./occt.ts";

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

/** A sketch plane: origin plus orthonormal x and normal, in meters. */
export interface SketchPlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly x: Vec3;
}

interface EntityBase {
  readonly id: string;
  readonly construction: boolean;
}
export interface SketchPoint extends EntityBase {
  readonly kind: "point";
  readonly position: Vec2;
}
export interface SketchLine extends EntityBase {
  readonly kind: "line";
  readonly start: Vec2;
  readonly end: Vec2;
}
export interface SketchCircle extends EntityBase {
  readonly kind: "circle";
  readonly center: Vec2;
  readonly radius: number;
}
/** A circular arc that runs counterclockwise from `start` to `end`, as Onshape stores arcs. */
export interface SketchArc extends EntityBase {
  readonly kind: "arc";
  readonly center: Vec2;
  readonly radius: number;
  readonly start: Vec2;
  readonly end: Vec2;
}
export interface SketchEllipse extends EntityBase {
  readonly kind: "ellipse";
  readonly center: Vec2;
  /** Unit direction `majorRadius` lies along. As in std, it may be the shorter radius. */
  readonly majorAxis: Vec2;
  readonly majorRadius: number;
  readonly minorRadius: number;
}
/**
 * Part of an ellipse, counterclockwise from `startParameter` to `endParameter`. Parameters have
 * period 1: 0 is on the major axis, 0.25 on the minor axis.
 */
export interface SketchEllipticalArc extends Omit<SketchEllipse, "kind"> {
  readonly kind: "ellipticalArc";
  readonly startParameter: number;
  readonly endParameter: number;
}
/** A Bézier curve by its control points; it passes through the first and last. */
export interface SketchBezier extends EntityBase {
  readonly kind: "bezier";
  readonly poles: readonly Vec2[];
}
/** A conic from `start` to `end`, bent toward `control` by `rho` (0.5 is a parabola). */
export interface SketchConic extends EntityBase {
  readonly kind: "conic";
  readonly start: Vec2;
  readonly control: Vec2;
  readonly end: Vec2;
  readonly rho: number;
}
/**
 * A spline through `points`, closed when the last point repeats the first. Without `parameters`
 * the points are spaced by chord length over [0, 1], as `opFitSpline` does; derivatives are per
 * unit parameter and only apply to open splines.
 */
export interface SketchFitSpline extends EntityBase {
  readonly kind: "fitSpline";
  readonly points: readonly Vec2[];
  readonly parameters: readonly number[] | null;
  readonly startDerivative: Vec2 | null;
  readonly endDerivative: Vec2 | null;
}
/** Sketch geometry in plane coordinates, meters. */
export type SketchEntity =
  | SketchPoint
  | SketchLine
  | SketchCircle
  | SketchArc
  | SketchEllipse
  | SketchEllipticalArc
  | SketchBezier
  | SketchConic
  | SketchFitSpline;
type SketchCurve = Exclude<SketchEntity, SketchPoint>;

/** The points of an entity that constraints name as `"<entity id>.<part>"`, e.g. `"line1.start"`. */
export type SketchPart = "start" | "end" | "center";
const PARTS: Readonly<Record<SketchEntity["kind"], readonly SketchPart[]>> = {
  point: [],
  line: ["start", "end"],
  circle: ["center"],
  arc: ["start", "end", "center"],
  ellipse: ["center"],
  ellipticalArc: ["start", "end", "center"],
  bezier: ["start", "end"],
  conic: ["start", "end"],
  fitSpline: ["start", "end"],
};

/** Whether a fit spline closes on itself. */
const isClosed = (spline: SketchFitSpline) =>
  spline.points.length > 2 && same(spline.points[0]!, spline.points.at(-1)!);
const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < ZERO_LENGTH;

/** The point at `parameter` (period 1) on an ellipse. */
export function ellipsePoint(
  ellipse: Omit<SketchEllipse, "kind" | "id" | "construction">,
  parameter: number,
): Vec2 {
  const [angle, [mx, my]] = [2 * Math.PI * parameter, ellipse.majorAxis];
  const [along, across] = [
    ellipse.majorRadius * Math.cos(angle),
    ellipse.minorRadius * Math.sin(angle),
  ];
  return [
    ellipse.center[0] + along * mx - across * my,
    ellipse.center[1] + along * my + across * mx,
  ];
}

/** An open curve's start and end; null for closed ones and points. */
export function curveEnds(entity: SketchEntity): readonly [Vec2, Vec2] | null {
  switch (entity.kind) {
    case "line":
    case "arc":
    case "conic":
      return [entity.start, entity.end];
    case "ellipticalArc":
      return [
        ellipsePoint(entity, entity.startParameter),
        ellipsePoint(entity, entity.endParameter),
      ];
    case "bezier":
      return [entity.poles[0]!, entity.poles.at(-1)!];
    case "fitSpline":
      return isClosed(entity) ? null : [entity.points[0]!, entity.points.at(-1)!];
    default:
      return null;
  }
}

/**
 * True when an entity can't become geometry: a zero or negative radius, coincident spline points, a conic
 * whose ends meet. Entities drawn without positions and never given an initial guess end up here.
 * A zero-length line isn't one: std's pointed `fCone` draws one at the apex, so it just makes no
 * edge (see `addSketch`).
 */
export function degenerate(entity: SketchEntity): boolean {
  // Negative radii included: OpenCascade can't build them.
  const tiny = (value: number) => !(value >= ZERO_LENGTH);
  switch (entity.kind) {
    case "point":
    case "line":
      return false;
    case "conic":
      return same(entity.start, entity.end);
    case "circle":
    case "arc":
      return tiny(entity.radius);
    case "ellipse":
    case "ellipticalArc":
      return tiny(entity.majorRadius) || tiny(entity.minorRadius);
    case "bezier":
      return entity.poles.every((pole) => same(pole, entity.poles[0]!));
    case "fitSpline":
      return entity.points.some((point, i) => i > 0 && same(entity.points[i - 1]!, point));
  }
}

/**
 * An entity placed by an `skSetInitialGuess` entry: the solver's own numbers for it, in meters
 * and radians. Onshape documents only the elliptical arc's (center, unit major axis, major and
 * minor radius, start and end angle); the point's, line's (a point, a direction and the start and
 * end parameters along it) and ellipse's follow the same pattern. Other kinds, or a guess of the
 * wrong length, return a message saying what can't be read.
 */
export function withGuess(entity: SketchEntity, guess: readonly number[]): SketchEntity | string {
  const sizes: Partial<Record<SketchEntity["kind"], number>> = {
    point: 2,
    line: 6,
    ellipse: 6,
    ellipticalArc: 8,
  };
  const size = sizes[entity.kind];
  if (size === undefined)
    return `An initial guess for ${entity.id} (${describe(entity)}) is not supported locally yet; its format isn't documented.`;
  if (guess.length !== size)
    return `The initial guess for ${entity.id} has ${guess.length} numbers; a ${entity.kind} takes ${size}.`;
  // Lengths are checked above, so every index read below exists.
  const n = (index: number) => guess[index]!;
  switch (entity.kind) {
    case "point":
      return { ...entity, position: [n(0), n(1)] };
    case "line": {
      const along = (t: number): Vec2 => [n(0) + t * n(2), n(1) + t * n(3)];
      return { ...entity, start: along(n(4)), end: along(n(5)) };
    }
    case "ellipse":
    case "ellipticalArc": {
      // Onshape uses the axis as given; one that isn't a unit vector would scale the curve.
      if (Math.abs(Math.hypot(n(2), n(3)) - 1) > 1e-9)
        return `The initial guess for ${entity.id} has a major axis that isn't a unit vector, which is not supported locally.`;
      const ellipse = {
        ...entity,
        center: [n(0), n(1)] as const,
        majorAxis: [n(2), n(3)] as const,
        majorRadius: n(4),
        minorRadius: n(5),
      };
      return ellipse.kind === "ellipse"
        ? ellipse
        : { ...ellipse, startParameter: n(6) / (2 * Math.PI), endParameter: n(7) / (2 * Math.PI) };
    }
    default:
      return entity;
  }
}

/** How messages name an entity's kind, e.g. "a Bézier curve". */
export function describe(entity: SketchEntity): string {
  const names: Record<SketchEntity["kind"], string> = {
    point: "a point",
    line: "a line",
    circle: "a circle",
    arc: "an arc",
    ellipse: "an ellipse",
    ellipticalArc: "an elliptical arc",
    bezier: "a Bézier curve",
    conic: "a conic",
    fitSpline: "a fit spline",
  };
  return names[entity.kind];
}

/** What a constraint points at: a whole entity, or one of its points. */
export interface SketchRef {
  readonly entity: string;
  readonly part: SketchPart | null;
}

/** An `skConstraint`, with its references resolved against the sketch's entities. */
export interface SketchConstraint {
  readonly id: string;
  /** A `ConstraintType` member, e.g. `"COINCIDENT"`. */
  readonly type: string;
  readonly first: SketchRef | null;
  readonly second: SketchRef | null;
  /** The mirror line of a MIRROR (symmetric) constraint. */
  readonly mirror: SketchRef | null;
  /** Dimension values: meters and radians. */
  readonly length: number | null;
  readonly angle: number | null;
  /** `DimensionDirection` of a DISTANCE. */
  readonly direction: "MINIMUM" | "HORIZONTAL" | "VERTICAL";
  /** `DimensionAlignment`: which way round a directional distance or parallel pair goes. */
  readonly alignment: "UNSPECIFIED" | "ALIGNED" | "ANTI_ALIGNED";
}

/** An unsolved sketch: entities in plane coordinates and constraints, added to the context by `skSolve`. */
export class Sketch {
  readonly id: readonly string[];
  readonly plane: SketchPlane;
  readonly entities: SketchEntity[] = [];
  readonly constraints: SketchConstraint[] = [];
  /** `skSetInitialGuess` entries by entity id, applied when the sketch is solved. */
  readonly guesses = new Map<string, readonly number[]>();
  solved = false;
  constructor(id: readonly string[], plane: SketchPlane) {
    this.id = id;
    this.plane = plane;
  }

  /**
   * Resolves a constraint reference the way std writes them: an entity id (`"rect.left"`), or an
   * entity id plus one of its points (`"rect.left.start"`). Entity ids may contain dots themselves.
   */
  ref(name: string): SketchRef | null {
    if (this.entities.some((entity) => entity.id === name)) return { entity: name, part: null };
    const dot = name.lastIndexOf(".");
    if (dot < 0) return null;
    const [id, part] = [name.slice(0, dot), name.slice(dot + 1)];
    const entity = this.entities.find((candidate) => candidate.id === id);
    const known = entity ? PARTS[entity.kind].find((candidate) => candidate === part) : undefined;
    return known ? { entity: id, part: known } : null;
  }
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Plane coordinates to world. */
export function toWorld(plane: SketchPlane, [u, v]: Vec2): Vec3 {
  const y = cross(plane.normal, plane.x);
  return [0, 1, 2].map((i) => plane.origin[i]! + u * plane.x[i]! + v * y[i]!) as unknown as Vec3;
}

/** std's `TOLERANCE.zeroLength`, meters. */
const ZERO_LENGTH = 1e-8;

/** Counterclockwise angle of `point` around `center`, in the plane's (x, normal x x) frame. */
const angleAround = (center: Vec2, point: Vec2) =>
  Math.atan2(point[1] - center[1], point[0] - center[0]);

/** A plane direction (no origin) in world coordinates. */
function toWorldDirection(plane: SketchPlane, [u, v]: Vec2): Vec3 {
  const y = cross(plane.normal, plane.x);
  return [0, 1, 2].map((i) => u * plane.x[i]! + v * y[i]!) as unknown as Vec3;
}

function edgeOf(oc: Oc, plane: SketchPlane, entity: SketchCurve): Shape {
  const point = (p: Vec2) => new oc.gp_Pnt(...toWorld(plane, p));
  const points = (list: readonly Vec2[]) => {
    const array = new oc.NCollection_Array1_gp_Pnt(1, list.length);
    list.forEach((p, i) => array.SetValue(i + 1, point(p)));
    return array;
  };
  switch (entity.kind) {
    case "line":
      return new oc.BRepBuilderAPI_MakeEdge(point(entity.start), point(entity.end)).Edge();
    case "circle":
    case "arc": {
      // The circle's parameter is the plane angle, so an arc's edge starts at its counterclockwise
      // start (parameter 0 in std's evaluators), as in Onshape.
      const axis = new oc.gp_Ax2(
        point(entity.center),
        new oc.gp_Dir(...plane.normal),
        new oc.gp_Dir(...plane.x),
      );
      const circle = new oc.gp_Circ(axis, entity.radius);
      if (entity.kind === "circle") return new oc.BRepBuilderAPI_MakeEdge(circle).Edge();
      const from = angleAround(entity.center, entity.start);
      let sweep = angleAround(entity.center, entity.end) - from;
      while (sweep <= 0) sweep += 2 * Math.PI;
      return new oc.BRepBuilderAPI_MakeEdge(circle, from, from + sweep).Edge();
    }
    case "ellipse":
    case "ellipticalArc": {
      // OpenCascade's major radius must be the longer one; when std's isn't, its x axis is the
      // minor axis and parameters shift by a quarter turn.
      const [mx, my] = entity.majorAxis;
      const swapped = entity.majorRadius < entity.minorRadius;
      const axis = new oc.gp_Ax2(
        point(entity.center),
        new oc.gp_Dir(...plane.normal),
        new oc.gp_Dir(...toWorldDirection(plane, swapped ? [-my, mx] : [mx, my])),
      );
      const [major, minor] = swapped
        ? [entity.minorRadius, entity.majorRadius]
        : [entity.majorRadius, entity.minorRadius];
      const ellipse = new oc.gp_Elips(axis, major, minor);
      if (entity.kind === "ellipse") return new oc.BRepBuilderAPI_MakeEdge(ellipse).Edge();
      const from = 2 * Math.PI * entity.startParameter - (swapped ? Math.PI / 2 : 0);
      let sweep = 2 * Math.PI * ((entity.endParameter - entity.startParameter) % 1);
      if (sweep <= 0) sweep += 2 * Math.PI;
      return new oc.BRepBuilderAPI_MakeEdge(ellipse, from, from + sweep).Edge();
    }
    case "bezier":
      return new oc.BRepBuilderAPI_MakeEdge(new oc.Geom_BezierCurve(points(entity.poles))).Edge();
    case "conic": {
      // A rational quadratic Bézier: weight rho / (1 - rho) on the control point puts the
      // curve's midpoint rho of the way from the chord's midpoint to the control point.
      const weights = new oc.NCollection_Array1_double(1, 3);
      [1, entity.rho / (1 - entity.rho), 1].forEach((w, i) => weights.SetValue(i + 1, w));
      const curve = new oc.Geom_BezierCurve(
        points([entity.start, entity.control, entity.end]),
        weights,
      );
      return new oc.BRepBuilderAPI_MakeEdge(curve).Edge();
    }
    case "fitSpline":
      return fitSplineEdge(oc, plane, entity);
  }
}

/** The interpolated spline through a fit spline's points, as an edge. */
function fitSplineEdge(oc: Oc, plane: SketchPlane, spline: SketchFitSpline): Shape {
  const closed = isClosed(spline);
  const through = closed ? spline.points.slice(0, -1) : spline.points;
  const array = new oc.NCollection_Array1_gp_Pnt(1, through.length);
  through.forEach((p, i) => array.SetValue(i + 1, new oc.gp_Pnt(...toWorld(plane, p))));
  let parameters = spline.parameters;
  if (!closed && !parameters) {
    const chords = through.map((p, i) =>
      i === 0 ? 0 : Math.hypot(p[0] - through[i - 1]![0], p[1] - through[i - 1]![1]),
    );
    const total = chords.reduce((sum, chord) => sum + chord, 0);
    let walked = 0;
    parameters = chords.map((chord) => (walked += chord) / total);
  }
  const interpolate = parameters
    ? (() => {
        const values = new oc.NCollection_Array1_double(1, parameters.length);
        parameters.forEach((t, i) => values.SetValue(i + 1, t));
        return new oc.GeomAPI_Interpolate(
          new oc.NCollection_HArray1_gp_Pnt(array),
          new oc.NCollection_HArray1_double(values),
          closed,
          1e-9,
        );
      })()
    : new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(array), closed, 1e-9);
  const ends = closed ? [] : [spline.startDerivative, spline.endDerivative];
  if (ends.some((derivative) => derivative)) {
    const tangents = new oc.NCollection_Array1_gp_Vec(1, through.length);
    const flags = new oc.NCollection_Array1_bool(1, through.length);
    for (let i = 0; i < through.length; i++) {
      const derivative = i === 0 ? ends[0] : i === through.length - 1 ? ends[1] : null;
      const direction: Vec3 = derivative ? toWorldDirection(plane, derivative) : [0, 0, 0];
      tangents.SetValue(i + 1, new oc.gp_Vec(...direction));
      flags.SetValue(i + 1, Boolean(derivative));
    }
    interpolate.Load(tangents, new oc.NCollection_HArray1_bool(flags), false);
  }
  interpolate.Perform();
  if (!interpolate.IsDone()) throw new Error(`Couldn't fit the sketch spline ${spline.id}.`);
  return new oc.BRepBuilderAPI_MakeEdge(interpolate.Curve()).Edge();
}

function compound(oc: Oc, shapes: readonly Shape[]): Shape {
  const result = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(result);
  for (const shape of shapes) builder.Add(result, shape);
  return result;
}

/**
 * Onshape-style regions: the bounded faces that the sketch's curves cut out of the sketch plane.
 * Splits a plane face larger than the sketch by every curve and keeps faces that don't touch its rim.
 */
export function sketchRegions(oc: Oc, plane: SketchPlane, edges: readonly Shape[]): Shape[] {
  if (edges.length === 0) return [];
  // The sheet reaches four times past the farthest any curve gets from the plane's origin, and a
  // meter more. That's measured on each edge's own bounding box (a B-spline's by its poles), not
  // on the points it was drawn through: a fit spline can swing far past those.
  const reach = Math.max(
    ...edges.map((edge) => {
      const box = new oc.Bnd_Box();
      oc.BRepBndLib.Add(edge, box, false);
      const low = [box.GetXMin(), box.GetYMin(), box.GetZMin()];
      const high = [box.GetXMax(), box.GetYMax(), box.GetZMax()];
      return Math.hypot(
        ...plane.origin.map((o, i) => Math.max(Math.abs(low[i]! - o), Math.abs(high[i]! - o))),
      );
    }),
  );
  const bound = reach * 4 + 1;
  const gpPlane = new oc.gp_Pln(
    new oc.gp_Ax3(
      new oc.gp_Pnt(...plane.origin),
      new oc.gp_Dir(...plane.normal),
      new oc.gp_Dir(...plane.x),
    ),
  );
  const sheet = new oc.BRepBuilderAPI_MakeFace(gpPlane, -bound, bound, -bound, bound).Face();
  const splitter = new oc.BRepAlgoAPI_Splitter();
  splitter.SetArguments(toList(oc, [sheet]));
  splitter.SetTools(toList(oc, edges));
  splitter.Build(new oc.Message_ProgressRange());
  if (splitter.HasErrors()) return [];
  // The unbounded outside is the face that still reaches the sheet's rim; its corners lie at
  // (+-bound, +-bound) in plane coordinates, while the sketch's curves stay well inside. Measured
  // along the plane's own axes: a world-axis box of a tilted sheet never reaches its rim.
  const y = cross(plane.normal, plane.x);
  const along = (axis: Vec3, at: Vec3) =>
    [0, 1, 2].reduce((sum, i) => sum + (at[i]! - plane.origin[i]!) * axis[i]!, 0);
  const touchesRim = (face: Shape) =>
    subShapes(oc, face, "VERTEX").some((vertex) => {
      const at = xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex)));
      return Math.max(Math.abs(along(plane.x, at)), Math.abs(along(y, at))) > bound * 0.99;
    });
  return subShapes(oc, splitter.Shape(), "FACE").filter((face) => !touchesRim(face));
}

/**
 * Adds a solved sketch to the context with the topology std documents for Onshape:
 * - one WIRE body per curve, whose body and edge carry the curve's id and whose end vertices are
 *   `"<id>.start"` and `"<id>.end"` (an arc's counterclockwise ends);
 * - one POINT body per point, and per circle, arc or ellipse center (`"<id>.center"`);
 * - one SHEET body of regions, whose faces, edges and vertices are sketch entities without an id.
 * Wire and point bodies are created by the sketch's `"wireOp"` operation, regions by the sketch.
 * A construction entity is construction throughout and bounds no region; a zero-length line
 * makes nothing. `entities` are the solved positions of the sketch's entities.
 */
export function addSketch(
  oc: Oc,
  state: GeometryState,
  sketch: Sketch,
  entities: readonly SketchEntity[],
): GeometryState {
  const wireOp = [...sketch.id, "wireOp"];
  const named = (entityId: string | null) => ({ sketch: { sketchId: sketch.id, entityId } });
  // A zero-length line (std's pointed cone draws one) makes no edge, body or region boundary.
  const curves = entities
    .filter((entity): entity is SketchCurve => entity.kind !== "point")
    .filter((entity) => entity.kind !== "line" || !same(entity.start, entity.end))
    .map((entity) => ({ entity, edge: edgeOf(oc, sketch.plane, entity) }));
  const wires = curves.map(({ entity, edge }) => {
    // A vertex is the curve's start if it sits there, else its end. Closed curves have none.
    const ends = curveEnds(entity);
    const start = ends && toWorld(sketch.plane, ends[0]);
    const end = (vertex: Shape) => {
      const at = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex));
      const atStart =
        start && Math.hypot(at.X() - start[0], at.Y() - start[1], at.Z() - start[2]) < ZERO_LENGTH;
      return atStart ? "start" : "end";
    };
    return {
      shape: new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(edge)).Wire(),
      bodyType: "WIRE" as const,
      createdBy: wireOp,
      construction: entity.construction,
      annotate: (shape: Shape, type: EntityType) =>
        named(type === "VERTEX" ? `${entity.id}.${end(shape)}` : entity.id),
    };
  });
  // Vertices that aren't curve ends: points, and circle, arc and ellipse centers.
  const points = entities.flatMap((entity) => {
    if (!("center" in entity) && entity.kind !== "point") return [];
    const [id, position] =
      entity.kind === "point"
        ? [entity.id, entity.position]
        : [`${entity.id}.center`, entity.center];
    return [
      {
        shape: new oc.BRepBuilderAPI_MakeVertex(
          new oc.gp_Pnt(...toWorld(sketch.plane, position)),
        ).Vertex(),
        bodyType: "POINT" as const,
        createdBy: wireOp,
        construction: entity.construction,
        annotate: () => named(id),
      },
    ];
  });
  const regions = sketchRegions(
    oc,
    sketch.plane,
    curves.filter(({ entity }) => !entity.construction).map(({ edge }) => edge),
  );
  const sheet = regions.length
    ? [
        {
          shape: compound(oc, regions),
          bodyType: "SHEET" as const,
          createdBy: sketch.id,
          annotate: () => named(null),
        },
      ]
    : [];
  return addBodies(oc, state, [...wires, ...sheet, ...points]).state;
}
