import { FsMap, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { ordered, startsWith, type Entity, type EntityType, type GeometryState } from "./Model.ts";
import { ShapeSet, subShapes, type Oc, type Shape } from "./occt.ts";

/** What `evaluateQuery` needs besides the query: the kernel, the geometry, and how to fail. */
export interface QueryEnv {
  readonly oc: Oc;
  readonly state: GeometryState;
  /** A catchable error, e.g. a malformed query. */
  readonly fail: (message: string) => never;
  /** A query type this runtime doesn't evaluate yet; stops the run. */
  readonly unsupported: (message: string) => never;
}

/** Field of a query map, untagged. */
const field = (query: FsMap, name: string) => untag(query.getField(name));
const text = (value: FsValue) => {
  const v = untag(value);
  return typeof v === "string" ? v : null;
};
const idOf = (value: FsValue): readonly string[] =>
  (untag(value) as FsArray).map((part) => String(untag(part)));
const unique = (entities: readonly Entity[]) => [
  ...new Map(entities.map((entity) => [entity.id, entity])).values(),
];
const byOrder = (entities: readonly Entity[]) => unique(entities).sort((a, b) => a.order - b.order);

/** Face or edge geometry class, as std's `GeometryType` names it. */
export function geometryType(oc: Oc, entity: Entity): string | null {
  if (entity.type === "FACE") {
    const kind = String(
      new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true).GetType(),
    ).replace("GeomAbs_", "");
    const map: Record<string, string> = {
      Plane: "PLANE",
      Cylinder: "CYLINDER",
      Cone: "CONE",
      Sphere: "SPHERE",
      Torus: "TORUS",
      SurfaceOfRevolution: "REVOLVED",
      SurfaceOfExtrusion: "EXTRUDED",
    };
    return map[kind] ?? "OTHER_SURFACE";
  }
  if (entity.type === "EDGE") {
    const kind = String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape)).GetType()).replace(
      "GeomAbs_",
      "",
    );
    if (kind === "Line") return "LINE";
    if (kind === "Circle") return oc.BRep_Tool.IsClosed(entity.shape) ? "CIRCLE" : "ARC";
    return "OTHER_CURVE";
  }
  return null;
}

/** Distance between two shapes. */
export function distance(oc: Oc, a: Shape, b: Shape): number {
  // The constructor overloads take an enum this build doesn't bind; load and perform instead.
  const extrema = new oc.BRepExtrema_DistShapeShape();
  extrema.LoadS1(a);
  extrema.LoadS2(b);
  extrema.Perform(new oc.Message_ProgressRange());
  return extrema.IsDone() ? extrema.Value() : Number.POSITIVE_INFINITY;
}

const CONTAINS_TOLERANCE = 1e-7;
/** std's `TOLERANCE.zeroLength` (math.fs), in meters: how close counts as a tie for qClosestTo. */
const ZERO_LENGTH = 1e-8;

/** Entities a std query (a map tagged `Query`) resolves to, in creation order. */
export function evaluateQuery(env: QueryEnv, query: FsValue): Entity[] {
  const map = untag(query);
  if (!(map instanceof FsMap)) return env.fail("Expected a Query.");
  const type = text(map.getField("queryType"));
  const all = (filter: (entity: Entity) => boolean) => ordered(env.state, filter);
  const sub = (name = "subquery") => evaluateQuery(env, map.getField(name));
  const entityType = text(map.getField("entityType")) as EntityType | null;
  const ofType = (entities: readonly Entity[]) =>
    entityType ? entities.filter((entity) => entity.type === entityType) : [...entities];

  switch (type) {
    case "NOTHING":
      return [];
    case "EVERYTHING":
      return all((entity) => entityType === null || entity.type === entityType);
    case "TRANSIENT": {
      const entity = env.state.entities.get(String(field(map, "transientId")));
      return entity ? [entity] : [];
    }
    case "CREATED_BY": {
      const id = idOf(map.getField("featureId"));
      return all(
        (entity) =>
          startsWith(entity.createdBy, id) && (entityType === null || entity.type === entityType),
      );
    }
    case "SKETCH_REGION": {
      const id = idOf(map.getField("featureId"));
      return all(
        (entity) =>
          entity.type === "FACE" &&
          entity.sketch !== null &&
          entity.sketch.entityId === null &&
          startsWith(entity.sketch.sketchId, id) &&
          entity.sketch.sketchId.length === id.length,
      );
    }
    case "IMPRINT": {
      // makeQuery(sketchId + "imprint", "IMPRINT", FACE): the regions a sketch imprints.
      const id = idOf(map.getField("operationId"));
      const sketchId = id.at(-1) === "imprint" ? id.slice(0, -1) : id;
      return all(
        (entity) =>
          entity.type === "FACE" &&
          entity.sketch?.entityId === null &&
          entity.sketch.sketchId.length === sketchId.length &&
          startsWith(entity.sketch.sketchId, sketchId),
      );
    }
    case "ENTITY_FILTER":
      return ofType(sub());
    case "BODY_TYPE": {
      const wanted = new Set(
        (untag(map.getField("bodyType")) as FsArray).map((value) => text(value)),
      );
      return sub().filter((entity) => wanted.has(entity.bodyType));
    }
    case "OWNER_PART":
      return byOrder(sub("query").flatMap((entity) => env.state.entities.get(entity.body) ?? []));
    case "OWNED_BY_PART": {
      // Only bodies own entities; a face in `part` doesn't stand for its whole body (std's evArea relies on this).
      const bodies = new Set(
        evaluateQuery(env, map.getField("part"))
          .filter((entity) => entity.type === "BODY")
          .map((entity) => entity.id),
      );
      return all(
        (entity) => bodies.has(entity.body) && (entityType === null || entity.type === entityType),
      );
    }
    case "CONSTRUCTION_FILTER": {
      const want = text(map.getField("constructionFilter")) === "YES";
      return sub().filter((entity) => entity.construction === want);
    }
    case "SKETCH_OBJECT_FILTER": {
      const want = text(map.getField("sketchObjectFilter")) === "YES";
      return sub().filter((entity) => (entity.sketch !== null) === want);
    }
    // There's no sheet metal, composite parts, meshes, or in-context geometry locally.
    case "SM_FLAT_FILTER":
      return text(map.getField("flatFilter")) === "YES" ? [] : sub();
    case "ACTIVE_SM_FILTER":
      return text(map.getField("activeSheetMetal")) === "YES" ? [] : sub();
    case "SM_DEFINITION_ENTITY_FILTER":
      return [];
    case "MODIFIABLE_ENTITY_FILTER":
      return sub();
    case "MESH_GEOMETRY_FILTER":
      return text(map.getField("meshGeometryFilter")) === "YES" ? [] : sub();
    case "CONTAINED_IN_COMPOSITE":
      return [];
    case "UNION":
      return byOrder(
        (untag(map.getField("subqueries")) as FsArray).flatMap((q) => evaluateQuery(env, q)),
      );
    case "INTERSECTION": {
      const [first, ...rest] = (untag(map.getField("subqueries")) as FsArray).map(
        (q) => new Set(evaluateQuery(env, q).map((entity) => entity.id)),
      );
      return first
        ? all((entity) => first.has(entity.id) && rest.every((set) => set.has(entity.id)))
        : [];
    }
    case "SUBTRACTION": {
      const remove = new Set(evaluateQuery(env, map.getField("query2")).map((entity) => entity.id));
      return evaluateQuery(env, map.getField("query1")).filter((entity) => !remove.has(entity.id));
    }
    case "NTH_ELEMENT": {
      const results = sub();
      const n = Number(field(map, "n"));
      const entity = results.at(n < 0 ? results.length + n : n);
      return entity && (n >= 0 ? n < results.length : -n <= results.length) ? [entity] : [];
    }
    case "GEOMETRY": {
      const want = text(map.getField("geometryType"));
      return sub().filter((entity) => geometryType(env.oc, entity) === want);
    }
    case "CAP_ENTITY": {
      const id = idOf(map.getField("featureId"));
      const capType = text(map.getField("capType"));
      const caps = all(
        (entity) =>
          entity.type === "FACE" &&
          entity.cap !== null &&
          startsWith(entity.createdBy, id) &&
          (capType === "EITHER" || entity.cap === capType),
      );
      if (entityType === null || entityType === "FACE") return caps;
      const members = new Set<string>();
      const capShapes = caps.map((cap) => cap.shape);
      return all((entity) => {
        if (entity.type !== entityType || members.has(entity.id)) return false;
        return capShapes.some(
          (cap) =>
            distance(env.oc, cap, entity.shape) < CONTAINS_TOLERANCE &&
            contains(env.oc, cap, entity.shape),
        );
      });
    }
    case "EDGE_ADJACENT":
    case "VERTEX_ADJACENT": {
      // Entities sharing an edge (or a vertex) with any seed, other than the seeds themselves.
      const kind = type === "EDGE_ADJACENT" ? "EDGE" : "VERTEX";
      const seeds = evaluateQuery(env, map.getField("query"));
      const shared = new ShapeSet<true>(env.oc);
      for (const seed of seeds)
        for (const part of seed.type === kind ? [seed.shape] : subShapes(env.oc, seed.shape, kind))
          shared.set(part, true);
      const seedIds = new Set(seeds.map((seed) => seed.id));
      const bodies = new Set(seeds.map((seed) => seed.body));
      return all(
        (entity) =>
          entity.type !== "BODY" &&
          bodies.has(entity.body) &&
          !seedIds.has(entity.id) &&
          (entityType === null || entity.type === entityType) &&
          (entity.type === kind ? [entity.shape] : subShapes(env.oc, entity.shape, kind)).some(
            (part) => shared.has(part),
          ),
      );
    }
    case "SKETCH_ENTITY": {
      // makeQuery(sketchId, "SKETCH_ENTITY", type, { sketchEntityId }): one named sketch entity.
      const sketchId = idOf(map.getField("operationId"));
      const entityId = text(map.getField("sketchEntityId"));
      return all(
        (entity) =>
          entity.sketch?.entityId === entityId &&
          entity.sketch.sketchId.length === sketchId.length &&
          startsWith(entity.sketch.sketchId, sketchId) &&
          (entityType === null || entity.type === entityType),
      );
    }
    case "PARALLEL_EDGES": {
      const direction = unitVector(map.getField("direction"));
      return evaluateQuery(env, map.getField("queryToFilter")).filter((entity) => {
        if (entity.type !== "EDGE" || geometryType(env.oc, entity) !== "LINE") return false;
        const curve = new env.oc.BRepAdaptor_Curve(env.oc.TopoDS.Edge(entity.shape));
        const tangent = curve.EvalD1(curve.FirstParameter()).D1;
        const t = Math.hypot(tangent.X(), tangent.Y(), tangent.Z());
        return (
          Math.abs(
            Math.abs(
              (tangent.X() * direction[0] +
                tangent.Y() * direction[1] +
                tangent.Z() * direction[2]) /
                t,
            ) - 1,
          ) < 1e-9
        );
      });
    }
    case "COINCIDES_WITH_PLANE": {
      const plane = untag(map.getField("plane"));
      if (!(plane instanceof FsMap)) return env.fail("COINCIDES_WITH_PLANE needs a plane.");
      const origin = unitVector(plane.getField("origin"), false);
      const normal = unitVector(plane.getField("normal"));
      const off = (x: number, y: number, z: number) =>
        Math.abs(
          (x - origin[0]) * normal[0] + (y - origin[1]) * normal[1] + (z - origin[2]) * normal[2],
        );
      return sub().filter((entity) =>
        samplePoints(env.oc, entity).every(([x, y, z]) => off(x, y, z) < CONTAINS_TOLERANCE),
      );
    }
    case "CONTAINS_POINT": {
      const [x, y, z] = (untag(map.getField("point")) as FsArray).map((c) => Number(untag(c)));
      const vertex = new env.oc.BRepBuilderAPI_MakeVertex(new env.oc.gp_Pnt(x!, y!, z!)).Vertex();
      return sub().filter((entity) => distance(env.oc, vertex, entity.shape) < CONTAINS_TOLERANCE);
    }
    case "CLOSEST_TO": {
      // The nearest entities, and any within TOLERANCE.zeroLength of them, as std documents.
      const [x, y, z] = (untag(map.getField("point")) as FsArray).map((c) => Number(untag(c)));
      const vertex = new env.oc.BRepBuilderAPI_MakeVertex(new env.oc.gp_Pnt(x!, y!, z!)).Vertex();
      const measured = sub().map((entity) => ({
        entity,
        distance: distance(env.oc, vertex, entity.shape),
      }));
      const nearest = Math.min(...measured.map((candidate) => candidate.distance));
      return measured
        .filter((candidate) => candidate.distance - nearest <= ZERO_LENGTH)
        .map((candidate) => candidate.entity);
    }
    default:
      return env.unsupported(`Query type ${type ?? "(missing)"} is not supported locally yet.`);
  }
}

/** A numeric 3-vector from a query field; normalized unless `normalize` is false. */
function unitVector(value: FsValue, normalize = true): [number, number, number] {
  const [x, y, z] = (untag(value) as FsArray).map((c) => Number(untag(c)));
  const length = normalize ? Math.hypot(x!, y!, z!) || 1 : 1;
  return [x! / length, y! / length, z! / length];
}

/** Points spread over an entity (vertex, edge, or face), for "lies in" tests. */
function samplePoints(oc: Oc, entity: Entity): [number, number, number][] {
  const p = (point: InstanceType<Oc["gp_Pnt"]>): [number, number, number] => [
    point.X(),
    point.Y(),
    point.Z(),
  ];
  if (entity.type === "VERTEX") return [p(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(entity.shape)))];
  if (entity.type === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
    const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
    return [0, 0.25, 0.5, 0.75, 1].map((t) => p(curve.EvalD0(a + t * (b - a))));
  }
  if (entity.type === "FACE") {
    const face = oc.TopoDS.Face(entity.shape);
    const bounds = oc.BRepTools.UVBounds(face);
    const surface = new oc.BRepAdaptor_Surface(face, true);
    return [0.1, 0.5, 0.9].flatMap((s) =>
      [0.1, 0.5, 0.9].map((t) =>
        p(
          surface.EvalD0(
            bounds.UMin + s * (bounds.UMax - bounds.UMin),
            bounds.VMin + t * (bounds.VMax - bounds.VMin),
          ),
        ),
      ),
    );
  }
  return [];
}

/** True when `part` is one of `whole`'s sub-shapes (an edge or vertex of a face). */
function contains(oc: Oc, whole: Shape, part: Shape): boolean {
  const kind = String(part.ShapeType()).replace("TopAbs_", "");
  for (
    const explorer = new oc.TopExp_Explorer(
      whole,
      oc.TopAbs_ShapeEnum[`TopAbs_${kind}` as "TopAbs_EDGE"],
    );
    explorer.More();
    explorer.Next()
  )
    if (explorer.Current().IsSame(part)) return true;
  return false;
}
