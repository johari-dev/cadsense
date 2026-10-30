import type { FsValue } from "../runtime/Value.ts";
import { fromList, seamEdges, ShapeSet, subShapes, type Oc, type Shape } from "./occt.ts";

/** A FeatureScript attribute on an entity. Unnamed ones are std's legacy form. */
export interface EntityAttribute {
  readonly name: string | null;
  readonly value: FsValue;
}

export type EntityType = "BODY" | "FACE" | "EDGE" | "VERTEX";
/** Matches std's `BodyType` members we produce. */
export type BodyType = "SOLID" | "SHEET" | "WIRE" | "POINT";

/** Where a sketch entity came from. */
export interface SketchOrigin {
  /** The sketch feature's id components. */
  readonly sketchId: readonly string[];
  /** The sketch entity id (`"hole0"`), or null for regions. */
  readonly entityId: string | null;
}

/** A body, face, edge or vertex with a transient id that lasts for the life of the context. */
export interface Entity {
  readonly id: string;
  readonly type: EntityType;
  readonly shape: Shape;
  /** Id of the owning body; a body's is its own. */
  readonly body: string;
  readonly bodyType: BodyType;
  /** Id components of the operation that created it. `qCreatedBy` matches by prefix. */
  readonly createdBy: readonly string[];
  readonly construction: boolean;
  readonly sketch: SketchOrigin | null;
  /** Extrude caps, for `qCapEntity`. */
  readonly cap: "START" | "END" | null;
  /** Attributes follow the entity through operations, and split pieces inherit them. */
  readonly attributes: readonly EntityAttribute[];
  /** Creation order; query results follow it. */
  readonly order: number;
}

/** Everything geometric in a context. Immutable, so rolling back a feature is keeping a reference. */
export interface GeometryState {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly next: number;
}

export const emptyGeometry: GeometryState = { entities: new Map(), next: 1 };

/** Per-entity details an operation knows about (caps, sketch origin, construction). */
export type Annotate = (
  shape: Shape,
  type: EntityType,
) => Partial<Pick<Entity, "cap" | "sketch" | "construction" | "attributes">>;

/** What an OpenCascade operation did to one input sub-shape. */
export interface History {
  deleted(shape: Shape): boolean;
  modified(shape: Shape): Shape[];
  generated(shape: Shape): Shape[];
}

/** History from an OpenCascade algorithm (`BRepAlgoAPI_*`, `BRepBuilderAPI_MakeShape`). */
export function historyOf(
  oc: Oc,
  algorithm: {
    Modified(s: Shape): InstanceType<Oc["NCollection_List_TopoDS_Shape"]>;
    Generated(s: Shape): InstanceType<Oc["NCollection_List_TopoDS_Shape"]>;
    IsDeleted(s: Shape): boolean;
  },
): History {
  return {
    deleted: (shape) => algorithm.IsDeleted(shape),
    modified: (shape) => fromList(oc, algorithm.Modified(shape)),
    generated: (shape) => fromList(oc, algorithm.Generated(shape)),
  };
}

/**
 * The faces, edges and vertices Onshape would report for `shape`: no seam edges, and no vertices that
 * only sit on closed edges (a full circle has none in Parasolid).
 */
export function topology(
  oc: Oc,
  shape: Shape,
): { faces: Shape[]; edges: Shape[]; vertices: Shape[] } {
  const allEdges = subShapes(oc, shape, "EDGE");
  // A point body: just its vertex.
  if (allEdges.length === 0)
    return { faces: [], edges: [], vertices: subShapes(oc, shape, "VERTEX") };
  const seams = seamEdges(oc, shape);
  const edges = allEdges.filter(
    (edge) => !seams.has(edge) && !oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)),
  );
  const bounding = new ShapeSet<true>(oc);
  for (const edge of edges)
    if (!oc.BRep_Tool.IsClosed(edge))
      for (const vertex of subShapes(oc, edge, "VERTEX")) bounding.set(vertex, true);
  return {
    faces: subShapes(oc, shape, "FACE"),
    edges,
    vertices: subShapes(oc, shape, "VERTEX").filter((vertex) => bounding.has(vertex)),
  };
}

interface NewBody {
  readonly shape: Shape;
  readonly bodyType: BodyType;
  readonly createdBy: readonly string[];
  readonly construction?: boolean;
  readonly annotate?: Annotate;
}

/** Adds brand-new bodies (and their topology), created by one operation. */
export function addBodies(
  oc: Oc,
  state: GeometryState,
  bodies: readonly NewBody[],
): { state: GeometryState; ids: string[] } {
  const entities = new Map(state.entities);
  let next = state.next;
  const ids: string[] = [];
  for (const body of bodies) {
    const bodyId = `T${next++}`;
    ids.push(bodyId);
    const make = (shape: Shape, type: EntityType, id: string): Entity => ({
      id,
      type,
      shape,
      body: bodyId,
      bodyType: body.bodyType,
      createdBy: body.createdBy,
      construction: body.construction ?? false,
      sketch: null,
      cap: null,
      attributes: [],
      order: next,
      ...body.annotate?.(shape, type),
    });
    entities.set(bodyId, make(body.shape, "BODY", bodyId));
    const { faces, edges, vertices } = topology(oc, body.shape);
    for (const [type, shapes] of [
      ["FACE", faces],
      ["EDGE", edges],
      ["VERTEX", vertices],
    ] as const)
      for (const shape of shapes) {
        const id = `T${next++}`;
        entities.set(id, make(shape, type, id));
      }
  }
  return { state: { entities, next }, ids };
}

/** Removes bodies and everything they own. */
export function removeBodies(state: GeometryState, bodyIds: readonly string[]): GeometryState {
  const gone = new Set(bodyIds);
  return {
    entities: new Map([...state.entities].filter(([, entity]) => !gone.has(entity.body))),
    next: state.next,
  };
}

interface Replacement {
  /** Bodies whose shapes went into the operation; all are replaced. */
  readonly consumed: readonly string[];
  /** Bodies that may keep their ids in the result (boolean targets, or union tools). */
  readonly keepIds: readonly string[];
  /**
   * Which candidate keeps its id: the one contributing the most faces (subtraction keeps a target's
   * identity), or the earliest in `keepIds` that contributes at all (union keeps the first tool's).
   */
  readonly keepIdBy?: "most" | "earliest";
  /** Result body shapes. */
  readonly results: readonly { readonly shape: Shape; readonly bodyType: BodyType }[];
  readonly history: History;
  /** Id components of the operation, for anything it creates. */
  readonly createdBy: readonly string[];
  readonly annotate?: Annotate;
}

/**
 * Replaces bodies after an operation, carrying transient ids across it with OpenCascade's history:
 * unchanged and one-to-one modified entities keep their ids; split ones get new ids but keep their
 * creator; generated and unexplained ones are new, created by the operation.
 */
export function replaceBodies(
  oc: Oc,
  state: GeometryState,
  replacement: Replacement,
): { state: GeometryState; ids: string[] } {
  const consumed = new Set(replacement.consumed);
  const old = [...state.entities.values()].filter(
    (entity) => consumed.has(entity.body) && entity.type !== "BODY",
  );
  const entities = new Map([...state.entities].filter(([, entity]) => !consumed.has(entity.body)));
  let next = state.next;
  const ids: string[] = [];
  const usedBodyIds = new Set<string>();
  const topologies = replacement.results.map((result) => topology(oc, result.shape));
  // Sub-shapes across every result: a face split between two result bodies is a 1:n change, so
  // neither piece may continue its id, even though each body holds only one of them.
  const inAnyResult = new ShapeSet<true>(oc);
  for (const { faces, edges, vertices } of topologies)
    for (const shape of [...faces, ...edges, ...vertices]) inAnyResult.set(shape, true);

  replacement.results.forEach((result, index) => {
    const { faces, edges, vertices } = topologies[index]!;
    const present = new ShapeSet<"FACE" | "EDGE" | "VERTEX">(oc);
    for (const face of faces) present.set(face, "FACE");
    for (const edge of edges) present.set(edge, "EDGE");
    for (const vertex of vertices) present.set(vertex, "VERTEX");
    // New sub-shape -> the entity it continues (or a creator for a fresh one).
    const assigned = new ShapeSet<{ id: string | null; from: Entity | null }>(oc);
    for (const entity of old) {
      if (replacement.history.deleted(entity.shape)) continue;
      const allModified = replacement.history
        .modified(entity.shape)
        .filter((shape) => inAnyResult.has(shape));
      const modified = allModified.filter((shape) => present.has(shape));
      if (modified.length === 0 && present.has(entity.shape) && !assigned.has(entity.shape))
        assigned.set(entity.shape, { id: entity.id, from: entity });
      for (const shape of modified)
        if (!assigned.has(shape))
          assigned.set(shape, { id: allModified.length === 1 ? entity.id : null, from: entity });
    }
    // The body keeps the id of the target it mostly came from.
    const votes = new Map<string, number>();
    for (const face of faces) {
      const from = assigned.get(face)?.from;
      if (from && replacement.keepIds.includes(from.body))
        votes.set(from.body, (votes.get(from.body) ?? 0) + 1);
    }
    const candidates = [...votes].filter(([id]) => !usedBodyIds.has(id));
    const keptBody =
      replacement.keepIdBy === "earliest"
        ? replacement.keepIds.find((id) => candidates.some(([candidate]) => candidate === id))
        : candidates.sort((a, b) => b[1] - a[1])[0]?.[0];
    const keptEntity = keptBody ? state.entities.get(keptBody) : undefined;
    const bodyId = keptBody ?? `T${next++}`;
    usedBodyIds.add(bodyId);
    ids.push(bodyId);
    entities.set(bodyId, {
      id: bodyId,
      type: "BODY",
      shape: result.shape,
      body: bodyId,
      bodyType: result.bodyType,
      createdBy: keptEntity?.createdBy ?? replacement.createdBy,
      construction: false,
      sketch: null,
      cap: null,
      attributes: keptEntity?.attributes ?? [],
      order: keptEntity?.order ?? next,
    });
    for (const [type, shapes] of [
      ["FACE", faces],
      ["EDGE", edges],
      ["VERTEX", vertices],
    ] as const)
      for (const shape of shapes) {
        const link = assigned.get(shape);
        const id = link?.id ?? `T${next++}`;
        entities.set(id, {
          id,
          type,
          shape,
          body: bodyId,
          bodyType: result.bodyType,
          createdBy: link?.from?.createdBy ?? replacement.createdBy,
          construction: false,
          sketch: link?.from?.sketch ?? null,
          cap: link?.from?.cap ?? null,
          attributes: link?.from?.attributes ?? [],
          order: link?.id ? link.from!.order : next,
          ...replacement.annotate?.(shape, type),
        });
      }
  });
  return { state: { entities, next }, ids };
}

/** A copy of `state` with `update` applied to the attributes of the entities in `ids`. */
export function withAttributes(
  state: GeometryState,
  ids: readonly string[],
  update: (attributes: readonly EntityAttribute[]) => readonly EntityAttribute[],
): GeometryState {
  const entities = new Map(state.entities);
  for (const id of ids) {
    const entity = entities.get(id);
    if (entity) entities.set(id, { ...entity, attributes: update(entity.attributes) });
  }
  return { entities, next: state.next };
}

/** Entities in creation order. */
export const ordered = (
  state: GeometryState,
  filter: (entity: Entity) => boolean = () => true,
): Entity[] =>
  [...state.entities.values()]
    .filter(filter)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en", { numeric: true }));

/** True when `id` starts with all of `prefix`'s components. */
export const startsWith = (id: readonly string[], prefix: readonly string[]) =>
  prefix.length <= id.length && prefix.every((part, i) => id[i] === part);
