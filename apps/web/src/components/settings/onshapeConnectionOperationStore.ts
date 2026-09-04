import type { EnvironmentId, OnshapeConnectionSummary } from "@cadsense/contracts";

import { createExclusiveOperationRunner } from "./OnshapeConnectionsSettings.logic";

export type OnshapeConnectionOperationNotice =
  | {
      readonly _tag: "Pending";
      readonly key: string;
      readonly message: string;
    }
  | {
      readonly _tag: "Error";
      readonly key: string;
      readonly message: string;
    };

export interface OnshapeConnectionOperationSnapshot {
  readonly pendingKey: string | null;
  readonly notice: OnshapeConnectionOperationNotice | null;
  readonly completion: {
    readonly sequence: number;
    readonly key: string;
    readonly outcome: "Success" | "Interrupted";
  } | null;
  readonly overlays: ReadonlyMap<string, OnshapeConnectionOverlay>;
  readonly catalogUpdatedAt: string | null;
}

export interface OnshapeConnectionOverlay {
  readonly connection: OnshapeConnectionSummary | null;
  readonly updatedAt: string;
}

export type OnshapeConnectionOperationResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Error"; readonly message: string }
  | { readonly _tag: "Interrupted" };

export type OnshapeConnectionOperationRunResult<A> =
  | OnshapeConnectionOperationResult<A>
  | { readonly _tag: "AlreadyRunning" };

export interface OnshapeConnectionOperationStore {
  readonly getSnapshot: () => OnshapeConnectionOperationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dismissError: () => void;
  readonly recordConnection: (connection: OnshapeConnectionSummary) => void;
  readonly recordRemoval: (connectionId: string, updatedAt: string) => void;
  readonly reconcileCatalog: (catalogUpdatedAt: string) => void;
  readonly run: <A>(
    key: string,
    pendingMessage: string,
    unexpectedErrorMessage: string,
    operation: () => Promise<OnshapeConnectionOperationResult<A>>,
  ) => Promise<OnshapeConnectionOperationRunResult<A>>;
}

const IDLE_SNAPSHOT: OnshapeConnectionOperationSnapshot = {
  pendingKey: null,
  notice: null,
  completion: null,
  overlays: new Map(),
  catalogUpdatedAt: null,
};

export function createOnshapeConnectionOperationStore(): OnshapeConnectionOperationStore {
  const runner = createExclusiveOperationRunner();
  const listeners = new Set<() => void>();
  let snapshot = IDLE_SNAPSHOT;
  let completionSequence = 0;

  const publish = (next: OnshapeConnectionOperationSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const run = async <A>(
    key: string,
    pendingMessage: string,
    unexpectedErrorMessage: string,
    operation: () => Promise<OnshapeConnectionOperationResult<A>>,
  ): Promise<OnshapeConnectionOperationRunResult<A>> => {
    const guarded = await runner.run(async () => {
      publish({
        ...snapshot,
        pendingKey: key,
        notice: { _tag: "Pending", key, message: pendingMessage },
        completion: null,
      });
      let result: OnshapeConnectionOperationResult<A>;
      try {
        result = await operation();
      } catch {
        result = { _tag: "Error", message: unexpectedErrorMessage };
      }

      if (result._tag === "Error") {
        publish({
          ...snapshot,
          pendingKey: null,
          notice: { _tag: "Error", key, message: result.message },
          completion: null,
        });
      } else {
        completionSequence += 1;
        publish({
          ...snapshot,
          pendingKey: null,
          notice: null,
          completion: { sequence: completionSequence, key, outcome: result._tag },
        });
      }
      return result;
    });

    return guarded._tag === "AlreadyRunning" ? guarded : guarded.value;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismissError: () => {
      if (snapshot.notice?._tag === "Error") {
        publish({ ...snapshot, notice: null, completion: null });
      }
    },
    recordConnection: (connection) => {
      if (snapshot.catalogUpdatedAt !== null && snapshot.catalogUpdatedAt >= connection.updatedAt) {
        return;
      }
      const overlays = new Map(snapshot.overlays);
      overlays.set(connection.connectionId, {
        connection,
        updatedAt: connection.updatedAt,
      });
      publish({ ...snapshot, overlays });
    },
    recordRemoval: (connectionId, updatedAt) => {
      if (snapshot.catalogUpdatedAt !== null && snapshot.catalogUpdatedAt >= updatedAt) return;
      const overlays = new Map(snapshot.overlays);
      overlays.set(connectionId, { connection: null, updatedAt });
      publish({ ...snapshot, overlays });
    },
    reconcileCatalog: (catalogUpdatedAt) => {
      if (snapshot.catalogUpdatedAt !== null && snapshot.catalogUpdatedAt > catalogUpdatedAt)
        return;
      const overlays = new Map(snapshot.overlays);
      for (const [connectionId, overlay] of overlays) {
        if (catalogUpdatedAt >= overlay.updatedAt) overlays.delete(connectionId);
      }
      if (
        overlays.size !== snapshot.overlays.size ||
        catalogUpdatedAt !== snapshot.catalogUpdatedAt
      ) {
        publish({ ...snapshot, overlays, catalogUpdatedAt });
      }
    },
    run,
  };
}

const sharedStores = new Map<EnvironmentId, OnshapeConnectionOperationStore>();

export function onshapeConnectionOperationStore(
  environmentId: EnvironmentId,
): OnshapeConnectionOperationStore {
  const existing = sharedStores.get(environmentId);
  if (existing !== undefined) return existing;
  const created = createOnshapeConnectionOperationStore();
  sharedStores.set(environmentId, created);
  return created;
}
