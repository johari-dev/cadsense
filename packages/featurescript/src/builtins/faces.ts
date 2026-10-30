import {
  addBodies,
  chainHistory,
  historyOf,
  imagesOf,
  ordered,
  removeBodies,
  replaceBodies,
  updateEntities,
  type Entity,
} from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import {
  fromList,
  ShapeSet,
  subShapes,
  toList,
  xyz,
  type Oc,
  type Shape,
} from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import {
  adjacentFillets,
  capSolid,
  compoundOf,
  connectedGroups,
  copyShape,
  edgePoints,
  mergedPlanarFaces,
  normalNear,
  offsetFace,
  rebuildSolid,
  planeAround,
  removalHistory,
  sameSurface,
  seatSeams,
  springFaces,
  sweptRegions,
  fillAndCut,
  shellOf,
  surfaceType,
  tangentChain,
  type FaceChange,
} from "./faceEdit.ts";
import { planeOf } from "./construction.ts";
import { idOf, kernel, magnitude, normalized, resolve, transient, vector } from "./geometryArgs.ts";
import { attempt, byBody, toTrsf } from "./operations.ts";
import { regenError } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Direct editing builtins: delete, offset and extract faces, and project outlines. The shape work
 * is in `faceEdit.ts`; these read definitions, pick bodies, and carry ids through `replaceBodies`.
 */

const flag = (definition: FsMap, field: string) => untag(definition.getField(field)) === true;

/** The faces a query selects. */
const facesIn = (call: BuiltinCall, model: ModelContext, oc: Oc, query: FsValue) =>
  resolve(call, model, oc, query).filter((entity) => entity.type === "FACE");

/**
 * Replaces `body` by the solids of a rebuilt shape. A failed rebuild raises `error`, unless a
 * neighbor that OpenCascade can't extend may be why, which stops the run as unsupported.
 */
function applyRebuild(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  body: Entity,
  changes: readonly FaceChange[],
  id: FsValue,
  error: string,
  options: { readonly mergeFaces?: boolean } = {},
): void {
  const rebuilt = rebuildSolid(oc, body.shape, changes, options);
  if (
    rebuilt.ok &&
    subShapes(oc, rebuilt.shape, "SOLID").length > subShapes(oc, body.shape, "SOLID").length
  )
    return call.unsupported(
      "This face edit leaves the body in touching pieces (an offset sphere comes back as the ball and a shell around it); it is not supported locally yet.",
    );
  if (!rebuilt.ok) {
    if (rebuilt.unsupported) return call.unsupported(rebuilt.unsupported);
    if (rebuilt.unextended.length)
      return call.unsupported(
        `Extending ${[...new Set(rebuilt.unextended)].join(", ")} faces to heal around a changed face is not supported locally yet.`,
      );
    return regenError(call, error);
  }
  model.geometry = replaceBodies(oc, model.geometry, {
    consumed: [body.id],
    keepIds: [body.id],
    results: subShapes(oc, rebuilt.shape, "SOLID").map((shape) => ({
      shape,
      bodyType: "SOLID" as const,
    })),
    history: rebuilt.history,
    createdBy: idOf(id),
  }).state;
}

/** Fillets next to the selection stop the run when `reFillet` asks to rebuild them. */
function rejectReFillet(
  call: BuiltinCall,
  oc: Oc,
  definition: FsMap,
  body: Entity,
  faces: Shape[],
) {
  if (flag(definition, "reFillet") && adjacentFillets(oc, body.shape, faces).length)
    return call.unsupported("Reapplying fillets around moved faces is not supported locally yet.");
}

/** A planar face's plane: origin, unit normal and x direction. */
function planeOfFace(oc: Oc, face: Shape): { origin: Vec3; normal: Vec3; x: Vec3 } | null {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  if (String(surface.GetType()) !== "GeomAbs_Plane") return null;
  const plane = surface.Plane();
  return {
    origin: xyz(plane.Location()),
    normal: xyz(plane.Axis().Direction()),
    x: xyz(plane.XAxis().Direction()),
  };
}

/**
 * Where `face` lands projected along `plane`'s normal onto the plane, as planar faces. Faces seen
 * edge-on (all their normals perpendicular to the plane's) project to nothing.
 */
function projectOntoPlane(
  oc: Oc,
  face: Shape,
  plane: { origin: Vec3; normal: Vec3; x: Vec3 },
  reach: number,
): Shape[] {
  const n = plane.normal;
  const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const edgeOn = [0.1, 0.5, 0.9].every((s) =>
    [0.1, 0.5, 0.9].every((t) => {
      const point = xyz(surface.Value(UMin + s * (UMax - UMin), VMin + t * (VMax - VMin)));
      const normal = normalNear(oc, face, point).normal;
      return Math.abs(normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2]) < 1e-9;
    }),
  );
  if (edgeOn) return [];
  const start = new oc.gp_Trsf();
  start.SetTranslation(new oc.gp_Vec(-n[0] * reach, -n[1] * reach, -n[2] * reach));
  const base = new oc.BRepBuilderAPI_Transform(face, start, true, false).Shape();
  const prism = new oc.BRepPrimAPI_MakePrism(
    base,
    new oc.gp_Vec(2 * reach * n[0], 2 * reach * n[1], 2 * reach * n[2]),
    false,
    true,
  ).Shape();
  const sheet = planeAround(oc, plane, [face]);
  const common = new oc.BRepAlgoAPI_Common();
  common.SetNonDestructive(true);
  common.SetArguments(toList(oc, [sheet]));
  common.SetTools(toList(oc, [prism]));
  common.Build(new oc.Message_ProgressRange());
  return common.HasErrors() ? [] : subShapes(oc, common.Shape(), "FACE");
}

export const FACE_BUILTINS = {
  opDeleteFace: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = facesIn(call, model, oc, definition.getField("deleteFaces"));
    if (selected.length === 0) return regenError(call, "DIRECT_EDIT_DELETE_SELECT_FACES");
    for (const [body, entities] of byBody(model, selected)) {
      let faces = entities.map((face) => face.shape);
      if (flag(definition, "includeFillet"))
        faces = [...faces, ...adjacentFillets(oc, body.shape, faces)];
      const all = subShapes(oc, body.shape, "FACE");
      if (all.length <= faces.length) return regenError(call, "DIRECT_EDIT_DELETE_FACE_ALL_FACES");

      if (flag(definition, "leaveOpen")) {
        // The rest of the body, as it was, in one sheet per connected piece.
        const gone = removalHistory(oc, faces);
        const kept = all.filter((face) => !gone.deleted(face));
        model.geometry = replaceBodies(oc, model.geometry, {
          consumed: [body.id],
          keepIds: [body.id],
          results: connectedGroups(oc, kept).map((group) => ({
            shape: shellOf(oc, group),
            bodyType: "SHEET" as const,
          })),
          history: gone,
          createdBy: idOf(id),
        }).state;
        continue;
      }
      if (body.bodyType !== "SOLID")
        return call.unsupported(
          "Healing after deleting faces of a surface is not supported locally yet; leave the void open.",
        );
      const healed = rebuildSolid(
        oc,
        body.shape,
        faces.map((face) => ({ face, moved: null })),
      );
      if (healed.ok) {
        model.geometry = replaceBodies(oc, model.geometry, {
          consumed: [body.id],
          keepIds: [body.id],
          results: subShapes(oc, healed.shape, "SOLID").map((shape) => ({
            shape,
            bodyType: "SOLID" as const,
          })),
          history: healed.history,
          createdBy: idOf(id),
        }).state;
        continue;
      }
      // Healing may have needed a surface we can't extend; capping instead would hide that.
      if (healed.unextended.length)
        return call.unsupported(
          `Extending ${[...new Set(healed.unextended)].join(", ")} faces to heal a deleted face is not supported locally yet.`,
        );
      const capped = flag(definition, "capVoid") ? capSolid(oc, body.shape, faces) : null;
      if (!capped) return regenError(call, "DIRECT_EDIT_DELETE_FACE_FAILED");
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: [{ shape: capped, bodyType: "SOLID" }],
        history: removalHistory(oc, faces),
        createdBy: idOf(id),
      }).state;
    }
    return undefined;
  },

  opOffsetFace: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = facesIn(call, model, oc, definition.getField("moveFaces"));
    if (selected.length === 0) return regenError(call, "DIRECT_EDIT_OFFSET_FACE_SELECT");
    const distance = magnitude(call, definition.getField("offsetDistance"), "offsetDistance");
    for (const [body, entities] of byBody(model, selected)) {
      const faces = entities.map((face) => face.shape);
      rejectReFillet(call, oc, definition, body, faces);
      if (body.bodyType !== "SOLID")
        return call.unsupported("Offsetting faces of a surface is not supported locally yet.");
      const changes = faces.map((face) => ({
        face,
        moved: offsetFace(oc, face, distance),
        // A flat face's edges move straight along its normal; others' paths aren't known here.
        carry: (edge: Shape) => {
          const plane = planeOfFace(oc, face);
          if (!plane) return null;
          const n = normalNear(oc, face, plane.origin).normal;
          const shift = new oc.gp_Trsf();
          shift.SetTranslation(new oc.gp_Vec(n[0] * distance, n[1] * distance, n[2] * distance));
          return new oc.BRepBuilderAPI_Transform(edge, shift, true, false).Shape();
        },
      }));
      if (changes.some((change) => change.moved === null))
        return regenError(call, "DIRECT_EDIT_OFFSET_FACE_FAILED");
      applyRebuild(call, oc, model, body, changes, id, "DIRECT_EDIT_OFFSET_FACE_FAILED", {
        mergeFaces: untag(definition.getField("mergeFaces")) !== false,
      });
    }
    return undefined;
  },

  opMoveFace: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = facesIn(call, model, oc, definition.getField("moveFaces"));
    if (selected.length === 0) return regenError(call, "DIRECT_EDIT_MOVE_FACE_SELECT");
    // Old versions pass a list of transforms (a turn of 180 degrees or more in two halves).
    const steps =
      definition.getField("transform") === undefined
        ? array(call, definition.getField("transformList"), "transformList")
        : [definition.getField("transform")];
    if (steps.length !== 1)
      return call.unsupported(
        "Moving faces through a list of transforms is not supported locally yet.",
      );
    const trsf = toTrsf(call, oc, steps[0]);
    for (const [body, entities] of byBody(model, selected)) {
      const faces = entities.map((face) => face.shape);
      rejectReFillet(call, oc, definition, body, faces);
      if (body.bodyType !== "SOLID")
        return call.unsupported("Moving faces of a surface is not supported locally yet.");
      const changes = faces
        .map((face) => ({
          face,
          moved: new oc.BRepBuilderAPI_Transform(face, trsf, true, false).Shape(),
          carry: (edge: Shape) => new oc.BRepBuilderAPI_Transform(edge, trsf, true, false).Shape(),
        }))
        .filter((change) => !sameSurface(oc, change.face, change.moved));
      if (changes.length)
        applyRebuild(call, oc, model, body, changes, id, "DIRECT_EDIT_MOVE_FACE_FAILED", {
          mergeFaces: untag(definition.getField("mergeFaces")) !== false,
        });
    }
    return undefined;
  },

  opReplaceFace: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = facesIn(call, model, oc, definition.getField("replaceFaces"));
    const templates = facesIn(call, model, oc, definition.getField("templateFace"));
    if (selected.length === 0 || templates.length === 0)
      return regenError(call, "DIRECT_EDIT_REPLACE_FACE_SELECT");
    if (templates.length > 1)
      return call.unsupported(
        "Replacing faces with several template faces is not supported locally yet.",
      );
    // The offset follows the template's own normal. The new face points the template's way, or
    // the other way with oppositeSense; a sense that would point into the body can't heal.
    const offset =
      definition.getField("offset") === undefined
        ? 0
        : magnitude(call, definition.getField("offset"), "offset");
    const surface =
      offset === 0
        ? copyShape(oc, templates[0]!.shape)
        : offsetFace(oc, templates[0]!.shape, offset);
    if (!surface) return regenError(call, "DIRECT_EDIT_REPLACE_FACE_FAILED");
    const target = flag(definition, "oppositeSense") ? surface.Reversed() : surface;
    for (const [body, entities] of byBody(model, selected)) {
      if (body.bodyType !== "SOLID")
        return call.unsupported("Replacing faces of a surface is not supported locally yet.");
      const changes = entities
        .map((face) => ({ face: face.shape, moved: target }))
        .filter((change) => !sameSurface(oc, change.face, target));
      if (changes.length)
        applyRebuild(call, oc, model, body, changes, id, "DIRECT_EDIT_REPLACE_FACE_FAILED");
    }
    return undefined;
  },

  opFlipOrientation: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const bodies = [
      ...byBody(model, resolve(call, model, oc, definition.getField("bodies"))).keys(),
    ];
    if (bodies.some((body) => body.bodyType !== "SHEET"))
      return call.fail("opFlipOrientation flips sheet bodies only.");
    // The reversed body holds the same faces turned over, so every id carries across as is.
    for (const body of bodies)
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: [{ shape: body.shape.Reversed(), bodyType: "SHEET" }],
        history: removalHistory(oc, []),
        createdBy: idOf(id),
      }).state;
    return undefined;
  },

  opExtractWires: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = resolve(call, model, oc, definition.getField("edges"));
    const wireBodies = new Set(
      selected
        .filter((entity) => entity.type === "BODY" && entity.bodyType === "WIRE")
        .map((body) => body.id),
    );
    const edges = [...model.geometry.entities.values()].filter(
      (entity) =>
        entity.type === "EDGE" && (selected.includes(entity) || wireBodies.has(entity.body)),
    );
    if (edges.length === 0) return regenError(call, "EXTRACT_WIRES_NEEDS_EDGES");
    const copies = subShapes(
      oc,
      copyShape(
        oc,
        compoundOf(
          oc,
          edges.map((edge) => edge.shape),
        ),
      ),
      "EDGE",
    );
    const chains = edgeChains(oc, copies);
    if (chains === "NON_MANIFOLD") return regenError(call, "EXTRACT_WIRES_NON_MANIFOLD");
    if (chains === "OVERLAPPING") return regenError(call, "EXTRACT_WIRES_OVERLAPPING_EDGES");
    const wires = chains.map((chain) => {
      const wire = new oc.BRepBuilderAPI_MakeWire();
      for (const edge of chain) wire.Add(oc.TopoDS.Edge(edge));
      return wire.IsDone() ? wire.Wire() : regenError(call, "EXTRACT_WIRES_NON_MANIFOLD");
    });
    model.geometry = addBodies(
      oc,
      model.geometry,
      wires.map((shape) => ({ shape, bodyType: "WIRE" as const, createdBy: idOf(id) })),
    ).state;
    return undefined;
  },

  opSplitEdges: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const edges = resolve(call, model, oc, definition.getField("edges")).filter(
      (entity) => entity.type === "EDGE",
    );
    if (edges.length === 0) return regenError(call, "SPLIT_EDGE_SELECT_EDGES");
    const surface = definition.getField("splittingSurface");
    const parameters = definition.getField("parameters");
    // Split points become vertices the splitter imprints on their edges.
    const points = new Map<Entity, Shape[]>();
    if (surface !== undefined) {
      const surfaceMap = untag(surface);
      const tools =
        surfaceMap instanceof FsMap && surfaceMap.getField("queryType") === undefined
          ? [
              planeAround(
                oc,
                planeOf(call, surface, "splittingSurface"),
                edges.map((edge) => edge.shape),
              ),
            ]
          : sheetFaces(model, resolve(call, model, oc, surface)).map((face) => face.shape);
      if (tools.length === 0) return regenError(call, "SPLIT_EDGE_FAILED");
      for (const edge of edges)
        points.set(
          edge,
          tools.flatMap((tool) =>
            subShapes(oc, new oc.BRepAlgoAPI_Section(edge.shape, tool, true).Shape(), "VERTEX"),
          ),
        );
    } else {
      if (parameters === undefined) return regenError(call, "SPLIT_EDGE_PROVIDE_PARAMETERS");
      const lists = array(call, parameters, "parameters");
      if (lists.length !== edges.length) return regenError(call, "SPLIT_EDGE_SIZES_MISMATCH");
      const byLength = untag(definition.getField("arcLengthParameterization")) !== false;
      edges.forEach((edge, i) => {
        const at = array(call, lists[i], "parameters").map((t) => magnitude(call, t, "parameter"));
        if (at.some((t) => t < 0 || t > 1)) return regenError(call, "SPLIT_EDGE_PARAMETER_BOUND");
        const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge.shape));
        points.set(
          edge,
          at.map((t) =>
            new oc.BRepBuilderAPI_MakeVertex(
              curve.Value(curveParameter(oc, edge.shape, t, byLength)),
            ).Vertex(),
          ),
        );
      });
    }
    for (const [body, bodyEdges] of byBody(model, edges)) {
      const vertices = bodyEdges.flatMap((edge) => points.get(edge) ?? []);
      if (vertices.length === 0) continue;
      const splitter = new oc.BRepAlgoAPI_Splitter();
      splitter.SetNonDestructive(true);
      splitter.SetArguments(toList(oc, [body.shape]));
      splitter.SetTools(toList(oc, vertices));
      splitter.Build(new oc.Message_ProgressRange());
      if (splitter.HasErrors()) return regenError(call, "SPLIT_EDGE_FAILED");
      replaceSplit(oc, model, body, splitter, id);
    }
    return undefined;
  },

  opSplitFace: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const targets = facesIn(call, model, oc, definition.getField("faceTargets"));
    if (targets.length === 0) return regenError(call, "SPLIT_SELECT_FACE_TARGETS");
    const query = (field: string) =>
      definition.getField(field) === undefined
        ? []
        : resolve(call, model, oc, definition.getField(field));
    const bodyTools = query("bodyTools").filter((entity) => entity.type === "BODY");
    const wireEdges = [...model.geometry.entities.values()].filter(
      (entity) =>
        entity.type === "EDGE" &&
        bodyTools.some((body) => body.id === entity.body && body.bodyType === "WIRE"),
    );
    const edgeTools = [
      ...query("edgeTools").filter((entity) => entity.type === "EDGE"),
      ...wireEdges,
    ];
    // std sets a direction only when there are edges to project along it.
    const direction =
      edgeTools.length && untag(definition.getField("projectionType")) === "DIRECTION"
        ? normalized(vector(call, definition.getField("direction"), 3, "direction"))
        : null;
    const faces = (field: string) =>
      query(field).filter((entity): entity is Entity => entity.type === "FACE");
    const surfaceTools = [
      ...faces("faceTools").map((face) => face.shape),
      ...sheetFaces(
        model,
        bodyTools.filter((body) => body.bodyType === "SHEET"),
      ).map((face) => face.shape),
    ];
    const planes = faces("planeTools").map((face) => planeOfFace(oc, face.shape) ?? face.shape);
    if (flag(definition, "extendToCompletion") || flag(definition, "mutualImprint"))
      return call.unsupported(
        "extendToCompletion and mutualImprint are not supported locally yet.",
      );

    const splittingTools: Shape[] = [];
    const owned: string[] = [];
    for (const [body, bodyTargets] of byBody(model, targets)) {
      // Planes cut as unbounded planes: a patch on each covering the whole part.
      const planeTools = planes.map((plane) =>
        "normal" in plane ? planeAround(oc, plane, [body.shape]) : plane,
      );
      const cuts = bodyTargets.flatMap((face) => [
        ...edgeTools.map((edge) => {
          const projected = projectEdge(oc, edge.shape, face.shape, direction);
          return projected === "UNSUPPORTED"
            ? call.unsupported(
                `Projecting a ${surfaceType(oc, face.shape) === "Plane" ? "curve that isn't parallel to the face" : "curve onto a curved face"} to split it is not supported locally yet.`,
              )
            : projected;
        }),
        ...[...surfaceTools, ...planeTools].flatMap((tool) =>
          subShapes(oc, new oc.BRepAlgoAPI_Section(face.shape, tool, true).Shape(), "EDGE"),
        ),
      ]);
      if (cuts.length === 0) continue;
      const splitter = new oc.BRepAlgoAPI_Splitter();
      splitter.SetNonDestructive(true);
      splitter.SetArguments(toList(oc, [body.shape]));
      splitter.SetTools(toList(oc, cuts));
      splitter.Build(new oc.Message_ProgressRange());
      if (splitter.HasErrors()) return regenError(call, "CANNOT_SPLIT_FACE");
      const before = model.geometry;
      const ids = replaceSplit(oc, model, body, splitter, id);
      const made = new ShapeSet<true>(oc);
      for (const cut of cuts)
        for (const image of imagesOf(historyOf(oc, splitter), cut)) made.set(image, true);
      const splittingEdges = [...model.geometry.entities.values()].filter(
        (entity) => entity.type === "EDGE" && ids.includes(entity.body) && made.has(entity.shape),
      );
      splittingTools.push(...splittingEdges.map((edge) => edge.shape));
      // Edges that already ran where the faces split, which ownExistingImprints claims.
      owned.push(
        ...splittingEdges.filter((edge) => before.entities.has(edge.id)).map((edge) => edge.id),
      );
    }
    if (flag(definition, "ownExistingImprints"))
      model.geometry = updateEntities(model.geometry, owned, (edge) => ({
        ...edge,
        createdBy: idOf(id),
      }));
    if (untag(definition.getField("keepToolSurfaces")) === false)
      model.geometry = removeBodies(
        model.geometry,
        bodyTools.map((body) => body.id),
      );
    const splitting = new ShapeSet<true>(oc);
    for (const shape of splittingTools) splitting.set(shape, true);
    return FsMap.fromEntries([
      [
        "splittingEdges",
        ordered(
          model.geometry,
          (entity) => entity.type === "EDGE" && splitting.has(entity.shape),
        ).map((edge) => transient(call, edge)),
      ],
    ]);
  },

  opExtendSheetBody: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    if (String(untag(definition.getField("endCondition"))) === "EXTEND_TO_TARGET")
      return call.unsupported("Extending a surface up to a target is not supported locally yet.");
    const selected = resolve(call, model, oc, definition.getField("entities"));
    const sheets = new Set(
      selected
        .filter((entity) => entity.type === "BODY" && entity.bodyType === "SHEET")
        .map((body) => body.id),
    );
    let edges = [...model.geometry.entities.values()].filter(
      (entity) =>
        entity.type === "EDGE" &&
        entity.bodyType === "SHEET" &&
        (selected.includes(entity) || sheets.has(entity.body)),
    );
    if (edges.length === 0) return regenError(call, "EXTEND_SHEET_BODY_NO_BODY");
    if (untag(definition.getField("tangentPropagation")) !== false)
      edges = tangentEdges(oc, model, edges);
    const distance = magnitude(call, definition.getField("extendDistance"), "extendDistance");
    for (const [body, bodyEdges] of byBody(model, edges))
      moveSheetEdges(
        call,
        oc,
        model,
        body,
        bodyEdges.map((edge) => ({ edge, distance })),
        id,
        "EXTEND_FAILED",
      );
    return undefined;
  },

  opEdgeChange: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const options = array(call, definition.getField("edgeChangeOptions"), "edgeChangeOptions").map(
      (option) => map(call, option, "edgeChangeOptions"),
    );
    // Edges grouped by body: each body's edges move together in one rebuild.
    const moves = new Map<string, { body: Entity; edges: { edge: Entity; distance: number }[] }>();
    for (const option of options) {
      if (
        option.getField("transformList") !== undefined ||
        option.getField("replaceFace") !== undefined
      )
        return call.unsupported(
          "Edge changes by transform or to a replacement face are not supported locally yet.",
        );
      if (option.getField("offset") === undefined) continue;
      const distance = magnitude(call, option.getField("offset"), "offset");
      for (const edge of resolve(call, model, oc, option.getField("edge")).filter(
        (e) => e.type === "EDGE",
      )) {
        const body = model.geometry.entities.get(edge.body)!;
        if (body.bodyType !== "SHEET")
          return call.unsupported("Changing edges of a solid is not supported locally yet.");
        const move = moves.get(body.id) ?? { body, edges: [] };
        move.edges.push({ edge, distance });
        moves.set(body.id, move);
      }
    }
    for (const { body, edges } of moves.values())
      moveSheetEdges(call, oc, model, body, edges, id, "EDGE_CHANGE_FAILED");
    return undefined;
  },

  opDraft: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const pull = normalized(vector(call, definition.getField("pullVec"), 3, "pullVec"));
    const angle = magnitude(call, definition.getField("angle"), "angle");
    // Each face pivots about where it meets its neutral plane: a face, or a plane through its
    // reference edge square to the pull.
    const drafts: { face: Entity; angle: number; plane: { origin: Vec3; normal: Vec3 } }[] = [];
    if (String(untag(definition.getField("draftType"))) === "REFERENCE_ENTITY") {
      if (flag(definition, "inferReferences"))
        return call.unsupported(
          "Parting line drafts whose faces Onshape infers from the parting edges are not supported locally yet.",
        );
      if (flag(definition, "referenceEntityPropagation"))
        return call.unsupported("referenceEntityPropagation is not supported locally yet.");
      const options = array(
        call,
        definition.getField("referenceEntityDraftOptions"),
        "referenceEntityDraftOptions",
      ).map((option) => map(call, option, "referenceEntityDraftOptions"));
      for (const option of options) {
        const face = facesIn(call, model, oc, option.getField("face"))[0];
        const references = resolve(call, model, oc, option.getField("references")).filter(
          (entity) => entity.type === "EDGE",
        );
        if (!face || references.length === 0) return regenError(call, "DRAFT_SELECT_PARTING_EDGES");
        // The face pivots about its own edges; a reference elsewhere can't hold it.
        const own = subShapes(oc, face.shape, "EDGE");
        if (references.some((edge) => !own.some((candidate) => candidate.IsSame(edge.shape))))
          return regenError(call, "DRAFT_SELECT_PARTING_EDGES");
        // The references must lie in one plane square to the pull for a single pivot plane.
        const points = references.flatMap((edge) => edgePoints(oc, edge.shape, 5));
        const height = (p: Vec3) => p[0] * pull[0] + p[1] * pull[1] + p[2] * pull[2];
        if (points.some((p) => Math.abs(height(p) - height(points[0]!)) > 1e-7))
          return call.unsupported(
            "Drafting about reference edges that aren't square to the pull direction is not supported locally yet.",
          );
        drafts.push({
          face,
          angle:
            option.getField("angle") === undefined
              ? angle
              : magnitude(call, option.getField("angle"), "angle"),
          plane: { origin: points[0]!, normal: pull },
        });
      }
    } else {
      let faces = facesIn(call, model, oc, definition.getField("draftFaces"));
      if (faces.length === 0) return regenError(call, "DRAFT_SELECT_FACES");
      if (flag(definition, "tangentPropagation"))
        faces = [...byBody(model, faces)].flatMap(([body, entities]) => {
          const chain = new ShapeSet<true>(oc);
          for (const face of tangentChain(
            oc,
            body.shape,
            entities.map((entity) => entity.shape),
          ))
            chain.set(face, true);
          return [...model.geometry.entities.values()].filter(
            (entity) =>
              entity.type === "FACE" && entity.body === body.id && chain.has(entity.shape),
          );
        });
      // Old versions name the neutral surface referenceFace or referencePlane.
      const reference =
        definition.getField("referenceSurface") ??
        definition.getField("referenceFace") ??
        definition.getField("referencePlane");
      if (reference === undefined) return regenError(call, "DRAFT_SELECT_NEUTRAL");
      const referenceMap = untag(reference);
      let plane: { origin: Vec3; normal: Vec3 } | null;
      if (referenceMap instanceof FsMap && referenceMap.getField("queryType") === undefined)
        plane = planeOf(call, reference, "referenceSurface");
      else {
        const face = facesIn(call, model, oc, reference)[0];
        if (!face) return regenError(call, "DRAFT_SELECT_NEUTRAL");
        plane = planeOfFace(oc, face.shape);
        if (!plane)
          return call.unsupported(
            `Drafting about a ${surfaceType(oc, face.shape).toUpperCase()} neutral surface is not supported locally yet; only planes.`,
          );
      }
      for (const face of faces) drafts.push({ face, angle, plane });
    }
    for (const [body, entities] of byBody(
      model,
      drafts.map((draft) => draft.face),
    )) {
      rejectReFillet(
        call,
        oc,
        definition,
        body,
        entities.map((face) => face.shape),
      );
      if (body.bodyType !== "SOLID")
        return call.unsupported("Drafting faces of a surface is not supported locally yet.");
      // OpenCascade removes material on Direction's side of the neutral plane for a positive
      // angle, as Onshape does on the pull side.
      const draft = new oc.BRepOffsetAPI_DraftAngle(body.shape);
      for (const { face, angle: faceAngle, plane } of drafts.filter((d) =>
        entities.includes(d.face),
      )) {
        draft.Add(
          oc.TopoDS.Face(face.shape),
          new oc.gp_Dir(...pull),
          faceAngle,
          new oc.gp_Pln(new oc.gp_Pnt(...plane.origin), new oc.gp_Dir(...plane.normal)),
          true,
        );
        if (!draft.AddDone()) return regenError(call, "DRAFT_FAILED");
      }
      const result = attempt(call, "DRAFT_FAILED", () => {
        draft.Build(new oc.Message_ProgressRange());
        return draft.Shape();
      });
      if (!draft.IsDone() || !new oc.BRepCheck_Analyzer(result, true, false).IsValid())
        return regenError(call, "DRAFT_FAILED");
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: subShapes(oc, result, "SOLID").map((shape) => ({
          shape,
          bodyType: "SOLID" as const,
        })),
        // A shape modification maps every sub-shape one to one.
        history: {
          deleted: () => false,
          modified: (shape) => {
            const image = draft.ModifiedShape(shape);
            return image.IsNull() || image.IsSame(shape) ? [] : [image];
          },
          generated: () => [],
        },
        createdBy: idOf(id),
      }).state;
    }
    return undefined;
  },

  opModifyFillet: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = facesIn(call, model, oc, definition.getField("faces"));
    if (selected.length === 0) return regenError(call, "DIRECT_EDIT_MODIFY_FILLET_SELECT");
    const remove = String(untag(definition.getField("modifyFilletType"))) === "REMOVE_FILLET";
    for (const [body, entities] of byBody(model, selected)) {
      const faces = entities.map((face) => face.shape);
      if (body.bodyType !== "SOLID")
        return call.unsupported("Modifying fillets of a surface is not supported locally yet.");
      const deletions = faces.map((face) => ({ face, moved: null }));
      if (remove) {
        applyRebuild(call, oc, model, body, deletions, id, "DIRECT_EDIT_MODIFY_FILLET_FAILED");
        continue;
      }
      rejectReFillet(call, oc, definition, body, faces);
      const radius = magnitude(call, definition.getField("radius"), "radius");
      // Remove the fillets, then fillet again where their two tangent neighbors meet.
      const springs = faces.map((face) => springFaces(oc, body.shape, face));
      if (springs.some((pair) => pair.length !== 2))
        return regenError(call, "DIRECT_EDIT_MODIFY_FILLET_FAILED");
      const healed = rebuildSolid(oc, body.shape, deletions);
      if (!healed.ok) return regenError(call, "DIRECT_EDIT_MODIFY_FILLET_FAILED");
      const sharp = springs.map(([a, b]) => {
        const edgesOf = (face: Shape) =>
          imagesOf(healed.history, face).flatMap((image) => subShapes(oc, image, "EDGE"));
        const other = edgesOf(b!);
        return edgesOf(a!).filter((edge) => other.some((candidate) => candidate.IsSame(edge)));
      });
      if (sharp.some((edges) => edges.length === 0))
        return regenError(call, "DIRECT_EDIT_MODIFY_FILLET_FAILED");
      const fillet = new oc.BRepFilletAPI_MakeFillet(healed.shape);
      for (const edge of sharp.flat()) fillet.Add(radius, oc.TopoDS.Edge(edge));
      const result = attempt(call, "DIRECT_EDIT_MODIFY_FILLET_FAILED", () => fillet.Shape());
      const history = chainHistory(healed.history, historyOf(oc, fillet));
      // Each fillet continues as the new fillet on its restored edge.
      const refilleted = new ShapeSet<Shape[]>(oc);
      faces.forEach((face, i) =>
        refilleted.set(
          face,
          sharp[i]!.flatMap((edge) => fromList(oc, fillet.Generated(edge))),
        ),
      );
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: subShapes(oc, result, "SOLID").map((shape) => ({
          shape,
          bodyType: "SOLID" as const,
        })),
        history: {
          deleted: (shape) => !refilleted.has(shape) && history.deleted(shape),
          modified: (shape) => refilleted.get(shape) ?? history.modified(shape),
          generated: (shape) => history.generated(shape),
        },
        createdBy: idOf(id),
      }).state;
    }
    return undefined;
  },

  opFullRoundFillet: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const side1 = facesIn(call, model, oc, definition.getField("side1Face"))[0];
    const side2 = facesIn(call, model, oc, definition.getField("side2Face"))[0];
    const centers = facesIn(call, model, oc, definition.getField("centerFaces"));
    if (!side1 || !side2 || centers.length === 0)
      return regenError(call, "FULL_ROUND_SELECT_FACES");
    const center = centers[0]!;
    const body = model.geometry.entities.get(center.body)!;
    if (side1.body !== body.id || side2.body !== body.id)
      return regenError(call, "FULL_ROUND_COMMON_BODY");
    // Only the constant-radius case: one flat center face spanning the gap between two parallel
    // planes square to it, rounded by a half cylinder of half the gap, tangent to all three.
    const outward = (face: Entity) => {
      const plane = planeOfFace(oc, face.shape);
      if (!plane) return null;
      const n = normalNear(oc, face.shape, plane.origin).normal;
      return { origin: plane.origin, normal: n };
    };
    const [a, b, top] = [outward(side1), outward(side2), outward(center)];
    const dot3 = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const along = (p: Vec3) => (a ? dot3(p, a.normal) : 0);
    // How far the center face reaches across the gap.
    const extent = subShapes(oc, center.shape, "VERTEX").map((v) =>
      along(xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(v)))),
    );
    if (
      centers.length !== 1 ||
      body.bodyType !== "SOLID" ||
      !a ||
      !b ||
      !top ||
      dot3(a.normal, b.normal) > -1 + 1e-9 ||
      Math.abs(dot3(a.normal, top.normal)) > 1e-9 ||
      Math.abs(Math.min(...extent) - Math.min(along(a.origin), along(b.origin))) > 1e-7 ||
      Math.abs(Math.max(...extent) - Math.max(along(a.origin), along(b.origin))) > 1e-7
    )
      return call.unsupported(
        "Full round fillets other than one flat face between two parallel planes square to it are not supported locally yet.",
      );
    // With propagation (the default), Onshape carries the round across faces tangent to the sides.
    if (
      untag(definition.getField("tangentPropagation")) !== false &&
      [side1, side2].some((side) => tangentChain(oc, body.shape, [side.shape]).length > 1)
    )
      return call.unsupported(
        "Full round fillets propagating across faces tangent to the sides are not supported locally yet.",
      );
    const radius = Math.abs(along(b.origin) - along(a.origin)) / 2;
    const middle = (along(a.origin) + along(b.origin)) / 2;
    const n = top.normal;
    // The axis runs along the gap, a radius below the center face, midway between the sides.
    const direction: Vec3 = normalized([
      n[1] * a.normal[2] - n[2] * a.normal[1],
      n[2] * a.normal[0] - n[0] * a.normal[2],
      n[0] * a.normal[1] - n[1] * a.normal[0],
    ]);
    const shift = middle - along(top.origin);
    const bounds = new oc.Bnd_Box();
    oc.BRepBndLib.Add(body.shape, bounds, false);
    const length = 2 * Math.sqrt(bounds.SquareExtent()) + 1e-3;
    // Where the rod starts: on the axis, half its length back.
    const at = (i: 0 | 1 | 2) =>
      top.origin[i] + shift * a.normal[i] - radius * n[i] - (direction[i] * length) / 2;
    const slab = new oc.BRepPrimAPI_MakePrism(
      center.shape,
      new oc.gp_Vec(-n[0] * radius, -n[1] * radius, -n[2] * radius),
      true,
      true,
    ).Shape();
    const rod = new oc.BRepPrimAPI_MakeCylinder(
      new oc.gp_Ax2(new oc.gp_Pnt(at(0), at(1), at(2)), new oc.gp_Dir(...direction)),
      radius,
      length,
    ).Shape();
    const trimmed = new oc.BRepAlgoAPI_Cut();
    trimmed.SetNonDestructive(true);
    trimmed.SetArguments(toList(oc, [slab]));
    trimmed.SetTools(toList(oc, [rod]));
    trimmed.Build(new oc.Message_ProgressRange());
    if (trimmed.HasErrors()) return regenError(call, "FILLET_FAILED");
    const rounded = fillAndCut(oc, body.shape, [], [trimmed.Shape()]);
    if (
      !rounded ||
      subShapes(oc, rounded.shape, "SOLID").length !== 1 ||
      !new oc.BRepCheck_Analyzer(rounded.shape, true, false).IsValid()
    )
      return regenError(call, "FILLET_FAILED");
    model.geometry = replaceBodies(oc, model.geometry, {
      consumed: [body.id],
      keepIds: [body.id],
      results: [{ shape: subShapes(oc, rounded.shape, "SOLID")[0]!, bodyType: "SOLID" }],
      history: rounded.history,
      createdBy: idOf(id),
    }).state;
    return undefined;
  },

  opExtractSurface: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const selected = resolve(call, model, oc, definition.getField("faces"));
    const sheets = new Set(
      selected
        .filter((entity) => entity.type === "BODY" && entity.bodyType === "SHEET")
        .map((body) => body.id),
    );
    const faces = [...model.geometry.entities.values()].filter(
      (entity) => entity.type === "FACE" && (selected.includes(entity) || sheets.has(entity.body)),
    );
    if (faces.length === 0) return regenError(call, "EXTRACT_SURFACE_NO_FACES");
    const offset =
      definition.getField("offset") === undefined
        ? 0
        : magnitude(call, definition.getField("offset"), "offset");
    const trimByNeighbors = untag(definition.getField("useFacesAroundToTrimOffset")) !== false;
    const unify = String(untag(definition.getField("redundancyType"))) === "REMOVE_ALL_REDUNDANCY";

    const sheetsOut: Shape[] = [];
    for (const [body, entities] of byBody(model, faces)) {
      let shapes = entities.map((face) => face.shape);
      if (flag(definition, "tangentPropagation")) shapes = tangentChain(oc, body.shape, shapes);
      if (offset !== 0 && trimByNeighbors && !offsetKeepsNeighbors(oc, body.shape, shapes))
        return call.unsupported(
          "Offsetting extracted faces trimmed by surrounding faces that aren't perpendicular planes is not supported locally yet.",
        );
      // Copy the group at once so faces that share edges still share the copied edges.
      const copied = subShapes(oc, copyShape(oc, compoundOf(oc, shapes)), "FACE");
      for (const group of connectedGroups(oc, copied)) {
        let sheet = shellOf(oc, group);
        if (offset !== 0) {
          const offsetSheet = new oc.BRepOffsetAPI_MakeOffsetShape();
          try {
            offsetSheet.PerformByJoin(
              sheet,
              offset,
              1e-7,
              oc.BRepOffset_Mode.BRepOffset_Skin,
              false,
              false,
              oc.GeomAbs_JoinType.GeomAbs_Intersection,
              false,
              new oc.Message_ProgressRange(),
            );
          } catch {
            return regenError(call, "DIRECT_EDIT_OFFSET_FACE_FAILED");
          }
          if (!offsetSheet.IsDone()) return regenError(call, "DIRECT_EDIT_OFFSET_FACE_FAILED");
          sheet = shellOf(oc, subShapes(oc, offsetSheet.Shape(), "FACE"));
        }
        if (unify) {
          const unified = new oc.ShapeUpgrade_UnifySameDomain(sheet, true, true, false);
          unified.Build();
          sheet = unified.Shape();
        }
        sheetsOut.push(sheet);
      }
    }
    model.geometry = addBodies(
      oc,
      model.geometry,
      sheetsOut.map((shape) => ({ shape, bodyType: "SHEET" as const, createdBy: idOf(id) })),
    ).state;
    return undefined;
  },

  opCreateOutline: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const target = facesIn(call, model, oc, definition.getField("target"))[0];
    if (!target) return call.fail("opCreateOutline needs a target face.");
    const plane = planeOfFace(oc, target.shape);
    if (!plane)
      return call.unsupported(
        `Outlines on ${surfaceType(oc, target.shape).toUpperCase()} targets are not supported locally yet; only planes.`,
      );
    const tools = [...byBody(model, resolve(call, model, oc, definition.getField("tools"))).keys()];
    const bounds = new oc.Bnd_Box();
    for (const tool of tools) oc.BRepBndLib.Add(tool.shape, bounds, false);
    oc.BRepBndLib.Add(target.shape, bounds, false);
    const reach = 2 * Math.sqrt(bounds.SquareExtent()) + 1e-3;
    const outlines = tools.flatMap((tool) =>
      connectedGroups(
        oc,
        mergedPlanarFaces(
          oc,
          subShapes(oc, tool.shape, "FACE").flatMap((face) =>
            projectOntoPlane(oc, face, plane, reach),
          ),
        ),
      ).map((group) => shellOf(oc, group)),
    );
    model.geometry = addBodies(
      oc,
      model.geometry,
      outlines.map((shape) => ({ shape, bodyType: "SHEET" as const, createdBy: idOf(id) })),
    ).state;
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;

/**
 * True when offsetting `faces` keeps their open boundary on the neighboring faces of `body`, so
 * trimming the offset by the neighbors (Onshape's default) changes nothing: every neighbor across
 * the boundary is a plane perpendicular to the face all along the shared edge.
 */
function offsetKeepsNeighbors(oc: Oc, body: Shape, faces: readonly Shape[]): boolean {
  const selected = new ShapeSet<true>(oc);
  for (const face of faces) selected.set(face, true);
  const owners = new ShapeSet<Shape[]>(oc);
  for (const face of subShapes(oc, body, "FACE"))
    for (const edge of subShapes(oc, face, "EDGE"))
      owners.set(edge, [...(owners.get(edge) ?? []), face]);
  return faces.every((face) =>
    subShapes(oc, face, "EDGE").every((edge) =>
      (owners.get(edge) ?? [])
        .filter((other) => !selected.has(other))
        .every(
          (neighbor) =>
            surfaceType(oc, neighbor) === "Plane" &&
            edgePoints(oc, edge, 5).every((point) => {
              const a = normalNear(oc, face, point).normal;
              const b = normalNear(oc, neighbor, point).normal;
              return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < 1e-9;
            }),
        ),
    ),
  );
}

/**
 * Edges grouped into chains that run end to end, each in order; ends within 0.1 um meet. Fails
 * where three or more ends meet (NON_MANIFOLD), or where edges overlap, cross or one ends on another
 * (OVERLAPPING).
 */
function edgeChains(oc: Oc, edges: readonly Shape[]): Shape[][] | "NON_MANIFOLD" | "OVERLAPPING" {
  const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;
  const ends = edges.map((edge) => {
    const [first, , last] = edgePoints(oc, edge, 3);
    return [first!, last!] as const;
  });
  const middles = edges.map((edge) => edgePoints(oc, edge, 3)[1]!);
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++)
      if (
        near(middles[i]!, middles[j]!) &&
        ends[i]!.every((end) => ends[j]!.some((other) => near(end, other)))
      )
        return "OVERLAPPING";
  // Edges that touch anywhere but at ends they share overlap or cross (or one ends on the other),
  // which is no chain either.
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const extrema = new oc.BRepExtrema_DistShapeShape();
      extrema.LoadS1(edges[i]!);
      extrema.LoadS2(edges[j]!);
      extrema.Perform(new oc.Message_ProgressRange());
      if (!extrema.IsDone() || extrema.Value() > 1e-7) continue;
      const atSharedEnd = (point: Vec3) =>
        ends[i]!.some((end) => near(end, point)) && ends[j]!.some((end) => near(end, point));
      const contacts = Array.from({ length: extrema.NbSolution() }, (_, k) =>
        xyz(extrema.PointOnShape1(k + 1)),
      );
      if (contacts.every(atSharedEnd)) continue;
      // std's enum: overlapping or crossing edges are OVERLAPPING (NON_MANIFOLD is three ends at
      // a point), so both stop the same way.
      return "OVERLAPPING";
    }
  const meeting = (point: Vec3) =>
    ends.flatMap(([a, b], index) => [a, b].filter((end) => near(end, point)).map(() => index));
  for (const [a, b] of ends)
    if (meeting(a).length > 2 || meeting(b).length > 2) return "NON_MANIFOLD";
  const used = new Set<number>();
  const chains: Shape[][] = [];
  // Open chains start at an end no other edge touches; what's left over are closed loops.
  const order = edges
    .map((_, index) => index)
    .sort(
      (i, j) =>
        Number(ends[j]!.some((end) => meeting(end).length === 1)) -
        Number(ends[i]!.some((end) => meeting(end).length === 1)),
    );
  for (const start of order) {
    if (used.has(start)) continue;
    used.add(start);
    const chain = [start];
    // Walk away from the start's free end, if it has one.
    let tip = meeting(ends[start]![0]).length === 1 ? ends[start]![1] : ends[start]![0];
    for (;;) {
      const next = meeting(tip).find((index) => !used.has(index));
      if (next === undefined) break;
      used.add(next);
      chain.push(next);
      tip = near(ends[next]![0], tip) ? ends[next]![1] : ends[next]![0];
    }
    chains.push(chain.map((index) => edges[index]!));
  }
  return chains;
}

/** Faces among `entities`, plus every face of sheet bodies among them. */
function sheetFaces(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const sheets = new Set(
    entities
      .filter((entity) => entity.type === "BODY" && entity.bodyType === "SHEET")
      .map((body) => body.id),
  );
  return [...model.geometry.entities.values()].filter(
    (entity) => entity.type === "FACE" && (entities.includes(entity) || sheets.has(entity.body)),
  );
}

/**
 * The curve parameter `t` (0 to 1) of the way along `edge` from its start as oriented: by length
 * (Onshape's default), or uniformly over the curve's own parameter.
 */
function curveParameter(oc: Oc, edge: Shape, t: number, byLength: boolean): number {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  const share = String(edge.Orientation()) === "TopAbs_REVERSED" ? 1 - t : t;
  if (!byLength) return a + share * (b - a);
  // Five-point Gauss-Legendre over 64 spans, then bisection inside the span holding the target.
  const nodes = [
    [0, 0.5688888888888889],
    [0.5384693101056831, 0.4786286704993665],
    [-0.5384693101056831, 0.4786286704993665],
    [0.906179845938664, 0.2369268850561891],
    [-0.906179845938664, 0.2369268850561891],
  ] as const;
  const length = (from: number, to: number) =>
    nodes.reduce((sum, [x, w]) => {
      const u = (from + to) / 2 + ((to - from) / 2) * x;
      return sum + w * curve.EvalD1(u).D1.Magnitude();
    }, 0) *
    ((to - from) / 2);
  const spans = 64;
  const step = (b - a) / spans;
  const cumulative = [0];
  for (let i = 0; i < spans; i++)
    cumulative.push(cumulative[i]! + length(a + i * step, a + (i + 1) * step));
  const target = share * cumulative[spans]!;
  const span = Math.min(spans - 1, Math.max(0, cumulative.findIndex((sum) => sum >= target) - 1));
  let [low, high] = [a + span * step, a + (span + 1) * step];
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (cumulative[span]! + length(a + span * step, mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Replaces `body` by what a splitter made of it (same body type, ids carried by the splitter's
 * history), returning the result's body ids. A wire split into loose edges is chained again.
 */
function replaceSplit(
  oc: Oc,
  model: ModelContext,
  body: Entity,
  splitter: InstanceType<Oc["BRepAlgoAPI_Splitter"]>,
  id: FsValue,
): string[] {
  const result = splitter.Shape();
  let history = historyOf(oc, splitter);
  const shapes =
    body.bodyType === "SOLID"
      ? subShapes(oc, result, "SOLID").map((solid) => {
          const seated = seatSeams(oc, solid, [body.shape]);
          if (!seated) return solid;
          history = chainHistory(history, seated.history);
          return seated.shape;
        })
      : body.bodyType === "SHEET"
        ? subShapes(oc, result, "SHELL").length
          ? subShapes(oc, result, "SHELL")
          : [shellOf(oc, subShapes(oc, result, "FACE"))]
        : body.bodyType === "WIRE"
          ? wiresOf(oc, subShapes(oc, result, "EDGE"))
          : [result];
  const replaced = replaceBodies(oc, model.geometry, {
    consumed: [body.id],
    keepIds: [body.id],
    results: shapes.map((shape) => ({ shape, bodyType: body.bodyType })),
    history,
    createdBy: idOf(id),
  });
  model.geometry = replaced.state;
  return replaced.ids;
}

/** Edges joined into one wire per connected chain. */
function wiresOf(oc: Oc, edges: readonly Shape[]): Shape[] {
  const chains = edgeChains(oc, edges);
  if (typeof chains === "string") return [compoundOf(oc, edges)];
  return chains.map((chain) => {
    const wire = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of chain) wire.Add(oc.TopoDS.Edge(edge));
    return wire.Wire();
  });
}

/**
 * `edge` laid onto `face` for splitting it: as is when it already lies on the face's surface, or,
 * for a plane, moved along the plane's normal (or `direction`) when it lies in a parallel plane
 * (any curve) or is a line (projected end to end). Other projections aren't supported.
 */
function projectEdge(
  oc: Oc,
  edge: Shape,
  face: Shape,
  direction: Vec3 | null,
): Shape | "UNSUPPORTED" {
  const samples = edgePoints(oc, edge, 7);
  if (samples.every((point) => normalNear(oc, face, point).distance < 1e-7)) return edge;
  const plane = planeOfFace(oc, face);
  if (!plane) return "UNSUPPORTED";
  const along = direction ?? plane.normal;
  const facing =
    along[0] * plane.normal[0] + along[1] * plane.normal[1] + along[2] * plane.normal[2];
  if (Math.abs(facing) < 1e-9) return "UNSUPPORTED";
  // How far along `along` each point travels to reach the plane.
  const travel = (p: Vec3) =>
    ((plane.origin[0] - p[0]) * plane.normal[0] +
      (plane.origin[1] - p[1]) * plane.normal[1] +
      (plane.origin[2] - p[2]) * plane.normal[2]) /
    facing;
  const moves = samples.map(travel);
  if (moves.every((move) => Math.abs(move - moves[0]!) < 1e-9)) {
    const shift = new oc.gp_Trsf();
    shift.SetTranslation(
      new oc.gp_Vec(along[0] * moves[0]!, along[1] * moves[0]!, along[2] * moves[0]!),
    );
    return new oc.BRepBuilderAPI_Transform(edge, shift, true, false).Shape();
  }
  if (surfaceKindOfEdge(oc, edge) !== "Line") return "UNSUPPORTED";
  const [start, , end] = edgePoints(oc, edge, 3);
  const onPlane = (p: Vec3): Vec3 => {
    const t = travel(p);
    return [p[0] + along[0] * t, p[1] + along[1] * t, p[2] + along[2] * t];
  };
  return new oc.BRepBuilderAPI_MakeEdge(
    new oc.gp_Pnt(...onPlane(start!)),
    new oc.gp_Pnt(...onPlane(end!)),
  ).Edge();
}

const surfaceKindOfEdge = (oc: Oc, edge: Shape) =>
  String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)).GetType()).replace("GeomAbs_", "");

/**
 * `edges` plus the edges of their bodies that continue them smoothly (tangent at a shared vertex),
 * transitively: std's extend selects a sheet's edges this way by default, and fillets and chamfers
 * with tangent propagation.
 */
export function tangentEdges(oc: Oc, model: ModelContext, edges: readonly Entity[]): Entity[] {
  const chosen = new Set(edges);
  const queue = [...edges];
  const tangent = (edge: Shape, at: Vec3) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    const atStart = Math.hypot(...xyz(curve.Value(a)).map((c, i) => c - at[i]!)) < 1e-7;
    const d = curve.EvalD1(atStart ? a : b).D1;
    const length = d.Magnitude() || 1;
    return [d.X() / length, d.Y() / length, d.Z() / length] as const;
  };
  while (queue.length) {
    const edge = queue.pop()!;
    for (const vertex of subShapes(oc, edge.shape, "VERTEX")) {
      const at = xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex)));
      for (const other of model.geometry.entities.values()) {
        if (other.type !== "EDGE" || other.body !== edge.body || chosen.has(other)) continue;
        if (!subShapes(oc, other.shape, "VERTEX").some((v) => v.IsSame(vertex))) continue;
        const [p, q] = [tangent(edge.shape, at), tangent(other.shape, at)];
        if (Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) > Math.cos(1e-3)) {
          chosen.add(other);
          queue.push(other);
        }
      }
    }
  }
  return [...chosen];
}

/**
 * Moves edges of a planar one-face sheet across its plane, each by its own distance (positive grows
 * the sheet), all in one rebuild, with the neighboring edges following along their own lines. The sheet is the base of a thin prism whose
 * side faces at those edges are offset by the face rebuild, so corners close the same way a solid's
 * do. A moved edge keeps its id as the edge on its moved side face.
 */
function moveSheetEdges(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  body: Entity,
  moves: readonly { readonly edge: Entity; readonly distance: number }[],
  id: FsValue,
  error: string,
): void {
  const edges = moves.map((move) => move.edge);
  const faces = subShapes(oc, body.shape, "FACE");
  const plane = faces.length === 1 ? planeOfFace(oc, faces[0]!) : null;
  if (!plane)
    return call.unsupported(
      faces.length === 1
        ? `Moving edges of a ${surfaceType(oc, faces[0]!).toUpperCase()} surface is not supported locally yet; only flat ones.`
        : "Moving edges of a surface with several faces is not supported locally yet.",
    );
  const face = faces[0]!;
  const bounds = new oc.Bnd_Box();
  oc.BRepBndLib.Add(face, bounds, false);
  const depth = 0.1 * Math.sqrt(bounds.SquareExtent());
  const prism = new oc.BRepPrimAPI_MakePrism(
    face,
    new oc.gp_Vec(-plane.normal[0] * depth, -plane.normal[1] * depth, -plane.normal[2] * depth),
    false,
    true,
  );
  // Side faces as the prism holds them: their orientation sets which way is out.
  const prismFaces = subShapes(oc, prism.Shape(), "FACE");
  const sides = edges.map((edge) => {
    const generated = fromList(oc, prism.Generated(edge.shape))[0];
    return generated && prismFaces.find((face) => face.IsSame(generated));
  });
  if (sides.some((side) => side === undefined)) return regenError(call, error);
  const changes = sides.map((side, i) => ({
    face: side!,
    moved: offsetFace(oc, side!, moves[i]!.distance),
  }));
  if (changes.some((change) => change.moved === null)) return regenError(call, error);
  const rebuilt = rebuildSolid(oc, prism.Shape(), changes);
  if (!rebuilt.ok) return regenError(call, error);
  const base = imagesOf(rebuilt.history, face)[0];
  if (!base) return regenError(call, error);
  // The prism's base faces into it; the sheet keeps its own normal.
  const sheet = String(base.Orientation()) === String(face.Orientation()) ? base : base.Reversed();
  const sheetEdges = subShapes(oc, sheet, "EDGE");
  const movedEdge = new ShapeSet<Shape[]>(oc);
  edges.forEach((edge, i) => {
    const sideImages = rebuilt.history.modified(sides[i]!);
    movedEdge.set(
      edge.shape,
      sheetEdges.filter((candidate) =>
        sideImages.some((image) => subShapes(oc, image, "EDGE").some((e) => e.IsSame(candidate))),
      ),
    );
  });
  model.geometry = replaceBodies(oc, model.geometry, {
    consumed: [body.id],
    keepIds: [body.id],
    results: [{ shape: shellOf(oc, [sheet]), bodyType: "SHEET" }],
    history: {
      deleted: (shape) => !movedEdge.has(shape) && rebuilt.history.deleted(shape),
      modified: (shape) => movedEdge.get(shape) ?? rebuilt.history.modified(shape),
      generated: () => [],
    },
    createdBy: idOf(id),
  }).state;
}

/**
 * opPattern for faces: the faces and their neighbors' extensions enclose a feature (a hole's empty
 * cylinder, a boss's volume), the cells a heal would fill or cut. Each instance moves those cells
 * and cuts a depression or fuses a protrusion, its new faces created by `[...id, name]`. An
 * instance whose cell doesn't land on the body's own surfaces (Parasolid would extend the copied
 * faces to whatever is there) stops the run as unsupported.
 */
export function patternFaces(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  faces: readonly Entity[],
  instances: readonly { readonly trsf: InstanceType<Oc["gp_Trsf"]>; readonly name: string }[],
  id: FsValue,
  copyAttributes: boolean,
): void {
  for (const [seedBody, seeds] of byBody(model, faces)) {
    if (seedBody.bodyType !== "SOLID")
      return call.unsupported("Patterning faces of a surface is not supported locally yet.");
    const swept = sweptRegions(
      oc,
      seedBody.shape,
      seeds.map((seed) => ({ face: seed.shape, moved: null })),
    );
    if (!swept.ok || swept.regions.length === 0)
      return call.unsupported(
        "Patterning faces that don't enclose a feature with their neighbors is not supported locally yet.",
      );
    // A seed piece's attributes, for the copies made from it.
    const seedOf = (piece: Shape) =>
      seeds.find(
        (seed) =>
          normalNear(oc, seed.shape, edgePoints(oc, subShapes(oc, piece, "EDGE")[0]!, 3)[1]!)
            .distance < 1e-7,
      );
    for (const { trsf, name } of instances) {
      const body = model.geometry.entities.get(seedBody.id)!;
      const moved = swept.regions.map((region) => {
        const transform = new oc.BRepBuilderAPI_Transform(region.cell, trsf, true, false);
        const image = (shape: Shape) => transform.ModifiedShape(shape);
        return {
          cell: transform.Shape(),
          // Heal fills a depression (cut its copy) and removes a protrusion (fuse its copy).
          add: !region.add,
          copies: region.changedFaces.map((piece) => ({
            piece: image(piece),
            seed: seedOf(piece),
          })),
          bounds: subShapes(oc, region.cell, "FACE")
            .filter((face) => !region.changedFaces.some((piece) => piece.IsSame(face)))
            .map(image),
        };
      });
      const changed = fillAndCut(
        oc,
        body.shape,
        moved.filter((region) => region.add).map((region) => region.cell),
        moved.filter((region) => !region.add).map((region) => region.cell),
      );
      if (!changed) return regenError(call, "PATTERN_FACE_FAILED");
      const inResult = new ShapeSet<true>(oc);
      for (const face of subShapes(oc, changed.shape, "FACE")) inResult.set(face, true);
      const fromBody = new ShapeSet<true>(oc);
      for (const face of subShapes(oc, body.shape, "FACE"))
        for (const image of imagesOf(changed.history, face)) fromBody.set(image, true);
      const landed = moved.every(
        (region) =>
          region.copies.every(({ piece }) =>
            imagesOf(changed.history, piece).some((image) => inResult.has(image)),
          ) &&
          region.bounds.every((bound) =>
            imagesOf(changed.history, bound).every(
              (image) => !inResult.has(image) || fromBody.has(image),
            ),
          ),
      );
      if (!landed)
        return call.unsupported(
          "A face pattern instance landing where the part's surfaces differ from the seed's is not supported locally yet.",
        );
      // Each copied face's seed: its lineage source, and its attributes when copying them.
      const copyOf = new ShapeSet<Entity>(oc);
      for (const region of moved)
        for (const { piece, seed } of region.copies)
          if (seed) for (const image of imagesOf(changed.history, piece)) copyOf.set(image, seed);
      model.geometry = replaceBodies(oc, model.geometry, {
        consumed: [body.id],
        keepIds: [body.id],
        results: subShapes(oc, changed.shape, "SOLID").map((shape) => ({
          shape,
          bodyType: "SOLID" as const,
        })),
        history: changed.history,
        createdBy: [...idOf(id), name],
        sources: (shape, type) => {
          const seed = type === "FACE" ? copyOf.get(shape) : undefined;
          return seed ? [seed.id] : [];
        },
        annotate: (shape, type) => {
          const seed = type === "FACE" && copyAttributes ? copyOf.get(shape) : undefined;
          return seed ? { attributes: seed.attributes } : {};
        },
      }).state;
    }
  }
}
