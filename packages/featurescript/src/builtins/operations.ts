import {
  addBodies,
  chainHistory,
  historyOf,
  imagesOf,
  LOOSEST_TOLERANCE,
  loosestTolerance,
  removeBodies,
  replaceBodies,
  type Entity,
  type Frame,
  type History,
} from "../geometry/Model.ts";
import { distance } from "../geometry/Query.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { ShapeSet, subShapes, toList, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { chainsOf, endsOf, helixCurve, near, wireOf } from "./curves.ts";
import { edgeSpline } from "./bspline.ts";
import { planeOf } from "./construction.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import {
  collapseRadius,
  connectedGroups,
  edgePoints,
  fillAndCut,
  interiorPoint,
  planeAround,
  seamsClear,
  shellCheck,
  shellSolid,
  smoothSheet,
  surfaceType,
  thickenFace,
  TIGHT_TOLERANCE,
  touchesSeam,
} from "./faceEdit.ts";
import { patternFaces, tangentEdges } from "./faces.ts";
import { regenError } from "./std.ts";
import { requireValid } from "./validity.ts";
import {
  crossesItself,
  foldsAlong,
  rotationMinimizingSpine,
  stallsOf,
  type Carrying,
} from "./sweepFrame.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Modeling operations beyond extrude and boolean: revolve, fillet, chamfer, shell, pattern,
 * transform, thicken, loft, sweep and split.
 */

/**
 * std's `Transform` (3x3 `linear`, length `translation`) as an OpenCascade transformation, for
 * every operation that moves or copies geometry by one. A gp_Trsf holds only rotations, mirrors and
 * one scale; given a matrix that scales the axes differently it makes the scale uniform without
 * saying so, so a transform it can't hold exactly stops here. Scaling unevenly takes a general
 * transformation (the geometry becoming B-splines), which this OpenCascade build doesn't bind (no
 * BRepBuilderAPI_GTransform).
 */
export function toTrsf(call: BuiltinCall, oc: Oc, value: FsValue): InstanceType<Oc["gp_Trsf"]> {
  const transform = map(call, value, "transform");
  const linear = array(call, transform.getField("linear"), "transform.linear").map((row) =>
    array(call, row, "transform.linear").map((x) => magnitude(call, x, "transform.linear")),
  );
  const t = vector(call, transform.getField("translation"), 3, "transform.translation");
  const m = (i: number, j: number) => linear[i]?.[j] ?? (i === j ? 1 : 0);
  const trsf = new oc.gp_Trsf();
  trsf.SetValues(
    m(0, 0),
    m(0, 1),
    m(0, 2),
    t[0],
    m(1, 0),
    m(1, 1),
    m(1, 2),
    t[1],
    m(2, 0),
    m(2, 1),
    m(2, 2),
    t[2],
  );
  const size = Math.max(1, ...linear.flat().map(Math.abs));
  const exact = [0, 1, 2].every((i) =>
    [0, 1, 2].every((j) => Math.abs(trsf.Value(i + 1, j + 1) - m(i, j)) <= 1e-9 * size),
  );
  if (!exact)
    return call.unsupported(
      "Transforms that scale unevenly (by different amounts along different axes) are not supported locally yet.",
    );
  return trsf;
}

/** A mate connector's `frame` moved by `trsf`, for a connector that moves with its body. */
function movedFrame(oc: Oc, trsf: InstanceType<Oc["gp_Trsf"]>, frame: Frame): Frame {
  const origin = new oc.gp_Pnt(...frame.origin).Transformed(trsf);
  const axis = (direction: Frame["xAxis"]) => {
    const moved = new oc.gp_Dir(...direction).Transformed(trsf);
    return [moved.X(), moved.Y(), moved.Z()] as const;
  };
  return {
    origin: [origin.X(), origin.Y(), origin.Z()],
    xAxis: axis(frame.xAxis),
    zAxis: axis(frame.zAxis),
  };
}

/**
 * True when OpenCascade's full check (geometry included) accepts `shape`, its tolerances are ones a
 * body may have, and no face has (next to) no area. Offsets deeper than a curved face's radius come
 * back as shapes only the check catches (a tube on the wrong side); folded-up offsets pass it with
 * 1 mm tolerances; a blend offset by its radius can pass as a face of no area.
 */
const sound = (oc: Oc, shape: Shape) =>
  new oc.BRepCheck_Analyzer(shape, true, false).IsValid() &&
  loosestTolerance(oc, shape) <= LOOSEST_TOLERANCE &&
  subShapes(oc, shape, "FACE").every((face) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props, false, false);
    return props.Mass() > 1e-12;
  });

/** A length in meters as millimeters for a message: up to three decimals, no trailing zeros. */
const millimeters = (meters: number) => String(+(Math.abs(meters) * 1000).toFixed(3));

/** `face` for a message: its surface and a point on it, in millimeters. */
function located(oc: Oc, face: Shape): string {
  const point = interiorPoint(oc, face);
  const at = point ? ` at (${point.map((v) => +(v * 1000).toFixed(3)).join(", ")}) mm` : "";
  return `the ${surfaceType(oc, face).toLowerCase()} face${at}`;
}

/** `face` for a message, with its `radius` in millimeters. */
const described = (oc: Oc, face: Shape, radius: number) =>
  `${located(oc, face)} (radius ${millimeters(radius)} mm)`;

/**
 * OpenCascade's shell of `body` open at `removed` faces; null when it throws, or for a hollow
 * body (it can't make one).
 */
function thickSolid(
  oc: Oc,
  body: Shape,
  removed: readonly Shape[],
  thickness: number,
): { shape: Shape; history: History } | null {
  if (removed.length === 0) return null;
  try {
    const shell = new oc.BRepOffsetAPI_MakeThickSolid();
    // The binding's defaults; spelling out a join type here changed results (a chamfered box's
    // shell lost 108 mm^3).
    shell.MakeThickSolidByJoin(body, toList(oc, removed), thickness, 1e-6);
    return shell.IsDone() ? { shape: shell.Shape(), history: historyOf(oc, shell) } : null;
  } catch {
    return null;
  }
}

/**
 * True when `result` is really `body` shelled: every removed face is gone, a hollow body (nothing
 * removed) gained an inner shell, and an inward shell lost volume. OpenCascade can hand back the
 * body unchanged and call it done.
 */
function shelled(
  oc: Oc,
  body: Shape,
  removed: readonly Shape[],
  thickness: number,
  result: Shape,
): boolean {
  const volume = (shape: Shape) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
    return props.Mass();
  };
  // The walls leave a rim in the removed face's plane; its middle is the opening.
  const remains = (face: Shape) => {
    const point = interiorPoint(oc, face, true);
    if (!point) return true;
    const probe = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();
    return subShapes(oc, result, "FACE").some((kept) => distance(oc, probe, kept) < 1e-7);
  };
  if (removed.some(remains)) return false;
  if (removed.length === 0 && subShapes(oc, result, "SHELL").length < 2) return false;
  return thickness > 0 || volume(result) < volume(body) * (1 - 1e-9);
}

/** Runs an OpenCascade algorithm, raising std's error enum if the kernel throws or reports failure. */
export function attempt<T>(call: BuiltinCall, error: string, run: () => T): T {
  try {
    return run();
  } catch {
    return regenError(call, error);
  }
}

/**
 * The fillet or chamfer `make` builds on `shape` along `edges`. OpenCascade's can't run along or end
 * on a seam (where a cylinder's parameter wraps; Parasolid has none), so when it fails there the
 * seams move clear and it runs again. If that can't work it's a local limitation; any other failure
 * is std's `error`.
 */
function blended(
  call: BuiltinCall,
  oc: Oc,
  body: Shape,
  edges: readonly Shape[],
  error: string,
  make: (shape: Shape, edges: readonly Shape[]) => { shape: Shape; history: History },
): { shape: Shape; history: History } {
  try {
    return make(body, edges);
  } catch {
    // Retried below with the seams moved.
  }
  const cleared = seamsClear(oc, body, edges);
  if (cleared)
    try {
      const made = make(
        cleared.shape,
        edges.flatMap((edge) => imagesOf(cleared.history, edge)),
      );
      return { shape: made.shape, history: chainHistory(cleared.history, made.history) };
    } catch {
      // Reported below.
    }
  if (subShapes(oc, body, "FACE").some((face) => touchesSeam(oc, face, edges)))
    return call.unsupported(
      "Filleting or chamfering an edge along or ending on a cylinder's seam is not supported locally yet.",
    );
  return regenError(call, error);
}

/** Distinct bodies of the resolved entities, keeping the entities grouped by body. */
export function byBody(model: ModelContext, entities: readonly Entity[]): Map<Entity, Entity[]> {
  const groups = new Map<Entity, Entity[]>();
  for (const entity of entities) {
    const body = model.geometry.entities.get(entity.body)!;
    groups.set(body, [...(groups.get(body) ?? []), entity]);
  }
  return groups;
}

/** Replaces one body by the solids of `result`, carrying ids across with `history`. */
function modifyBody(
  oc: Oc,
  model: ModelContext,
  body: Entity,
  result: Shape,
  history: History,
  id: FsValue,
) {
  model.geometry = replaceBodies(oc, model.geometry, {
    consumed: [body.id],
    keepIds: [body.id],
    results: subShapes(oc, result, "SOLID").map((shape) => ({ shape, bodyType: "SOLID" as const })),
    history,
    createdBy: idOf(id),
  }).state;
}

/**
 * OpenCascade fillets and chamfers a selected edge's whole tangent chain. Without
 * tangentPropagation, Onshape stops at the selected edges, so a selection with an unselected
 * tangent continuation stops the run instead of rounding more than asked.
 */
function rejectUnpropagated(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  definition: FsMap,
  edges: readonly Entity[],
) {
  if (
    untag(definition.getField("tangentPropagation")) !== true &&
    tangentEdges(oc, model, edges).length > edges.length
  )
    return call.unsupported(
      "Filleting or chamfering an edge without the edges tangent to it is not supported locally yet; set tangentPropagation.",
    );
}

/** Edges selected directly, plus the edges of selected faces. */
function edgesOf(oc: Oc, model: ModelContext, entities: readonly Entity[]): Entity[] {
  const faces = entities.filter((entity) => entity.type === "FACE");
  const inFaces = new ShapeSet<true>(oc);
  for (const face of faces)
    for (const edge of subShapes(oc, face.shape, "EDGE")) inFaces.set(edge, true);
  return [...model.geometry.entities.values()].filter(
    (entity) =>
      entity.type === "EDGE" &&
      (entities.includes(entity) ||
        (faces.some((face) => face.body === entity.body) && inFaces.has(entity.shape))),
  );
}

/** Selected faces, plus every face of selected sheet bodies. */
function facesOf(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const bodies = new Set(
    entities
      .filter((entity) => entity.type === "BODY" && entity.bodyType === "SHEET")
      .map((body) => body.id),
  );
  return [...model.geometry.entities.values()].filter(
    (entity) => entity.type === "FACE" && (entities.includes(entity) || bodies.has(entity.body)),
  );
}

/** A planar face's outward normal (following the face's orientation), or null if it isn't planar. */
function planarNormal(oc: Oc, face: Shape): Vec3 | null {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  if (String(surface.GetType()) !== "GeomAbs_Plane") return null;
  const normal = xyz(surface.Plane().Axis().Direction());
  return String(face.Orientation()) === "TopAbs_REVERSED"
    ? [-normal[0], -normal[1], -normal[2]]
    : normal;
}

const translated = (oc: Oc, shape: Shape, by: Vec3) => {
  const move = new oc.gp_Trsf();
  move.SetTranslation(new oc.gp_Vec(...by));
  return new oc.BRepBuilderAPI_Transform(shape, move, true, false).Shape();
};

/** Orders `edges` end to end (they may arrive in any order) and joins them into one wire. */
function chainedWire(call: BuiltinCall, oc: Oc, edges: readonly Shape[], error: string): Shape {
  const ends = (edge: Shape) =>
    subShapes(oc, edge, "VERTEX").map((vertex) => xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex))));
  const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;
  const touches = (edge: Shape, point: Vec3) => ends(edge).some((end) => near(end, point));
  const remaining = [...edges];
  // Start from an edge with an end no other edge touches, if the path is open.
  const startIndex = Math.max(
    0,
    remaining.findIndex((edge) =>
      ends(edge).some((end) => remaining.every((other) => other === edge || !touches(other, end))),
    ),
  );
  const ordered = remaining.splice(startIndex, 1);
  while (remaining.length) {
    const tips = ends(ordered.at(-1)!);
    const next = remaining.findIndex((edge) => tips.some((tip) => touches(edge, tip)));
    if (next < 0) return regenError(call, error);
    ordered.push(...remaining.splice(next, 1));
  }
  const wire = new oc.BRepBuilderAPI_MakeWire();
  for (const edge of ordered) wire.Add(oc.TopoDS.Edge(edge));
  if (!wire.IsDone()) return regenError(call, error);
  return wire.Wire();
}

/** Marks the faces of an operation's first and last sections as its start and end caps. */
function capsOf(oc: Oc, first: Shape, last: Shape): ShapeSet<"START" | "END"> {
  const caps = new ShapeSet<"START" | "END">(oc);
  for (const face of subShapes(oc, first, "FACE")) caps.set(face, "START");
  for (const face of subShapes(oc, last, "FACE")) caps.set(face, "END");
  return caps;
}

/** How closely a sweep's surfaces follow the true swept shape, in meters. */
const SWEEP_TOLERANCE = 1e-7;

type PipeShell = InstanceType<Oc["BRepOffsetAPI_MakePipeShell"]>;
/** Sets a sweep's profile control, twist and scale on a fresh pipe shell for `profile`. */
type SweepControl = (shell: PipeShell, profile: Shape) => void;

/** One profile wire swept along `spine`, closed into a solid when `solid`. */
function pipeShell(
  call: BuiltinCall,
  oc: Oc,
  spine: InstanceType<Oc["TopoDS_Wire"]>,
  profile: Shape,
  solid: boolean,
  control: SweepControl,
) {
  const shell = new oc.BRepOffsetAPI_MakePipeShell(spine);
  shell.SetTolerance(SWEEP_TOLERANCE, SWEEP_TOLERANCE, 1e-2);
  control(shell, profile);
  attempt(call, "SWEEP_FAILED", () => shell.Build(new oc.Message_ProgressRange()));
  if (!shell.IsDone() || (solid && !attempt(call, "SWEEP_FAILED", () => shell.MakeSolid())))
    return regenError(call, "SWEEP_FAILED");
  // OpenCascade fits the swept surfaces to SWEEP_TOLERANCE and lands near it; a sweep it couldn't
  // fit within twice that would be silently off.
  const error = shell.ErrorOnSurface();
  if (error > 2 * SWEEP_TOLERANCE)
    return call.unsupported(
      `opSweep: OpenCascade's swept surface strays ${error.toExponential(2)} m from the true sweep; a sweep this hard to fit is not supported locally yet.`,
    );
  return shell;
}

/**
 * A path edge OpenCascade's pipe can follow: a spline whose spans turn more than 45 degrees (a
 * compact helix turns several revolutions per span) gets knots added, at multiplicity degree - 1,
 * until no span turns more. Adding knots leaves the curve unchanged.
 */
function sweepablePathEdge(oc: Oc, edge: Shape): Shape {
  if (String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)).GetType()) !== "GeomAbs_BSplineCurve")
    return edge;
  const curve = edgeSpline(oc, edge);
  return addSweepKnots(oc, curve) ? new oc.BRepBuilderAPI_MakeEdge(curve).Edge() : edge;
}

/** Adds knots to `curve` so no span turns more than 45 degrees; true when it added any. */
type Running =
  | InstanceType<Oc["BRepAdaptor_Curve"]>
  | InstanceType<Oc["BRepAdaptor_CompCurve"]>
  | InstanceType<Oc["Geom_BSplineCurve"]>;

/**
 * The unit direction `curve` runs in at `u`: its derivative's, or where that's zero (a spline whose
 * first control points coincide sets off from rest), its chord over a millionth of its range on
 * the side toward its middle. Null when even that doesn't move.
 */
function headingAt(curve: Running, u: number): Vec3 | null {
  const { Point, D1 } = curve.EvalD1(u);
  const [point, d] = [xyz(Point), xyz(D1)];
  Point.delete();
  D1.delete();
  if (Math.hypot(...d) > 0) return normalized(d);
  const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
  const step = (last - first) * 1e-6 * (u - first < last - u ? 1 : -1);
  const other = curve.Value(u + step);
  const [x, y, z] = xyz(other);
  other.delete();
  const sense = Math.sign(step);
  const chord: Vec3 = [(x - point[0]) * sense, (y - point[1]) * sense, (z - point[2]) * sense];
  return Math.hypot(...chord) > 0 ? normalized(chord) : null;
}

function addSweepKnots(oc: Oc, curve: InstanceType<Oc["Geom_BSplineCurve"]>): boolean {
  const knots = Array.from({ length: curve.NbKnots() }, (_, i) => curve.Knot(i + 1));
  const added: number[] = [];
  knots.slice(0, -1).forEach((a, i) => {
    const b = knots[i + 1]!;
    const tangents = Array.from({ length: 17 }, (_, k) => headingAt(curve, a + ((b - a) * k) / 16));
    const turning = tangents.slice(1).reduce((sum, t, k) => {
      const before = tangents[k];
      if (!t || !before) return sum;
      const cosine = before[0] * t[0] + before[1] * t[1] + before[2] * t[2];
      return sum + Math.acos(Math.max(-1, Math.min(1, cosine)));
    }, 0);
    const pieces = Math.ceil(turning / (Math.PI / 4));
    for (let k = 1; k < pieces; k++) added.push(a + ((b - a) * k) / pieces);
  });
  if (added.length === 0) return false;
  const values = new oc.NCollection_Array1_double(1, added.length);
  const mults = new oc.NCollection_Array1_int(1, added.length);
  added.forEach((u, i) => {
    values.SetValue(i + 1, u);
    mults.SetValue(i + 1, Math.max(1, curve.Degree() - 1));
  });
  curve.InsertKnots(values, mults, 1e-12, false);
  return true;
}

/**
 * A face swept into a solid, with caps marked. A face with holes sweeps each loop into an open
 * tube on the same frame (each inner one lies inside the outer by construction) and is closed by
 * caps made from the first and last sections, outer loop and holes; cutting the inner tubes from
 * the outer one instead is many times slower on the frame's support-sheet surfaces.
 */
function sweptFace(
  call: BuiltinCall,
  oc: Oc,
  spine: InstanceType<Oc["TopoDS_Wire"]>,
  face: Shape,
  control: SweepControl,
): { result: Shape; caps: ShapeSet<"START" | "END"> } {
  const outerWire = oc.BRepTools.OuterWire(oc.TopoDS.Face(face));
  const inner = subShapes(oc, face, "WIRE").filter((wire) => !wire.IsSame(outerWire));
  if (inner.length === 0) {
    const shell = pipeShell(call, oc, spine, outerWire, true, control);
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shell.Shape(), props, false, false, false);
    const swept = {
      result: props.Mass() < 0 ? shell.Shape().Reversed() : shell.Shape(),
      caps: capsOf(oc, shell.FirstShape(), shell.LastShape()),
    };
    // The builder holds the sweep's laws (and any support sheets) until it's freed.
    props.delete();
    shell.delete();
    return swept;
  }
  const tubes = [outerWire, ...inner].map((wire) => {
    const shell = pipeShell(call, oc, spine, wire, false, control);
    const tube = { walls: shell.Shape(), first: shell.FirstShape(), last: shell.LastShape() };
    shell.delete();
    return tube;
  });
  if (isClosed(oc, spine))
    return closedTubes(
      call,
      oc,
      tubes.map((tube) => tube.walls),
    );
  // The holes keep their loops' orientation in the face, so they bound the caps as they are.
  const cap = (end: "first" | "last") => {
    const make = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(tubes[0]![end]), true);
    for (const tube of tubes.slice(1)) make.Add(oc.TopoDS.Wire(tube[end]));
    if (!make.IsDone()) return regenError(call, "SWEEP_FAILED");
    const made = make.Face();
    make.delete();
    return made;
  };
  const [start, end] = [cap("first"), cap("last")];
  const sewing = new oc.BRepBuilderAPI_Sewing(10 * SWEEP_TOLERANCE, true, true, true, false);
  for (const shape of [...tubes.map((tube) => tube.walls), start, end]) sewing.Add(shape);
  sewing.Perform(new oc.Message_ProgressRange());
  const shells = subShapes(oc, sewing.SewedShape(), "SHELL");
  if (shells.length !== 1 || sewing.NbFreeEdges() > 0) return regenError(call, "SWEEP_FAILED");
  const make = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shells[0]!));
  const solid = make.Solid();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
  const caps = new ShapeSet<"START" | "END">(oc);
  caps.set(sewing.IsModified(start) ? sewing.Modified(start) : start, "START");
  caps.set(sewing.IsModified(end) ? sewing.Modified(end) : end, "END");
  const result = props.Mass() < 0 ? solid.Reversed() : solid;
  props.delete();
  make.delete();
  sewing.delete();
  return { result, caps };
}

/** True when `wire` ends where it starts. */
function isClosed(oc: Oc, wire: InstanceType<Oc["TopoDS_Wire"]>): boolean {
  const along = new oc.BRepAdaptor_CompCurve(wire, false);
  const [a, b] = [along.Value(along.FirstParameter()), along.Value(along.LastParameter())];
  const closed = a.Distance(b) < 1e-7;
  a.delete();
  b.delete();
  along.delete();
  return closed;
}

/**
 * A face with holes swept round a closed path: each loop's tube is already a closed shell, so the
 * solid is the outer tube's shell with each hole's tube's shell turned inside out. Its volume must
 * come out as the outer tube's less the holes' tubes'.
 */
function closedTubes(
  call: BuiltinCall,
  oc: Oc,
  walls: readonly Shape[],
): { result: Shape; caps: ShapeSet<"START" | "END"> } {
  const volumeOf = (shape: Shape) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
    const mass = props.Mass();
    props.delete();
    return mass;
  };
  // Each tube's shell, turned to enclose its tube, and that tube's volume.
  const shells = walls.map((wall) => {
    const shell = subShapes(oc, wall, "SHELL")[0];
    if (!shell || subShapes(oc, wall, "SHELL").length !== 1)
      return regenError(call, "SWEEP_FAILED");
    const alone = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell));
    const volume = volumeOf(alone.Solid());
    alone.delete();
    return { shell: volume < 0 ? shell.Reversed() : shell, volume: Math.abs(volume) };
  });
  const [outer, ...holes] = shells;
  const make = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(outer!.shell));
  for (const hole of holes) make.Add(oc.TopoDS.Shell(hole.shell.Reversed()));
  const solid = make.Solid();
  make.delete();
  const expected = outer!.volume - holes.reduce((sum, hole) => sum + hole.volume, 0);
  const volume = volumeOf(solid);
  if (!(expected > 0) || Math.abs(volume - expected) > 1e-6 * outer!.volume)
    return regenError(call, "SWEEP_FAILED");
  return { result: solid, caps: new ShapeSet<"START" | "END">(oc) };
}

/** A chain of profile edges swept into a sheet. */
function sweptWire(
  call: BuiltinCall,
  oc: Oc,
  spine: InstanceType<Oc["TopoDS_Wire"]>,
  wire: Shape,
  control: SweepControl,
): { result: Shape; caps: ShapeSet<"START" | "END"> } {
  const shell = pipeShell(call, oc, spine, wire, false, control);
  const swept = { result: shell.Shape(), caps: capsOf(oc, shell.FirstShape(), shell.LastShape()) };
  shell.delete();
  return swept;
}

/**
 * The profile control, twist and scale std's Sweep asks for, and the spine to sweep along. By
 * default the profile turns with the path in its rotation-minimizing frame (see sweepFrame.ts),
 * along a rebuilt spine unless the path is lines and arcs; it keeps its orientation, keeps a fixed
 * up direction, or follows faces' normals when asked. Scale grows linearly with length from 1 to
 * `scaleFactor` (not round a closed path). Twist turns it `angle` radians (right-handed about the
 * path) along a straight path, by following a helix around it. `folds` tells whether a kept or
 * locked profile would fold through itself.
 */
function sweepControl(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  definition: FsMap,
  spine: InstanceType<Oc["TopoDS_Wire"]>,
  pathEdges: readonly Shape[],
  stalled: boolean,
): {
  spine: InstanceType<Oc["TopoDS_Wire"]>;
  control: SweepControl;
  mode: string;
  /** Frees what the sweeps no longer need once built: the support sheets and rebuilt spine. */
  release: () => void;
  /** Why sweeping `profile` this way folds it through itself, or null when it doesn't. */
  folds: (profile: Shape) => string | null;
  /** Why sweeping `profile` this way would run into itself, or null when it wouldn't. */
  crosses: (profile: Shape) => string | null;
} {
  const field = (name: string) => definition.getField(name);
  // Unset options come as undefined or as queries that find nothing (std's Curve pattern passes
  // qNothing() lock faces even with LOCK_FACES); either way there's nothing to lock to.
  const lockFaces =
    field("lockFaces") === undefined
      ? []
      : facesOf(model, resolve(call, model, oc, field("lockFaces")));
  const lockDirection = field("lockDirection");
  const given = untag(field("profileControl"));
  const mode =
    given === "KEEP_ORIENTATION" || untag(field("keepProfileOrientation")) === true
      ? "KEEP_ORIENTATION"
      : (given === undefined || given === "LOCK_DIRECTION") && lockDirection !== undefined
        ? "LOCK_DIRECTION"
        : (given === undefined || given === "LOCK_FACES") && lockFaces.length > 0
          ? "LOCK_FACES"
          : "NONE";
  // Every frame but a kept one turns with the path's direction, which a stall doesn't have; a kept
  // one is checked for folds by bounding how fast that direction turns, which a stall doesn't let.
  if (stalled)
    return call.unsupported(
      `opSweep with profile control ${mode} along a path whose curve stops dead somewhere (its derivative is zero there) is not supported locally yet.`,
    );
  const along = new oc.BRepAdaptor_CompCurve(spine, false);
  const [first, last] = [along.FirstParameter(), along.LastParameter()];
  const start = xyz(along.Value(first));
  const scale =
    untag(field("hasScale")) === true ? magnitude(call, field("scaleFactor"), "scaleFactor") : 1;
  const twist = untag(field("hasTwist")) === true ? magnitude(call, field("angle"), "angle") : 0;
  if (scale !== 1) {
    const end = xyz(along.Value(last));
    if (Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) < 1e-7)
      return call.unsupported(
        "opSweep with a scale along a closed path is not supported locally yet: its last section would have to meet its first at another size.",
      );
  }
  let auxiliary: InstanceType<Oc["TopoDS_Wire"]> | null = null;
  if (twist !== 0) {
    if (mode === "LOCK_FACES" || mode === "LOCK_DIRECTION")
      return call.unsupported(`opSweep with a twist and ${mode} is not supported locally yet.`);
    const end = xyz(along.Value(last));
    const run: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const reach = Math.hypot(...run);
    const axis = normalized(run);
    // Straight whatever its curve type (a two-point fit spline is a line too).
    const straight = pathEdges.every((edge) => {
      const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
      const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
      return Array.from({ length: 17 }, (_, i) => xyz(curve.Value(a + ((b - a) * i) / 16))).every(
        (p) => {
          const offset: Vec3 = [p[0] - start[0], p[1] - start[1], p[2] - start[2]];
          const along = offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2];
          return Math.hypot(...offset.map((c, k) => c - along * axis[k]!)) < 1e-9;
        },
      );
    });
    if (!straight)
      return call.unsupported(
        "opSweep with a twist along a curved path is not supported locally yet.",
      );
    // A helix around the path, one path length out, turning `twist` over it. In plane mode the
    // pipe pairs each path point with where the plane square to the path there meets the helix,
    // which on a straight path is exact; matching by length fraction instead drifts.
    const x = perpendicular(axis);
    const y: Vec3 = [
      axis[1] * x[2] - axis[2] * x[1],
      axis[2] * x[0] - axis[0] * x[2],
      axis[0] * x[1] - axis[1] * x[0],
    ];
    const turns = Math.abs(twist) / (2 * Math.PI);
    const sense = Math.sign(twist) * 2 * Math.PI;
    const helix = helixCurve(call, oc, {
      point: (t) => {
        const [c, s] = [Math.cos(sense * t), Math.sin(sense * t)];
        return [0, 1, 2].map(
          (k) => start[k]! + (run[k]! * t) / turns + reach * (c * x[k]! + s * y[k]!),
        ) as unknown as Vec3;
      },
      axisStart: start,
      direction: axis,
      x,
      height: 0,
      startRadius: reach,
      first: 0,
      last: turns,
      turn: sense,
      helicalPitch: reach / turns,
      spiralPitch: 0,
    });
    addSweepKnots(oc, helix);
    auxiliary = oc.TopoDS.Wire(wireOf(oc, helix));
  }
  // By default the profile turns with the path in its rotation-minimizing frame, carried on
  // support sheets: a frame that depends on the path's shape, not its knots. Along lines and arcs
  // OpenCascade's own frame already is that one, and keeps the swept faces cylinders and tori.
  // The frame is fitted on the path's own edges, not the knotted ones the other modes sweep.
  const heading = headingAt(along, first);
  if (!heading) return call.unsupported("opSweep along a path that never moves is not supported.");
  const framed =
    mode === "NONE" && !auxiliary && !linesAndArcs(oc, spine, pathEdges)
      ? rotationMinimizingSpine(call, oc, pathEdges, start, heading)
      : null;
  const used = framed?.spine ?? spine;
  const law = scale !== 1 ? lengthScaleLaw(call, oc, used, scale) : null;
  const control: SweepControl = (shell, profile) => {
    if (auxiliary) shell.SetMode(auxiliary, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    else if (framed && !shell.SetMode(framed.support))
      return call.unsupported(
        "opSweep couldn't hold its profile in the path's minimum-twist frame; this path is not supported locally yet.",
      );
    else if (mode === "KEEP_ORIENTATION")
      shell.SetMode(new oc.gp_Ax2(new oc.gp_Pnt(...start), new oc.gp_Dir(0, 0, 1)));
    else if (mode === "LOCK_DIRECTION")
      shell.SetMode(new oc.gp_Dir(...normalized(vector(call, lockDirection, 3, "lockDirection"))));
    else if (mode === "LOCK_FACES" && !shell.SetMode(compound(oc, lockFaces)))
      return regenError(call, "SWEEP_BAD_LOCK_FACES");
    if (law) shell.SetLaw(profile, law, false, false);
    else shell.Add(profile, false, false);
  };
  return {
    spine: used,
    control,
    mode: twist !== 0 ? `${mode} with a twist` : mode,
    release: () => {
      framed?.spine.delete();
      framed?.support.delete();
      law?.delete();
    },
    // A kept profile folds where its plane comes to hold the path's direction (a single straight
    // edge, where that edge does); a locked one where the path runs along the locked direction,
    // where its turn about the path is undefined. Other frames keep the profile's angle to the
    // path, and a twist runs along a straight path.
    // Lock faces turn the profile as the faces do, which isn't known here (see Carrying).
    crosses: (profile) => {
      const polylines = profilePoints(oc, profile);
      const plane = planeThrough(polylines.flat());
      const carrying: Carrying = auxiliary
        ? { kind: "twisted", angle: twist }
        : mode === "KEEP_ORIENTATION"
          ? { kind: "kept" }
          : mode === "LOCK_DIRECTION"
            ? {
                kind: "locked",
                direction: normalized(vector(call, lockDirection, 3, "lockDirection")),
              }
            : mode === "LOCK_FACES"
              ? { kind: "faces" }
              : { kind: "turning" };
      const normal = plane?.kind === "plane" && mode !== "LOCK_FACES" ? plane.normal : null;
      const found = crossesItself(
        call,
        oc,
        pathEdges,
        start,
        heading,
        carrying,
        polylines,
        normal,
        scale,
      );
      return found === "near"
        ? "the profile reaches past a bend's center"
        : found === "far"
          ? "two stretches of the path pass within the profile's reach of each other"
          : null;
    },
    folds: (profile) => {
      const size = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
      const along = (...measures: ((tangent: Vec3) => number)[]) =>
        foldsAlong(call, oc, pathEdges, start, heading, measures);
      if (auxiliary) return null;
      if (mode === "LOCK_DIRECTION") {
        const lock = normalized(vector(call, lockDirection, 3, "lockDirection"));
        return along((t) => size(cross(t, lock)))
          ? "the path runs along the locked direction"
          : null;
      }
      if (mode !== "KEEP_ORIENTATION") return null;
      const edgePoints = profilePoints(oc, profile);
      // A kept strip folds where the path runs along its profile edge, and a kept plane where the
      // path crosses it.
      const measureOf = (plane: NonNullable<ReturnType<typeof planeThrough>>) => {
        if (plane.kind === "line") return (t: Vec3) => size(cross(t, plane.direction));
        const sign = Math.sign(dot(heading, plane.normal)) || 1;
        return (t: Vec3) => sign * dot(t, plane.normal);
      };
      const whole = planeThrough(edgePoints.flat());
      // Not planar: edge by edge, straight or each in its own plane, all along one walk of the path.
      const planes = whole ? [whole] : edgePoints.map(planeThrough);
      if (planes.some((plane) => plane === null))
        return call.unsupported(
          "opSweep keeping the orientation of a profile with an edge that isn't planar is not supported locally yet.",
        );
      return along(...planes.flatMap((plane) => (plane ? [measureOf(plane)] : [])))
        ? "the kept profile comes to lie along the path"
        : null;
    },
  };
}

/**
 * A scale law growing evenly with length along `spine`, from 1 at its start to `scale` at its
 * end. OpenCascade spreads a law over a spine's edges by their lengths, but within an edge by the
 * edge's own parameter, which needn't run evenly (an arc's does, a spline's often doesn't). So the
 * law is tabulated against that mapping, each edge's length integrated by Simpson's rule, and
 * interpolated, with nodes added until it holds to 1e-9 of the change in scale.
 */
function lengthScaleLaw(
  call: BuiltinCall,
  oc: Oc,
  spine: InstanceType<Oc["TopoDS_Wire"]>,
  scale: number,
) {
  const pointOf = (curve: InstanceType<Oc["BRepAdaptor_Curve"]>, u: number) => {
    const point = curve.Value(u);
    const at = xyz(point);
    point.delete();
    return at;
  };
  // The spine's edges in walking order, each with the way it's walked.
  const along = new oc.BRepAdaptor_CompCurve(spine, false);
  const startPoint = along.Value(along.FirstParameter());
  let tip = xyz(startPoint);
  startPoint.delete();
  along.delete();
  const left = subShapes(oc, spine, "EDGE").map((edge) => {
    const topoEdge = oc.TopoDS.Edge(edge);
    const curve = new oc.BRepAdaptor_Curve(topoEdge);
    const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
    const forward = String(edge.Orientation()) !== "TopAbs_REVERSED";
    topoEdge.delete();
    edge.delete();
    return { curve, from: forward ? first : last, to: forward ? last : first };
  });
  const walked: typeof left = [];
  try {
    while (left.length) {
      const next = left.findIndex(({ curve, from }) => {
        const p = pointOf(curve, from);
        return Math.hypot(p[0] - tip[0], p[1] - tip[1], p[2] - tip[2]) < 1e-7;
      });
      if (next < 0) return call.fail("opSweep couldn't follow its path's edges in order.");
      const [edge] = left.splice(next, 1);
      walked.push(edge!);
      tip = pointOf(edge!.curve, edge!.to);
    }
    const speed = (curve: InstanceType<Oc["BRepAdaptor_Curve"]>, u: number) => {
      const { Point, D1 } = curve.EvalD1(u);
      const magnitude = D1.Magnitude();
      Point.delete();
      D1.delete();
      return magnitude;
    };
    // Each edge's pieces (fractions of its parameter range) and the length up to each piece's end.
    let pieces = walked.map(() => Array.from({ length: 33 }, (_, k) => k / 32));
    const tolerance = 1e-9 * Math.abs(scale - 1);
    const node = new oc.gp_Pnt2d(0, 0);
    try {
      for (let pass = 0; pass < 40; pass++) {
        const at = (i: number, f: number) =>
          walked[i]!.from + (walked[i]!.to - walked[i]!.from) * f;
        const simpson = (i: number, f: number, g: number) => {
          const [a, b] = [at(i, f), at(i, g)];
          const curve = walked[i]!.curve;
          return (
            (Math.abs(b - a) / 6) *
            (speed(curve, a) + 4 * speed(curve, (a + b) / 2) + speed(curve, b))
          );
        };
        const lengths = pieces.map((fs, i) => {
          const out = [0];
          for (let k = 1; k < fs.length; k++)
            out.push(out[k - 1]! + simpson(i, fs[k - 1]!, fs[k]!));
          return out;
        });
        const total = lengths.reduce((sum, ls) => sum + ls.at(-1)!, 0);
        // Node (w, value): w spreads edges by length and runs with the parameter within each.
        const nodes: [number, number][] = [];
        const middles: [number, number][] = [];
        let before = 0;
        pieces.forEach((fs, i) => {
          const edgeLength = lengths[i]!.at(-1)!;
          const w = (f: number) => (before + edgeLength * f) / total;
          const value = (s: number) => 1 + ((scale - 1) * (before + s)) / total;
          fs.forEach((f, k) => {
            if (k > 0 || i === 0) nodes.push([w(f), value(lengths[i]![k]!)]);
            if (k > 0) {
              const half = (fs[k - 1]! + f) / 2;
              middles.push([w(half), value(lengths[i]![k - 1]! + simpson(i, fs[k - 1]!, half))]);
            }
          });
          before += edgeLength;
        });
        const points = new oc.NCollection_Array1_gp_Pnt2d(1, nodes.length);
        nodes.forEach(([w, value], k) => {
          // SetCoord(x, y) would be taken for SetCoord(index, value).
          node.SetX(w);
          node.SetY(value);
          points.SetValue(k + 1, node);
        });
        const law = new oc.Law_Interpol();
        law.Set(points, false);
        points.delete();
        // Split the pieces whose middle the law misses.
        let index = 0;
        let split = false;
        pieces = pieces.map((fs) =>
          fs.flatMap((f, k) => {
            if (k === 0) return [f];
            const [w, value] = middles[index++]!;
            if (Math.abs(law.Value(w) - value) <= tolerance) return [f];
            split = true;
            return [(fs[k - 1]! + f) / 2, f];
          }),
        );
        if (!split) return law;
        law.delete();
      }
    } finally {
      node.delete();
    }
    return call.unsupported(
      "opSweep couldn't make its scale follow the path's length closely enough; this path is not supported locally yet.",
    );
  } finally {
    for (const { curve } of [...walked, ...left]) curve.delete();
  }
}

const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
/** The cross product of two vectors. */
const cross = (u: Vec3, v: Vec3): Vec3 => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/**
 * The plane `points` lie in (within 1e-9 m), or the line when they're all on one, or null when they
 * don't lie in one plane. The plane runs through the first point, the point farthest from it and
 * the point farthest off the line between them.
 */
function planeThrough(
  points: readonly Vec3[],
): { kind: "plane"; normal: Vec3 } | { kind: "line"; direction: Vec3 } | null {
  const start = points[0];
  if (!start) return null;
  const size = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const off = (p: Vec3): Vec3 => [p[0] - start[0], p[1] - start[1], p[2] - start[2]];
  const far = points.reduce((best, p) => (size(off(p)) > size(off(best)) ? p : best));
  if (size(off(far)) < 1e-12) return null;
  const normal = points
    .map((p) => cross(off(far), off(p)))
    .reduce((best, n) => (size(n) > size(best) ? n : best));
  // Off the line by less than 1e-9 m everywhere: a line.
  if (size(normal) / size(off(far)) < 1e-9)
    return { kind: "line", direction: normalized(off(far)) };
  const unit = normalized(normal);
  return points.every((p) => Math.abs(dot(off(p), unit)) < 1e-9)
    ? { kind: "plane", normal: unit }
    : null;
}

/** Points along each edge of a profile: 17 per edge, ends included. */
function profilePoints(oc: Oc, profile: Shape): Vec3[][] {
  return subShapes(oc, profile, "EDGE").map((edge) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    const points = Array.from({ length: 17 }, (_, i): Vec3 => {
      const point = curve.Value(a + ((b - a) * i) / 16);
      const at = xyz(point);
      point.delete();
      return at;
    });
    curve.delete();
    return points;
  });
}

/**
 * True when every edge of the path is a line or a circular arc and, if the path closes, it lies in
 * one plane. Along such a path OpenCascade's own (corrected Frenet) frame is rotation-minimizing:
 * fixed along a line, holding the arc's plane normal round an arc, carried on through tangent
 * joins. A closed 3D loop still needs its closing turn spread, which only the support sheets do.
 */
function linesAndArcs(oc: Oc, spine: Shape, pathEdges: readonly Shape[]): boolean {
  const curves = pathEdges.map((edge) => new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const analytic = (kind: string) => kind === "GeomAbs_Line" || kind === "GeomAbs_Circle";
  if (!curves.every((curve) => analytic(String(curve.GetType())))) return false;
  const along = new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(spine), false);
  const [start, end] = [
    xyz(along.Value(along.FirstParameter())),
    xyz(along.Value(along.LastParameter())),
  ];
  if (Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) > 1e-7) return true;
  const plane = planeThrough(
    curves.flatMap((curve) => {
      const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
      return Array.from({ length: 9 }, (_, i): Vec3 => xyz(curve.Value(a + ((b - a) * i) / 8)));
    }),
  );
  return plane !== null;
}

/** Any unit vector perpendicular to `d`. */
function perpendicular(d: Vec3): Vec3 {
  const other: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalized([
    d[1] * other[2] - d[2] * other[1],
    d[2] * other[0] - d[0] * other[2],
    d[0] * other[1] - d[1] * other[0],
  ]);
}

/**
 * The points of an `opLoft` connection made of vertices, one per profile. Several connections, or
 * connections at points along edges, aren't matched locally.
 */
function connectionPoints(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  definition: FsMap,
): Vec3[] | null {
  const value = definition.getField("connections");
  const connections = value === undefined ? [] : array(call, value, "connections");
  if (connections.length === 0) return null;
  if (connections.length > 1)
    return call.unsupported("opLoft with more than one connection is not supported locally yet.");
  const connection = map(call, connections[0], "connections[0]");
  const along = connection.getField("connectionEdges");
  if (along !== undefined && array(call, along, "connectionEdges").length > 0)
    return call.unsupported(
      "opLoft connections at points along edges are not supported locally yet.",
    );
  return resolve(call, model, oc, connection.getField("connectionEntities"))
    .filter((entity) => entity.type === "VERTEX" || entity.bodyType === "POINT")
    .map((entity) =>
      xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(subShapes(oc, entity.shape, "VERTEX")[0]!))),
    );
}

/**
 * Profile wires rebuilt to start at their connection point and to wind the same way as the first
 * (point profiles pass through). A profile without a connection point raises std's error.
 */
function connectedWires(
  call: BuiltinCall,
  oc: Oc,
  wires: readonly Shape[],
  anchors: readonly Vec3[],
): Shape[] {
  let reference: Vec3 | null = null;
  return wires.map((wire) => {
    if (String(wire.ShapeType()) === "TopAbs_VERTEX") return wire;
    const chains = chainsOf(oc, subShapes(oc, wire, "EDGE"));
    if (!chains || chains.length !== 1) return regenError(call, "LOFT_PROFILE_FAILED");
    let chain = chains[0]!;
    const startOf = (link: { edge: Shape; backward: boolean }) =>
      endsOf(oc, link.edge)[link.backward ? 1 : 0];
    const anchor = anchors.find((point) => chain.some((link) => near(startOf(link), point)));
    if (!anchor) return regenError(call, "LOFT_CONNECTION_MATCHING");
    const at = chain.findIndex((link) => near(startOf(link), anchor));
    chain = [...chain.slice(at), ...chain.slice(0, at)];
    // Newell's normal of the corners, in walking order, gives the winding.
    const corners = chain.map(startOf);
    const normal = corners.reduce<Vec3>(
      (n, p, i) => {
        const q = corners[(i + 1) % corners.length]!;
        return [
          n[0] + (p[1] - q[1]) * (p[2] + q[2]),
          n[1] + (p[2] - q[2]) * (p[0] + q[0]),
          n[2] + (p[0] - q[0]) * (p[1] + q[1]),
        ];
      },
      [0, 0, 0],
    );
    reference ??= normal;
    // Walking a loop the other way from the same start visits its edges in reverse, each flipped.
    if (normal[0] * reference[0] + normal[1] * reference[1] + normal[2] * reference[2] < 0)
      chain = chain.toReversed().map((link) => ({ edge: link.edge, backward: !link.backward }));
    const rebuilt = new oc.BRepBuilderAPI_MakeWire();
    for (const link of chain)
      rebuilt.Add(oc.TopoDS.Edge(link.backward ? link.edge.Reversed() : link.edge));
    return rebuilt.Wire();
  });
}

/**
 * True when a path turns sharply where its edges meet: an edge's end leaves in a different
 * direction from the one the edge it meets arrives in, including doubling straight back, and a
 * closed edge's own start and end meeting at an angle.
 */
function hasSharpCorner(oc: Oc, edges: readonly Shape[]): boolean {
  const ends = edges.flatMap((edge) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const at = (u: number, isEnd: boolean) => {
      const point = curve.Value(u);
      const end = { isEnd, point: xyz(point), tangent: headingAt(curve, u) };
      point.delete();
      return end;
    };
    return [at(curve.FirstParameter(), false), at(curve.LastParameter(), true)];
  });
  const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;
  return ends.some((a, i) =>
    ends.slice(i + 1).some((b) => {
      // Pairs include each edge's own start and end, which meet only when it's closed.
      // An end that doesn't move has no direction to compare (the sweep stops on it later).
      if (!near(a.point, b.point) || !a.tangent || !b.tangent) return false;
      // Curves run on through an end-to-start join, so the tangents agree; at an end-to-end or
      // start-to-start join they oppose.
      const expected = a.isEnd === b.isEnd ? -1 : 1;
      const dot =
        a.tangent[0] * b.tangent[0] + a.tangent[1] * b.tangent[1] + a.tangent[2] * b.tangent[2];
      return 1 - expected * dot > 1e-9;
    }),
  );
}

/**
 * Builtin fields that select a variant this runtime doesn't model yet. Unset forms don't count:
 * undefined, false, NONE, empty arrays, and queries (alone or in arrays) that find nothing.
 */
function rejectVariants(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  definition: FsMap,
  fields: readonly string[],
) {
  const isQuery = (value: FsValue) => {
    const v = untag(value);
    return v instanceof FsMap && v.getField("queryType") !== undefined;
  };
  const unset = (value: FsValue): boolean => {
    const v = untag(value);
    if (v === undefined || v === false || v === "NONE") return true;
    if (Array.isArray(v)) return v.every(unset);
    return isQuery(value) && resolve(call, model, oc, value).length === 0;
  };
  for (const field of fields)
    if (!unset(definition.getField(field)))
      return call.unsupported(`${field} is not supported locally yet.`);
}

export const OPERATION_BUILTINS = {
  opRevolve: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const faces = resolve(call, model, oc, definition.getField("entities")).filter(
      (entity) => entity.type === "FACE",
    );
    if (faces.length === 0) return call.fail("Nothing to revolve.");
    const axis = map(call, definition.getField("axis"), "axis");
    const origin = vector(call, axis.getField("origin"), 3, "axis.origin");
    const direction = normalized(vector(call, axis.getField("direction"), 3, "axis.direction"));
    const ax1 = new oc.gp_Ax1(new oc.gp_Pnt(...origin), new oc.gp_Dir(...direction));
    const forward = magnitude(call, definition.getField("angleForward") ?? 0, "angleForward");
    const back =
      definition.getField("angleBack") === undefined
        ? 0
        : magnitude(call, definition.getField("angleBack"), "angleBack");
    // Angles are normalized to [0, 2 PI), so a full revolve can arrive as 0.
    const full = Math.abs(forward + back) < 1e-12 || Math.abs(forward + back - 2 * Math.PI) < 1e-12;
    const total = full ? 2 * Math.PI : forward + back;
    const caps = new ShapeSet<"START" | "END">(oc);
    // A profile reaching both sides of the axis would sweep through itself.
    const across = (p: Vec3) => {
      const n = planarNormal(oc, faces[0]!.shape);
      if (!n) return 0;
      const side = [
        n[1] * direction[2] - n[2] * direction[1],
        n[2] * direction[0] - n[0] * direction[2],
        n[0] * direction[1] - n[1] * direction[0],
      ];
      return (
        (p[0] - origin[0]) * side[0]! +
        (p[1] - origin[1]) * side[1]! +
        (p[2] - origin[2]) * side[2]!
      );
    };
    for (const face of faces) {
      const offsets = subShapes(oc, face.shape, "EDGE")
        .flatMap((edge) => edgePoints(oc, edge, 9))
        .map(across);
      if (Math.min(...offsets) < -1e-9 && Math.max(...offsets) > 1e-9)
        return regenError(call, "REVOLVE_FAILED");
    }
    const solids = faces.map((face) => {
      const start = new oc.gp_Trsf();
      start.SetRotation(ax1, -back);
      const base = back
        ? new oc.BRepBuilderAPI_Transform(face.shape, start, true, false).Shape()
        : face.shape;
      return attempt(call, "REVOLVE_FAILED", () => {
        const revol = new oc.BRepPrimAPI_MakeRevol(base, ax1, total, true);
        const shape = revol.Shape();
        if (!full) {
          for (const cap of subShapes(oc, revol.FirstShape(), "FACE")) caps.set(cap, "START");
          for (const cap of subShapes(oc, revol.LastShape(), "FACE")) caps.set(cap, "END");
        }
        return shape;
      });
    });
    model.geometry = addBodies(
      oc,
      model.geometry,
      solids.map((shape) => ({
        shape,
        bodyType: "SOLID" as const,
        createdBy: idOf(id),
        annotate: (s: Shape) => ({ cap: caps.get(s) ?? null }),
      })),
    ).state;
    return undefined;
  },

  opFillet: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    if (
      untag(definition.getField("crossSection")) !== undefined &&
      untag(definition.getField("crossSection")) !== "CIRCULAR"
    )
      return call.unsupported("Only circular fillets are supported locally yet.");
    if (definition.getField("partialFilletBounds") !== undefined)
      return call.unsupported("Partial fillets are not supported locally yet.");
    rejectVariants(call, oc, model, definition, [
      "isAsymmetric",
      "createDetachedSurface",
      "smoothCorners",
    ]);
    if (String(untag(definition.getField("blendControlType")) ?? "RADIUS") !== "RADIUS")
      return call.unsupported("Fillets sized by width are not supported locally yet.");
    // OpenCascade's variable rolling ball takes off 9.476 mm^3 where a ball growing from 1 to 3 mm
    // along a 10 mm cube edge would take 9.179 (its envelope), or 9.299 with circular sections
    // square to the edge; which one Parasolid builds isn't documented.
    if (untag(definition.getField("isVariable")) === true)
      return call.unsupported(
        "Variable fillets are not supported locally yet: OpenCascade's varying radius doesn't follow a documented Onshape profile.",
      );
    const radius = magnitude(call, definition.getField("radius"), "radius");
    const edges = edgesOf(oc, model, resolve(call, model, oc, definition.getField("entities")));
    if (edges.length === 0) return call.fail("Nothing to fillet.");
    rejectUnpropagated(call, oc, model, definition, edges);
    for (const [body, bodyEdges] of byBody(model, edges)) {
      const result = blended(
        call,
        oc,
        body.shape,
        bodyEdges.map((edge) => edge.shape),
        "FILLET_FAILED",
        (shape, along) => {
          const fillet = new oc.BRepFilletAPI_MakeFillet(shape);
          for (const edge of along) fillet.Add(radius, oc.TopoDS.Edge(edge));
          return { shape: fillet.Shape(), history: historyOf(oc, fillet) };
        },
      );
      modifyBody(oc, model, body, result.shape, result.history, id);
    }
    return undefined;
  },

  opChamfer: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const type = String(untag(definition.getField("chamferType")) ?? "EQUAL_OFFSETS");
    if (String(untag(definition.getField("chamferMethod")) ?? "FACE_OFFSET") !== "FACE_OFFSET")
      return call.unsupported("Chamfers measured by apex range are not supported locally yet.");
    // Which face takes width1 (or the angle) follows the kernel's edge direction, which differs
    // between Parasolid and OpenCascade, so only distances that are equal both ways can match.
    let width: number;
    if (type === "EQUAL_OFFSETS") width = magnitude(call, definition.getField("width"), "width");
    else if (type === "TWO_OFFSETS") {
      width = magnitude(call, definition.getField("width1"), "width1");
      if (Math.abs(width - magnitude(call, definition.getField("width2"), "width2")) > 1e-12)
        return call.unsupported(
          "Chamfers with two different distances are not supported locally yet: which face takes each distance follows Parasolid's edge direction.",
        );
    } else
      return call.unsupported(
        `Chamfer type ${type} is not supported locally yet: which face takes the distance follows Parasolid's edge direction.`,
      );
    const edges = edgesOf(oc, model, resolve(call, model, oc, definition.getField("entities")));
    if (edges.length === 0) return call.fail("Nothing to chamfer.");
    rejectUnpropagated(call, oc, model, definition, edges);
    for (const [body, bodyEdges] of byBody(model, edges)) {
      const result = blended(
        call,
        oc,
        body.shape,
        bodyEdges.map((edge) => edge.shape),
        "CHAMFER_FAILED",
        (shape, along) => {
          const chamfer = new oc.BRepFilletAPI_MakeChamfer(shape);
          for (const edge of along) chamfer.Add(width, oc.TopoDS.Edge(edge));
          return { shape: chamfer.Shape(), history: historyOf(oc, chamfer) };
        },
      );
      modifyBody(oc, model, body, result.shape, result.history, id);
    }
    return undefined;
  },

  opShell: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const thickness = magnitude(call, definition.getField("thickness"), "thickness");
    const selected = resolve(call, model, oc, definition.getField("entities"));
    for (const [body, entities] of byBody(model, selected)) {
      const faces = entities.filter((entity) => entity.type === "FACE").map((face) => face.shape);
      // The body less its offset (or its offset less the body), else OpenCascade's own shell; each
      // only when it's valid, really a shell, and one with sharp joins (OpenCascade's own rounds
      // concave ones). Either can fail where the other works: an offset of a box with a chamfered
      // top edge comes back wrong; OpenCascade's shell can't make a hollow body.
      const accepted = (made: { shape: Shape; history: History } | null) => {
        if (
          !made ||
          !sound(oc, made.shape) ||
          !shelled(oc, body.shape, faces, thickness, made.shape)
        )
          return null;
        const check = shellCheck(oc, body.shape, faces, thickness, made.shape);
        return check === "wrong" ? null : { ...made, consumed: check.consumed };
      };
      const built = shellSolid(oc, body.shape, faces, thickness);
      // Only walls that leave no room for a cavity anywhere are what Onshape fails too.
      if (built === "no cavity") return regenError(call, "SHELL_FAILED");
      // A kept face shrunk to nothing while a cavity fits (a convex blend no wider than the walls):
      // Onshape likely meets its neighbours at a sharp corner, which isn't built here.
      const collapsing = subShapes(oc, body.shape, "FACE")
        .filter((face) => !faces.some((removed) => removed.IsSame(face)))
        .map((face) => ({ face, radius: collapseRadius(oc, face, thickness) }))
        .find(({ radius }) => radius !== null);
      if (collapsing)
        return call.unsupported(
          `Shelling this body is not supported locally yet: walls ${millimeters(thickness)} mm thick shrink ${described(oc, collapsing.face, collapsing.radius!)} to nothing.`,
        );
      const made = accepted(built) ?? accepted(thickSolid(oc, body.shape, faces, thickness));
      if (!made) return call.unsupported("Shelling this body is not supported locally yet.");
      // Walls with no room on a thin feature (or, outward, across a narrow gap): leaving the feature
      // solid (or the gap filled) is a guess at what Onshape does.
      if (made.consumed)
        return call.unsupported(
          `Shelling this body is not supported locally yet: ${located(oc, made.consumed)} ${thickness < 0 ? "is on a feature thinner" : "faces a gap narrower"} than two ${millimeters(thickness)} mm walls.`,
        );
      modifyBody(oc, model, body, made.shape, made.history, id);
    }
    return undefined;
  },

  opPattern: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const transforms = array(call, definition.getField("transforms"), "transforms");
    const names = array(call, definition.getField("instanceNames"), "instanceNames").map((name) =>
      String(untag(name)),
    );
    if (names.length !== transforms.length)
      return call.fail("transforms and instanceNames must be the same size.");
    const selected = resolve(call, model, oc, definition.getField("entities"));
    if (selected.some((entity) => entity.type !== "BODY" && entity.type !== "FACE"))
      return call.unsupported("Patterning edges or vertices is not supported locally yet.");
    const entities = selected.filter((entity) => entity.type === "BODY");
    const faces = selected.filter((entity) => entity.type === "FACE");
    if (faces.length)
      patternFaces(
        call,
        oc,
        model,
        faces,
        transforms.map((transform, i) => ({ trsf: toTrsf(call, oc, transform), name: names[i]! })),
        id,
        untag(definition.getField("copyPropertiesAndAttributes")) !== false,
      );
    const copies = transforms.flatMap((transform, i) => {
      const trsf = toTrsf(call, oc, transform);
      return entities.map((body) => {
        const moved = new oc.BRepBuilderAPI_Transform(body.shape, trsf, true, false);
        // Each copied entity names the seed entity it copies, for lineage.
        const seeds = new ShapeSet<string>(oc);
        for (const seed of model.geometry.entities.values())
          if (seed.body === body.id) seeds.set(moved.ModifiedShape(seed.shape), seed.id);
        return {
          shape: moved.Shape(),
          sources: (shape: Shape) => {
            const seed = seeds.get(shape);
            return seed ? [seed] : [];
          },
          bodyType: body.bodyType,
          createdBy: [...idOf(id), names[i]!],
          construction: body.construction,
          ...(body.frame ? { frame: movedFrame(oc, trsf, body.frame) } : {}),
          annotate: (_: Shape, type: string) =>
            type === "BODY" && untag(definition.getField("copyPropertiesAndAttributes")) !== false
              ? { attributes: body.attributes, properties: body.properties }
              : {},
        };
      });
    });
    model.geometry = addBodies(oc, model.geometry, copies).state;
    return undefined;
  },

  opTransform: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const trsf = toTrsf(call, oc, definition.getField("transform"));
    const bodies = [
      ...byBody(model, resolve(call, model, oc, definition.getField("bodies"))).keys(),
    ];
    for (const body of bodies) {
      const moved = new oc.BRepBuilderAPI_Transform(body.shape, trsf, true, false);
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: [
          {
            shape: moved.Shape(),
            bodyType: body.bodyType,
            ...(body.frame ? { frame: movedFrame(oc, trsf, body.frame) } : {}),
          },
        ],
        history: historyOf(oc, moved),
        createdBy: idOf(id),
      }).state;
    }
    return undefined;
  },

  opThicken: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const front = magnitude(call, definition.getField("thickness1"), "thickness1");
    const back = magnitude(call, definition.getField("thickness2"), "thickness2");
    const selected = resolve(call, model, oc, definition.getField("entities"));
    const faces = facesOf(model, selected);
    if (faces.length === 0) return regenError(call, "THICKEN_SELECT_ENTITIES");
    const thickened = (face: Shape): Shape => {
      const normal = planarNormal(oc, face);
      if (normal) {
        // A planar face sweeps straight along its normal, from -back to +front.
        const start = translated(oc, face, [
          -normal[0] * back,
          -normal[1] * back,
          -normal[2] * back,
        ]);
        const depth = front + back;
        return attempt(call, "THICKEN_FAILED", () =>
          new oc.BRepPrimAPI_MakePrism(
            start,
            new oc.gp_Vec(normal[0] * depth, normal[1] * depth, normal[2] * depth),
            true,
            true,
          ).Shape(),
        );
      }
      return (
        thickenFace(oc, face, front, back) ??
        call.unsupported("Thickening this surface is not supported locally yet.")
      );
    };
    // Faces sharing edges thicken as one sheet, one solid. Where they meet tangentially, the
    // pieces' end walls coincide and fusing them is exact; at a sharp join Onshape fills or trims
    // the corner in a way not reproduced here.
    const solids = connectedGroups(
      oc,
      faces.map((face) => face.shape),
    ).map((group) => {
      if (!smoothSheet(oc, group))
        return call.unsupported(
          "Thickening faces that meet at a sharp edge is not supported locally yet.",
        );
      // Deeper than a face's radius on its concave side there's no surface to offset to. With
      // every face of the sheet so, nothing is left to thicken and Onshape fails too; with only
      // some (a blend and the face beside it), Onshape likely closes the gap with a sharp corner.
      const collapsing = group
        .map((face) => ({
          face,
          radius: collapseRadius(oc, face, front) ?? collapseRadius(oc, face, -back),
        }))
        .filter(({ radius }) => radius !== null);
      if (collapsing.length === group.length) return regenError(call, "THICKEN_FAILED");
      const [shrunk] = collapsing;
      if (shrunk)
        return call.unsupported(
          `Thickening this surface is not supported locally yet: ${millimeters(Math.max(front, back))} mm shrinks ${described(oc, shrunk.face, shrunk.radius!)} to nothing.`,
        );
      const pieces = group.map(thickened);
      // OpenCascade failing to build a valid solid, or gluing one together with tolerances its
      // check passes, is a local limitation.
      const loosest = Math.max(TIGHT_TOLERANCE, ...group.map((face) => loosestTolerance(oc, face)));
      const right = (shape: Shape) => sound(oc, shape) && loosestTolerance(oc, shape) <= loosest;
      if (!pieces.every(right))
        return call.unsupported("Thickening this surface is not supported locally yet.");
      const [first, ...rest] = pieces;
      const fused = rest.length ? fillAndCut(oc, first!, rest, [])?.shape : first;
      if (!fused || subShapes(oc, fused, "SOLID").length !== 1 || !right(fused))
        return call.unsupported("Thickening this surface is not supported locally yet.");
      return fused;
    });
    let state = addBodies(
      oc,
      model.geometry,
      solids.map((shape) => ({ shape, bodyType: "SOLID" as const, createdBy: idOf(id) })),
    ).state;
    // keepTools false deletes sheet bodies selected whole; sketches, construction planes and
    // solids always stay.
    if (untag(definition.getField("keepTools")) === false)
      state = removeBodies(
        state,
        selected
          .filter(
            (entity) =>
              entity.type === "BODY" &&
              entity.bodyType === "SHEET" &&
              !entity.construction &&
              ![...model.geometry.entities.values()].some(
                (face) => face.body === entity.id && face.sketch !== null,
              ),
          )
          .map((body) => body.id),
      );
    model.geometry = state;
    return undefined;
  },

  opLoft: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    rejectVariants(call, oc, model, definition, [
      "guideSubqueries",
      "derivativeInfo",
      "addSections",
      "makePeriodic",
    ]);
    const anchors = connectionPoints(call, oc, model, definition);
    const solid = String(untag(definition.getField("bodyType")) ?? "SOLID") !== "SURFACE";
    const profiles = array(call, definition.getField("profileSubqueries"), "profileSubqueries");
    if (profiles.length < 2) return regenError(call, "LOFT_SELECT_PROFILES");
    const loft = new oc.BRepOffsetAPI_ThruSections(solid, false, 1e-6);
    // With a connection the profiles start at it and wind alike, so OpenCascade pairs them as given.
    const wires: Shape[] = [];
    if (anchors) loft.CheckCompatibility(false);
    for (const profile of profiles) {
      const entities = resolve(call, model, oc, profile);
      const faces = facesOf(model, entities);
      const vertices = entities.filter((entity) => entity.type === "VERTEX");
      const edges = entities.filter((entity) => entity.type === "EDGE");
      if (faces.length === 1) {
        if (subShapes(oc, faces[0]!.shape, "WIRE").length > 1)
          return regenError(call, "LOFT_PROFILE_NO_INNER_LOOPS");
        wires.push(oc.BRepTools.OuterWire(oc.TopoDS.Face(faces[0]!.shape)));
      } else if (faces.length === 0 && vertices.length === 1 && edges.length === 0)
        wires.push(vertices[0]!.shape);
      else if (faces.length === 0 && edges.length > 0 && !solid)
        wires.push(
          chainedWire(
            call,
            oc,
            edges.map((edge) => edge.shape),
            "LOFT_PROFILE_FAILED",
          ),
        );
      else return regenError(call, faces.length > 1 ? "LOFT_PROFILE_SINGLE_FACE" : "LOFT_FAILED");
    }
    for (const wire of anchors ? connectedWires(call, oc, wires, anchors) : wires)
      if (String(wire.ShapeType()) === "TopAbs_VERTEX") loft.AddVertex(oc.TopoDS.Vertex(wire));
      else loft.AddWire(oc.TopoDS.Wire(wire));
    const shape = attempt(call, "LOFT_FAILED", () => {
      loft.Build(new oc.Message_ProgressRange());
      return loft.Shape();
    });
    const caps = capsOf(oc, loft.FirstShape(), loft.LastShape());
    const bodies = (solid ? subShapes(oc, shape, "SOLID") : subShapes(oc, shape, "SHELL")).map(
      (body) => requireValid(call, oc, body, "LOFT_FAILED"),
    );
    if (bodies.length === 0) return regenError(call, "LOFT_FAILED");
    model.geometry = addBodies(
      oc,
      model.geometry,
      bodies.map((body) => ({
        shape: body,
        bodyType: solid ? ("SOLID" as const) : ("SHEET" as const),
        createdBy: idOf(id),
        annotate: (s: Shape) => ({ cap: caps.get(s) ?? null }),
      })),
    ).state;
    return undefined;
  },

  /**
   * Sweeps faces (into solids) or chains of edges (into sheets) along a chain of path edges, from
   * the path's end nearest the profile (the START cap). By default the profile turns with the path
   * in its rotation-minimizing frame (sweepFrame.ts; along lines and arcs that's OpenCascade's own,
   * which keeps cylinders and tori); sweepControl covers the other profile controls, twist and
   * scale. Surfaces are fitted to 0.1 um; a face with holes sweeps each loop and subtracts the inner
   * tubes. Stops where a kept or locked profile would fold through itself, and on any result
   * OpenCascade could only join loosely.
   */
  opSweep: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const profiles = resolve(call, model, oc, definition.getField("profiles"));
    const faces = facesOf(model, profiles);
    const profileEdges = profiles.filter((entity) => entity.type === "EDGE");
    if (faces.length === 0 && profileEdges.length === 0)
      return regenError(call, "SWEEP_SELECT_PROFILE");
    const path = resolve(call, model, oc, definition.getField("path")).filter(
      (entity) => entity.type === "EDGE",
    );
    if (path.length === 0) return regenError(call, "SWEEP_SELECT_PATH");
    const chained = oc.TopoDS.Wire(
      chainedWire(
        call,
        oc,
        path.map((edge) => sweepablePathEdge(oc, edge.shape)),
        "SWEEP_PATH_FAILED",
      ),
    );
    // Onshape's START cap is the one at the profile, so the spine runs away from it.
    const along = new oc.BRepAdaptor_CompCurve(chained, false);
    const profileShapes = [...faces, ...profileEdges].map((entity) => entity.shape);
    const gap = (u: number) =>
      Math.min(
        ...profileShapes.map((shape) =>
          distance(oc, new oc.BRepBuilderAPI_MakeVertex(along.Value(u)).Vertex(), shape),
        ),
      );
    // std doesn't say how Onshape carries a profile around a sharp corner in the path.
    if (
      hasSharpCorner(
        oc,
        path.map((edge) => edge.shape),
      )
    )
      return call.unsupported(
        "opSweep along a path with a sharp corner (edges that meet at an angle) is not supported locally yet.",
      );
    // Where a path's curve comes to rest it has no direction: a corner may hide there.
    const stalls = stallsOf(
      oc,
      path.map((edge) => edge.shape),
    );
    if (stalls.includes("corner"))
      return call.unsupported(
        "opSweep along a path with a sharp corner (where its curve comes to rest and turns) is not supported locally yet.",
      );
    const [startGap, endGap] = [gap(along.FirstParameter()), gap(along.LastParameter())];
    const spine = endGap < startGap - 1e-9 ? oc.TopoDS.Wire(chained.Reversed()) : chained;
    // Sweeping only one way from a profile partway along the path needs the path cut there.
    if (
      untag(definition.getField("extendToFullPath")) === false &&
      Math.min(startGap, endGap) > 1e-7
    )
      return call.unsupported(
        "opSweep with extendToFullPath false from a profile partway along the path is not supported locally yet.",
      );
    const swept = sweepControl(
      call,
      oc,
      model,
      definition,
      spine,
      path.map((edge) => edge.shape),
      stalls.length > 0,
    );
    const sweep = (shape: Shape, bodyType: "SOLID" | "SHEET") => {
      const fold = swept.folds(shape);
      if (fold)
        return call.unsupported(
          `opSweep with profile control ${swept.mode} folds the profile through itself along this path (${fold}); this is not supported locally yet.`,
        );
      const crossing = swept.crosses(shape);
      if (crossing)
        return call.unsupported(
          `opSweep with profile control ${swept.mode}: the swept body would run into itself (${crossing}); this is not supported locally yet.`,
        );
      const { result, caps } =
        bodyType === "SOLID"
          ? sweptFace(call, oc, swept.spine, shape, swept.control)
          : sweptWire(call, oc, swept.spine, shape, swept.control);
      // A backstop: OpenCascade glues what it can't join exactly by raising tolerances, which
      // ordinary sweeps keep within twice SWEEP_TOLERANCE.
      const loosest = Math.max(
        ...subShapes(oc, result, "VERTEX").map((v) => oc.BRep_Tool.Tolerance(oc.TopoDS.Vertex(v))),
        ...subShapes(oc, result, "EDGE").map((e) => oc.BRep_Tool.Tolerance(oc.TopoDS.Edge(e))),
      );
      if (loosest > 100 * SWEEP_TOLERANCE)
        return call.unsupported(
          `opSweep: OpenCascade could only join the swept body to within ${loosest.toExponential(1)} m; this sweep is not supported locally yet.`,
        );
      return {
        shape: requireValid(call, oc, result, "SWEEP_FAILED"),
        bodyType,
        createdBy: idOf(id),
        annotate: (s: Shape) => ({ cap: caps.get(s) ?? null }),
      };
    };
    const bodies = (() => {
      try {
        return [
          ...faces.map((face) => sweep(face.shape, "SOLID")),
          ...(profileEdges.length
            ? [
                sweep(
                  chainedWire(
                    call,
                    oc,
                    profileEdges.map((edge) => edge.shape),
                    "SWEEP_PROFILE_FAILED",
                  ),
                  "SHEET",
                ),
              ]
            : []),
        ];
      } finally {
        swept.release();
      }
    })();
    model.geometry = addBodies(oc, model.geometry, bodies).state;
    return undefined;
  },

  opSplitPart: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    if (untag(definition.getField("useTrimmed")) === true)
      return call.unsupported("useTrimmed is not supported locally yet.");
    const targets = [
      ...byBody(model, resolve(call, model, oc, definition.getField("targets"))).keys(),
    ];
    if (targets.length === 0) return regenError(call, "SPLIT_SELECT_TARGETS");
    // Planes and planar faces cut as unbounded planes: a patch on the plane covering every target.
    const across = (plane: { origin: Vec3; normal: Vec3 }) =>
      planeAround(
        oc,
        plane,
        targets.map((target) => target.shape),
      );
    const toolValue = definition.getField("tool");
    const toolMap = untag(toolValue);
    let tool: Shape;
    let side: { origin: Vec3; normal: Vec3 } | null = null;
    let toolBodies: Entity[] = [];
    if (toolMap instanceof FsMap && toolMap.getField("queryType") === undefined) {
      const plane = planeOf(call, toolValue, "tool");
      tool = across(plane);
      side = plane;
    } else {
      const entities = resolve(call, model, oc, toolValue);
      const faces = facesOf(model, entities);
      if (faces.length === 0) return regenError(call, "SPLIT_SELECT_TOOL");
      toolBodies = entities.filter((entity) => entity.type === "BODY");
      const normal = faces.length === 1 ? planarNormal(oc, faces[0]!.shape) : null;
      if (normal) {
        const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(faces[0]!.shape), true);
        const origin = xyz(surface.Plane().Location());
        tool = across({ origin, normal });
        side = { origin, normal };
      } else tool = faces.length === 1 ? faces[0]!.shape : compound(oc, faces);
    }
    const keep = String(untag(definition.getField("keepType")) ?? "KEEP_ALL");
    if (keep !== "KEEP_ALL" && !side)
      return call.unsupported(`${keep} needs a planar tool locally.`);
    for (const target of targets) {
      const splitter = new oc.BRepAlgoAPI_Splitter();
      splitter.SetArguments(toList(oc, [target.shape]));
      splitter.SetTools(toList(oc, [tool]));
      splitter.Build(new oc.Message_ProgressRange());
      if (splitter.HasErrors()) return regenError(call, "SPLIT_FAILED");
      const kind = target.bodyType === "SOLID" ? "SOLID" : "SHELL";
      const pieces = subShapes(oc, splitter.Shape(), kind).filter((piece) => {
        if (keep === "KEEP_ALL" || !side) return true;
        const props = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(piece, props, false, false, false);
        const c = xyz(props.CentreOfMass());
        const ahead =
          (c[0] - side.origin[0]) * side.normal[0] +
            (c[1] - side.origin[1]) * side.normal[1] +
            (c[2] - side.origin[2]) * side.normal[2] >
          0;
        return keep === "KEEP_FRONT" ? ahead : !ahead;
      });
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [target.id],
        keepIds: [target.id],
        results: pieces.map((shape) => ({ shape, bodyType: target.bodyType })),
        history: historyOf(oc, splitter),
        createdBy: idOf(id),
      }).state;
    }
    // Sheet bodies used as tools are deleted unless keepTools is true; construction planes stay.
    if (untag(definition.getField("keepTools")) !== true)
      model.geometry = removeBodies(
        model.geometry,
        toolBodies
          .filter((body) => body.bodyType === "SHEET" && !body.construction)
          .map((body) => body.id),
      );
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;

/** A compound of several entities' shapes. */
function compound(oc: Oc, entities: readonly Entity[]): Shape {
  const result = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(result);
  for (const entity of entities) builder.Add(result, entity.shape);
  return result;
}
