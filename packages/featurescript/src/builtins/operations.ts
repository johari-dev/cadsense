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

/** Builtin fields that select a variant this runtime doesn't model yet. */
function rejectVariants(call: BuiltinCall, definition: FsMap, fields: readonly string[]) {
  for (const field of fields) {
    const value = untag(definition.getField(field));
    if (value === undefined || value === false || (Array.isArray(value) && value.length === 0))
      continue;
    if (typeof value === "string" && value === "NONE") continue;
    return call.unsupported(`${field} is not supported locally yet.`);
  }
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
    rejectVariants(call, definition, ["isAsymmetric", "createDetachedSurface", "smoothCorners"]);
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
    rejectVariants(call, definition, [
      "guideSubqueries",
      "connections",
      "derivativeInfo",
      "addSections",
      "makePeriodic",
    ]);
    const solid = String(untag(definition.getField("bodyType")) ?? "SOLID") !== "SURFACE";
    const profiles = array(call, definition.getField("profileSubqueries"), "profileSubqueries");
    if (profiles.length < 2) return regenError(call, "LOFT_SELECT_PROFILES");
    const loft = new oc.BRepOffsetAPI_ThruSections(solid, false, 1e-6);
    for (const profile of profiles) {
      const entities = resolve(call, model, oc, profile);
      const faces = facesOf(model, entities);
      const vertices = entities.filter((entity) => entity.type === "VERTEX");
      const edges = entities.filter((entity) => entity.type === "EDGE");
      if (faces.length === 1) {
        if (subShapes(oc, faces[0]!.shape, "WIRE").length > 1)
          return regenError(call, "LOFT_PROFILE_NO_INNER_LOOPS");
        loft.AddWire(oc.BRepTools.OuterWire(oc.TopoDS.Face(faces[0]!.shape)));
      } else if (faces.length === 0 && vertices.length === 1 && edges.length === 0)
        loft.AddVertex(oc.TopoDS.Vertex(vertices[0]!.shape));
      else if (faces.length === 0 && edges.length > 0 && !solid)
        loft.AddWire(
          oc.TopoDS.Wire(
            chainedWire(
              call,
              oc,
              edges.map((edge) => edge.shape),
              "LOFT_PROFILE_FAILED",
            ),
          ),
        );
      else return regenError(call, faces.length > 1 ? "LOFT_PROFILE_SINGLE_FACE" : "LOFT_FAILED");
    }
    const shape = attempt(call, "LOFT_FAILED", () => {
      loft.Build(new oc.Message_ProgressRange());
      return loft.Shape();
    });
    const caps = capsOf(oc, loft.FirstShape(), loft.LastShape());
    const bodies = solid ? subShapes(oc, shape, "SOLID") : subShapes(oc, shape, "SHELL");
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

  opSweep: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    rejectVariants(call, definition, [
      "keepProfileOrientation",
      "lockFaces",
      "lockDirection",
      "profileControl",
      "twistAngle",
      "scale",
    ]);
    const profiles = resolve(call, model, oc, definition.getField("profiles"));
    const faces = facesOf(model, profiles);
    const profileEdges = profiles.filter((entity) => entity.type === "EDGE");
    if (faces.length === 0 && profileEdges.length === 0)
      return regenError(call, "SWEEP_SELECT_PROFILE");
    const path = resolve(call, model, oc, definition.getField("path")).filter(
      (entity) => entity.type === "EDGE",
    );
    if (path.length === 0) return regenError(call, "SWEEP_SELECT_PATH");
    const spine = oc.TopoDS.Wire(
      chainedWire(
        call,
        oc,
        path.map((edge) => edge.shape),
        "SWEEP_PATH_FAILED",
      ),
    );
    const sweep = (profile: Shape, bodyType: "SOLID" | "SHEET") => {
      const pipe = attempt(call, "SWEEP_FAILED", () => {
        const made = new oc.BRepOffsetAPI_MakePipe(spine, profile);
        made.Build(new oc.Message_ProgressRange());
        return made;
      });
      const caps = capsOf(oc, pipe.FirstShape(), pipe.LastShape());
      return {
        shape: pipe.Shape(),
        bodyType,
        createdBy: idOf(id),
        annotate: (s: Shape) => ({ cap: caps.get(s) ?? null }),
      };
    };
    model.geometry = addBodies(oc, model.geometry, [
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
    ]).state;
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
