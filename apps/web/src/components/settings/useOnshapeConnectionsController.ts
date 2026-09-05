import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import { EnvironmentId, type OnshapeConnectionSummary } from "@cadsense/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ensureLocalApi } from "../../localApi";
import { onshapeConnectionEnvironment } from "../../state/onshapeConnections";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type OnshapeConnectionDraft,
  type OnshapeCredentialDraft,
  safeOnshapeConnectionErrorMessage,
} from "./OnshapeConnectionsSettings.logic";
import {
  onshapeConnectionOperationStore,
  type OnshapeConnectionOperationSnapshot,
} from "./onshapeConnectionOperationStore";

export type OnshapeConnectionEditor =
  | { readonly kind: "add" }
  | { readonly kind: "rename"; readonly connectionId: string }
  | { readonly kind: "replace"; readonly connectionId: string }
  | null;

const EMPTY_ONSHAPE_CONNECTIONS: ReadonlyArray<OnshapeConnectionSummary> = [];

function useSharedOperationSnapshot(
  operation: ReturnType<typeof onshapeConnectionOperationStore>,
): OnshapeConnectionOperationSnapshot {
  return useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
}

export function useOnshapeConnectionPendingKey(environmentId: EnvironmentId | null): string | null {
  const fallbackEnvironmentId = EnvironmentId.make("onshape-connections:no-environment");
  return useSharedOperationSnapshot(
    onshapeConnectionOperationStore(environmentId ?? fallbackEnvironmentId),
  ).pendingKey;
}

/**
 * Owns the connection catalog's interaction state. The view only chooses how
 * to present this interface; request serialization, redaction-safe errors,
 * confirmation, and stale-list reconciliation stay behind this seam.
 */
export function useOnshapeConnectionsController(environmentId: EnvironmentId) {
  const {
    data,
    error: listError,
    isPending: isListPending,
    refresh,
  } = useEnvironmentQuery(onshapeConnectionEnvironment.list({ environmentId, input: {} }));
  const createConnection = useAtomCommand(onshapeConnectionEnvironment.create, {
    reportFailure: false,
  });
  const renameConnection = useAtomCommand(onshapeConnectionEnvironment.rename, {
    reportFailure: false,
  });
  const replaceCredentials = useAtomCommand(onshapeConnectionEnvironment.replaceCredentials, {
    reportFailure: false,
  });
  const removeConnection = useAtomCommand(onshapeConnectionEnvironment.remove, {
    reportFailure: false,
  });
  const [editor, setEditor] = useState<OnshapeConnectionEditor>(null);
  const [editorInvalidation, setEditorInvalidation] = useState<string | null>(null);
  const operationStore = onshapeConnectionOperationStore(environmentId);
  const operationSnapshot = useSharedOperationSnapshot(operationStore);
  const pendingKey = operationSnapshot.pendingKey;
  const overlays = operationSnapshot.overlays;
  const serverConnections = data?.connections ?? EMPTY_ONSHAPE_CONNECTIONS;
  const currentRefresh = useRef(refresh);
  currentRefresh.current = refresh;

  useEffect(() => {
    if (data === null) return;
    operationStore.reconcileCatalog(data.catalogUpdatedAt);
  }, [data, operationStore]);

  useEffect(() => {
    if (data === null || editor === null || editor.kind === "add") return;
    const existsOnServer = data.connections.some(
      (connection) => connection.connectionId === editor.connectionId,
    );
    const optimisticConnection = overlays.get(editor.connectionId)?.connection;
    if (existsOnServer || optimisticConnection) return;
    setEditor(null);
    setEditorInvalidation(
      "The connection being edited was removed on this device, so the editor was closed.",
    );
  }, [data, editor, overlays]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshOnFocus = () => currentRefresh.current();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);

  const recordOptimisticConnection = (connection: OnshapeConnectionSummary) => {
    operationStore.recordConnection(connection);
  };

  const recordOptimisticRemoval = (connectionId: string, updatedAt: string) => {
    operationStore.recordRemoval(connectionId, updatedAt);
  };

  const runMutation = async <A, E>(
    key: string,
    pendingMessage: string,
    operation: () => Promise<AtomCommandResult<A, E>>,
    onSuccess: (value: A) => void,
  ): Promise<string | null> => {
    const guarded = await operationStore.run(
      key,
      pendingMessage,
      "cadsense could not complete this connection change. Try again.",
      async () => {
        const result = await operation();
        if (result._tag === "Success") {
          onSuccess(result.value);
          return { _tag: "Success", value: result.value } as const;
        }
        if (isAtomCommandInterrupted(result)) return { _tag: "Interrupted" } as const;
        return {
          _tag: "Error",
          message: safeOnshapeConnectionErrorMessage(squashAtomCommandFailure(result)),
        } as const;
      },
    );
    if (guarded._tag === "AlreadyRunning") {
      return "Another Onshape connection change is already in progress on this device.";
    }
    if (guarded._tag === "Success") return null;
    return guarded._tag === "Error" ? guarded.message : null;
  };

  const connections = [
    ...serverConnections
      .filter((connection) => overlays.get(connection.connectionId)?.connection !== null)
      .map((connection) => overlays.get(connection.connectionId)?.connection ?? connection),
    ...[...overlays.values()]
      .map((overlay) => overlay.connection)
      .filter(
        (connection): connection is OnshapeConnectionSummary =>
          connection !== null &&
          !serverConnections.some((server) => server.connectionId === connection.connectionId),
      ),
  ];

  const openEditor = (nextEditor: Exclude<OnshapeConnectionEditor, null>) => {
    operationStore.dismissError();
    setEditorInvalidation(null);
    setEditor(nextEditor);
  };

  const saveCreate = (draft: OnshapeConnectionDraft) =>
    runMutation(
      "add",
      "Verifying the new connection with Onshape.",
      () => createConnection({ environmentId, input: draft }),
      (connection) => {
        recordOptimisticConnection(connection);
        setEditor(null);
      },
    );

  const saveRename = (connection: OnshapeConnectionSummary, name: string) =>
    runMutation(
      `rename:${connection.connectionId}`,
      `Renaming "${connection.name}".`,
      () =>
        renameConnection({
          environmentId,
          input: { connectionId: connection.connectionId, name },
        }),
      (updatedConnection) => {
        recordOptimisticConnection(updatedConnection);
        setEditor(null);
      },
    );

  const saveReplacement = (connection: OnshapeConnectionSummary, draft: OnshapeCredentialDraft) =>
    runMutation(
      `replace:${connection.connectionId}`,
      `Verifying replacement credentials for "${connection.name}" with Onshape.`,
      () =>
        replaceCredentials({
          environmentId,
          input: { connectionId: connection.connectionId, ...draft },
        }),
      (updatedConnection) => {
        recordOptimisticConnection(updatedConnection);
        setEditor(null);
      },
    );

  const remove = async (connection: OnshapeConnectionSummary): Promise<void> => {
    await operationStore.run(
      `remove:${connection.connectionId}`,
      `Confirming removal of "${connection.name}".`,
      "cadsense could not remove this connection. Try again.",
      async () => {
        try {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            `Remove "${connection.name}" and its saved credentials? Existing Onshape projects stay available offline, but future sync requires another compatible connection. This cannot be undone.`,
            { variant: "destructive" },
          );
          if (!confirmed) return { _tag: "Interrupted" } as const;
        } catch {
          return {
            _tag: "Error",
            message: "cadsense could not open the confirmation. Try again.",
          } as const;
        }

        const result = await removeConnection({
          environmentId,
          input: { connectionId: connection.connectionId },
        });
        if (result._tag === "Success") {
          recordOptimisticRemoval(result.value.connectionId, result.value.updatedAt);
          return { _tag: "Success", value: undefined } as const;
        }
        if (isAtomCommandInterrupted(result)) return { _tag: "Interrupted" } as const;
        return {
          _tag: "Error",
          message: safeOnshapeConnectionErrorMessage(squashAtomCommandFailure(result)),
        } as const;
      },
    );
  };

  return {
    connections,
    editor,
    pendingKey,
    operationNotice: operationSnapshot.notice,
    operationCompletion: operationSnapshot.completion,
    editorInvalidation,
    listError,
    isListPending,
    hasListData: data !== null,
    interactionsDisabled: editor !== null || pendingKey !== null,
    refresh,
    dismissOperationError: operationStore.dismissError,
    openEditor,
    cancelEditor: () => setEditor(null),
    saveCreate,
    saveRename,
    saveReplacement,
    remove,
  };
}
