import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  OnshapeConnectionId,
  type OnshapeConnectionListResult,
  type OnshapeConnectionSummary,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { OnshapeConnectionDraft } from "./OnshapeConnectionsSettings.logic";

const atoms = vi.hoisted(() => ({
  list: vi.fn(),
  create: Symbol("create"),
  rename: Symbol("rename"),
  replaceCredentials: Symbol("replaceCredentials"),
  remove: Symbol("remove"),
}));

const testState = vi.hoisted(() => ({
  query: {
    data: null as OnshapeConnectionListResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  create: vi.fn(),
  rename: vi.fn(),
  replaceCredentials: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: <T,>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] =>
      hooks.useState(initialValue),
    useSyncExternalStore: hooks.useSyncExternalStore,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));

vi.mock("../../state/onshapeConnections", () => ({
  onshapeConnectionEnvironment: atoms,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => testState.query,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === atoms.create) return testState.create;
    if (command === atoms.rename) return testState.rename;
    if (command === atoms.replaceCredentials) return testState.replaceCredentials;
    if (command === atoms.remove) return testState.remove;
    throw new Error("Unexpected Onshape command");
  },
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: testState.confirm } }),
}));

import { onshapeConnectionOperationStore } from "./onshapeConnectionOperationStore";
import { useOnshapeConnectionsController } from "./useOnshapeConnectionsController";

let environmentSequence = 0;
let environmentId = EnvironmentId.make("primary-environment-0");
const connectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001");
const baseConnection: OnshapeConnectionSummary = {
  connectionId,
  name: "Team Onshape",
  host: "https://cad.onshape.com",
  verifiedAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
const credentialDraft: OnshapeConnectionDraft = {
  name: "Team Onshape",
  host: "cad.onshape.com",
  accessKeyId: "access-key",
  secretKey: "secret-key",
};

function listResult(
  connections: ReadonlyArray<OnshapeConnectionSummary>,
  catalogUpdatedAt = "2026-09-04T00:00:00.000Z",
): OnshapeConnectionListResult {
  return { connections: [...connections], catalogUpdatedAt };
}

function renderController(targetEnvironmentId = environmentId) {
  hooks.beginRender();
  return useOnshapeConnectionsController(targetEnvironmentId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Onshape connections controller", () => {
  beforeEach(() => {
    hooks.reset();
    environmentSequence += 1;
    environmentId = EnvironmentId.make(`primary-environment-${environmentSequence}`);
    onshapeConnectionOperationStore(environmentId).dismissError();
    vi.stubGlobal("window", new EventTarget());
    atoms.list.mockReset();
    testState.query.data = listResult([baseConnection]);
    testState.query.error = null;
    testState.query.isPending = false;
    testState.query.refresh.mockReset();
    testState.create.mockReset();
    testState.rename.mockReset();
    testState.replaceCredentials.mockReset();
    testState.remove.mockReset();
    testState.confirm.mockReset().mockResolvedValue(true);
  });

  it("adds a verified public summary without retaining credentials in rendered state", async () => {
    testState.query.data = listResult([], "1970-01-01T00:00:00.000Z");
    testState.create.mockResolvedValue(AsyncResult.success(baseConnection));

    let controller = renderController();
    controller.openEditor({ kind: "add" });
    controller = renderController();
    expect(controller.editor).toEqual({ kind: "add" });

    await expect(controller.saveCreate(credentialDraft)).resolves.toBeNull();
    controller = renderController();

    expect(testState.create).toHaveBeenCalledWith({
      environmentId,
      input: credentialDraft,
    });
    expect(controller.editor).toBeNull();
    expect(controller.connections).toEqual([baseConnection]);
    expect(JSON.stringify(controller.connections)).not.toContain("access-key");
    expect(JSON.stringify(controller.connections)).not.toContain("secret-key");
  });

  it("renames locally through the rename command and publishes the returned summary", async () => {
    const renamed = {
      ...baseConnection,
      name: "Workshop Onshape",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    testState.rename.mockResolvedValue(AsyncResult.success(renamed));

    let controller = renderController();
    controller.openEditor({ kind: "rename", connectionId });
    controller = renderController();
    await expect(controller.saveRename(baseConnection, renamed.name)).resolves.toBeNull();
    controller = renderController();

    expect(testState.rename).toHaveBeenCalledWith({
      environmentId,
      input: { connectionId, name: "Workshop Onshape" },
    });
    expect(controller.connections[0]?.name).toBe("Workshop Onshape");
    expect(controller.editor).toBeNull();
    expect(testState.query.refresh).not.toHaveBeenCalled();
  });

  it("drops an optimistic overlay when the authoritative list changes", async () => {
    const optimistic = {
      ...baseConnection,
      name: "Optimistic name",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    testState.rename.mockResolvedValue(AsyncResult.success(optimistic));

    let controller = renderController();
    await controller.saveRename(baseConnection, optimistic.name);
    controller = renderController();
    expect(controller.connections[0]?.name).toBe("Optimistic name");

    const authoritative = {
      ...baseConnection,
      name: "Name from another client",
      updatedAt: "2026-09-04T00:00:02.000Z",
    };
    testState.query.data = listResult([authoritative], authoritative.updatedAt);
    renderController();
    controller = renderController();
    expect(controller.connections).toEqual([authoritative]);

    testState.query.data = listResult([], "2026-09-04T00:00:03.000Z");
    renderController();
    controller = renderController();
    expect(controller.connections).toEqual([]);
  });

  it("publishes a successful mutation over a stale refresh that landed while it was pending", async () => {
    const request = deferred<ReturnType<typeof AsyncResult.success<OnshapeConnectionSummary>>>();
    const optimistic = {
      ...baseConnection,
      name: "Late mutation result",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const staleRefresh = { ...baseConnection };
    testState.rename.mockReturnValue(request.promise);

    let controller = renderController();
    const saving = controller.saveRename(baseConnection, optimistic.name);
    testState.query.data = listResult([staleRefresh]);
    controller = renderController();
    request.resolve(AsyncResult.success(optimistic));
    await saving;
    controller = renderController();

    expect(controller.connections).toEqual([optimistic]);

    testState.query.data = listResult([optimistic], optimistic.updatedAt);
    renderController();
    controller = renderController();
    expect(controller.connections).toEqual([optimistic]);
  });

  it("does not let a late mutation response overwrite a newer catalog revision", async () => {
    const request = deferred<ReturnType<typeof AsyncResult.success<OnshapeConnectionSummary>>>();
    const lateResult = {
      ...baseConnection,
      name: "Late mutation result",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const newerAuthoritative = {
      ...baseConnection,
      name: "Newer authoritative name",
      updatedAt: "2026-09-04T00:00:02.000Z",
    };
    testState.rename.mockReturnValue(request.promise);

    let controller = renderController();
    const saving = controller.saveRename(baseConnection, lateResult.name);
    hooks.reset();
    testState.query.data = listResult([newerAuthoritative], newerAuthoritative.updatedAt);
    controller = renderController();
    request.resolve(AsyncResult.success(lateResult));
    await saving;
    controller = renderController();

    expect(controller.connections).toEqual([newerAuthoritative]);
  });

  it("does not resurrect a create removed by a newer catalog before its response arrives", async () => {
    const request = deferred<ReturnType<typeof AsyncResult.success<OnshapeConnectionSummary>>>();
    const created = {
      ...baseConnection,
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    testState.query.data = listResult([], "1970-01-01T00:00:00.000Z");
    testState.create.mockReturnValue(request.promise);

    let controller = renderController();
    const saving = controller.saveCreate(credentialDraft);
    testState.query.data = listResult([], "2026-09-04T00:00:02.000Z");
    controller = renderController();
    request.resolve(AsyncResult.success(created));
    await saving;
    controller = renderController();

    expect(controller.connections).toEqual([]);
  });

  it("clears an editor whose connection was removed outside this view", () => {
    let controller = renderController();
    controller.openEditor({ kind: "rename", connectionId });
    controller = renderController();
    expect(controller.editor).toEqual({ kind: "rename", connectionId });

    testState.query.data = listResult([], "2026-09-04T00:00:01.000Z");
    renderController();
    controller = renderController();

    expect(controller.editor).toBeNull();
    expect(controller.interactionsDisabled).toBe(false);
    expect(controller.editorInvalidation).toContain("editor was closed");
  });

  it("refreshes the local catalog when the renderer regains focus", () => {
    renderController();
    window.dispatchEvent(new Event("focus"));

    expect(testState.query.refresh).toHaveBeenCalledOnce();
  });

  it("replaces host and credentials while exposing only the returned public summary", async () => {
    const replaced = {
      ...baseConnection,
      host: "https://team.onshape.com",
      verifiedAt: "2026-09-04T01:00:00.000Z",
      updatedAt: "2026-09-04T01:00:00.000Z",
    };
    testState.replaceCredentials.mockResolvedValue(AsyncResult.success(replaced));

    let controller = renderController();
    controller.openEditor({ kind: "replace", connectionId });
    controller = renderController();
    await expect(
      controller.saveReplacement(baseConnection, {
        host: "team.onshape.com",
        accessKeyId: "new-access-key",
        secretKey: "new-secret-key",
      }),
    ).resolves.toBeNull();
    controller = renderController();

    expect(testState.replaceCredentials).toHaveBeenCalledWith({
      environmentId,
      input: {
        connectionId,
        host: "team.onshape.com",
        accessKeyId: "new-access-key",
        secretKey: "new-secret-key",
      },
    });
    expect(controller.connections).toEqual([replaced]);
    expect(JSON.stringify(controller.connections)).not.toContain("new-secret-key");
  });

  it("confirms removal and immediately removes the saved card", async () => {
    testState.remove.mockResolvedValue(
      AsyncResult.success({ connectionId, updatedAt: "2026-09-04T00:00:01.000Z" }),
    );

    let controller = renderController();
    await controller.remove(baseConnection);
    controller = renderController();

    expect(testState.confirm).toHaveBeenCalledWith(
      'Remove "Team Onshape" and its saved credentials? Existing Onshape projects stay available offline, but future sync requires another compatible connection. This cannot be undone.',
      { variant: "destructive" },
    );
    expect(testState.remove).toHaveBeenCalledWith({
      environmentId,
      input: { connectionId },
    });
    expect(controller.connections).toEqual([]);
  });

  it("locks competing actions while pending and returns a safe typed error", async () => {
    const request =
      deferred<ReturnType<typeof AsyncResult.failure<never, { readonly _tag: string }>>>();
    testState.create.mockReturnValue(request.promise);

    let controller = renderController();
    controller.openEditor({ kind: "add" });
    controller = renderController();
    const saving = controller.saveCreate(credentialDraft);
    controller = renderController();

    expect(controller.pendingKey).toBe("add");
    expect(controller.operationNotice).toEqual({
      _tag: "Pending",
      key: "add",
      message: "Verifying the new connection with Onshape.",
    });
    expect(controller.interactionsDisabled).toBe(true);
    await expect(controller.saveCreate(credentialDraft)).resolves.toBe(
      "Another Onshape connection change is already in progress on this device.",
    );
    expect(testState.create).toHaveBeenCalledOnce();

    request.resolve(
      AsyncResult.failure(
        Cause.fail({ _tag: "OnshapeVerificationThrottledError", retryAfterSeconds: 90 }),
      ),
    );
    await expect(saving).resolves.toBe(
      "Too many connection verification attempts. Try again in 2 minutes.",
    );
    controller = renderController();
    expect(controller.pendingKey).toBeNull();
    expect(controller.operationNotice).toEqual({
      _tag: "Error",
      key: "add",
      message: "Too many connection verification attempts. Try again in 2 minutes.",
    });
    expect(controller.interactionsDisabled).toBe(true);
    expect(controller.editor).toEqual({ kind: "add" });
  });

  it("preserves an active operation and its failure across unmount and remount", async () => {
    const remountEnvironmentId = EnvironmentId.make("remount-environment");
    onshapeConnectionOperationStore(remountEnvironmentId).dismissError();
    testState.query.data = listResult([]);
    const request =
      deferred<ReturnType<typeof AsyncResult.failure<never, { readonly _tag: string }>>>();
    testState.create.mockReturnValue(request.promise);

    let controller = renderController(remountEnvironmentId);
    const saving = controller.saveCreate(credentialDraft);
    controller = renderController(remountEnvironmentId);
    expect(controller.pendingKey).toBe("add");
    expect(controller.connections).toEqual([]);
    expect(controller.interactionsDisabled).toBe(true);

    hooks.reset();
    controller = renderController(remountEnvironmentId);
    expect(controller.pendingKey).toBe("add");
    expect(controller.operationNotice?._tag).toBe("Pending");
    await expect(controller.saveCreate(credentialDraft)).resolves.toBe(
      "Another Onshape connection change is already in progress on this device.",
    );
    expect(testState.create).toHaveBeenCalledOnce();

    request.resolve(AsyncResult.failure(Cause.fail({ _tag: "OnshapeInvalidCredentialsError" })));
    await expect(saving).resolves.toBe(
      "Onshape rejected this access key ID and secret key. Check them and try again.",
    );
    controller = renderController(remountEnvironmentId);
    expect(controller.pendingKey).toBeNull();
    expect(controller.operationNotice).toEqual({
      _tag: "Error",
      key: "add",
      message: "Onshape rejected this access key ID and secret key. Check them and try again.",
    });

    controller.dismissOperationError();
    controller = renderController(remountEnvironmentId);
    expect(controller.operationNotice).toBeNull();
  });

  it("keeps a successful removal hidden across remount until the catalog catches up", async () => {
    const remountEnvironmentId = EnvironmentId.make("remount-removal-environment");
    const removed = { connectionId, updatedAt: "2026-09-04T00:00:01.000Z" } as const;
    const request = deferred<ReturnType<typeof AsyncResult.success<typeof removed>>>();
    testState.remove.mockReturnValue(request.promise);

    let controller = renderController(remountEnvironmentId);
    const removing = controller.remove(baseConnection);
    await Promise.resolve();
    expect(testState.remove).toHaveBeenCalledOnce();

    hooks.reset();
    controller = renderController(remountEnvironmentId);
    expect(controller.pendingKey).toBe(`remove:${connectionId}`);

    request.resolve(AsyncResult.success(removed));
    await removing;
    testState.query.error = "refresh failed";
    controller = renderController(remountEnvironmentId);
    expect(controller.pendingKey).toBeNull();
    expect(controller.interactionsDisabled).toBe(false);
    expect(controller.connections).toEqual([]);
    expect(controller.operationCompletion).toEqual({
      sequence: 1,
      key: `remove:${connectionId}`,
      outcome: "Success",
    });

    testState.query.data = listResult([], removed.updatedAt);
    controller = renderController(remountEnvironmentId);
    expect(controller.connections).toEqual([]);
  });
});
