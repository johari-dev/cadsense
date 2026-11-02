import {
  CadProjectState,
  CadSnapshotId,
  CadUserOperationError,
  EnvironmentId,
  OrchestrationProjectShell,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const start = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const threads = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useEffect: reactHookHarness.useEffect, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../state/onshapeProjects", () => ({
  onshapeProjectEnvironment: { startCadOperation: "start" },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => start }));
vi.mock("../state/entities", () => ({ useThreadShells: () => threads.current }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: toast } }));
import { CadSyncButton } from "./CadSyncButton";

const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeCad = Schema.decodeUnknownSync(CadProjectState);

const element = "d".repeat(24);
/** Snapshot `n` of the CAD at `microversion`; an unchanged re-import is a new snapshot of the same one. */
const snapshot = (n: number, microversion = "f") => ({
  snapshotId: `00000000-0000-4000-8000-00000000000${n}`,
  microversionId: microversion.repeat(24),
  createdAt: "2026-09-05T00:00:00Z",
  manifestBytes: 1,
  assetBytes: 1,
});
const roots = ["default", "NPD-16"].map((configuration, index) => ({
  rootId: String(index + 1).repeat(64),
  elementId: element,
  kind: "assembly",
  configuration,
  current: snapshot(2),
  rollback: null,
  lastOutcome: null,
}));
const catalog = (name: string, kind: string) => ({
  refreshedAt: "2026-09-05T00:00:00Z",
  microversionId: "b".repeat(24),
  roots: [{ elementId: element, name, kind }],
  sourceElement: { elementId: element, status: "available" },
});
const cadState = (cadRoots: readonly unknown[], cadCatalog: unknown, extra: object = {}) => ({
  enabled: true,
  roots: cadRoots,
  operation: null,
  lastOutcome: null,
  catalog: cadCatalog,
  ...extra,
});
const shell = (fields: object) => ({
  ...decodeProject({
    id: "cad-sync-button",
    title: "Pillow",
    workspaceRoot: "C:/cad-sync-button",
    defaultModelSelection: null,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    ...fields,
  }),
  environmentId: EnvironmentId.make("test"),
});
/** A local project linking a SolidWorks assembly, imported in `roots`. */
const projectWith = (cadRoots: readonly unknown[], extra: object = {}) =>
  shell({
    localCadSource: { filePath: "cad/pillow_block.sldasm" },
    cad: cadState(cadRoots, catalog("cad/pillow_block.sldasm", "assembly"), extra),
  });
/** An Onshape project whose document's own element is a Part Studio. */
const onshapeWith = (cadRoots: readonly unknown[], cadCatalog: unknown) =>
  shell({
    onshapeSource: {
      connectionId: "00000000-0000-4000-8000-0000000000c1",
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      workspaceType: "w",
      workspaceId: "c".repeat(24),
      elementId: element,
      configuration: "size=large",
    },
    cad: cadState(cadRoots, cadCatalog),
  });
type TestProject = ReturnType<typeof shell>;
/** `project` with its CAD state changed by `change`, decoded so the result is a real project. */
const withCad = (project: TestProject, change: object): TestProject => ({
  ...project,
  cad: decodeCad({ ...project.cad, ...change }),
});

interface Props {
  children?: ReactNode;
  render?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}
/** The Sync button, which the tooltip trigger renders. */
const syncButton = (tree: ReactNode): Props | undefined => {
  if (Array.isArray(tree)) return tree.map(syncButton).find(Boolean);
  if (!isValidElement<Props>(tree)) return undefined;
  if (tree.props.onClick) return tree.props;
  return syncButton(tree.props.children) ?? syncButton(tree.props.render);
};
/** Every string in the rendered tree, which includes the tooltip's text. */
const text = (tree: ReactNode): string => {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (!isValidElement<Props>(tree)) return "";
  return text(tree.props.children) + text(tree.props.render);
};
const render = (project: TestProject, rootId: string | null) => {
  hooks.beginRender();
  return CadSyncButton({ project, rootId, disabled: false });
};
const press = (project: TestProject, rootId: string | null) =>
  syncButton(render(project, rootId))!.onClick!();
const synced = (root: object) => ({
  environmentId: EnvironmentId.make("test"),
  input: { projectId: "cad-sync-button", kind: "sync", root },
});
const operationId = CadSnapshotId.make("00000000-0000-4000-8000-00000000000a");
const outcome = (status: string, reason: string | null = null) => ({
  operationId,
  kind: "sync",
  status,
  completedAt: "2026-09-05T00:01:00Z",
  reason,
});
/** Lets the click handler's awaited start settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CAD panel Sync button", () => {
  beforeEach(() => {
    hooks.reset();
    start.mockReset();
    start.mockResolvedValue(AsyncResult.success({ operationId }));
    toast.mockReset();
    threads.current = [];
  });
  it("syncs the local root the panel shows in that root's configuration", () => {
    press(projectWith(roots), roots[1]!.rootId);
    expect(start).toHaveBeenLastCalledWith(
      synced({ elementId: element, kind: "assembly", configuration: "NPD-16" }),
    );
    press(projectWith(roots), roots[0]!.rootId);
    expect(start).toHaveBeenLastCalledWith(
      synced({ elementId: element, kind: "assembly", configuration: "default" }),
    );
  });
  it("imports the linked file in its default configuration before anything is shown", () => {
    press(projectWith([]), null);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      synced({ elementId: element, kind: "assembly", configuration: "default" }),
    );
  });
  it("syncs an Onshape root with its own kind and configuration", () => {
    const studio = [{ ...roots[1]!, kind: "part-studio" }];
    press(onshapeWith(studio, catalog("Bracket", "part-studio")), studio[0]!.rootId);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      synced({ elementId: element, kind: "part-studio", configuration: "NPD-16" }),
    );
  });
  it("syncs the Onshape document's own element first, in the project's configuration", () => {
    press(onshapeWith([], catalog("Bracket", "part-studio")), null);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      synced({ elementId: element, kind: "part-studio", configuration: "size=large" }),
    );
  });
  it("renders nothing when an Onshape project has no root to sync from the panel", () => {
    expect(render(onshapeWith([], null), null)).toBeNull();
    const missing = { ...catalog("Bracket", "assembly"), roots: [] };
    expect(render(onshapeWith([], missing), null)).toBeNull();
  });
  it("is disabled and names the chats that block it while another chat runs", () => {
    threads.current = [
      {
        id: "other",
        environmentId: EnvironmentId.make("test"),
        projectId: "cad-sync-button",
        title: "Bracket review",
        latestTurn: { state: "running" },
        session: null,
      },
    ];
    const tree = render(projectWith(roots), roots[0]!.rootId);
    expect(syncButton(tree)!.disabled).toBe(true);
    expect(text(tree)).toContain(
      "Bracket review is running in this project. Sync after it finishes.",
    );
  });
  it("labels a running sync by what it does", () => {
    const running = {
      operation: { operationId, kind: "sync", root: null, startedAt: "2026-09-05T00:00:00Z" },
    };
    expect(text(render(projectWith(roots, running), roots[0]!.rootId))).toContain("Converting…");
    const onshape = onshapeWith(roots, catalog("Robot", "assembly"));
    const syncing = withCad(onshape, running);
    expect(text(render(syncing, roots[0]!.rootId))).toContain("Syncing…");
  });
  it("reports the outcome of the sync it started once the server records it", async () => {
    const before = onshapeWith(roots, catalog("Robot", "assembly"));
    press(before, roots[0]!.rootId);
    await settle();
    render(before, roots[0]!.rootId);
    expect(toast).not.toHaveBeenCalled();
    const after = withCad(before, {
      roots: [{ ...roots[0]!, current: snapshot(3, "e") }, roots[1]!],
      lastOutcome: outcome("succeeded"),
    });
    render(after, roots[0]!.rootId);
    expect(toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "Robot synced",
      description: "Chats showing it now show the new revision.",
    });
    render(after, roots[0]!.rootId);
    expect(toast).toHaveBeenCalledOnce();
  });
  it("says an unchanged sync left the model as it was, even as a new snapshot", async () => {
    // A local STEP import writes a new snapshot of unchanged bytes; only the microversion holds.
    for (const current of [snapshot(2), snapshot(3)]) {
      hooks.reset();
      toast.mockReset();
      const before = onshapeWith(roots, catalog("Robot", "assembly"));
      press(before, roots[0]!.rootId);
      await settle();
      const after = withCad(before, {
        roots: [{ ...roots[0]!, current }, roots[1]!],
        lastOutcome: outcome("succeeded"),
      });
      render(after, roots[0]!.rootId);
      expect(toast).toHaveBeenCalledExactlyOnceWith({
        type: "info",
        title: "Robot is already up to date",
      });
    }
  });
  it("shows the recorded reason when the sync fails, and stays quiet when it is cancelled", async () => {
    const before = onshapeWith(roots, catalog("Robot", "assembly"));
    const reason = "Could not reach Onshape. Existing downloaded CAD is unchanged.";
    press(before, roots[0]!.rootId);
    await settle();
    render(withCad(before, { lastOutcome: outcome("failed", reason) }), roots[0]!.rootId);
    expect(toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not sync Robot",
      description: reason,
    });
    hooks.reset();
    toast.mockReset();
    press(before, roots[0]!.rootId);
    await settle();
    render(withCad(before, { lastOutcome: outcome("cancelled") }), roots[0]!.rootId);
    expect(toast).not.toHaveBeenCalled();
  });
  it("ignores an outcome that belongs to another operation", async () => {
    const before = onshapeWith(roots, catalog("Robot", "assembly"));
    press(before, roots[0]!.rootId);
    await settle();
    const other = {
      ...outcome("succeeded"),
      operationId: CadSnapshotId.make("00000000-0000-4000-8000-00000000000b"),
    };
    render(withCad(before, { lastOutcome: other }), roots[0]!.rootId);
    expect(toast).not.toHaveBeenCalled();
  });
  it("explains a sync the server refuses to start", async () => {
    start.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new CadUserOperationError({ reason: "throttled" }))),
    );
    press(onshapeWith(roots, catalog("Robot", "assembly")), roots[0]!.rootId);
    await settle();
    expect(toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not sync Robot",
      description: "Onshape is limiting requests. Try again in a few minutes.",
    });
  });
});
