import { emptyGeometry, type GeometryState } from "../geometry/Model.ts";
import type { Oc } from "../geometry/occt.ts";
import { FsMap, FsTagged, keyOf, untag, type FsValue } from "./Value.ts";

/** The part of a context that `@abortFeature` rolls back. Immutable, so a snapshot is a reference. */
export interface ContextState {
  /** Variable name to `{ value, description }`. */
  readonly variables: FsMap;
  /** Query variable name to `{ value, description }`; a separate namespace from `variables`. */
  readonly queryVariables: FsMap;
  readonly geometry: GeometryState;
  /** The id (untagged) of the last operation that succeeded, for `lastOperationId`. */
  readonly lastOperation: FsValue;
  /** Entity id to the id of the last operation that created or changed its shape. */
  readonly modifiedBy: ReadonlyMap<string, FsValue>;
  /** Operations that ran, by `keyOf` their id: which builtin and its definition. */
  readonly operations: ReadonlyMap<string, OperationRecord>;
}

/** An operation that ran: the `op*` builtin and the definition it was given. */
export interface OperationRecord {
  readonly builtin: string;
  readonly definition: FsValue;
}

/**
 * The operations recorded by the time a geometry state was reached, so queries (which only see
 * the state) can tell what made an entity.
 */
const operationsAt = new WeakMap<GeometryState, ReadonlyMap<string, OperationRecord>>();
/** Whether operation `id` had run by the time `state` was reached. */
export const hasRun = (state: GeometryState, id: FsValue): boolean =>
  operationsAt.get(state)?.has(keyOf(untag(id))) === true;

/**
 * The operation that made an entity created by `createdBy`: the recorded operation whose id is
 * the longest prefix of it (a pattern's copies are created by its id plus an instance name).
 * Undefined when no operation of this run made it (a sketch, a STEP base, a picked point).
 */
export function creatorOf(
  state: GeometryState,
  createdBy: readonly string[],
): OperationRecord | undefined {
  const operations = operationsAt.get(state);
  for (let n = createdBy.length; n > 0; n--) {
    const found = operations?.get(keyOf(createdBy.slice(0, n)));
    if (found) return found;
  }
  return undefined;
}

const OK_STATUS = FsMap.fromEntries([["statusType", "OK"]]);

/**
 * A geometry state and the states its context went through to reach it, newest first. Each
 * geometry change (one or more per operation) is a step; a rolled-back feature's steps aren't in
 * the lineage of the state it rolls back to. Identity tracking reads it to tell a deleted entity
 * from a split or merged one.
 */
/** A `FeatureScriptVersionNumber` value's place in its enum; anything else sorts as newest. */
export const versionOrder = (version: FsValue): number =>
  version instanceof FsTagged && typeof version.value === "string"
    ? (version.tag.ordinals.get(version.value) ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;

export interface Lineage {
  readonly state: GeometryState;
  readonly previous: Lineage | null;
  /** Steps since the context was created; `lastOperationId` reports it. */
  readonly index: number;
}
const lineages = new WeakMap<GeometryState, Lineage>([
  [emptyGeometry, { state: emptyGeometry, previous: null, index: 0 }],
]);
/** How a context reached `state`, or undefined for a state no context holds. */
export const lineageOf = (state: GeometryState): Lineage | undefined => lineages.get(state);

/**
 * What a FeatureScript `Context` holds: variables, feature status, and (later) geometry.
 * FeatureScript sees it as an opaque builtin value.
 */
export class ModelContext {
  /** The `FeatureScriptVersionNumber` enum value the context was created with. */
  readonly version: FsValue;
  private state: ContextState = {
    variables: FsMap.empty,
    queryVariables: FsMap.empty,
    geometry: emptyGeometry,
    lastOperation: undefined,
    modifiedBy: new Map(),
    operations: new Map(),
  };
  /** The geometry kernel, or null when the runtime was created without one. */
  readonly oc: Oc | null;
  /** Feature id to status map. Kept across rollback, so a failed feature keeps its error. */
  private readonly statuses = new Map<string, FsMap>();
  /**
   * Open features by token, innermost last, each with the version it runs at: its parent's, or
   * lower when its definition holds it back with `asVersion`.
   */
  private readonly transactions = new Map<
    number,
    { readonly id: string; readonly state: ContextState; readonly version: FsValue }
  >();
  private nextToken = 1;
  /** Id of the most recently started top-level feature. */
  lastActiveId: FsValue = [];
  /** Feature and subfeature ids by the order they first started, for `valuesSortedById`. */
  private readonly started = new Map<string, number>();

  constructor(version: FsValue, oc: Oc | null) {
    this.version = version;
    this.oc = oc;
  }

  get geometry(): GeometryState {
    return this.state.geometry;
  }
  set geometry(geometry: GeometryState) {
    // A state seen before (a rollback) keeps the lineage and operations it had.
    if (!operationsAt.has(geometry)) operationsAt.set(geometry, this.state.operations);
    if (!lineages.has(geometry)) {
      const previous = lineages.get(this.state.geometry) ?? null;
      lineages.set(geometry, { state: geometry, previous, index: (previous?.index ?? 0) + 1 });
    }
    this.state = { ...this.state, geometry };
  }

  /** The version the innermost open feature runs at; std's version checks read it. */
  get activeVersion(): FsValue {
    return [...this.transactions.values()].at(-1)?.version ?? this.version;
  }

  /**
   * Starts a feature or operation; `abort` restores the context to this point. A definition's
   * `asVersion` holds it (and its subfeatures) back to that version, never forward.
   */
  start(id: FsValue, asVersion?: FsValue): number {
    const token = this.nextToken++;
    const key = keyOf(untag(id));
    const parent = this.activeVersion;
    const version =
      asVersion !== undefined && versionOrder(asVersion) < versionOrder(parent)
        ? asVersion
        : parent;
    this.transactions.set(token, { id: key, state: this.state, version });
    if (!this.started.has(key)) this.started.set(key, this.started.size);
    if ((untag(id) as readonly FsValue[]).length === 1) this.lastActiveId = id;
    return token;
  }
  /**
   * Finishes a feature, by token or (when std passes an empty token) by its id, and any feature
   * still open inside it.
   */
  end(token: number | null, id: FsValue) {
    const found = this.find(token, id);
    if (found !== undefined) this.closeFrom(found);
  }
  /**
   * Rolls back a feature's changes, with any feature still open inside it, so a child's held-back
   * version ends with it. Its status (and error) stays.
   */
  abort(token: number | null, id: FsValue) {
    const found = this.find(token, id);
    if (found === undefined) return;
    this.state = this.transactions.get(found)!.state;
    this.closeFrom(found);
  }
  /** Closes the transaction `token` and every one opened after it (they nest inside it). */
  private closeFrom(token: number) {
    let closing = false;
    // Deleting from a Map while iterating it is safe; later keys are still visited.
    for (const key of this.transactions.keys()) {
      closing ||= key === token;
      if (closing) this.transactions.delete(key);
    }
  }
  /** When `id` first started, counting from 0, or undefined if it never has. */
  startOrder(id: FsValue): number | undefined {
    return this.started.get(keyOf(untag(id)));
  }
  private find(token: number | null, id: FsValue): number | undefined {
    if (token !== null) return this.transactions.has(token) ? token : undefined;
    const key = keyOf(untag(id));
    return [...this.transactions].toReversed().find(([, t]) => t.id === key)?.[0];
  }

  getVariable(name: string): FsValue {
    const entry = this.state.variables.getField(name);
    return entry instanceof FsMap ? entry.getField("value") : undefined;
  }
  hasVariable(name: string) {
    return this.state.variables.getField(name) !== undefined;
  }
  setVariable(name: string, value: FsValue, description: FsValue) {
    this.state = {
      ...this.state,
      variables: this.state.variables.set(
        name,
        FsMap.fromEntries([
          ["value", value],
          ["description", description],
        ]),
      ),
    };
  }
  /**
   * Everything an operation can change (geometry and operation records), to put back with
   * `restore` when the operation fails partway. Immutable, so a reference is a snapshot.
   */
  snapshot(): ContextState {
    return this.state;
  }
  restore(snapshot: ContextState) {
    this.state = snapshot;
  }

  /**
   * Records a successful operation (an `op*` builtin) with `id`, given the geometry before it:
   * it's the last operation now, and the last to modify every entity it added or whose shape it
   * changed. Rolled back with the feature that ran it.
   */
  recordOperation(id: FsValue, before: GeometryState, builtin: string, definition: FsValue) {
    const after = this.state.geometry;
    const operation = untag(id);
    const modifiedBy = new Map<string, FsValue>();
    for (const [key, entity] of after.entities) {
      const previous = before.entities.get(key);
      const changed = !previous || !previous.shape.IsSame(entity.shape);
      const known = this.state.modifiedBy.get(key);
      if (changed) modifiedBy.set(key, operation);
      else if (known !== undefined) modifiedBy.set(key, known);
    }
    const operations = new Map(this.state.operations).set(keyOf(operation), {
      builtin,
      definition,
    });
    operationsAt.set(after, operations);
    this.state = { ...this.state, lastOperation: operation, modifiedBy, operations };
  }
  /** The last operation's id, or undefined before any has run. */
  get lastOperation(): FsValue {
    return this.state.lastOperation;
  }
  /**
   * The id of the last operation that created or changed an entity. Entities no operation has
   * touched (sketch output, a STEP base, picked points) were made by their `createdBy`.
   */
  lastModifyingOperation(entityId: string, createdBy: readonly string[]): FsValue {
    return this.state.modifiedBy.get(entityId) ?? [...createdBy];
  }

  /** A query `setQueryVariable` stored, or undefined when there's none of that name. */
  getQueryVariable(name: string): FsValue {
    const entry = this.state.queryVariables.getField(name);
    return entry instanceof FsMap ? entry.getField("value") : undefined;
  }
  setQueryVariable(name: string, value: FsValue, description: FsValue) {
    this.state = {
      ...this.state,
      queryVariables: this.state.queryVariables.set(
        name,
        FsMap.fromEntries([
          ["value", value],
          ["description", description],
        ]),
      ),
    };
  }

  /** Name to value. */
  variables(): FsMap {
    return FsMap.fromEntries(
      this.state.variables
        .entries()
        .map(([name, entry]) => [name, (entry as FsMap).getField("value")] as const),
    );
  }
  /** Name to `{ value, description }`. */
  variablesWithDescriptions(): FsMap {
    return this.state.variables;
  }

  status(id: FsValue): FsMap {
    return this.statuses.get(keyOf(untag(id))) ?? OK_STATUS;
  }
  setStatus(id: FsValue, status: FsMap) {
    this.statuses.set(keyOf(untag(id)), status);
  }
  clearStatus(id: FsValue) {
    this.statuses.delete(keyOf(untag(id)));
  }
}
