import {
  addBodies,
  chainHistory,
  historyOf,
  ordered,
  removeBodies,
  replaceBodies,
  sameAttributeType,
  updateEntities,
  type Entity,
  type EntityAttribute,
  type History,
} from "../geometry/Model.ts";
import { ShapeSet, subShapes, toList, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { equals, FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { map } from "./args.ts";
import { properties } from "./edges.ts";
import { tidied } from "./faceEdit.ts";
import { idOf, kernel, magnitude, normalized, resolve, transient, vector } from "./geometryArgs.ts";
import { regenError, stdPlane } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

// ------------------------------------------------------------------ attributes and properties

/** Where `setProperty` keeps a property on a body: its `PropertyType` member, or `CUSTOM:<id>`. */
function propertyKey(call: BuiltinCall, definition: FsMap): string {
  const type = untag(definition.getField("propertyType"));
  if (typeof type !== "string") return call.fail("propertyType must be a PropertyType.");
  if (type !== "CUSTOM") return type;
  return `CUSTOM:${String(untag(definition.getField("customPropertyId"))).toLowerCase()}`;
}

/** `attributePattern` matching: every key in the pattern is present with an equal value. */
const matchesPattern = (value: FsValue, pattern: FsValue): boolean => {
  const p = untag(pattern);
  if (!(p instanceof FsMap)) return true;
  const v = untag(value);
  return v instanceof FsMap && p.entries().every(([key, expected]) => equals(v.get(key), expected));
};
/** Legacy unnamed attributes are told apart by type tag. */

/** The attributes on `entities` that `definition` selects (by name, pattern, or legacy type). */
function selectAttributes(entities: readonly Entity[], definition: FsMap): EntityAttribute[] {
  const name = untag(definition.getField("name"));
  const pattern = definition.getField("attributePattern");
  return entities.flatMap((entity) =>
    entity.attributes.filter((attribute) => {
      if (typeof name === "string")
        return attribute.name === name && matchesPattern(attribute.value, pattern);
      if (pattern !== undefined)
        return (
          attribute.name === null &&
          sameAttributeType(attribute.value, pattern) &&
          matchesPattern(attribute.value, pattern)
        );
      return true;
    }),
  );
}
const uniqueValues = (values: readonly FsValue[]) =>
  values.filter((value, i) => values.findIndex((other) => equals(other, value)) === i);

// ------------------------------------------------------------------ extrude

/** Model size, for "through all" extrudes. */
function modelExtent(oc: Oc, shapes: readonly Shape[]): number {
  const box = new oc.Bnd_Box();
  for (const shape of shapes) oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) return 1;
  return (
    Math.hypot(
      box.GetXMax() - box.GetXMin(),
      box.GetYMax() - box.GetYMin(),
      box.GetZMax() - box.GetZMin(),
    ) +
    Math.hypot(box.GetXMax(), box.GetYMax(), box.GetZMax()) +
    1
  );
}

/** Signed distance for one end of an extrude. */
function bound(
  call: BuiltinCall,
  definition: FsMap,
  end: "end" | "start",
  throughAll: number,
): number {
  const type = String(
    untag(definition.getField(`${end}Bound`)) ?? (end === "end" ? "BLIND" : "NONE"),
  );
  if (type === "NONE" || (end === "start" && definition.getField("startBound") === undefined))
    return 0;
  if (type === "BLIND") return magnitude(call, definition.getField(`${end}Depth`), `${end}Depth`);
  if (type === "THROUGH_ALL") return throughAll;
  return call.unsupported(`Extrude bound ${type} is not supported locally yet.`);
}

export const GEOMETRY_BUILTINS = {
  evaluateQuery: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    return resolve(call, model, oc, map(call, args, "definition").getField("query")).map((entity) =>
      transient(call, entity),
    );
  },
  evaluateQueryCount: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    return resolve(call, model, oc, map(call, args, "definition").getField("query")).length;
  },
  isQueryEmpty: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    return resolve(call, model, oc, map(call, args, "definition").getField("query")).length === 0;
  },
  transientIdToString: ([id]) => String(untag(id)),

  opExtrude: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const faces = resolve(call, model, oc, definition.getField("entities")).filter(
      (entity) => entity.type === "FACE",
    );
    if (faces.length === 0) return call.fail("Nothing to extrude.");
    const direction = normalized(vector(call, definition.getField("direction"), 3, "direction"));
    const throughAll = modelExtent(
      oc,
      ordered(model.geometry, (entity) => entity.type === "BODY").map((entity) => entity.shape),
    );
    const end = bound(call, definition, "end", throughAll);
    // startDepth extends opposite `direction`; isStartBoundOpposite (default true) keeps that sense.
    const startSign = untag(definition.getField("isStartBoundOpposite")) === false ? -1 : 1;
    const start = bound(call, definition, "start", throughAll) * startSign;
    const length = end + start;
    if (Math.abs(length) < 1e-12) return call.fail("The extrude has zero depth.");
    const caps = new ShapeSet<"START" | "END">(oc);
    const shapes = faces.map((face) => {
      const offset = new oc.gp_Trsf();
      offset.SetTranslation(
        new oc.gp_Vec(-direction[0] * start, -direction[1] * start, -direction[2] * start),
      );
      const base = new oc.BRepBuilderAPI_Transform(face.shape, offset, true, false).Shape();
      const prism = new oc.BRepPrimAPI_MakePrism(
        base,
        new oc.gp_Vec(direction[0] * length, direction[1] * length, direction[2] * length),
        false,
        true,
      );
      for (const cap of subShapes(oc, prism.FirstShape(), "FACE"))
        caps.set(cap, length > 0 ? "START" : "END");
      for (const cap of subShapes(oc, prism.LastShape(), "FACE"))
        caps.set(cap, length > 0 ? "END" : "START");
      const solid = prism.Shape();
      // A negative-length prism comes out inside-out; reversing it keeps volumes positive.
      return length < 0 ? solid.Reversed() : solid;
    });
    model.geometry = addBodies(
      oc,
      model.geometry,
      shapes.map((shape) => ({
        shape,
        bodyType: "SOLID" as const,
        createdBy: idOf(id),
        annotate: (s: Shape) => ({ cap: caps.get(s) ?? null }),
      })),
    ).state;
    return undefined;
  },

  /**
   * The plane of the first entity `face` resolves to: a planar face's, or a mate connector's XY
   * plane (std's `QueryFilterCompound.ALLOWS_PLANE` sends both, e.g. cPlane's offset plane).
   */
  evPlane: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const entity = resolve(call, model, oc, map(call, args, "definition").getField("face"))[0];
    // A mate connector's body and vertex carry its coordinate system; std's `plane(cSys)`.
    if (entity?.frame)
      return stdPlane(call, entity.frame.origin, entity.frame.zAxis, entity.frame.xAxis);
    if (entity?.type !== "FACE")
      return call.fail("CANNOT_RESOLVE_PLANE: no planar face or mate connector to evaluate.");
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
    if (String(surface.GetType()) !== "GeomAbs_Plane")
      return call.fail("CANNOT_RESOLVE_PLANE: the face isn't planar.");
    const position = surface.Plane().Position();
    // A reversed face's outward normal is opposite its surface's; keep x, flip the normal.
    const flip = String(entity.shape.Orientation()) === "TopAbs_REVERSED" ? -1 : 1;
    const [nx, ny, nz] = xyz(position.Direction());
    // The origin is the face's centroid, integrated as accurately as evArea's (adaptively when
    // the boundary isn't lines, circles and ellipses). Unverified: Onshape doesn't document it.
    const centroid = properties(oc, entity.shape, 2, call.unsupported).CentreOfMass();
    return stdPlane(
      call,
      xyz(centroid),
      [nx * flip, ny * flip, nz * flip],
      xyz(position.XDirection()),
    );
  },

  setAttribute: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const entities = resolve(call, model, oc, definition.getField("entities"));
    if (entities.length === 0) return call.fail("setAttribute: entities resolve to nothing.");
    const name = untag(definition.getField("name"));
    const attribute = definition.getField("attribute");
    model.geometry = updateEntities(
      model.geometry,
      entities.map((entity) => entity.id),
      (entity) => ({
        ...entity,
        attributes:
          typeof name === "string"
            ? [
                ...entity.attributes.filter((existing) => existing.name !== name),
                ...(attribute === undefined ? [] : [{ name, value: attribute }]),
              ]
            : [
                ...entity.attributes.filter(
                  (existing) =>
                    existing.name !== null || !sameAttributeType(existing.value, attribute),
                ),
                { name: null, value: attribute },
              ],
      }),
    );
    return undefined;
  },
  getAttributes: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    return uniqueValues(
      selectAttributes(resolve(call, model, oc, definition.getField("entities")), definition).map(
        (attribute) => attribute.value,
      ),
    );
  },
  getAttribute: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const entity = resolve(call, model, oc, definition.getField("entity"))[0];
    const name = untag(definition.getField("name"));
    return entity?.attributes.find((attribute) => attribute.name === name)?.value;
  },
  getAllAttributes: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const entity = resolve(call, model, oc, map(call, value, "definition").getField("entity"))[0];
    return FsMap.fromEntries(
      (entity?.attributes ?? []).flatMap((attribute) =>
        attribute.name === null ? [] : [[attribute.name, attribute.value] as const],
      ),
    );
  },
  removeAttributes: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const entities = resolve(call, model, oc, definition.getField("entities"));
    for (const entity of entities) {
      const remove = new Set(selectAttributes([entity], definition));
      model.geometry = updateEntities(model.geometry, [entity.id], (kept) => ({
        ...kept,
        attributes: kept.attributes.filter((attribute) => !remove.has(attribute)),
      }));
    }
    return undefined;
  },

  setProperty: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const key = propertyKey(call, definition);
    const setTo = definition.getField("value");
    if (setTo === undefined) return call.fail("setProperty needs a value.");
    // Std: bodies take every property, faces only APPEARANCE and NAME.
    const entities = resolve(call, model, oc, definition.getField("entities"));
    const faces = entities.filter((entity) => entity.type === "FACE");
    if (faces.length > 0 && key !== "APPEARANCE" && key !== "NAME")
      return call.unsupported(`setProperty ${key} on faces is not supported locally yet.`);
    model.geometry = updateEntities(
      model.geometry,
      [...entities.filter((entity) => entity.type === "BODY"), ...faces].map((entity) => entity.id),
      (entity) => ({ ...entity, properties: new Map([...entity.properties, [key, setTo]]) }),
    );
    return undefined;
  },
  // Std: getProperty "cannot be called on the current context inside custom features", and a
  // preview only ever has that context. Reading what setProperty stored would pass here and fail
  // in Onshape.
  getProperty: (_args, call) =>
    call.fail(
      "getProperty can't read the Part Studio a custom feature runs in. Onshape allows it only in table functions, editing logic and manipulator change functions.",
    ),

  // Sheet metal doesn't exist locally, so no query contains flattened sheet metal.
  queryContainsFlattenedSheetMetal: ([ctx], call) => {
    kernel(call, ctx);
    return false;
  },

  opBoolean: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const bodies = (field: string) => {
      const query = definition.getField(field);
      if (query === undefined) return [];
      const ids = [...new Set(resolve(call, model, oc, query).map((entity) => entity.body))];
      return ids.map((bodyId) => model.geometry.entities.get(bodyId)!);
    };
    const tools = bodies("tools");
    const targets = bodies("targets");
    const operation = String(untag(definition.getField("operationType")));
    const keepTools = untag(definition.getField("keepTools")) === true;
    if (tools.length === 0) return regenError(call, "BOOLEAN_NEED_ONE_SOLID");
    if ([...tools, ...targets].some((body) => body.bodyType !== "SOLID"))
      return call.unsupported("Booleans on surface bodies are not supported locally yet.");

    let algorithm: InstanceType<Oc["BRepAlgoAPI_BooleanOperation"]>;
    let consumed: Entity[];
    let keepIds: string[];
    let keepIdBy: "most" | "earliest" = "most";
    // An intersection of more than two bodies: what the bodies before the last share, and how it
    // came from them. OpenCascade's common of one argument with several tools is the argument and
    // the tools' union, so each body joins in its own step.
    let shared: { shape: Shape; history: History } | null = null;
    if (operation === "SUBTRACTION" || operation === "SUBTRACT_COMPLEMENT") {
      if (targets.length === 0) return regenError(call, "BOOLEAN_NEED_ONE_SOLID");
      // SUBTRACT_COMPLEMENT removes what's outside the tools' union: each target keeps only its
      // common part with them, and its id.
      algorithm =
        operation === "SUBTRACTION" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common();
      algorithm.SetArguments(
        toList(
          oc,
          targets.map((body) => body.shape),
        ),
      );
      algorithm.SetTools(
        toList(
          oc,
          tools.map((body) => body.shape),
        ),
      );
      consumed = keepTools ? targets : [...targets, ...tools];
      keepIds = targets.map((body) => body.id);
    } else if (operation === "UNION" || operation === "INTERSECTION") {
      const all = [...tools, ...targets];
      if (all.length < 2) return regenError(call, "BOOLEAN_NEED_ONE_SOLID");
      if (operation === "INTERSECTION")
        for (const body of all.slice(1, -1)) {
          const step = new oc.BRepAlgoAPI_Common();
          step.SetArguments(toList(oc, [shared?.shape ?? all[0]!.shape]));
          step.SetTools(toList(oc, [body.shape]));
          step.SetNonDestructive(true);
          step.Build(new oc.Message_ProgressRange());
          if (step.HasErrors()) return regenError(call, "BOOLEAN_INVALID");
          const history = historyOf(oc, step);
          shared = {
            shape: step.Shape(),
            history: shared ? chainHistory(shared.history, history) : history,
          };
        }
      algorithm = operation === "UNION" ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Common();
      algorithm.SetArguments(toList(oc, [shared?.shape ?? all[0]!.shape]));
      algorithm.SetTools(
        toList(
          oc,
          (shared ? all.slice(-1) : all.slice(1)).map((body) => body.shape),
        ),
      );
      // With keepTools the tools stay as they are and the result is a new body.
      consumed = keepTools ? [] : all;
      keepIds = keepTools ? [] : all.map((body) => body.id);
      keepIdBy = "earliest";
    } else return call.unsupported(`Boolean ${operation} is not supported locally yet.`);

    algorithm.SetNonDestructive(true);
    algorithm.Build(new oc.Message_ProgressRange());
    if (algorithm.HasErrors()) return regenError(call, "BOOLEAN_INVALID");
    // Parasolid merges the faces a boolean leaves split on one surface (a union's coplanar sides),
    // but not splits the inputs already had.
    const tidy = tidied(oc, algorithm, [
      ...[...targets, ...tools].map((body) => body.shape),
      ...(shared ? [shared.shape] : []),
    ]);
    if (!tidy) return regenError(call, "BOOLEAN_INVALID");
    const result = shared
      ? { shape: tidy.shape, history: chainHistory(shared.history, tidy.history) }
      : tidy;
    model.geometry = replaceBodies(oc, model.geometry, {
      consumed: consumed.map((body) => body.id),
      keepIds,
      keepIdBy,
      results: subShapes(oc, result.shape, "SOLID").map((shape) => ({
        shape,
        bodyType: "SOLID" as const,
      })),
      history: result.history,
      createdBy: idOf(id),
    }).state;
    return undefined;
  },

  opDeleteBodies: ([ctx, , value], call) => {
    const { model, oc } = kernel(call, ctx);
    const bodies = resolve(
      call,
      model,
      oc,
      map(call, value, "definition").getField("entities"),
    ).map((entity) => entity.body);
    model.geometry = removeBodies(model.geometry, [...new Set(bodies)]);
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
