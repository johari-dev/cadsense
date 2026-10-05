import {
  addBodies,
  historyOf,
  removeBodies,
  replaceBodies,
  type Entity,
  type Frame,
  type History,
} from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { ShapeSet, subShapes, toList, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { planeFace, planeOf } from "./construction.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { regenError } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Modeling operations beyond extrude and boolean: revolve, fillet, chamfer, shell, pattern,
 * transform, thicken, loft, sweep and split.
 */

/** std's `Transform` (3x3 `linear`, length `translation`) as an OpenCascade transformation. */
function toTrsf(call: BuiltinCall, oc: Oc, value: FsValue): InstanceType<Oc["gp_Trsf"]> {
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

/** Runs an OpenCascade algorithm, raising std's error enum if the kernel throws or reports failure. */
function attempt<T>(call: BuiltinCall, error: string, run: () => T): T {
  try {
    return run();
  } catch {
    return regenError(call, error);
  }
}

/** Distinct bodies of the resolved entities, keeping the entities grouped by body. */
function byBody(model: ModelContext, entities: readonly Entity[]): Map<Entity, Entity[]> {
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
    const solids = faces.map((face) => {
      const start = new oc.gp_Trsf();
      start.SetRotation(ax1, -back);
      const base = back
        ? new oc.BRepBuilderAPI_Transform(face.shape, start, true, false).Shape()
        : face.shape;
      const revol = attempt(
        call,
        "REVOLVE_FAILED",
        () => new oc.BRepPrimAPI_MakeRevol(base, ax1, total, true),
      );
      if (!full) {
        for (const cap of subShapes(oc, revol.FirstShape(), "FACE")) caps.set(cap, "START");
        for (const cap of subShapes(oc, revol.LastShape(), "FACE")) caps.set(cap, "END");
      }
      return revol.Shape();
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
    if (
      untag(definition.getField("isVariable")) === true ||
      definition.getField("partialFilletBounds") !== undefined
    )
      return call.unsupported("Variable and partial fillets are not supported locally yet.");
    const radius = magnitude(call, definition.getField("radius"), "radius");
    const edges = edgesOf(oc, model, resolve(call, model, oc, definition.getField("entities")));
    if (edges.length === 0) return call.fail("Nothing to fillet.");
    for (const [body, bodyEdges] of byBody(model, edges)) {
      const fillet = new oc.BRepFilletAPI_MakeFillet(body.shape);
      for (const edge of bodyEdges) fillet.Add(radius, oc.TopoDS.Edge(edge.shape));
      const result = attempt(call, "FILLET_FAILED", () => fillet.Shape());
      modifyBody(oc, model, body, result, historyOf(oc, fillet), id);
    }
    return undefined;
  },

  opChamfer: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const type = String(untag(definition.getField("chamferType")) ?? "EQUAL_OFFSETS");
    if (type !== "EQUAL_OFFSETS")
      return call.unsupported(`Chamfer type ${type} is not supported locally yet.`);
    const width = magnitude(call, definition.getField("width"), "width");
    const edges = edgesOf(oc, model, resolve(call, model, oc, definition.getField("entities")));
    if (edges.length === 0) return call.fail("Nothing to chamfer.");
    for (const [body, bodyEdges] of byBody(model, edges)) {
      const chamfer = new oc.BRepFilletAPI_MakeChamfer(body.shape);
      for (const edge of bodyEdges) chamfer.Add(width, oc.TopoDS.Edge(edge.shape));
      const result = attempt(call, "CHAMFER_FAILED", () => chamfer.Shape());
      modifyBody(oc, model, body, result, historyOf(oc, chamfer), id);
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
      const shell = new oc.BRepOffsetAPI_MakeThickSolid();
      const result = attempt(call, "SHELL_FAILED", () => {
        if (faces.length)
          shell.MakeThickSolidByJoin(body.shape, toList(oc, faces), thickness, 1e-6);
        else shell.MakeThickSolidBySimple(body.shape, thickness);
        return shell.Shape();
      });
      modifyBody(oc, model, body, result, historyOf(oc, shell), id);
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
    const entities = resolve(call, model, oc, definition.getField("entities"));
    if (entities.some((entity) => entity.type !== "BODY"))
      return call.unsupported("Face patterns are not supported locally yet; pattern bodies.");
    const copies = transforms.flatMap((transform, i) => {
      const trsf = toTrsf(call, oc, transform);
      return entities.map((body) => ({
        shape: new oc.BRepBuilderAPI_Transform(body.shape, trsf, true, false).Shape(),
        bodyType: body.bodyType,
        createdBy: [...idOf(id), names[i]!],
        ...(body.frame ? { frame: movedFrame(oc, trsf, body.frame) } : {}),
        annotate: (_: Shape, type: string) =>
          type === "BODY" && untag(definition.getField("copyPropertiesAndAttributes")) !== false
            ? { attributes: body.attributes, properties: body.properties }
            : {},
      }));
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
    const solids = faces.map((face) => {
      const normal = planarNormal(oc, face.shape);
      if (normal) {
        // A planar face sweeps straight along its normal, from -back to +front.
        const start = translated(oc, face.shape, [
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
      if (front !== 0 && back !== 0)
        return call.unsupported("Thickening a curved face both ways is not supported locally yet.");
      const thick = new oc.BRepOffsetAPI_MakeThickSolid();
      return attempt(call, "THICKEN_FAILED", () => {
        thick.MakeThickSolidBySimple(face.shape, front !== 0 ? front : -back);
        return thick.Shape();
      });
    });
    let state = addBodies(
      oc,
      model.geometry,
      solids.map((shape) => ({ shape, bodyType: "SOLID" as const, createdBy: idOf(id) })),
    ).state;
    // keepTools false deletes sheet bodies selected whole; sketches and solids always stay.
    if (untag(definition.getField("keepTools")) === false)
      state = removeBodies(
        state,
        selected
          .filter(
            (entity) =>
              entity.type === "BODY" &&
              entity.bodyType === "SHEET" &&
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
    // Planes and planar faces cut as unbounded planes: a face this large crosses every target.
    const box = new oc.Bnd_Box();
    for (const target of targets) oc.BRepBndLib.Add(target.shape, box, false);
    const reach = 10 * Math.sqrt(box.SquareExtent()) + 1;
    const toolValue = definition.getField("tool");
    const toolMap = untag(toolValue);
    let tool: Shape;
    let side: { origin: Vec3; normal: Vec3 } | null = null;
    let toolBodies: Entity[] = [];
    if (toolMap instanceof FsMap && toolMap.getField("queryType") === undefined) {
      const plane = planeOf(call, toolValue, "tool");
      tool = planeFace(oc, plane, reach, reach);
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
        const x = xyz(surface.Plane().XAxis().Direction());
        tool = planeFace(oc, { origin, normal, x }, reach, reach);
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
    // Sheet bodies used as tools are deleted unless keepTools is true.
    if (untag(definition.getField("keepTools")) !== true)
      model.geometry = removeBodies(
        model.geometry,
        toolBodies.filter((body) => body.bodyType === "SHEET").map((body) => body.id),
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
