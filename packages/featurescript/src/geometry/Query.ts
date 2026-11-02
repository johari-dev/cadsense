import { coneOf, edgeConvexity, edgeJoint, isReversed, properties } from "../builtins/edges.ts";
import { creatorOf, hasRun, lineageOf, type Lineage } from "../runtime/ModelContext.ts";
import { equals, FsMap, FsTagged, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import {
  ordered,
  topology,
  topologyNamesOf,
  type Entity,
  type EntityType,
  type GeometryState,
} from "./Model.ts";
import { ShapeSet, subShapes, toList, xyz, type Oc, type Shape } from "./occt.ts";

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

/**
 * Onshape compares ids as their components joined by dots, so std spells one operation both
 * `sketchId + "wireOp"` and `id + "sketch.wireOp"`.
 */
const joined = (id: readonly string[]) => id.join(".");
/** True when `id` is `prefix` or continues it with more (dot-separated) components. */
const continues = (id: string, prefix: string) =>
  prefix === "" || id === prefix || id.startsWith(`${prefix}.`);

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

/**
 * The entities in `state` that continue entity `id` (of `type`): itself while it lasts, else the
 * entities of its type that came from it since (split pieces, merged entities), through the
 * lineage; edges a split cut across a face came from it too, but don't continue it.
 */
function continuations(state: GeometryState, id: string, type: EntityType): Entity[] {
  const kept = state.entities.get(id);
  if (kept) return [kept];
  const from = (entity: Entity) => {
    if (entity.type !== type) return false;
    const seen = new Set<string>();
    const queue = [...(state.lineage.get(entity.id) ?? [])];
    while (queue.length) {
      const next = queue.pop()!;
      if (next === id) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(state.lineage.get(next) ?? []));
    }
    return false;
  };
  return ordered(state, from);
}

/**
 * Entities a std query (a map tagged `Query`) resolves to. std leaves the order open except for
 * `qUnion`, which keeps its subqueries' order; everything else comes in creation order.
 */
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
    case "EVERYTHING": {
      // std's qBodyType folds body types into an EVERYTHING query rather than wrapping it.
      const bodyTypes = map.getField("bodyType");
      const wanted =
        bodyTypes === undefined
          ? null
          : new Set((untag(bodyTypes) as FsArray).map((value) => text(value)));
      return all(
        (entity) =>
          (entityType === null || entity.type === entityType) &&
          (wanted === null || wanted.has(entity.bodyType)),
      );
    }
    case "TRANSIENT": {
      const entity = env.state.entities.get(String(field(map, "transientId")));
      return entity ? [entity] : [];
    }
    case "CREATED_BY": {
      const id = joined(idOf(map.getField("featureId")));
      // Split pieces and merged entities have several creators (Entity.alsoCreatedBy).
      return all(
        (entity) =>
          [entity.createdBy, ...(entity.alsoCreatedBy ?? [])].some((creator) =>
            continues(joined(creator), id),
          ) &&
          (entityType === null || entity.type === entityType),
      );
    }
    case "SKETCH_REGION": {
      const id = joined(idOf(map.getField("featureId")));
      const regions = all(
        (entity) =>
          entity.type === "FACE" &&
          entity.sketch !== null &&
          entity.sketch.entityId === null &&
          joined(entity.sketch.sketchId) === id,
      );
      return untag(map.getField("filterInnerLoops")) === true
        ? outerRegions(env.oc, regions)
        : regions;
    }
    case "SWEPT_FACE": {
      // makeQuery(extrudeId, "SWEPT_FACE", FACE): the side faces an extrude swept, every face it
      // made but its caps (std's drafted extrude drafts these).
      const id = joined(idOf(map.getField("operationId")));
      return all(
        (entity) =>
          entity.type === "FACE" &&
          entity.cap === null &&
          entity.sketch === null &&
          continues(joined(entity.createdBy), id),
      );
    }
    case "IMPRINT": {
      // makeQuery(sketchId + "imprint", "IMPRINT", FACE): the regions a sketch imprints.
      const id = joined(idOf(map.getField("operationId")));
      const sketchId = id.endsWith(".imprint") ? id.slice(0, -".imprint".length) : id;
      return all(
        (entity) =>
          entity.type === "FACE" &&
          entity.sketch?.entityId === null &&
          joined(entity.sketch.sketchId) === sketchId,
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
      const owned = (entity: Entity) =>
        bodies.has(entity.body) && (entityType === null || entity.type === entityType);
      // qOwnedByBody(query, body) keeps the query's entities that the body owns.
      return map.getField("subquery") === undefined ? all(owned) : sub().filter(owned);
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
    // Bend lines attached to a flattened sheet metal part.
    case "PARTS_ATTACHED_TO":
      return [];
    case "MODIFIABLE_ENTITY_FILTER":
      return sub();
    case "MESH_GEOMETRY_FILTER":
      return text(map.getField("meshGeometryFilter")) === "YES" ? [] : sub();
    case "CONTAINED_IN_COMPOSITE":
      return [];
    case "UNION":
      // std: qUnion "is guaranteed to preserve order"; an entity keeps its first place.
      return unique(
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
      const id = joined(idOf(map.getField("featureId")));
      const capType = text(map.getField("capType"));
      const caps = all(
        (entity) =>
          entity.type === "FACE" &&
          entity.cap !== null &&
          continues(joined(entity.createdBy), id) &&
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
      // makeQuery(operationId, "SKETCH_ENTITY", type, { sketchEntityId }): one named sketch entity,
      // by the sketch's id or by the operation that made it (std's `sketchId + "wireOp"`). Where
      // a sketch's wire body is created by the sketch id itself, its wire operation still names it.
      const operation = joined(idOf(map.getField("operationId")));
      const entityId = text(map.getField("sketchEntityId"));
      return all((entity) => {
        if (entity.sketch?.entityId !== entityId) return false;
        if (entityType !== null && entity.type !== entityType) return false;
        const sketchId = joined(entity.sketch.sketchId);
        return (
          sketchId === operation ||
          continues(joined(entity.createdBy), operation) ||
          (operation === `${sketchId}.wireOp` &&
            (entity.bodyType === "WIRE" || entity.bodyType === "POINT"))
        );
      });
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
      const flat = {
        origin: unitVector(plane.getField("origin"), false),
        normal: unitVector(plane.getField("normal")),
      };
      return sub().filter((entity) => inPlane(env, entity, flat));
    }
    case "CONTAINS_POINT": {
      // A solid body contains the points inside it as well as on it, as Onshape's FeatureScript
      // lead describes qContainsPoint on the forum: OpenCascade's distance from a point inside a
      // solid to the solid is 0 (its "inner solution"). Faces, edges and vertices contain only
      // points on them.
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
    case "TRACKING":
      return tracked(env, map);
    case "EDGE_TOPOLOGY_FILTER": {
      // std's EdgeTopology: WIRE joins no faces, ONE_SIDED one, TWO_SIDED two. LAMINAR is
      // internal; it's Parasolid's name for an edge with one face.
      const wanted = text(map.getField("edgeTopologyType"));
      return sub().filter((entity) => {
        if (entity.type !== "EDGE") return false;
        const faces = facesJoined(env, entity);
        const topology = faces === 0 ? "WIRE" : faces === 1 ? "ONE_SIDED" : "TWO_SIDED";
        return topology === wanted || (wanted === "LAMINAR" && topology === "ONE_SIDED");
      });
    }
    case "ATTRIBUTE_FILTER": {
      // Named attributes by name (and an exact value or a map pattern); without a name, std's
      // legacy unnamed attributes by type tag (or standard type) and pattern.
      const name = text(map.getField("name"));
      const exact = map.has("valueToMatchExactly")
        ? map.getField("valueToMatchExactly")
        : undefined;
      const pattern = map.getField("attributePattern");
      const candidates = map.getField("subquery") === undefined ? all(() => true) : sub();
      return candidates.filter((entity) =>
        entity.attributes.some((attribute) =>
          name !== null
            ? attribute.name === name &&
              (!map.has("valueToMatchExactly") || equals(attribute.value, exact)) &&
              (pattern === undefined || matchesPattern(attribute.value, pattern))
            : attribute.name === null &&
              pattern !== undefined &&
              sameKind(attribute.value, pattern) &&
              matchesPattern(attribute.value, pattern),
        ),
      );
    }
    case "LARGEST":
    case "SMALLEST": {
      // Only the highest dimension counts; ties within a relative 1e-9 all come back.
      const candidates = sub();
      if (candidates.length === 0) return [];
      const top = Math.max(...candidates.map(dimension));
      const sized = candidates
        .filter((entity) => dimension(entity) === top)
        .map((entity) => ({ entity, size: measure(env.oc, entity.shape, top, env.unsupported) }));
      const sizes = sized.map((candidate) => candidate.size);
      const best = type === "LARGEST" ? Math.max(...sizes) : Math.min(...sizes);
      const slack = 1e-9 * Math.max(...sizes.map(Math.abs));
      return sized
        .filter((candidate) => Math.abs(candidate.size - best) <= slack)
        .map((candidate) => candidate.entity);
    }
    case "FARTHEST_ALONG": {
      // Each entity's farthest point along the direction; ties within TOLERANCE.zeroLength.
      const direction = unitVector(map.getField("direction"));
      const reached = sub().map((entity) => ({
        entity,
        reach: reach(env.oc, entity.shape, direction, env.unsupported),
      }));
      const farthest = Math.max(...reached.map((candidate) => candidate.reach));
      return reached
        .filter((candidate) => farthest - candidate.reach <= ZERO_LENGTH)
        .map((candidate) => candidate.entity);
    }
    case "UNIQUE_VERTICES": {
      // Of coincident vertices, the earliest made stays (std: "the lowest deterministic ID").
      const kept: { entity: Entity; at: readonly number[] }[] = [];
      for (const entity of byOrder(sub())) {
        if (entity.type !== "VERTEX") {
          kept.push({ entity, at: [] });
          continue;
        }
        const at = xyz(env.oc.BRep_Tool.Pnt(env.oc.TopoDS.Vertex(entity.shape)));
        if (
          !kept.some(
            (other) =>
              other.at.length === 3 &&
              Math.hypot(other.at[0]! - at[0], other.at[1]! - at[1], other.at[2]! - at[2]) <=
                ZERO_LENGTH,
          )
        )
          kept.push({ entity, at });
      }
      return kept.map((candidate) => candidate.entity);
    }
    case "COINCIDENT": {
      // Entities that are exactly a target of the same type (see `coincide`).
      const targets = evaluateQuery(env, map.getField("target"));
      return sub().filter((entity) => {
        if (entity.type === "BODY")
          return env.unsupported("qCoincidentFilter on bodies is not supported locally yet.");
        return targets.some(
          (target) => target.type === entity.type && coincide(env, entity, target),
        );
      });
    }
    case "PLANE_NORMAL": {
      // Planar faces whose outward normal runs along `normal` (or against it, when allowed).
      const normal = unitVector(map.getField("normal"));
      const both = untag(map.getField("allowAntiparallel")) === true;
      return sub().filter((entity) => {
        const n = planeNormal(env.oc, entity);
        if (!n) return false;
        const along = dotOf(n, normal);
        return along >= 1 - PARALLEL || (both && along <= -1 + PARALLEL);
      });
    }
    case "PLANE_PARALLEL_DIRECTION": {
      const direction = unitVector(map.getField("direction"));
      return sub().filter((entity) => {
        const n = planeNormal(env.oc, entity);
        return n !== null && Math.abs(dotOf(n, direction)) <= PARALLEL;
      });
    }
    case "FACE_PARALLEL_DIRECTION": {
      // Planes square to the direction, cylinders and extrusions along it.
      const direction = unitVector(map.getField("direction"));
      return sub().filter((entity) => {
        if (entity.type !== "FACE") return false;
        const n = planeNormal(env.oc, entity);
        if (n) return Math.abs(dotOf(n, direction)) <= PARALLEL;
        const surface = new env.oc.BRepAdaptor_Surface(env.oc.TopoDS.Face(entity.shape), true);
        const kind = String(surface.GetType());
        const along =
          kind === "GeomAbs_Cylinder"
            ? xyz(surface.Cylinder().Axis().Direction())
            : kind === "GeomAbs_SurfaceOfExtrusion"
              ? xyz(surface.Direction())
              : null;
        return along !== null && Math.abs(dotOf(along, direction)) >= 1 - PARALLEL;
      });
    }
    case "AXIS": {
      // Axis-symmetric entities whose axis is the given line, either way along it.
      const line = untag(map.getField("axis"));
      if (!(line instanceof FsMap)) return env.fail("qAxis needs a line.");
      const origin = unitVector(line.getField("origin"), false);
      const direction = unitVector(line.getField("direction"));
      return sub().filter((entity) => {
        const axis = axisOf(env, entity);
        if (!axis) return false;
        const offset = [0, 1, 2].map((i) => axis.origin[i]! - origin[i]!) as [
          number,
          number,
          number,
        ];
        const along = dotOf(offset, direction);
        const off = Math.hypot(...offset.map((c, i) => c - along * direction[i]!));
        return (
          Math.abs(dotOf(axis.direction, direction)) >= 1 - PARALLEL && off < CONTAINS_TOLERANCE
        );
      });
    }
    case "IN_FRONT_OF_PLANE":
    case "INTERSECTS_PLANE": {
      // Proven extremes of each entity along the plane's normal (`reach`) decide its side.
      const plane = untag(map.getField("plane"));
      if (!(plane instanceof FsMap)) return env.fail(`${type} needs a plane.`);
      const normal = unitVector(plane.getField("normal"));
      const level = dotOf(unitVector(plane.getField("origin"), false), normal);
      const back = [-normal[0], -normal[1], -normal[2]] as const;
      return sub().filter((entity) => {
        const lowest = -reach(env.oc, entity.shape, back, env.unsupported);
        if (type === "IN_FRONT_OF_PLANE") return lowest >= level - CONTAINS_TOLERANCE;
        const highest = reach(env.oc, entity.shape, normal, env.unsupported);
        return lowest <= level + CONTAINS_TOLERANCE && highest >= level - CONTAINS_TOLERANCE;
      });
    }
    case "INTERSECTS_LINE": {
      // A segment of the infinite line long enough to pass each entity.
      const line = untag(map.getField("line"));
      if (!(line instanceof FsMap)) return env.fail("qIntersectsLine needs a line.");
      const origin = unitVector(line.getField("origin"), false);
      const direction = unitVector(line.getField("direction"));
      return sub().filter((entity) => {
        const box = new env.oc.Bnd_Box();
        env.oc.BRepBndLib.Add(entity.shape, box, false);
        const center = [
          (box.GetXMin() + box.GetXMax()) / 2,
          (box.GetYMin() + box.GetYMax()) / 2,
          (box.GetZMin() + box.GetZMax()) / 2,
        ];
        const t = dotOf(
          center.map((c, i) => c - origin[i]!) as [number, number, number],
          direction,
        );
        const reachOut = Math.sqrt(box.SquareExtent()) + 1;
        const end = (k: number) =>
          new env.oc.gp_Pnt(
            ...([0, 1, 2].map((i) => origin[i]! + (t + k) * direction[i]!) as [
              number,
              number,
              number,
            ]),
          );
        const segment = new env.oc.BRepBuilderAPI_MakeEdge(end(-reachOut), end(reachOut)).Edge();
        return distance(env.oc, segment, entity.shape) < CONTAINS_TOLERANCE;
      });
    }
    case "INTERSECTS_BALL": {
      // Anything reaching within `radius` of the point; a solid also counts from inside.
      const [x, y, z] = (untag(map.getField("point")) as FsArray).map((c) => Number(untag(c)));
      const radius = Number(untag(map.getField("radius")));
      const center = new env.oc.BRepBuilderAPI_MakeVertex(new env.oc.gp_Pnt(x!, y!, z!)).Vertex();
      return sub().filter(
        (entity) => distance(env.oc, center, entity.shape) <= radius + ZERO_LENGTH,
      );
    }
    case "EDGE_CONVEXITY_FILTER": {
      const wanted = text(map.getField("convexityType"));
      return sub().filter((entity) => {
        if (entity.type !== "EDGE") return false;
        const body = env.state.entities.get(entity.body);
        return (
          body !== undefined &&
          edgeConvexity(env.oc, body, entity.shape, env.unsupported) === wanted
        );
      });
    }
    case "EDGE_VERTEX": {
      // The vertex where each edge starts (or ends) as evEdgeTangentLine walks it.
      const atStart = untag(map.getField("atStart")) === true;
      return byOrder(
        evaluateQuery(env, map.getField("query")).flatMap((edge) => {
          if (edge.type !== "EDGE") return [];
          const curve = new env.oc.BRepAdaptor_Curve(env.oc.TopoDS.Edge(edge.shape));
          const first = atStart !== isReversed(edge.shape);
          const end = xyz(curve.EvalD0(first ? curve.FirstParameter() : curve.LastParameter()));
          return all(
            (vertex) =>
              vertex.type === "VERTEX" &&
              vertex.body === edge.body &&
              subShapes(env.oc, edge.shape, "VERTEX").some((v) => v.IsSame(vertex.shape)) &&
              distance(env.oc, vertex.shape, pointShape(env.oc, end)) < CONTAINS_TOLERANCE,
          );
        }),
      );
    }
    case "LOOP_EDGES":
      return loopEdges(env, sub());
    case "TANGENT_CONNECTED_FACES":
    case "CONVEX_CONNECTED_FACES":
    case "CONCAVE_CONNECTED_FACES": {
      const tolerance = map.getField("angleTolerance");
      const property =
        type === "TANGENT_CONNECTED_FACES"
          ? "tangent"
          : type === "CONVEX_CONNECTED_FACES"
            ? "convex"
            : "concave";
      const joints = new Map<string, boolean>();
      return flood(
        env,
        sub().filter((entity) => entity.type === "FACE"),
        (edge) => {
          let crosses = joints.get(edge.id);
          if (crosses === undefined) {
            const body = env.state.entities.get(edge.body)!;
            crosses = edgeJoint(
              env.oc,
              body,
              edge.shape,
              ...(tolerance === undefined ? [] : [Number(untag(tolerance))]),
            )[property];
            joints.set(edge.id, crosses);
          }
          return crosses;
        },
      );
    }
    case "LOOP_BOUNDED_FACES": {
      // From across `edge`, every face reachable without crossing into `face`.
      const seeds = sub();
      const face = seeds.find((entity) => entity.type === "FACE");
      const edge = seeds.find((entity) => entity.type === "EDGE");
      if (!face || !edge) return env.fail("qLoopBoundedFaces needs a face and an edge.");
      const across = facesOfEdge(env, edge).filter((other) => other.id !== face.id);
      if (across.length === facesOfEdge(env, edge).length)
        return env.fail("qLoopBoundedFaces needs an edge of the face.");
      return flood(env, across, () => true, new Set([face.id]));
    }
    case "FACE_OR_EDGE_BOUNDED_FACES": {
      // From the first (seed) face, every face reachable without crossing a bounding edge or
      // entering a bounding face.
      const [seed, ...bounds] = sub();
      if (seed?.type !== "FACE")
        return env.fail("qFaceOrEdgeBoundedFaces needs a seed face first.");
      const fences = new Set(
        bounds.filter((entity) => entity.type === "EDGE").map((edge) => edge.id),
      );
      const walls = new Set(
        bounds.filter((entity) => entity.type === "FACE").map((face) => face.id),
      );
      return flood(env, [seed], (edge) => !fences.has(edge.id), walls);
    }
    case "FILLET_FACES": {
      // Every fillet face of each seed fillet's body whose radius compares to the seed's.
      const compare = text(map.getField("compareType"));
      const matches = sub().flatMap((seed) => {
        const radius = seed.type === "FACE" ? filletRadius(env, seed) : null;
        if (radius === null) return [];
        return all((face) => {
          if (face.type !== "FACE" || face.body !== seed.body) return false;
          const other = filletRadius(env, face);
          if (other === null) return false;
          if (compare === "LESS_EQUAL") return other <= radius + ZERO_LENGTH;
          if (compare === "GREATER_EQUAL") return other >= radius - ZERO_LENGTH;
          return Math.abs(other - radius) <= ZERO_LENGTH;
        });
      });
      return byOrder(matches);
    }
    case "PATTERN_INSTANCES": {
      // opPattern creates each instance's entities by its id plus the instance name.
      const id = idOf(map.getField("featureId"));
      const names = (untag(map.getField("instanceNames")) as FsArray).map((name) =>
        String(untag(name)),
      );
      return all(
        (entity) =>
          (entityType === null || entity.type === entityType) &&
          names.some((name) => continues(joined(entity.createdBy), joined([...id, name]))),
      );
    }
    // Closed composite parts don't exist locally, so they consume nothing.
    case "CONSUMED":
      return text(map.getField("consumed")) === "YES" ? [] : sub();
    case "DEPENDENCY": {
      // An extruded body depends on its profile (std's drafted extrude reads it for the profile's
      // plane): what opExtrude's recorded profile query found when it ran. Other operations'
      // dependencies aren't known locally.
      const found = new Map<string, Entity>();
      for (const entity of sub()) {
        const creator = entity.type === "BODY" ? creatorOf(env.state, entity.createdBy) : undefined;
        const definition = untag(creator?.definition);
        if (creator?.builtin !== "opExtrude" || !(definition instanceof FsMap))
          return env.unsupported(
            "qDependency is only known locally for bodies opExtrude made: other operations don't record what they were made from.",
          );
        // Resolved where the extrude ran, so later geometry its query would also match isn't.
        // What continues the profile now: itself, or the pieces a later split made of it (by
        // lineage); a profile deleted since is no dependency.
        for (const profile of evaluateQuery(
          { ...env, state: creator.before },
          definition.getField("entities"),
        ))
          for (const current of continuations(env.state, profile.id, profile.type))
            found.set(current.id, current);
      }
      return [...found.values()].filter(
        (entity) => entityType === null || entity.type === entityType,
      );
    }
    case "LAMINAR_DEPENDENCY":
      return env.unsupported(
        "qLaminarDependency needs to know which entities each operation was made from, which isn't recorded locally yet.",
      );
    case "PATTERN":
      return env.unsupported(
        "qMatching needs a congruence test between faces or edges, which isn't available locally yet.",
      );
    case "HISTORICAL":
      return env.unsupported(
        "Historical queries come from Onshape's saved selections and can't be evaluated locally.",
      );
    case "SM_APPLICATION_TYPE_FILTER":
    case "SM_FORM_FILTER":
    case "CORRESPONDING_IN_FLAT":
      return env.unsupported(
        `Query type ${type} is about sheet metal, which isn't supported locally.`,
      );
    case "COMPOSITE_CONTAINING":
    case "COMPOSITE_PART_TYPE_FITLER":
      return env.unsupported(
        `Query type ${type} is about composite parts, which aren't supported locally.`,
      );
    case "SOURCE_MESH":
      return env.unsupported("qSourceMesh is about mesh geometry, which isn't supported locally.");
    case "TOLERANCE_FILTER":
      return env.unsupported(
        "Tolerance filters need Onshape's tolerance data, which isn't available locally.",
      );
    case "MATE_CONNECTOR":
      return env.unsupported(
        "qMateConnectorsOfParts needs mate connectors' owner parts, which aren't recorded locally yet.",
      );
    case "HOLE_FACES":
      return env.unsupported(
        `Query type ${type} needs hole recognition, which isn't available locally yet.`,
      );
    case "OP_HOLE_FACE":
    case "OP_HOLE_PROFILE": {
      // The faces or profile entities opHole named, optionally by face name and identity entity.
      const id = joined(idOf(map.getField("featureId")));
      const kind = type === "OP_HOLE_FACE" ? "HOLE_FACE" : "HOLE_PROFILE";
      const name = untag(map.getField("name")) === undefined ? null : text(map.getField("name"));
      const identities =
        untag(map.getField("identity")) === undefined
          ? null
          : new Set(sub("identity").map((entity) => entity.id));
      return all(
        (entity) =>
          (entityType === null || entity.type === entityType) &&
          topologyNamesOf(env.oc, entity.shape).some(
            (named) =>
              named.kind === kind &&
              continues(joined(named.operation), id) &&
              (name === null || named.name === name) &&
              (identities === null || (named.identity !== null && identities.has(named.identity))),
          ),
      );
    }
    case "LOOP_AROUND_FACE":
    case "SHELL_CONTAINING_FACE":
    case "TANGENT_EDGES":
    case "TANGENT_FACES":
      return env.unsupported(
        `Query type ${type} isn't implemented by std itself ("Not yet implemented").`,
      );
    case "COEDGE":
      return env.unsupported(
        "qCoEdge can't be evaluated: std says it only names an oriented edge in generated code.",
      );
    case "TANGENT_CONNECTED_EDGES":
      return tangentChain(
        env,
        sub().filter((entity) => entity.type === "EDGE"),
      );
    default:
      return env.unsupported(`Query type ${type ?? "(missing)"} is not supported locally yet.`);
  }
}

/**
 * An identity tracking query (`makeRobustQuery`, the Query variable feature): the entities that
 * keep the identity of `subquery1`'s. Here an entity keeps its transient id exactly when an
 * operation leaves it unchanged or modifies it one to one, so that's the entity with the same id.
 * One whose id is gone was deleted, split or merged. Only deletion (a step that just removed
 * bodies) has a known answer, nothing; for the others Onshape would follow it to pieces this
 * runtime can't name, so the run stops. A face, edge or vertex that still has its id wasn't split
 * (every piece of a split gets a new id), but a split body keeps its id on one piece; so when the
 * query follows splits and merges, a body that went through a step adding or removing bodies
 * stops the run too. `startTracking`'s derived entities need operation history that isn't
 * recorded.
 */
function tracked(env: QueryEnv, query: FsMap): Entity[] {
  if (untag(query.getField("identityPreservingOnly")) !== true)
    return env.unsupported(
      "Tracking what later operations derive from an entity (startTracking) is not supported locally yet; only identity tracking (makeRobustQuery) is.",
    );
  const head = lineageOf(env.state);
  if (!head) return env.unsupported("Tracking queries need the context's geometry history.");
  const ids = (untag(query.getField("subquery1")) as FsArray).map((item) => {
    const transient = untag(item);
    if (!(transient instanceof FsMap) || text(transient.getField("queryType")) !== "TRANSIENT")
      return env.unsupported("Tracking queries locally only follow evaluated entities.");
    return String(field(transient, "transientId"));
  });
  const followsSplits = untag(query.getField("followSplitMerge")) === true;
  return byOrder(
    ids.flatMap((id) => {
      const entity = env.state.entities.get(id);
      if (entity) {
        if (
          followsSplits &&
          entity.type === "BODY" &&
          maySplitOrMerge(head, id, query.getField("lastOperationId"))
        )
          return env.unsupported(
            `Tracking body ${id}: a later operation may have split, merged or consumed it, and following it is not supported locally yet.`,
          );
        return [entity];
      }
      // The step that removed it: newest first, `after` is the state just after `before`.
      for (
        let after = head, before = head.previous;
        before;
        after = before, before = before.previous
      ) {
        if (!before.state.entities.has(id)) continue;
        const onlyRemoved = [...after.state.entities].every(
          ([key, kept]) => before.state.entities.get(key) === kept,
        );
        if (onlyRemoved) return [];
        return env.unsupported(
          `Tracking entity ${id}: a later operation split, merged or consumed it, and following it is not supported locally yet.`,
        );
      }
      // Never in this context's history, e.g. made by a feature that was rolled back.
      return [];
    }),
  );
}

/**
 * Whether body `id` went through a step that replaced it while adding or removing other bodies
 * after operation `since` (the tracking query's start; its whole history if that operation isn't
 * known): a split leaves its id on one piece, and a union keeps one of the ids.
 */
function maySplitOrMerge(head: Lineage, id: string, since: FsValue): boolean {
  const bodies = (state: GeometryState) =>
    [...state.entities.values()]
      .filter((entity) => entity.type === "BODY")
      .map((entity) => entity.id)
      .sort()
      .join(",");
  const known = since !== undefined && hasRun(head.state, since);
  for (let after = head, before = head.previous; before; after = before, before = before.previous) {
    // Steps up to and including the start operation came before tracking began.
    if (known && !hasRun(before.state, since)) return false;
    const [was, is] = [before.state.entities.get(id), after.state.entities.get(id)];
    if (!was || !is) return false;
    if (was !== is && bodies(before.state) !== bodies(after.state)) return true;
  }
  return false;
}

/** `attributePattern` matching: every key in the pattern is present with an equal value. */
const matchesPattern = (value: FsValue, pattern: FsValue): boolean => {
  const p = untag(pattern);
  if (!(p instanceof FsMap)) return true;
  const v = untag(value);
  return v instanceof FsMap && p.entries().every(([key, expected]) => equals(v.get(key), expected));
};
/** Legacy unnamed attributes match by type tag, or by standard type when the pattern has none. */
const sameKind = (value: FsValue, pattern: FsValue) => {
  const tag = (v: FsValue) => (v instanceof FsTagged ? v.tag : null);
  if (tag(value) !== tag(pattern)) return false;
  const kind = (v: FsValue) => {
    const u = untag(v);
    return Array.isArray(u) ? "array" : u instanceof FsMap ? "map" : typeof u;
  };
  return kind(value) === kind(pattern);
};

/** 3 for solids, 2 for faces and sheets, 1 for edges and wires, 0 for vertices and points. */
const dimension = (entity: Entity): number =>
  entity.type === "BODY"
    ? { SOLID: 3, SHEET: 2, WIRE: 1, POINT: 0, MATE_CONNECTOR: 0 }[entity.bodyType]
    : { FACE: 2, EDGE: 1, VERTEX: 0 }[entity.type];
/** Volume, area or length for the dimension; points all measure 1. */
function measure(
  oc: Oc,
  shape: Shape,
  dimension: number,
  stop: (message: string) => never,
): number {
  if (dimension === 0) return 1;
  let known = sizes.get(shape);
  if (!known) sizes.set(shape, (known = new Map()));
  const size = known.get(dimension) ?? properties(oc, shape, dimension, stop).Mass();
  known.set(dimension, size);
  return size;
}
/**
 * Sizes already measured, by shape and dimension, so qCoincidentFilter measures each face once
 * rather than once per pair. Shapes are never changed in place: a changed face is a new shape.
 */
const sizes = new WeakMap<Shape, Map<number, number>>();

/** How close (meters) a proven extreme's bound and its found value must agree. */
const EXTREME_GAP = 1e-11;
/** Subdivisions a spline extreme may take before the run stops. */
const EXTREME_STEPS = 20_000;
/** The narrowest spline piece searched, as a fraction of the parameter range. */
const SMALLEST_PIECE = 1e-12;
/** How close a segment's ends may snap to knots, as a fraction of its width. */
const SEGMENT_TOLERANCE = 1e-3;

type Direction = readonly [number, number, number];
const along = (p: readonly number[], d: Direction) => p[0]! * d[0] + p[1]! * d[1] + p[2]! * d[2];

/** A parameter box, as [low, high] per parameter: [s, t] or [u1, u2, v1, v2]. */
type Box = readonly number[];

/** The two halves of a parameter box, split across parameter `k`. */
const halves = (box: Box, k: number): Box[] => {
  const [lo, hi] = [box[2 * k]!, box[2 * k + 1]!];
  return [
    [lo, (lo + hi) / 2],
    [(lo + hi) / 2, hi],
  ].map(([from, to]) => box.map((end, i) => (i === 2 * k ? from! : i === 2 * k + 1 ? to! : end)));
};
/** How many pieces a loose bound may split into to get a finite bound on each. */
const LOOSE_PIECES = 64;

/**
 * The largest value of a function over a parameter box, by best-first branch and bound. `bound`
 * gives a piece's upper bound and which parameter to halve, `value` samples its middle. The piece
 * with the highest bound is split until no bound beats the best sample by `EXTREME_GAP`. Returns
 * the best sample and its piece, or null when nothing beats `floor`; `stop` when it doesn't settle.
 * Not `tight`, it returns the bound itself instead (the box's, split only where a piece has no
 * finite bound yet), which is never below the largest value.
 */
function highest(
  start: Box,
  bound: (box: Box) => { readonly top: number; readonly split: number },
  value: (box: Box) => number,
  floor: number,
  stop: () => never,
  tight: boolean,
): { readonly value: number; readonly box: Box } | null {
  if (!tight) {
    let top = Number.NEGATIVE_INFINITY;
    for (const pending = [start]; pending.length; ) {
      const box = pending.pop()!;
      const piece = bound(box);
      if (Number.isFinite(piece.top)) top = Math.max(top, piece.top);
      else if (pending.length > LOOSE_PIECES) return stop();
      else pending.push(...halves(box, piece.split));
    }
    return top > floor ? { value: top, box: start } : null;
  }
  let found: { value: number; box: Box } | null = null;
  const best = () => found?.value ?? floor;
  const open = [{ box: start, ...bound(start) }];
  const sample = (box: Box) => {
    const at = value(box);
    if (at > best()) found = { value: at, box };
  };
  sample(start);
  for (let steps = 0; ; steps++) {
    let index = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.top > open[index]!.top) index = i;
    const piece = open[index];
    if (!piece || piece.top <= best() + EXTREME_GAP) return found;
    const [k, lo, hi] = [piece.split, piece.box[2 * piece.split]!, piece.box[2 * piece.split + 1]!];
    if (steps > EXTREME_STEPS || hi - lo <= SMALLEST_PIECE * (start[2 * k + 1]! - start[2 * k]!))
      return stop();
    open.splice(index, 1);
    for (const box of halves(piece.box, k)) {
      sample(box);
      const next = bound(box);
      if (next.top > best() + EXTREME_GAP) open.push({ box, ...next });
    }
  }
}

/**
 * How far along unit `direction` a shape reaches: the largest p . direction over its points,
 * proven or the run stops. It's the largest of its vertices, its edges' extremes and its faces'
 * interior extremes:
 * - lines peak at their ends; circles and ellipses in closed form, if the peak is on the arc;
 * - planes, cylinders, cones and extrusions peak on their boundary (along a ruling the value is
 *   constant, and a ruling's piece of the face ends on the boundary);
 * - a sphere or torus peaks inside at one point (or, for a torus along its axis, one circle), in
 *   closed form, counted when it lies on the face;
 * - B-spline and Bezier curves and faces (and hyperbola and parabola edges, converted exactly)
 *   by branch and bound: a piece lies in its control points' convex hull, so pieces whose hull
 *   can't beat the best value found are dropped and the rest split until bound and value agree
 *   to `EXTREME_GAP`; surfaces of revolution likewise, with their profile's hull turned;
 * - a face whose search peaks off the trimmed face, offset and other curves and surfaces, and
 *   searches that don't converge stop the run.
 *
 * Not `tight`, it returns an upper bound instead, which is never below the largest value and
 * never needs a search: whole spheres' and tori's peaks, and each spline or turned face's or
 * edge's control hull over its whole range. It stops only on offset and other curves and
 * surfaces, and on conversions that don't match the shape.
 */
export function reach(
  oc: Oc,
  shape: Shape,
  direction: Direction,
  stop: (message: string) => never,
  tight = true,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const vertex of subShapes(oc, shape, "VERTEX"))
    best = Math.max(best, along(xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex))), direction));
  for (const edge of subShapes(oc, shape, "EDGE"))
    if (!oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)))
      best = Math.max(best, edgeReach(oc, edge, direction, stop, tight));
  for (const face of subShapes(oc, shape, "FACE"))
    best = faceReach(oc, face, direction, best, stop, tight);
  return best;
}

/** Directions (radians) rays are cast in to classify a point against a face, in order. */
const RAY_ANGLES = [0.3, 1.7, 2.9, 4.4, 5.6, 0.9, 3.7, 5.1];
/** A turn, for moving periodic parameters into a face's range. */
const TURN = 2 * Math.PI;
/** `t` moved by whole turns to the first value at or above `low`. */
const turnedPast = (t: number, low: number) => t + Math.ceil((low - t) / TURN - 1e-12) * TURN;

export type FaceRegion = {
  readonly face: InstanceType<Oc["TopoDS_Face"]>;
  readonly bounds: { UMin: number; UMax: number; VMin: number; VMax: number };
  /** Each edge's curve in the parameter plane, with its range and ends; a seam has two. */
  readonly curves: readonly {
    readonly curve: InstanceType<Oc["Geom2d_Curve"]>;
    readonly first: number;
    readonly last: number;
    readonly trimmed: InstanceType<Oc["Geom2d_TrimmedCurve"]>;
    readonly ends: readonly InstanceType<Oc["gp_Pnt2d"]>[];
  }[];
};

/** A face's region in its parameter plane: the curves its edges draw there. */
export function faceRegion(oc: Oc, shape: Shape): FaceRegion {
  const face = oc.TopoDS.Face(shape);
  const curves: FaceRegion["curves"][number][] = [];
  for (
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    explorer.More();
    explorer.Next()
  ) {
    // The explorer keeps each use's orientation, which picks a seam's curve on that side.
    const on = new oc.BRepAdaptor_Curve2d(oc.TopoDS.Edge(explorer.Current()), face);
    const [curve, first, last] = [on.Curve(), on.FirstParameter(), on.LastParameter()];
    curves.push({
      curve,
      first,
      last,
      trimmed: new oc.Geom2d_TrimmedCurve(curve, first, last, true, true),
      ends: [curve.Value(first), curve.Value(last)],
    });
  }
  return { face, bounds: oc.BRepTools.UVBounds(face), curves };
}

/**
 * Whether parameters (u, v) are on a face: within `CONTAINS_TOLERANCE` (in space) of one of its
 * edges, or inside the loops its edges draw in the parameter plane. A ray from the point counts
 * the edge curves it crosses; a ray through a vertex, along a curve or tangent to one is cast
 * again in another direction, and when none is clean the run stops.
 */
export function onFace(
  oc: Oc,
  region: FaceRegion,
  u: number,
  v: number,
  stop: (message: string) => never,
): boolean {
  const { bounds, curves } = region;
  const derivatives = new oc.BRepAdaptor_Surface(region.face, true).EvalD1(u, v);
  const speed = Math.max(
    Math.hypot(...xyz(derivatives.D1U)),
    Math.hypot(...xyz(derivatives.D1V)),
    1e-12,
  );
  const close = CONTAINS_TOLERANCE / speed; // the tolerance in space, in parameters
  const at = new oc.gp_Pnt2d(u, v);
  for (const { curve, first, last, ends } of curves) {
    if (ends.some((end) => end.Distance(at) <= close)) return true;
    const projection = new oc.Geom2dAPI_ProjectPointOnCurve(at, curve, first, last);
    if (projection.NbPoints() > 0 && projection.LowerDistance() <= close) return true;
  }
  // Long enough to leave the parameter box from anywhere in it.
  const length =
    2 *
    (Math.hypot(bounds.UMax - bounds.UMin, bounds.VMax - bounds.VMin) +
      Math.hypot(u - bounds.UMin, v - bounds.VMin) +
      1);
  const precision = 1e-9 * Math.max(bounds.UMax - bounds.UMin, bounds.VMax - bounds.VMin, 1);
  for (const angle of RAY_ANGLES) {
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const ray = new oc.Geom2d_TrimmedCurve(
      new oc.Geom2d_Line(at, new oc.gp_Dir2d(new oc.gp_XY(cos, sin))),
      0,
      length,
      true,
      true,
    );
    let crossings = 0;
    const clean = curves.every(({ curve, first, last, trimmed, ends }) => {
      const hits = new oc.Geom2dAPI_InterCurveCurve(ray, trimmed, precision);
      if (hits.NbSegments() > 0) return false;
      for (let i = 1; i <= hits.NbPoints(); i++) {
        const hit = hits.Point(i);
        if (ends.some((end) => end.Distance(hit) <= 10 * close + precision)) return false;
        const t = new oc.Geom2dAPI_ProjectPointOnCurve(hit, curve, first, last);
        if (t.NbPoints() === 0) return false;
        const tangent = curve.DN(t.LowerDistanceParameter(), 1);
        const size = Math.hypot(tangent.X(), tangent.Y());
        if (!(Math.abs(cos * tangent.Y() - sin * tangent.X()) > 1e-6 * size)) return false;
        crossings++;
      }
      return true;
    });
    if (clean) return crossings % 2 === 1;
  }
  return stop("Whether a point lies on a trimmed face can't be settled locally.");
}

/**
 * Whether the iso-line at v (all u) meets a face: it crosses or touches one of its edge curves,
 * or, crossing none, lies inside.
 */
function isoLineOnFace(
  oc: Oc,
  region: FaceRegion,
  v: number,
  stop: (message: string) => never,
): boolean {
  const { bounds, curves } = region;
  const line = new oc.Geom2d_TrimmedCurve(
    new oc.Geom2d_Line(new oc.gp_Pnt2d(bounds.UMin - 1, v), new oc.gp_Dir2d(new oc.gp_XY(1, 0))),
    0,
    bounds.UMax - bounds.UMin + 2,
    true,
    true,
  );
  const precision = 1e-9 * Math.max(bounds.UMax - bounds.UMin, bounds.VMax - bounds.VMin, 1);
  const meets = curves.some(({ trimmed }) => {
    const hits = new oc.Geom2dAPI_InterCurveCurve(line, trimmed, precision);
    return hits.NbPoints() > 0 || hits.NbSegments() > 0;
  });
  return meets || onFace(oc, region, (bounds.UMin + bounds.UMax) / 2, v, stop);
}

function edgeReach(
  oc: Oc,
  edge: Shape,
  d: Direction,
  stop: (message: string) => never,
  tight: boolean,
): number {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  const value = (u: number) => along(xyz(curve.EvalD0(u)), d);
  const ends = Math.max(value(a), value(b));
  const kind = String(curve.GetType()).replace("GeomAbs_", "");
  if (kind === "Line") return ends;
  if (kind === "Circle" || kind === "Ellipse") {
    // p(t) = c + A cos t X + B sin t Y peaks at t = atan2(B Y.d, A X.d), if the arc reaches it.
    const conic = kind === "Circle" ? curve.Circle() : curve.Ellipse();
    const position = conic.Position();
    const [A, B] =
      kind === "Circle"
        ? [curve.Circle().Radius(), curve.Circle().Radius()]
        : [curve.Ellipse().MajorRadius(), curve.Ellipse().MinorRadius()];
    const [x, y] = [
      A * along(xyz(position.XDirection()), d),
      B * along(xyz(position.YDirection()), d),
    ];
    const peak = Math.atan2(y, x);
    const turn = 2 * Math.PI;
    const k = Math.ceil((a - peak) / turn - 1e-12);
    const inside = peak + k * turn <= b + 1e-12;
    return inside ? Math.max(ends, along(xyz(position.Location()), d) + Math.hypot(x, y)) : ends;
  }
  if (kind === "BSplineCurve" || kind === "BezierCurve") {
    const spline = kind === "BSplineCurve" ? curve.BSpline() : curve.Bezier();
    return splineReach(oc, spline, a, b, d, ends, stop, tight);
  }
  if (kind === "Hyperbola" || kind === "Parabola") {
    // Exactly a rational B-spline. The conversion has its own parameters, so the search runs over
    // the spline's whole range, which is the edge.
    const geometry = oc.BRep_Tool.Curve(oc.TopoDS.Edge(edge), 0, 0);
    const spline = oc.GeomConvert.CurveToBSplineCurve(
      new oc.Geom_TrimmedCurve(geometry.returnValue, geometry.First, geometry.Last, true, true),
    );
    const [s, t] = [spline.FirstParameter(), spline.LastParameter()];
    const sameEnds =
      near(xyz(spline.Value(s)), xyz(curve.EvalD0(a))) &&
      near(xyz(spline.Value(t)), xyz(curve.EvalD0(b)));
    if (!sameEnds) return stop(`A ${kind} edge didn't convert to a B-spline with its own ends.`);
    return splineReach(oc, spline, s, t, d, ends, stop, tight);
  }
  return stop(`Extremes of ${kind} edges along a direction aren't supported locally yet.`);
}

type SplineCurve = InstanceType<Oc["Geom_BSplineCurve"]> | InstanceType<Oc["Geom_BezierCurve"]>;

/**
 * The highest p . d of a B-spline or Bezier curve over [a, b], at least `floor`: a piece lies in
 * its control points' convex hull, so `highest` bounds each piece by its highest control point.
 */
function splineReach(
  oc: Oc,
  spline: SplineCurve,
  a: number,
  b: number,
  d: Direction,
  floor: number,
  stop: (message: string) => never,
  tight: boolean,
): number {
  const hull = (s: number, t: number) => {
    let piece: SplineCurve;
    if (spline instanceof oc.Geom_BSplineCurve) {
      piece = new oc.Geom_BSplineCurve(spline);
      piece.Segment(s, t, SEGMENT_TOLERANCE * (t - s));
    } else {
      piece = new oc.Geom_BezierCurve(spline);
      piece.Segment(s, t);
    }
    const top = Math.max(
      ...Array.from({ length: piece.NbPoles() }, (_, i) => along(xyz(piece.Pole(i + 1)), d)),
    );
    piece.delete(); // a search makes thousands of copies; free each in the kernel's heap
    return top;
  };
  const found = highest(
    [a, b],
    ([s, t]) => ({ top: hull(s!, t!), split: 0 }),
    ([s, t]) => along(xyz(spline.Value((s! + t!) / 2)), d),
    floor,
    () => stop("The extreme of a spline edge along a direction can't be pinned down locally."),
    tight,
  );
  return found?.value ?? floor;
}

/**
 * For a surface of revolution's profile, the points whose convex hull holds its piece over
 * [v1, v2]: a spline's control points, a line's ends, or a circle or ellipse arc's ends and the
 * meeting point of its end tangents (null for arcs over a quarter turn, to be split first). Other
 * profiles stop the run.
 */
function profileHull(
  oc: Oc,
  profile: ReturnType<InstanceType<Oc["BRepAdaptor_Surface"]>["BasisCurve"]>,
  stop: (message: string) => never,
): (v1: number, v2: number) => readonly (readonly number[])[] | null {
  const kind = String(profile.GetType()).replace("GeomAbs_", "");
  const at = (v: number) => xyz(profile.EvalD0(v));
  if (kind === "Line") return (v1, v2) => [at(v1), at(v2)];
  if (kind === "BSplineCurve" || kind === "BezierCurve") {
    const spline: SplineCurve = kind === "BSplineCurve" ? profile.BSpline() : profile.Bezier();
    return (v1, v2) => {
      let piece: SplineCurve;
      if (spline instanceof oc.Geom_BSplineCurve) {
        piece = new oc.Geom_BSplineCurve(spline);
        piece.Segment(v1, v2, SEGMENT_TOLERANCE * (v2 - v1));
      } else {
        piece = new oc.Geom_BezierCurve(spline);
        piece.Segment(v1, v2);
      }
      const poles = Array.from({ length: piece.NbPoles() }, (_, i) => xyz(piece.Pole(i + 1)));
      piece.delete();
      return poles;
    };
  }
  if (kind === "Circle" || kind === "Ellipse") {
    // p(t) = c + A cos t X + B sin t Y; the end tangents of [t1, t2] meet at
    // c + (A cos m X + B sin m Y) / cos h, with m the middle and h the half width.
    const conic = kind === "Circle" ? profile.Circle() : profile.Ellipse();
    const position = conic.Position();
    const [A, B] =
      kind === "Circle"
        ? [profile.Circle().Radius(), profile.Circle().Radius()]
        : [profile.Ellipse().MajorRadius(), profile.Ellipse().MinorRadius()];
    const [c, X, Y] = [position.Location(), position.XDirection(), position.YDirection()].map(xyz);
    return (v1, v2) => {
      if (v2 - v1 > Math.PI / 2) return null;
      const [m, half] = [(v1 + v2) / 2, (v2 - v1) / 2];
      const corner = c!.map(
        (o, i) => o + (A * Math.cos(m) * X![i]! + B * Math.sin(m) * Y![i]!) / Math.cos(half),
      );
      return [at(v1), corner, at(v2)];
    };
  }
  return stop(`Surfaces of revolution of ${kind} profiles aren't supported locally yet.`);
}

/** `best` raised by the face's interior extreme, if it has one above `best` on the face. */
function faceReach(
  oc: Oc,
  face: Shape,
  d: Direction,
  best: number,
  stop: (message: string) => never,
  tight: boolean,
): number {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const kind = String(surface.GetType()).replace("GeomAbs_", "");
  if (["Plane", "Cylinder", "Cone", "SurfaceOfExtrusion"].includes(kind)) return best;
  const point = (u: number, v: number) => xyz(surface.EvalD0(u, v));
  const region = () => faceRegion(oc, face);
  /**
   * Whether a sphere's or torus's peak at (u, v) is on the face: u (and v on a torus) moved by
   * whole turns into the face's parameter range, then classified there. `expected` checks that
   * the parameters, read from the surface, give the peak.
   */
  const peakOnFace = (u: number, v: number, expected: readonly number[], periodicV: boolean) => {
    if (!near(point(u, v), expected))
      return stop(`A ${kind} face's peak isn't where its parameters put it.`);
    const uvRegion = region();
    const { bounds } = uvRegion;
    const [pu, pv] = [
      turnedPast(u, bounds.UMin - 1e-9),
      periodicV ? turnedPast(v, bounds.VMin - 1e-9) : v,
    ];
    if (pu > bounds.UMax + 1e-9 || pv > bounds.VMax + 1e-9 || pv < bounds.VMin - 1e-9) return false;
    return onFace(oc, uvRegion, pu, pv, stop);
  };
  if (kind === "Sphere") {
    // P(u, v) = C + r (cos v (cos u X + sin u Y) + sin v Z), with X, Y and Z read from the surface.
    const sphere = surface.Sphere();
    const center = xyz(sphere.Location());
    const r = sphere.Radius();
    const top = along(center, d) + r;
    if (top <= best + EXTREME_GAP) return best;
    // A loose bound takes the whole surface's peak, on the face or not.
    if (!tight) return top;
    const [X, Y, Z] = [point(0, 0), point(Math.PI / 2, 0), point(0, Math.PI / 2)].map((p) =>
      p.map((c, i) => (c - center[i]!) / r),
    ) as [number[], number[], number[]];
    const [u, v] = [
      Math.atan2(along(Y, d), along(X, d)),
      Math.asin(Math.min(1, Math.max(-1, along(Z, d)))),
    ];
    const peak = center.map((c, i) => c + r * d[i]!);
    return peakOnFace(u, v, peak, false) ? top : best;
  }
  if (kind === "Torus") {
    // This build has no gp_Torus: read it from the surface. P(u, v) = C + (R + r cos v) w(u) +
    // r sin v Z, with w(u) = cos u X + sin u Y.
    const [p0, pPi, pQuarter] = [point(0, 0), point(Math.PI, 0), point(Math.PI / 2, 0)];
    const tube = xyz(surface.EvalD1(0, 0).D1V);
    const r = Math.hypot(...tube);
    const z = tube.map((c) => c / r);
    const center = p0.map((c, i) => (c + pPi[i]!) / 2);
    const outer = Math.hypot(...p0.map((c, i) => c - center[i]!));
    const [x, y] = [p0, pQuarter].map((p) => p.map((c, i) => (c - center[i]!) / outer)) as [
      number[],
      number[],
    ];
    const R = outer - r;
    const h = Math.hypot(along(x, d), along(y, d));
    const top = along(center, d) + R * h + r;
    if (top <= best + EXTREME_GAP) return best;
    if (!tight) return top;
    if (h > 1e-12) {
      const u = Math.atan2(along(y, d), along(x, d));
      const v = Math.atan2(along(z, d), h);
      const w = x.map((c, i) => Math.cos(u) * c + Math.sin(u) * y[i]!);
      const peak = center.map(
        (c, i) => c + (R + r * Math.cos(v)) * w[i]! + r * Math.sin(v) * z[i]!,
      );
      return peakOnFace(u, v, peak, true) ? top : best;
    }
    // Along the axis, the whole circle at the tube's top (or bottom), v = +-pi / 2, peaks.
    const uvRegion = region();
    const v = turnedPast((Math.sign(along(z, d)) * Math.PI) / 2, uvRegion.bounds.VMin - 1e-9);
    if (v > uvRegion.bounds.VMax + 1e-9) return best;
    return isoLineOnFace(oc, uvRegion, v, stop) ? top : best;
  }
  const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  /**
   * `best` raised by `highest` over the face's parameter box. The box's peak counts when it is
   * on the trimmed face; off it, the face's own peak is unknown and the run stops. Not `tight`,
   * the box's bound counts as it is.
   */
  const search = (bound: (box: Box) => { readonly top: number; readonly split: number }) => {
    const middle = ([u1, u2, v1, v2]: Box) => point((u1! + u2!) / 2, (v1! + v2!) / 2);
    const found = highest(
      [bounds.UMin, bounds.UMax, bounds.VMin, bounds.VMax],
      bound,
      (box) => along(middle(box), d),
      best,
      () => stop(`The extreme of a ${kind} face along a direction can't be pinned down locally.`),
      tight,
    );
    if (!found) return best;
    if (!tight) return found.value;
    const [u1, u2, v1, v2] = found.box;
    if (onFace(oc, region(), (u1! + u2!) / 2, (v1! + v2!) / 2, stop)) return found.value;
    return stop(`A trimmed ${kind} face's extreme along a direction can't be pinned down locally.`);
  };
  if (kind === "BSplineSurface" || kind === "BezierSurface") {
    // A Bezier surface is a B-spline with no inner knots and the same parameters.
    const spline =
      kind === "BSplineSurface"
        ? surface.BSpline()
        : oc.GeomConvert.SurfaceToBSplineSurface(oc.BRep_Tool.Surface(oc.TopoDS.Face(face)));
    const [um, vm] = [(bounds.UMin + bounds.UMax) / 2, (bounds.VMin + bounds.VMax) / 2];
    if (!near(xyz(spline.Value(um, vm)), point(um, vm)))
      return stop(`A ${kind} face didn't convert to a B-spline with its own parameters.`);
    // The piece's control net along d: its top, and whether it varies more along u than v (a
    // piece is split across the way it varies, so a ridge isn't cut into slivers along its length).
    return search(([u1, u2, v1, v2]) => {
      const copy = new oc.Geom_BSplineSurface(spline);
      copy.Segment(
        u1!,
        u2!,
        v1!,
        v2!,
        SEGMENT_TOLERANCE * (u2! - u1!),
        SEGMENT_TOLERANCE * (v2! - v1!),
      );
      const [nu, nv] = [copy.NbUPoles(), copy.NbVPoles()];
      const at = Array.from({ length: nu }, (_, i) =>
        Array.from({ length: nv }, (_, j) => along(xyz(copy.Pole(i + 1, j + 1)), d)),
      );
      copy.delete(); // a search makes thousands of copies; free each in the kernel's heap
      const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);
      const alongU = Math.max(
        ...Array.from({ length: nv }, (_, j) => spread(at.map((row) => row[j]!))),
      );
      const alongV = Math.max(...at.map(spread));
      return { top: Math.max(...at.flat()), split: alongU >= alongV ? 0 : 1 };
    });
  }
  if (kind === "SurfaceOfRevolution") {
    // P(u, v) is the profile's point at v turned by u about the axis. Over a piece, the profile
    // lies in the convex hull of a few points (`profileHull`); turned by one angle, a linear
    // function peaks at one of them, so the piece's bound is the highest any of them reaches
    // turning through the piece's angles, which is closed form.
    const axis = surface.AxeOfRevolution();
    const [origin, z] = [xyz(axis.Location()), xyz(axis.Direction())];
    const seed = Math.abs(z[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const xRaw = seed.map((c, i) => c - along(seed, z as Direction) * z[i]!);
    const x = xRaw.map((c) => c / Math.hypot(...xRaw));
    const y = [
      z[1]! * x[2]! - z[2]! * x[1]!,
      z[2]! * x[0]! - z[0]! * x[2]!,
      z[0]! * x[1]! - z[1]! * x[0]!,
    ];
    /** A point as height along the axis, distance from it and angle around it. */
    const polar = (p: readonly number[]) => {
      const q = p.map((c, i) => c - origin[i]!);
      const [a, rx, ry] = [z, x, y].map((e) => dotOf(q, e)) as [number, number, number];
      return { a, r: Math.hypot(rx, ry), psi: Math.atan2(ry, rx) };
    };
    const turned = (p: readonly number[], u: number) => {
      const { a, r, psi } = polar(p);
      return origin.map(
        (c, i) => c + a * z[i]! + r * (Math.cos(psi + u) * x[i]! + Math.sin(psi + u) * y[i]!),
      );
    };
    const profile = surface.BasisCurve();
    const hull = profileHull(oc, profile, stop);
    // The model must be the surface: check it where the search starts and ends.
    for (const [u, v] of [
      [bounds.UMin, bounds.VMin],
      [bounds.UMax, bounds.VMax],
      [(bounds.UMin + bounds.UMax) / 2, (bounds.VMin + bounds.VMax) / 2],
    ] as const)
      if (!near(turned(xyz(profile.EvalD0(v)), u), point(u, v)))
        return stop("A surface of revolution doesn't match its profile turned about its axis.");
    const [dz, dx, dy] = [z, x, y].map((e) => dotOf(d, e)) as [number, number, number];
    const [h, phi, level] = [Math.hypot(dx, dy), Math.atan2(dy, dx), along(origin, d)];
    /** p . d turned to u, and the most it reaches turning through [u1, u2]. */
    const at = (p: readonly number[], u: number) => {
      const { a, r, psi } = polar(p);
      return level + a * dz + r * h * Math.cos(psi + u - phi);
    };
    const reaches = (p: readonly number[], u1: number, u2: number) => {
      const { a, r, psi } = polar(p);
      const peak = phi - psi; // where cos(psi + u - phi) is 1, up to whole turns
      const turn = 2 * Math.PI;
      const passes = peak + Math.ceil((u1 - peak) / turn - 1e-12) * turn <= u2 + 1e-12;
      const cos = passes ? 1 : Math.max(Math.cos(psi + u1 - phi), Math.cos(psi + u2 - phi));
      return level + a * dz + r * h * cos;
    };
    return search(([u1, u2, v1, v2]) => {
      const points = hull(v1!, v2!);
      if (!points) return { top: Number.POSITIVE_INFINITY, split: 1 };
      const top = Math.max(...points.map((p) => reaches(p, u1!, u2!)));
      // Halve whichever adds more to the bound: the turning (the bound at the middle angle
      // alone is lower by that much) or the profile's hull (above the surface's middle point).
      const [um, vm] = [(u1! + u2!) / 2, (v1! + v2!) / 2];
      const fixed = Math.max(...points.map((p) => at(p, um)));
      return { top, split: top - fixed >= fixed - along(point(um, vm), d) ? 0 : 1 };
    });
  }
  return stop(`Extremes of ${kind} faces along a direction aren't supported locally yet.`);
}

type Point = readonly [number, number, number];
const near = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < CONTAINS_TOLERANCE;
/** `n + 1` points evenly spread over an edge's parameter range, ends included. */
function edgePoints(oc: Oc, edge: Shape, n = 64): Point[] {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  return Array.from({ length: n + 1 }, (_, i) => xyz(curve.EvalD0(a + ((b - a) * i) / n)));
}
const lies = (oc: Oc, points: readonly Point[], shape: Shape) =>
  points.every((p) => distance(oc, pointShape(oc, p), shape) < CONTAINS_TOLERANCE);
const relativelyEqual = (x: number, y: number) =>
  Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1e-12);

/**
 * Whether two entities of the same type are exactly the same geometry. Points can only prove
 * that they differ (a sample of one off the other, a different length or area); sameness is
 * proven exactly: the same shape; lines with the same ends; arcs of the same circle with the same
 * ends and middle; faces on the same plane, cylinder or cone with matching edges and area (a
 * bounded region there is fixed by its boundary). Anything else, such as two distinct splines or
 * spheres, stops the run.
 */
function coincide(env: QueryEnv, a: Entity, b: Entity): boolean {
  const { oc } = env;
  if (a.shape.IsSame(b.shape)) return true;
  if (a.type === "VERTEX")
    return near(
      xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(a.shape))),
      xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(b.shape))),
    );
  const verdict =
    a.type === "EDGE"
      ? sameEdge(oc, a.shape, b.shape, env.unsupported)
      : sameFace(oc, a.shape, b.shape, env.unsupported);
  if (verdict !== "unknown") return verdict === "yes";
  return env.unsupported(
    `qCoincidentFilter can't establish locally whether ${a.id} and ${b.id} coincide exactly.`,
  );
}

type Verdict = "yes" | "no" | "unknown";

function sameEdge(oc: Oc, a: Shape, b: Shape, stop: (message: string) => never): Verdict {
  if (a.IsSame(b)) return "yes";
  const length = (edge: Shape) => measure(oc, edge, 1, stop);
  if (!relativelyEqual(length(a), length(b))) return "no";
  if (!lies(oc, edgePoints(oc, a), b) || !lies(oc, edgePoints(oc, b), a)) return "no";
  const [ca, cb] = [a, b].map((edge) => new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge))) as [
    InstanceType<Oc["BRepAdaptor_Curve"]>,
    InstanceType<Oc["BRepAdaptor_Curve"]>,
  ];
  const [ka, kb] = [String(ca.GetType()), String(cb.GetType())];
  const at = (curve: typeof ca, t: number) =>
    xyz(
      curve.EvalD0(curve.FirstParameter() + t * (curve.LastParameter() - curve.FirstParameter())),
    );
  const sameEnds =
    (near(at(ca, 0), at(cb, 0)) && near(at(ca, 1), at(cb, 1))) ||
    (near(at(ca, 0), at(cb, 1)) && near(at(ca, 1), at(cb, 0)));
  if (ka !== kb) return "unknown";
  if (ka === "GeomAbs_Line") return sameEnds ? "yes" : "no";
  if (ka === "GeomAbs_Circle") {
    const [x, y] = [ca.Circle(), cb.Circle()];
    const sameCircle =
      near(xyz(x.Location()), xyz(y.Location())) &&
      relativelyEqual(x.Radius(), y.Radius()) &&
      Math.abs(Math.abs(dotOf(xyz(x.Axis().Direction()), xyz(y.Axis().Direction()))) - 1) <=
        PARALLEL;
    if (!sameCircle) return "no";
    // Full circles are the same wherever each starts.
    const closed = (curve: typeof ca) => near(at(curve, 0), at(curve, 1));
    if (closed(ca) && closed(cb)) return "yes";
    // Constant speed, so the parameter's middle is the arc's middle; it tells an arc from its
    // complement when both share their ends.
    return sameEnds && near(at(ca, 0.5), at(cb, 0.5)) ? "yes" : "no";
  }
  return "unknown";
}

function sameFace(oc: Oc, a: Shape, b: Shape, stop: (message: string) => never): Verdict {
  if (a.IsSame(b)) return "yes";
  if (!relativelyEqual(measure(oc, a, 2, stop), measure(oc, b, 2, stop))) return "no";
  const boundary = (face: Shape) =>
    subShapes(oc, face, "EDGE").flatMap((edge) => edgePoints(oc, edge, 16));
  if (!lies(oc, boundary(a), b) || !lies(oc, boundary(b), a)) return "no";
  const surfaces = [a, b].map((face) => new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  const [sa, sb] = surfaces as [
    InstanceType<Oc["BRepAdaptor_Surface"]>,
    InstanceType<Oc["BRepAdaptor_Surface"]>,
  ];
  const kind = String(sa.GetType());
  if (kind !== String(sb.GetType())) return "unknown";
  const onLine = (
    p: readonly number[],
    origin: readonly number[],
    direction: readonly number[],
  ) => {
    const offset = [0, 1, 2].map((i) => p[i]! - origin[i]!);
    const along = dotOf(offset, direction);
    return Math.hypot(...offset.map((c, i) => c - along * direction[i]!)) < CONTAINS_TOLERANCE;
  };
  const parallel = (u: readonly number[], v: readonly number[]) =>
    Math.abs(Math.abs(dotOf(u, v)) - 1) <= PARALLEL;
  let sameSurface: boolean;
  if (kind === "GeomAbs_Plane") {
    const [p, q] = [sa.Plane(), sb.Plane()];
    const n = xyz(p.Axis().Direction());
    const offset = [0, 1, 2].map((i) => xyz(q.Location())[i]! - xyz(p.Location())[i]!);
    sameSurface =
      parallel(n, xyz(q.Axis().Direction())) && Math.abs(dotOf(offset, n)) < CONTAINS_TOLERANCE;
  } else if (kind === "GeomAbs_Cylinder") {
    const [p, q] = [sa.Cylinder(), sb.Cylinder()];
    const d = xyz(p.Axis().Direction());
    sameSurface =
      relativelyEqual(p.Radius(), q.Radius()) &&
      parallel(d, xyz(q.Axis().Direction())) &&
      onLine(xyz(q.Location()), xyz(p.Location()), d);
  } else if (kind === "GeomAbs_Cone") {
    const [p, q] = [coneOf(oc, a), coneOf(oc, b)];
    sameSurface =
      near(p.apex, q.apex) && parallel(p.z, q.z) && relativelyEqual(p.halfAngle, q.halfAngle);
  } else return "unknown";
  if (!sameSurface) return "no";
  // The same bounded region of a plane, cylinder or cone has the same boundary, so each boundary
  // must lie within the other's, however the two are cut into edges. Seams and degenerate edges
  // are left out: they depend on where the surface's parameters start.
  const [ea, eb] = [topology(oc, a).edges, topology(oc, b).edges];
  const verdicts = [
    ...ea.map((edge) => covered(oc, edge, eb)),
    ...eb.map((edge) => covered(oc, edge, ea)),
  ];
  if (verdicts.every((verdict) => verdict === "yes")) return "yes";
  return verdicts.includes("no") ? "no" : "unknown";
}

/**
 * Whether `edge` lies within the union of `others`: a line within collinear lines, a circle or arc
 * within arcs of the same circle, compared as intervals along the line or angles around the
 * circle (so edges cut at different points still cover each other). "no" only when the others
 * are all lines and circles, since nothing else could cover the rest; other curves give "unknown".
 */
function covered(oc: Oc, edge: Shape, others: readonly Shape[]): Verdict {
  const curve = (shape: Shape) => new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(shape));
  const kind = (shape: Shape) => String(curve(shape).GetType());
  const point = (shape: Shape, t: number) => {
    const c = curve(shape);
    return xyz(c.EvalD0(c.FirstParameter() + t * (c.LastParameter() - c.FirstParameter())));
  };
  const elsewhere: Verdict = others.every((other) =>
    ["GeomAbs_Line", "GeomAbs_Circle"].includes(kind(other)),
  )
    ? "no"
    : "unknown";
  const coversFrom = (
    target: readonly [number, number],
    spans: readonly (readonly [number, number])[],
    slack: number,
  ) => {
    let reached = target[0];
    for (const [from, to] of [...spans].sort((p, q) => p[0] - q[0]))
      if (from <= reached + slack) reached = Math.max(reached, to);
    return reached >= target[1] - slack;
  };
  if (kind(edge) === "GeomAbs_Line") {
    const [start, end] = [point(edge, 0), point(edge, 1)];
    const length = Math.hypot(...start.map((c, i) => end[i]! - c));
    const direction = start.map((c, i) => (end[i]! - c) / length);
    const along = (p: readonly number[]) =>
      dotOf(
        p.map((c, i) => c - start[i]!),
        direction,
      );
    const onLine = (p: readonly number[]) =>
      Math.hypot(...p.map((c, i) => c - start[i]! - along(p) * direction[i]!)) < CONTAINS_TOLERANCE;
    const spans = others
      .filter(
        (other) =>
          kind(other) === "GeomAbs_Line" && onLine(point(other, 0)) && onLine(point(other, 1)),
      )
      .map((other) => {
        const [p, q] = [along(point(other, 0)), along(point(other, 1))];
        return [Math.min(p, q), Math.max(p, q)] as const;
      });
    return coversFrom([0, length], spans, CONTAINS_TOLERANCE) ? "yes" : elsewhere;
  }
  if (kind(edge) === "GeomAbs_Circle") {
    const circle = curve(edge).Circle();
    const center = xyz(circle.Location());
    const radius = circle.Radius();
    const axis = xyz(circle.Axis().Direction());
    const x = xyz(circle.Position().XDirection());
    const y = [
      axis[1] * x[2] - axis[2] * x[1],
      axis[2] * x[0] - axis[0] * x[2],
      axis[0] * x[1] - axis[1] * x[0],
    ];
    const angle = (p: readonly number[]) => {
      const offset = p.map((c, i) => c - center[i]!);
      return Math.atan2(dotOf(offset, y), dotOf(offset, x));
    };
    const turn = 2 * Math.PI;
    const wrap = (value: number) => ((value % turn) + turn) % turn;
    // An arc as an angle interval going counterclockwise about `axis` from its start.
    const span = (shape: Shape): readonly [number, number] => {
      const [a, m, b] = [angle(point(shape, 0)), angle(point(shape, 0.5)), angle(point(shape, 1))];
      if (near(point(shape, 0), point(shape, 1))) return [a, a + turn];
      const forward = wrap(b - a);
      return wrap(m - a) <= forward ? [a, a + forward] : [b, b + wrap(a - b)];
    };
    const sameCircle = (other: Shape) => {
      if (kind(other) !== "GeomAbs_Circle") return false;
      const c = curve(other).Circle();
      return (
        near(xyz(c.Location()), center) &&
        relativelyEqual(c.Radius(), radius) &&
        Math.abs(Math.abs(dotOf(xyz(c.Axis().Direction()), axis)) - 1) <= PARALLEL
      );
    };
    const target = span(edge);
    const spans = others
      .filter(sameCircle)
      .map(span)
      .flatMap(([from, to]) => [-turn, 0, turn].map((k) => [from + k, to + k] as const));
    return coversFrom(target, spans, CONTAINS_TOLERANCE / radius) ? "yes" : elsewhere;
  }
  return "unknown";
}

/**
 * Whether an entity lies exactly in a plane. Lines by their ends; circles and ellipses by center
 * and axis; splines by their control points (a spline lies in a plane exactly when they all do);
 * planar faces by their plane, while other analytic faces never lie in one; bodies by all their
 * faces (or edges, or vertices). Where neither proof nor a point off the plane settles it, the
 * run stops.
 */
function inPlane(env: QueryEnv, entity: Entity, plane: { origin: Point; normal: Point }): boolean {
  const { oc } = env;
  const off = (p: readonly number[]) =>
    Math.abs(
      dotOf(
        [0, 1, 2].map((i) => p[i]! - plane.origin[i]!),
        plane.normal,
      ),
    );
  const onPlane = (p: readonly number[]) => off(p) < CONTAINS_TOLERANCE;
  const parallelToNormal = (d: readonly number[]) =>
    Math.abs(Math.abs(dotOf(d, plane.normal)) - 1) <= PARALLEL;
  if (entity.type === "VERTEX")
    return onPlane(xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(entity.shape))));
  if (entity.type === "BODY") {
    const owned = (type: EntityType) =>
      [...env.state.entities.values()].filter(
        (other) => other.body === entity.id && other.type === type,
      );
    const parts =
      [owned("FACE"), owned("EDGE"), owned("VERTEX")].find((list) => list.length > 0) ?? [];
    return parts.every((part) => inPlane(env, part, plane));
  }
  if (entity.type === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
    const kind = String(curve.GetType()).replace("GeomAbs_", "");
    if (kind === "Line") return edgePoints(oc, entity.shape, 1).every(onPlane);
    if (kind === "Circle" || kind === "Ellipse") {
      const position = kind === "Circle" ? curve.Circle().Position() : curve.Ellipse().Position();
      return onPlane(xyz(position.Location())) && parallelToNormal(xyz(position.Direction()));
    }
    if (kind === "BSplineCurve" || kind === "BezierCurve") {
      // The adaptor's spline is already placed where the edge is (its location applied).
      const spline = kind === "BSplineCurve" ? curve.BSpline() : curve.Bezier();
      return Array.from({ length: spline.NbPoles() }, (_, i) => xyz(spline.Pole(i + 1))).every(
        onPlane,
      );
    }
    if (!edgePoints(oc, entity.shape).every(onPlane)) return false;
    return env.unsupported(`qCoincidesWithPlane on ${kind} edges is not supported locally yet.`);
  }
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
  const kind = String(surface.GetType()).replace("GeomAbs_", "");
  if (kind === "Plane") {
    const p = surface.Plane();
    return onPlane(xyz(p.Location())) && parallelToNormal(xyz(p.Axis().Direction()));
  }
  if (["Cylinder", "Cone", "Sphere", "Torus"].includes(kind)) return false;
  if (!subShapes(oc, entity.shape, "EDGE").every((edge) => edgePoints(oc, edge, 16).every(onPlane)))
    return false;
  return env.unsupported(`qCoincidesWithPlane on ${kind} faces is not supported locally yet.`);
}

/** Unit vectors this close to (anti)parallel or perpendicular count as such. */
const PARALLEL = 1e-9;
const dotOf = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** A planar face's outward normal, or null for anything else. */
function planeNormal(oc: Oc, entity: Entity): readonly [number, number, number] | null {
  if (entity.type !== "FACE") return null;
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
  if (String(surface.GetType()) !== "GeomAbs_Plane") return null;
  const n = xyz(surface.Plane().Axis().Direction());
  return String(entity.shape.Orientation()) === "TopAbs_REVERSED" ? [-n[0], -n[1], -n[2]] : n;
}

/**
 * The axis of an axis-symmetric entity, as std's qAxis lists them: line and circle edges,
 * cylinders, cones and surfaces of revolution, mate connectors (their Z). Null for the rest; a
 * torus stops the run (this build can't read a torus's axis).
 */
function axisOf(
  env: QueryEnv,
  entity: Entity,
): { origin: readonly number[]; direction: readonly number[] } | null {
  const { oc } = env;
  if (entity.frame) return { origin: entity.frame.origin, direction: entity.frame.zAxis };
  if (entity.type === "EDGE") {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(entity.shape));
    const kind = String(curve.GetType());
    if (kind === "GeomAbs_Line") {
      const at = curve.EvalD1(curve.FirstParameter());
      const d = xyz(at.D1);
      const size = Math.hypot(...d);
      return { origin: xyz(at.Point), direction: d.map((c) => c / size) };
    }
    if (kind === "GeomAbs_Circle") {
      const axis = curve.Circle().Axis();
      return { origin: xyz(axis.Location()), direction: xyz(axis.Direction()) };
    }
    return null;
  }
  if (entity.type !== "FACE") return null;
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
  const kind = String(surface.GetType());
  if (kind === "GeomAbs_Cylinder") {
    const axis = surface.Cylinder().Axis();
    return { origin: xyz(axis.Location()), direction: xyz(axis.Direction()) };
  }
  if (kind === "GeomAbs_Cone") {
    const cone = coneOf(oc, entity.shape);
    return { origin: cone.apex, direction: cone.z };
  }
  if (kind === "GeomAbs_SurfaceOfRevolution") {
    const axis = surface.AxeOfRevolution();
    return { origin: xyz(axis.Location()), direction: xyz(axis.Direction()) };
  }
  if (kind === "GeomAbs_Torus")
    return env.unsupported("qAxis on a torus is not supported locally yet.");
  return null;
}

/** Operations that copy existing geometry, so their faces may be fillets made before them. */
const COPYING = new Set(["opPattern", "opBooleanedPattern", "opMergeContexts"]);

/**
 * A face's fillet radius, or null when it isn't a fillet. A face is a fillet when an opFillet of
 * this run made it; its radius comes from its current surface (a cylinder's or sphere's radius, a
 * torus's tube radius), so it follows later transforms. A fillet face whose surface has since
 * become something else, faces no operation of this run made (a STEP base), and faces an
 * operation copied can't be judged locally, so they stop the run; sketch regions are never fillets.
 */
export function filletRadius(
  env: Pick<QueryEnv, "oc" | "state" | "unsupported">,
  face: Entity,
): number | null {
  if (face.sketch) return null;
  const creator = creatorOf(env.state, face.createdBy);
  if (!creator || COPYING.has(creator.builtin))
    return env.unsupported(
      `Whether face ${face.id} is a fillet can't be told locally: no fillet operation of this run is known to have made it.`,
    );
  if (creator.builtin !== "opFillet") return null;
  const surface = new env.oc.BRepAdaptor_Surface(env.oc.TopoDS.Face(face.shape), true);
  const kind = String(surface.GetType());
  if (kind === "GeomAbs_Cylinder") return surface.Cylinder().Radius();
  if (kind === "GeomAbs_Sphere") return surface.Sphere().Radius();
  // A torus's v circle is its tube: |dP/dv| is the tube radius everywhere.
  if (kind === "GeomAbs_Torus") return Math.hypot(...xyz(surface.EvalD1(0, 0).D1V));
  return env.unsupported(
    `Face ${face.id} was made by a fillet but is now a ${kind.replace("GeomAbs_", "")} surface, so its radius can't be read locally.`,
  );
}

const pointShape = (oc: Oc, p: readonly number[]) =>
  new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(p[0]!, p[1]!, p[2]!)).Vertex();

/** The face entities of its body that an edge bounds. */
function facesOfEdge(env: QueryEnv, edge: Entity): Entity[] {
  return [...env.state.entities.values()].filter(
    (face) =>
      face.type === "FACE" &&
      face.body === edge.body &&
      subShapes(env.oc, face.shape, "EDGE").some((candidate) => candidate.IsSame(edge.shape)),
  );
}
/** The edge entities of its body that bound a face. */
function edgesOfFace(env: QueryEnv, face: Entity): Entity[] {
  const own = subShapes(env.oc, face.shape, "EDGE");
  return [...env.state.entities.values()].filter(
    (edge) =>
      edge.type === "EDGE" &&
      edge.body === face.body &&
      own.some((candidate) => candidate.IsSame(edge.shape)),
  );
}

/**
 * Faces reached from `seeds` by crossing edges `crosses` allows, never entering `blocked` faces.
 * Seeds are part of the result.
 */
function flood(
  env: QueryEnv,
  seeds: readonly Entity[],
  crosses: (edge: Entity) => boolean,
  blocked: ReadonlySet<string> = new Set(),
): Entity[] {
  const reached = new Map(seeds.map((seed) => [seed.id, seed]));
  for (const queue = [...seeds]; queue.length; ) {
    const face = queue.pop()!;
    for (const edge of edgesOfFace(env, face)) {
      if (!crosses(edge)) continue;
      for (const next of facesOfEdge(env, edge)) {
        if (reached.has(next.id) || blocked.has(next.id)) continue;
        reached.set(next.id, next);
        queue.push(next);
      }
    }
  }
  return byOrder([...reached.values()]);
}

/**
 * std's qLoopEdges: for seed faces, the edges bounding them together (each used by one seed face);
 * for a laminar seed edge (one face), its whole laminar loop; other seed edges as they are.
 */
function loopEdges(env: QueryEnv, seeds: readonly Entity[]): Entity[] {
  const uses = new Map<string, { edge: Entity; count: number }>();
  for (const face of seeds.filter((entity) => entity.type === "FACE"))
    for (const edge of edgesOfFace(env, face))
      uses.set(edge.id, { edge, count: (uses.get(edge.id)?.count ?? 0) + 1 });
  const result = [...uses.values()].filter((use) => use.count === 1).map((use) => use.edge);
  for (const seed of seeds.filter((entity) => entity.type === "EDGE")) {
    if (facesJoined(env, seed) !== 1) {
      result.push(seed);
      continue;
    }
    // The laminar edges joined to the seed through shared vertices.
    const loop = new Map([[seed.id, seed]]);
    for (const queue = [seed]; queue.length; ) {
      const edge = queue.pop()!;
      const ends = subShapes(env.oc, edge.shape, "VERTEX");
      for (const other of env.state.entities.values()) {
        if (other.type !== "EDGE" || other.body !== edge.body || loop.has(other.id)) continue;
        if (
          !subShapes(env.oc, other.shape, "VERTEX").some((v) => ends.some((end) => end.IsSame(v)))
        )
          continue;
        if (facesJoined(env, other) !== 1) continue;
        loop.set(other.id, other);
        queue.push(other);
      }
    }
    result.push(...loop.values());
  }
  return byOrder(result);
}

/** How many faces of its body an edge bounds. */
function facesJoined(env: QueryEnv, edge: Entity): number {
  const body = env.state.entities.get(edge.body);
  if (!body) return 0;
  return subShapes(env.oc, body.shape, "FACE").filter((face) =>
    subShapes(env.oc, face, "EDGE").some((candidate) => candidate.IsSame(edge.shape)),
  ).length;
}

/** Edges continuing each other closer than this (radians) at a shared vertex are tangent. */
const TANGENT_ANGLE = 1e-6;

/** Where each end of an edge sits and which way the edge leaves it, in the curve's own terms. */
function edgeEnds(oc: Oc, edge: Shape) {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  return [curve.FirstParameter(), curve.LastParameter()].map((u, end) => {
    const result = curve.EvalD1(u);
    const d = xyz(result.D1);
    const size = Math.hypot(...d);
    const sign = end === 0 ? 1 : -1;
    return {
      point: xyz(result.Point),
      leaving: [(sign * d[0]) / size, (sign * d[1]) / size, (sign * d[2]) / size] as const,
    };
  });
}

/**
 * `seeds` and every edge reached from them through vertices where two edges continue each other
 * tangentially (their directions leaving the vertex are opposite), across any number of them.
 */
function tangentChain(env: QueryEnv, seeds: readonly Entity[]): Entity[] {
  const { oc } = env;
  const chain = new Map(seeds.map((seed) => [seed.id, seed]));
  const near = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= CONTAINS_TOLERANCE;
  for (const queue = [...seeds]; queue.length; ) {
    const edge = queue.pop()!;
    const ends = edgeEnds(oc, edge.shape);
    for (const vertex of subShapes(oc, edge.shape, "VERTEX")) {
      const at = xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex)));
      for (const other of env.state.entities.values()) {
        if (other.type !== "EDGE" || other.body !== edge.body || chain.has(other.id)) continue;
        if (!subShapes(oc, other.shape, "VERTEX").some((candidate) => candidate.IsSame(vertex)))
          continue;
        const tangent = ends
          .filter((end) => near(end.point, at))
          .some((end) =>
            edgeEnds(oc, other.shape)
              .filter((otherEnd) => near(otherEnd.point, at))
              .some(
                (otherEnd) =>
                  end.leaving[0] * otherEnd.leaving[0] +
                    end.leaving[1] * otherEnd.leaving[1] +
                    end.leaving[2] * otherEnd.leaving[2] <=
                  -Math.cos(TANGENT_ANGLE),
              ),
          );
        if (!tangent) continue;
        chain.set(other.id, other);
        queue.push(other);
      }
    }
  }
  return byOrder([...chain.values()]);
}

/**
 * Sketch regions that aren't inside another: those whose border touches the outer boundary of all
 * the regions together (std: "A region whose border has a vertex or edge on the outside boundary
 * is not considered contained").
 */
function outerRegions(oc: Oc, regions: readonly Entity[]): Entity[] {
  if (regions.length < 2) return [...regions];
  const fuse = new oc.BRepAlgoAPI_Fuse();
  fuse.SetArguments(toList(oc, [regions[0]!.shape]));
  fuse.SetTools(
    toList(
      oc,
      regions.slice(1).map((region) => region.shape),
    ),
  );
  fuse.Build(new oc.Message_ProgressRange());
  const unified = new oc.ShapeUpgrade_UnifySameDomain(fuse.Shape(), true, true, false);
  unified.Build();
  const boundary = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(boundary);
  for (const face of subShapes(oc, unified.Shape(), "FACE"))
    builder.Add(boundary, oc.BRepTools.OuterWire(oc.TopoDS.Face(face)));
  return regions.filter((region) => distance(oc, region.shape, boundary) < CONTAINS_TOLERANCE);
}

/** A numeric 3-vector from a query field; normalized unless `normalize` is false. */
function unitVector(value: FsValue, normalize = true): [number, number, number] {
  const [x, y, z] = (untag(value) as FsArray).map((c) => Number(untag(c)));
  const length = normalize ? Math.hypot(x!, y!, z!) || 1 : 1;
  return [x! / length, y! / length, z! / length];
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
