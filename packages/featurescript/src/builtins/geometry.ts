import {
  addBodies,
  historyOf,
  ordered,
  removeBodies,
  replaceBodies,
  withAttributes,
  type Entity,
  type EntityAttribute,
} from "../geometry/Model.ts";
import { evaluateQuery } from "../geometry/Query.ts";
import { Sketch, solveSketch, type SketchPlane, type Vec2, type Vec3 } from "../geometry/Sketch.ts";
import { ShapeSet, subShapes, toList, xyz, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import {
  equals,
  FsBuiltin,
  FsMap,
  FsTagged,
  untag,
  type FsArray,
  type FsValue,
} from "../runtime/Value.ts";
import { context, map } from "./args.ts";
import { lengthVector, regenError, stdEnum, stdTagged, unitVector } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Geometry builtins, on OpenCascade. Lengths arrive in meters, plain or as `ValueWithUnits`. */

/** The context's model and kernel; a runtime without a kernel stops here. */
const kernel = (call: BuiltinCall, ctx: FsValue): { model: ModelContext; oc: Oc } => {
  const model = context(call, ctx);
  if (!model.oc)
    return call.unsupported(
      "Geometry needs the OpenCascade kernel; create the runtime with FeatureScriptRuntime.withGeometry().",
    );
  return { model, oc: model.oc };
};

/** A number, or the SI magnitude of a `ValueWithUnits`. */
const magnitude = (call: BuiltinCall, value: FsValue, what: string): number => {
  const v = untag(value);
  if (typeof v === "number") return v;
  if (v instanceof FsMap && typeof v.getField("value") === "number")
    return v.getField("value") as number;
  return call.fail(`${what} must be a number or a length.`);
};
const vector = <N extends 2 | 3>(
  call: BuiltinCall,
  value: FsValue,
  size: N,
  what: string,
): N extends 2 ? Vec2 : Vec3 => {
  const items = untag(value);
  if (!Array.isArray(items) || items.length !== size)
    return call.fail(`${what} must be a ${size}D vector.`);
  return (items as FsArray).map((item) => magnitude(call, item, what)) as unknown as N extends 2
    ? Vec2
    : Vec3;
};
const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** A `Query` that names one entity. */
const transient = (call: BuiltinCall, entity: Entity) =>
  stdTagged(call, "query.fs", "Query", [
    ["queryType", stdEnum(call, "query.fs", "QueryType", "TRANSIENT")],
    ["transientId", entity.id],
  ]);

const resolve = (call: BuiltinCall, model: ModelContext, oc: Oc, query: FsValue): Entity[] =>
  evaluateQuery(
    { oc, state: model.geometry, fail: call.fail, unsupported: call.unsupported },
    query,
  );

const idOf = (value: FsValue): readonly string[] =>
  (untag(value) as FsArray).map((part) => String(untag(part)));

// ------------------------------------------------------------------ sketches

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
/** Adds an entity; `value` holds its parameters (with or without units). */
const sketchEntity =
  (
    build: (
      call: BuiltinCall,
      id: string,
      value: FsMap,
      construction: boolean,
    ) => Sketch["entities"][number],
  ): BuiltinImpl =>
  ([sketch, id, value], call) => {
    const { sketch: target } = sketchOf(call, sketch);
    const definition = map(call, value, "value");
    target.entities.push(
      build(
        call,
        String(untag(id)),
        definition,
        untag(definition.getField("construction")) === true,
      ),
    );
    return undefined;
  };

// ------------------------------------------------------------------ attributes

/** `attributePattern` matching: every key in the pattern is present with an equal value. */
const matchesPattern = (value: FsValue, pattern: FsValue): boolean => {
  const p = untag(pattern);
  if (!(p instanceof FsMap)) return true;
  const v = untag(value);
  return v instanceof FsMap && p.entries().every(([key, expected]) => equals(v.get(key), expected));
};
/** Legacy unnamed attributes are told apart by type tag. */
const sameTag = (a: FsValue, b: FsValue) =>
  (a instanceof FsTagged ? a.tag : null) === (b instanceof FsTagged ? b.tag : null);

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
          sameTag(attribute.value, pattern) &&
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
  skLineSegment: sketchEntity((call, id, value, construction) => ({
    kind: "line",
    id,
    start: vector(call, value.getField("start"), 2, "start"),
    end: vector(call, value.getField("end"), 2, "end"),
    construction,
  })),
  skCircle: sketchEntity((call, id, value, construction) => ({
    kind: "circle",
    id,
    center: vector(call, value.getField("center"), 2, "center"),
    radius: magnitude(call, value.getField("radius"), "radius"),
    construction,
  })),
  skArc: sketchEntity((call, id, value, construction) => ({
    kind: "arc",
    id,
    start: vector(call, value.getField("start"), 2, "start"),
    mid: vector(call, value.getField("mid"), 2, "mid"),
    end: vector(call, value.getField("end"), 2, "end"),
    construction,
  })),
  skPoint: sketchEntity((call, id, value, construction) => ({
    kind: "point",
    id,
    position: vector(call, value.getField("position"), 2, "position"),
    construction,
  })),
  // No constraint solver yet: std's helpers (rectangles, polygons) build geometry that already
  // satisfies the constraints they add, so these are accepted as-is.
  skConstraint: () => undefined,
  skSolve: ([sketch], call) => {
    const { sketch: target, model } = sketchOf(call, sketch);
    model.geometry = solveSketch(model.oc!, model.geometry, target);
    return undefined;
  },

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

  evPlane: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const face = resolve(call, model, oc, map(call, args, "definition").getField("face"))[0];
    if (face?.type !== "FACE") return call.fail("CANNOT_RESOLVE_PLANE: no face to evaluate.");
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), true);
    if (String(surface.GetType()) !== "GeomAbs_Plane")
      return call.fail("CANNOT_RESOLVE_PLANE: the face isn't planar.");
    const position = surface.Plane().Position();
    // A reversed face's outward normal is opposite its surface's; keep x, flip the normal.
    const flip = String(face.shape.Orientation()) === "TopAbs_REVERSED" ? -1 : 1;
    const normal = xyz(position.Direction()).map((c) => c * flip);
    // The origin is the face's centroid. Unverified: Onshape doesn't document where it puts it.
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face.shape, props, false, false);
    return stdTagged(call, "surfaceGeometry.fs", "Plane", [
      ["origin", lengthVector(call, xyz(props.CentreOfMass()))],
      ["normal", unitVector(call, normal)],
      ["x", unitVector(call, xyz(position.XDirection()))],
    ]);
  },

  setAttribute: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const entities = resolve(call, model, oc, definition.getField("entities"));
    if (entities.length === 0) return call.fail("setAttribute: entities resolve to nothing.");
    const name = untag(definition.getField("name"));
    const attribute = definition.getField("attribute");
    model.geometry = withAttributes(
      model.geometry,
      entities.map((entity) => entity.id),
      (attributes) =>
        typeof name === "string"
          ? [
              ...attributes.filter((existing) => existing.name !== name),
              ...(attribute === undefined ? [] : [{ name, value: attribute }]),
            ]
          : [
              ...attributes.filter(
                (existing) => existing.name !== null || !sameTag(existing.value, attribute),
              ),
              { name: null, value: attribute },
            ],
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
      model.geometry = withAttributes(model.geometry, [entity.id], (attributes) =>
        attributes.filter((attribute) => !remove.has(attribute)),
      );
    }
    return undefined;
  },

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
    if (operation === "SUBTRACTION") {
      if (targets.length === 0) return regenError(call, "BOOLEAN_NEED_ONE_SOLID");
      algorithm = new oc.BRepAlgoAPI_Cut();
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
      algorithm = operation === "UNION" ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Common();
      algorithm.SetArguments(toList(oc, [all[0]!.shape]));
      algorithm.SetTools(
        toList(
          oc,
          all.slice(1).map((body) => body.shape),
        ),
      );
      consumed = all;
      keepIds = all.map((body) => body.id);
      keepIdBy = "earliest";
    } else return call.unsupported(`Boolean ${operation} is not supported locally yet.`);

    algorithm.Build(new oc.Message_ProgressRange());
    if (algorithm.HasErrors()) return regenError(call, "BOOLEAN_INVALID");
    model.geometry = replaceBodies(oc, model.geometry, {
      consumed: consumed.map((body) => body.id),
      keepIds,
      keepIdBy,
      results: subShapes(oc, algorithm.Shape(), "SOLID").map((shape) => ({
        shape,
        bodyType: "SOLID" as const,
      })),
      history: historyOf(oc, algorithm),
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
