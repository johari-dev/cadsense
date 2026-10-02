import {
  addBodies,
  historyOf,
  replaceBodies,
  type Entity,
  type History,
} from "../geometry/Model.ts";
import { ShapeSet, subShapes, toList, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { untag, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { regenError } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Modeling operations beyond extrude and boolean: revolve, fillet, chamfer, shell, pattern, transform. */

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
        annotate: (_: Shape, type: string) =>
          type === "BODY" && untag(definition.getField("copyPropertiesAndAttributes")) !== false
            ? { attributes: body.attributes }
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
        results: [{ shape: moved.Shape(), bodyType: body.bodyType }],
        history: historyOf(oc, moved),
        createdBy: idOf(id),
      }).state;
    }
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
