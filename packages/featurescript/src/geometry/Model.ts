import { FsFault } from "../runtime/Errors.ts";
import type { FsValue } from "../runtime/Value.ts";
import { fromList, seamEdges, ShapeSet, subShapes, type Oc, type Shape } from "./occt.ts";

/** A FeatureScript attribute on an entity. Unnamed ones are std's legacy form. */
export interface EntityAttribute {
  readonly name: string | null;
  readonly value: FsValue;
}

export type EntityType = "BODY" | "FACE" | "EDGE" | "VERTEX";
/** Matches std's `BodyType` members we produce. */
export type BodyType = "SOLID" | "SHEET" | "WIRE" | "POINT" | "MATE_CONNECTOR";

/** A mate connector's coordinate system: origin in meters, unit x and z axes. */
export interface Frame {
  readonly origin: readonly [number, number, number];
  readonly xAxis: readonly [number, number, number];
  readonly zAxis: readonly [number, number, number];
}

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
  /**
   * A body's properties from `setProperty`, keyed by `PropertyType` member (`"NAME"`) or
   * `CUSTOM:<id>`. They stay with the body's id through operations. Empty on faces, edges, vertices.
   */
  readonly properties: ReadonlyMap<string, FsValue>;
  /** Creation order; query results follow it. */
  readonly order: number;
  /** A mate connector's coordinate system, on its body and its one vertex. */
  readonly frame?: Frame;
}

/** Everything geometric in a context. Immutable, so rolling back a feature is keeping a reference. */
export interface GeometryState {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly next: number;
  /**
   * For each entity id, the ids of the entities it came from other than itself, gathered over every
   * operation that made or changed it: a split face's pieces name the face, a face that absorbed
   * others in a merge names them, a face OpenCascade generated from an edge names the edge. Entries
   * outlive their entities, so a chain of operations can be followed back.
   */
  readonly lineage: ReadonlyMap<string, readonly string[]>;
}

export const emptyGeometry: GeometryState = { entities: new Map(), next: 1, lineage: new Map() };

/** `lineage` with `id` also coming from `sources` (never from itself). */
function descend(
  lineage: Map<string, readonly string[]>,
  id: string,
  sources: Iterable<string>,
): void {
  const all = [...new Set([...(lineage.get(id) ?? []), ...sources])].filter(
    (source) => source !== id,
  );
  if (all.length) lineage.set(id, all);
}

export const NO_PROPERTIES: ReadonlyMap<string, FsValue> = new Map();

/** Per-entity details an operation knows about (caps, sketch origin, construction, copies). */
export type Annotate = (
  shape: Shape,
  type: EntityType,
) => Partial<Pick<Entity, "cap" | "sketch" | "construction" | "attributes" | "properties">>;

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
 * only sit on closed edges (a full circle has none in Parasolid). A seam is an edge closed on the one
 * face that uses it; where a cut left another face on it too (a half-lap across a pin's seam),
 * OpenCascade keeps it closed on the periodic face, but it's a real edge.
 */
export function topology(
  oc: Oc,
  shape: Shape,
): { faces: Shape[]; edges: Shape[]; vertices: Shape[] } {
  const allEdges = subShapes(oc, shape, "EDGE");
  // A point body: just its vertex.
  if (allEdges.length === 0)
    return { faces: [], edges: [], vertices: subShapes(oc, shape, "VERTEX") };
  const faces = subShapes(oc, shape, "FACE");
  const users = new ShapeSet<number>(oc);
  for (const face of faces)
    for (const edge of subShapes(oc, face, "EDGE")) users.set(edge, (users.get(edge) ?? 0) + 1);
  const seams = seamEdges(oc, shape);
  const edges = allEdges.filter(
    (edge) =>
      !(seams.has(edge) && users.get(edge) === 1) &&
      !oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)),
  );
  const bounding = new ShapeSet<true>(oc);
  for (const edge of edges)
    if (!oc.BRep_Tool.IsClosed(edge))
      for (const vertex of subShapes(oc, edge, "VERTEX")) bounding.set(vertex, true);
  return {
    faces,
    edges,
    vertices: subShapes(oc, shape, "VERTEX").filter((vertex) => bounding.has(vertex)),
  };
}

/**
 * The loosest vertex or edge tolerance a body may have, in meters. OpenCascade's chamfers leave
 * 1e-4 m; an inward offset turned inside out leaves 1e-3 m and still passes OpenCascade's check.
 * STEP imports are held to it too: the loosest of 45 sample files measured 6.9e-5 m.
 */
export const LOOSEST_TOLERANCE = 5e-4;

/** The largest vertex or edge tolerance in `shape`, in meters. */
export function loosestTolerance(oc: Oc, shape: Shape): number {
  let loosest = 0;
  for (const vertex of subShapes(oc, shape, "VERTEX"))
    loosest = Math.max(loosest, oc.BRep_Tool.Tolerance(oc.TopoDS.Vertex(vertex)));
  for (const edge of subShapes(oc, shape, "EDGE"))
    loosest = Math.max(loosest, oc.BRep_Tool.Tolerance(oc.TopoDS.Edge(edge)));
  return loosest;
}

/**
 * Why a body's shape is one no operation should report (OpenCascade built something invalid), or
 * null. Points and mate connectors are single vertices; wires and sheets must pass OpenCascade's
 * full check, geometry included (it alone catches a thicken deeper than a face's radius), and stay
 * within {@link LOOSEST_TOLERANCE}; solids must also be closed with a positive volume. It costs
 * about 6% of the test suite's time.
 */

function invalidity(oc: Oc, shape: Shape, bodyType: BodyType): string | null {
  if (bodyType === "POINT" || bodyType === "MATE_CONNECTOR") return null;
  if (!new oc.BRepCheck_Analyzer(shape, true, false).IsValid()) return "fails OpenCascade's check";
  if (loosestTolerance(oc, shape) > LOOSEST_TOLERANCE) return "has tolerances over 0.5 mm";
  if (bodyType !== "SOLID") return null;
  if (!subShapes(oc, shape, "SHELL").every((shell) => oc.BRep_Tool.IsClosed(shell)))
    return "isn't closed";
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass() > 0 ? null : "has no positive volume";
}

/**
 * Stops the run when an operation's result body is invalid: not a status Onshape would report and
 * not an error FeatureScript can catch, since which error Onshape would raise isn't known. Builtins
 * that know their std error should check first; this is the backstop for every operation.
 */
function assertValid(oc: Oc, shape: Shape, bodyType: BodyType, createdBy: readonly string[]) {
  const why = invalidity(oc, shape, bodyType);
  if (why)
    throw new FsFault(
      "internal",
      `${createdBy.join(".")} produced an invalid ${bodyType.toLowerCase()} body (the kernel's shape ${why}); stopping rather than reporting a shape Onshape wouldn't make.`,
      [],
    );
}

interface NewBody {
  readonly shape: Shape;
  readonly bodyType: BodyType;
  readonly createdBy: readonly string[];
  readonly construction?: boolean;
  readonly annotate?: Annotate;
  readonly frame?: Frame;
  /** Ids of existing entities a new entity copies (a pattern's copy names its seed's entities). */
  readonly sources?: (shape: Shape, type: EntityType) => readonly string[];
}

/** Adds brand-new bodies (and their topology), created by one operation. */
export function addBodies(
  oc: Oc,
  state: GeometryState,
  bodies: readonly NewBody[],
): { state: GeometryState; ids: string[] } {
  const entities = new Map(state.entities);
  const lineage = new Map(state.lineage);
  let next = state.next;
  const ids: string[] = [];
  for (const body of bodies) {
    assertValid(oc, body.shape, body.bodyType, body.createdBy);
    const bodyId = `T${next++}`;
    ids.push(bodyId);
    if (body.sources) descend(lineage, bodyId, body.sources(body.shape, "BODY"));
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
      properties: NO_PROPERTIES,
      order: next,
      ...(body.frame ? { frame: body.frame } : {}),
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
        if (body.sources) descend(lineage, id, body.sources(shape, type));
      }
  }
  return { state: { entities, next, lineage }, ids };
}

/** Removes bodies and everything they own. */
export function removeBodies(state: GeometryState, bodyIds: readonly string[]): GeometryState {
  const gone = new Set(bodyIds);
  return {
    entities: new Map([...state.entities].filter(([, entity]) => !gone.has(entity.body))),
    next: state.next,
    lineage: state.lineage,
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
  /** Result body shapes; a moved mate connector brings its moved frame. */
  readonly results: readonly {
    readonly shape: Shape;
    readonly bodyType: BodyType;
    readonly frame?: Frame;
  }[];
  readonly history: History;
  /** Id components of the operation, for anything it creates. */
  readonly createdBy: readonly string[];
  readonly annotate?: Annotate;
  /** Ids of entities a result entity copies beyond what `history` says (a face pattern's seed). */
  readonly sources?: (shape: Shape, type: EntityType) => readonly string[];
}

/**
 * Replaces bodies after an operation, carrying transient ids across it with OpenCascade's history:
 * unchanged entities (the same shape still in the result, even where the history calls it deleted)
 * and one-to-one modified ones keep their ids; split ones get new ids but keep their creator;
 * generated and unexplained ones are new, created by the operation. What an entity is
 * (construction, sketch origin, cap, attributes) follows it to whatever continues it.
 */
export function replaceBodies(
  oc: Oc,
  state: GeometryState,
  replacement: Replacement,
): { state: GeometryState; ids: string[] } {
  const consumed = new Set(replacement.consumed);
  // In creation order, so when entities merge into one shape the oldest keeps its id, however
  // earlier operations happened to reinsert them.
  const old = [...state.entities.values()]
    .filter((entity) => consumed.has(entity.body) && entity.type !== "BODY")
    .sort((a, b) => a.order - b.order);
  const entities = new Map([...state.entities].filter(([, entity]) => !consumed.has(entity.body)));
  const lineage = new Map(state.lineage);
  let next = state.next;
  const ids: string[] = [];
  const usedBodyIds = new Set<string>();
  // Ids already given to a face, edge or vertex of an earlier result body. Bodies that touched
  // going in can share a face coming out (two targets cut by one tool); each owns its own entity.
  const usedIds = new Set<string>();
  for (const result of replacement.results)
    assertValid(oc, result.shape, result.bodyType, replacement.createdBy);
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
    // New sub-shape -> every old entity it came from (split, merged or generated), for lineage.
    const origins = new ShapeSet<Entity[]>(oc);
    const cameFrom = (shape: Shape, entity: Entity) => {
      if (present.has(shape)) origins.set(shape, [...(origins.get(shape) ?? []), entity]);
    };
    for (const entity of old) {
      for (const shape of replacement.history.generated(entity.shape)) cameFrom(shape, entity);
      // A shape still in the result wasn't deleted, whatever the history says: OpenCascade's
      // fillet and chamfer report every edge and face they don't touch as deleted.
      if (replacement.history.deleted(entity.shape) && !present.has(entity.shape)) continue;
      const allModified = replacement.history
        .modified(entity.shape)
        .filter((shape) => inAnyResult.has(shape));
      const modified = allModified.filter((shape) => present.has(shape));
      for (const shape of modified.length ? modified : [entity.shape]) cameFrom(shape, entity);
      // An entity an earlier body continued can't continue here too; another may claim the shape.
      if (usedIds.has(entity.id)) continue;
      if (modified.length === 0 && present.has(entity.shape) && !assigned.has(entity.shape))
        assigned.set(entity.shape, { id: entity.id, from: entity });
      for (const shape of modified)
        if (!assigned.has(shape))
          assigned.set(shape, { id: allModified.length === 1 ? entity.id : null, from: entity });
    }
    // The body keeps the id of the target it mostly came from. Wire and point bodies (mate
    // connectors) have no faces, so their edges or vertices vote instead.
    const votes = new Map<string, number>();
    for (const voters of [faces, edges, vertices]) {
      for (const shape of voters) {
        const from = assigned.get(shape)?.from;
        if (from && replacement.keepIds.includes(from.body))
          votes.set(from.body, (votes.get(from.body) ?? 0) + 1);
      }
      if (votes.size > 0) break;
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
    descend(
      lineage,
      bodyId,
      [faces, edges, vertices].flatMap((shapes) =>
        shapes.flatMap((shape) => (origins.get(shape) ?? []).map((origin) => origin.body)),
      ),
    );
    entities.set(bodyId, {
      id: bodyId,
      type: "BODY",
      shape: result.shape,
      body: bodyId,
      bodyType: result.bodyType,
      createdBy: keptEntity?.createdBy ?? replacement.createdBy,
      construction: keptEntity?.construction ?? false,
      sketch: null,
      cap: null,
      attributes: keptEntity?.attributes ?? [],
      properties: keptEntity?.properties ?? NO_PROPERTIES,
      order: keptEntity?.order ?? next,
      ...(result.frame ? { frame: result.frame } : {}),
    });
    for (const [type, shapes] of [
      ["FACE", faces],
      ["EDGE", edges],
      ["VERTEX", vertices],
    ] as const)
      for (const shape of shapes) {
        const link = assigned.get(shape);
        const id = link?.id && !usedIds.has(link.id) ? link.id : `T${next++}`;
        usedIds.add(id);
        descend(lineage, id, [
          ...(origins.get(shape) ?? []).map((origin) => origin.id),
          ...(replacement.sources?.(shape, type) ?? []),
        ]);
        entities.set(id, {
          id,
          type,
          shape,
          body: bodyId,
          bodyType: result.bodyType,
          createdBy: link?.from?.createdBy ?? replacement.createdBy,
          construction: link?.from?.construction ?? false,
          sketch: link?.from?.sketch ?? null,
          cap: link?.from?.cap ?? null,
          attributes: link?.from?.attributes ?? [],
          properties: NO_PROPERTIES,
          order: link?.id ? link.from!.order : next,
          ...(result.frame && type === "VERTEX" ? { frame: result.frame } : {}),
          ...replacement.annotate?.(shape, type),
        });
      }
  });
  return { state: { entities, next, lineage }, ids };
}

/** A copy of `state` with `update` applied to the entities in `ids`, e.g. to set attributes. */
export function updateEntities(
  state: GeometryState,
  ids: readonly string[],
  update: (entity: Entity) => Entity,
): GeometryState {
  const entities = new Map(state.entities);
  for (const id of ids) {
    const entity = entities.get(id);
    if (entity) entities.set(id, update(entity));
  }
  return { entities, next: state.next, lineage: state.lineage };
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

/** `shapes` without repeats of one shape (`IsSame`). */
function distinct(shapes: readonly Shape[]): Shape[] {
  return shapes.filter((shape, i) => shapes.findIndex((other) => other.IsSame(shape)) === i);
}

/**
 * What `history` turned `shape` into: nothing if deleted, its images if modified, else itself.
 * Each image once, so a face split and merged back again reads as one face, not a split.
 */
export function imagesOf(history: History, shape: Shape): Shape[] {
  if (history.deleted(shape)) return [];
  const modified = history.modified(shape);
  return modified.length ? distinct(modified) : [shape];
}

/**
 * Two operations run one after the other, as one history: what `first` made of a shape, carried
 * through `second`. For direct edits that chain booleans (fill, then cut) on the same body.
 */
export function chainHistory(first: History, second: History): History {
  const images = (shape: Shape) =>
    distinct(imagesOf(first, shape).flatMap((image) => imagesOf(second, image)));
  return {
    deleted: (shape) => images(shape).length === 0,
    modified: (shape) => {
      const out = images(shape);
      return out.length === 1 && out[0]!.IsSame(shape) ? [] : out;
    },
    generated: (shape) => [
      ...first.generated(shape).flatMap((made) => imagesOf(second, made)),
      ...imagesOf(first, shape).flatMap((image) => second.generated(image)),
    ],
  };
}

/**
 * A name an operation gave one of the faces, edges or vertices it made: `opHole`'s face names
 * (`qOpHoleFace`) and profile names (`qOpHoleProfile`).
 */
export interface TopologyName {
  readonly kind: "HOLE_FACE" | "HOLE_PROFILE";
  /** Id components of the naming operation. */
  readonly operation: readonly string[];
  readonly name: string | null;
  /** Transient id of the entity that identifies the hole (`opHole`'s `identities`), if given. */
  readonly identity: string | null;
}

const topologyNames = new WeakMap<Oc, ShapeSet<TopologyName[]>>();

/**
 * Records `name` on `shape` (once). Names belong to that exact face, edge or vertex, so a later
 * operation that rebuilds it drops them; rolling a feature back can't leave stale names, since its
 * shapes are gone with it. A boolean can share one face between a kept tool and its target; both
 * then carry the name.
 */
export function nameTopology(oc: Oc, shape: Shape, name: TopologyName): void {
  const names = topologyNames.get(oc) ?? new ShapeSet<TopologyName[]>(oc);
  topologyNames.set(oc, names);
  const existing = names.get(shape) ?? [];
  const same = (other: TopologyName) =>
    other.kind === name.kind &&
    other.name === name.name &&
    other.identity === name.identity &&
    other.operation.join("/") === name.operation.join("/");
  if (!existing.some(same)) names.set(shape, [...existing, name]);
}

/** Names operations recorded on `shape`, for the queries that find them. */
export const topologyNamesOf = (oc: Oc, shape: Shape): readonly TopologyName[] =>
  topologyNames.get(oc)?.get(shape) ?? [];
