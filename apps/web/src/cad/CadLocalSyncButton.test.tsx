import { EnvironmentId, OrchestrationProjectShell } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const start = vi.hoisted(() => vi.fn());
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../state/onshapeProjects", () => ({
  onshapeProjectEnvironment: { startCadOperation: "start" },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => start }));
import { CadLocalSyncButton } from "./CadLocalSyncButton";

const element = "d".repeat(24);
const roots = ["default", "NPD-16"].map((configuration, index) => ({
  rootId: String(index + 1).repeat(64),
  elementId: element,
  kind: "assembly",
  configuration,
  current: {
    snapshotId: "00000000-0000-4000-8000-000000000002",
    microversionId: "f".repeat(24),
    createdAt: "2026-09-05T00:00:00Z",
    manifestBytes: 1,
    assetBytes: 1,
  },
  rollback: null,
  lastOutcome: null,
}));
/** A local project linking a SolidWorks assembly, imported in `roots`. */
const projectWith = (cadRoots: readonly unknown[]) => ({
  ...Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "cad-sync-button",
    title: "Pillow",
    workspaceRoot: "C:/cad-sync-button",
    defaultModelSelection: null,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    localCadSource: { filePath: "cad/pillow_block.sldasm" },
    cad: {
      enabled: true,
      roots: cadRoots,
      operation: null,
      lastOutcome: null,
      catalog: {
        refreshedAt: "2026-09-05T00:00:00Z",
        microversionId: "b".repeat(24),
        roots: [{ elementId: element, name: "cad/pillow_block.sldasm", kind: "assembly" }],
        sourceElement: { elementId: element, status: "available" },
      },
    },
  }),
  environmentId: EnvironmentId.make("test"),
});

interface Props {
  children?: ReactNode;
  render?: ReactNode;
  onClick?: () => void;
}
/** The Sync button, which the tooltip trigger renders. */
const syncButton = (tree: ReactNode): Props | undefined => {
  if (Array.isArray(tree)) return tree.map(syncButton).find(Boolean);
  if (!isValidElement<Props>(tree)) return undefined;
  if (tree.props.onClick) return tree.props;
  return syncButton(tree.props.children) ?? syncButton(tree.props.render);
};
const press = (project: ReturnType<typeof projectWith>, rootId: string | null) => {
  hooks.beginRender();
  syncButton(CadLocalSyncButton({ project, rootId, disabled: false }))!.onClick!();
};
const synced = (configuration: string) => ({
  environmentId: EnvironmentId.make("test"),
  input: {
    projectId: "cad-sync-button",
    kind: "sync",
    root: { elementId: element, kind: "assembly", configuration },
  },
});

describe("local CAD Sync button", () => {
  beforeEach(() => {
    hooks.reset();
    start.mockReset();
  });
  it("syncs the root the panel shows in that root's configuration", () => {
    press(projectWith(roots), roots[1]!.rootId);
    expect(start).toHaveBeenLastCalledWith(synced("NPD-16"));
    press(projectWith(roots), roots[0]!.rootId);
    expect(start).toHaveBeenLastCalledWith(synced("default"));
  });
  it("imports the linked file in its default configuration before anything is shown", () => {
    press(projectWith([]), null);
    expect(start).toHaveBeenCalledExactlyOnceWith(synced("default"));
  });
});
