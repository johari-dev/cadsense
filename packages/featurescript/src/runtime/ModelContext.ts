import { FsMap, keyOf, untag, type FsValue } from "./Value.ts";

/** The part of a context that `@abortFeature` rolls back. Immutable, so a snapshot is a reference. */
interface ContextState {
  /** Variable name to `{ value, description }`. */
  readonly variables: FsMap;
}

const OK_STATUS = FsMap.fromEntries([["statusType", "OK"]]);

/**
 * What a FeatureScript `Context` holds: variables, feature status, and (later) geometry.
 * FeatureScript sees it as an opaque builtin value.
 */
export class ModelContext {
  /** The `FeatureScriptVersionNumber` enum value the context was created with. */
  readonly version: FsValue;
  private state: ContextState = { variables: FsMap.empty };
  /** Feature id to status map. Kept across rollback, so a failed feature keeps its error. */
  private readonly statuses = new Map<string, FsMap>();
  /** Open features and operations by token, innermost last. */
  private readonly transactions = new Map<
    number,
    { readonly id: string; readonly state: ContextState }
  >();
  private nextToken = 1;
  /** Id of the most recently started top-level feature. */
  lastActiveId: FsValue = [];

  constructor(version: FsValue) {
    this.version = version;
  }

  /** Starts a feature or operation; `abort` restores the context to this point. */
  start(id: FsValue): number {
    const token = this.nextToken++;
    this.transactions.set(token, { id: keyOf(untag(id)), state: this.state });
    if ((untag(id) as readonly FsValue[]).length === 1) this.lastActiveId = id;
    return token;
  }
  /** Finishes a feature, by token or (when std passes an empty token) by its id. */
  end(token: number | null, id: FsValue) {
    const found = this.find(token, id);
    if (found !== undefined) this.transactions.delete(found);
  }
  /** Rolls back a feature's changes. Its status (and error) stays. */
  abort(token: number | null, id: FsValue) {
    const found = this.find(token, id);
    if (found === undefined) return;
    this.state = this.transactions.get(found)!.state;
    this.transactions.delete(found);
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
      variables: this.state.variables.set(
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
