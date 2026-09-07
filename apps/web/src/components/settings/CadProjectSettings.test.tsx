import { EnvironmentId, OrchestrationProjectShell } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const commands = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), enabled: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: reactHookHarness.useEffect,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/onshapeProjects", () => ({
  onshapeProjectEnvironment: {
    startCadOperation: "start",
    cancelCadOperation: "cancel",
    setCadEnabled: "enabled",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: keyof typeof commands) => commands[key],
}));
import { CadProjectSettings } from "./CadProjectSettings";

const project = {
  ...Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "cad-ui",
    title: "CAD",
    workspaceRoot: "C:/cad-ui",
    defaultModelSelection: null,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    onshapeSource: {
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      workspaceType: "m",
      workspaceId: "b".repeat(24),
      configuration: "default",
      connectionId: "00000000-0000-4000-8000-000000000001",
    },
    cad: {
      enabled: true,
      roots: [],
      operation: null,
      lastOutcome: null,
      catalog: {
        refreshedAt: "2026-09-05T00:00:00Z",
        microversionId: "b".repeat(24),
        roots: [{ elementId: "c".repeat(24), name: "Intake", kind: "assembly" }],
        sourceElement: null,
      },
    },
  }),
  environmentId: EnvironmentId.make("test"),
};
interface Props {
  children?: ReactNode;
  control?: ReactNode;
  onClick?: () => void;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}
const find = (tree: ReactNode, predicate: (props: Props) => boolean): Props[] => {
  if (Array.isArray(tree)) return tree.flatMap((child) => find(child, predicate));
  if (!isValidElement<Props>(tree)) return [];
  return [
    ...(predicate(tree.props) ? [tree.props] : []),
    ...find(tree.props.children, predicate),
    ...find(tree.props.control, predicate),
  ];
};
const render = (runActive = false, current = project) => {
  hooks.beginRender();
  return CadProjectSettings({ project: current, runActive });
};
const button = (text: string, active = false, current = project) =>
  find(render(active, current), (props) => props.children === text)[0]!;

describe("manual CAD project controls", () => {
  it("honors the retry deadline without retrying automatically or disabling local settings", async () => {
    hooks.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    Object.values(commands).forEach((command) => command.mockReset());
    try {
      const limited: typeof project = {
        ...project,
        cad: {
          ...project.cad!,
          lastOutcome: {
            operationId: "00000000-0000-4000-8000-000000000001",
            kind: "discover",
            status: "failed",
            completedAt: "2026-09-05T00:00:00Z",
            reason: "Onshape is limiting requests.",
            retryAt: "2026-09-05T00:01:00Z",
          },
        },
      };
      expect(button("Refresh CAD catalog", false, limited).disabled).toBe(true);
      expect(button("Turn off CAD", false, limited).disabled).toBe(false);
      button("Refresh CAD catalog", false, limited).onClick!();
      expect(commands.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(button("Refresh CAD catalog", false, limited).disabled).toBe(false);
      expect(commands.start).not.toHaveBeenCalled();
    } finally {
      hooks.reset();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    hooks.reset();
    Object.values(commands).forEach((command) => {
      command.mockReset();
      command.mockResolvedValue(AsyncResult.success(undefined));
    });
  });
  it("does not contact Onshape on mount or selection, and syncs only the explicitly selected root", async () => {
    render();
    expect(commands.start).not.toHaveBeenCalled();
    expect(button("Sync snapshot").disabled).toBe(true);
    find(render(), (props) => props.onValueChange !== undefined)[0]!.onValueChange!("c".repeat(24));
    expect(commands.start).not.toHaveBeenCalled();
    button("Sync snapshot").onClick!();
    expect(commands.start).toHaveBeenCalledExactlyOnceWith({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        kind: "sync",
        root: { elementId: "c".repeat(24), kind: "assembly", configuration: "default" },
      },
    });
  });
  it("blocks repeated starts while admission is pending", async () => {
    let resolve!: (value: ReturnType<typeof AsyncResult.success<void>>) => void;
    const promise = new Promise<ReturnType<typeof AsyncResult.success<void>>>((complete) => {
      resolve = complete;
    });
    commands.start.mockReturnValue(promise);
    button("Refresh CAD catalog").onClick!();
    button("Refresh CAD catalog").onClick!();
    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(button("Turn off CAD").disabled).toBe(true);
    resolve(AsyncResult.success(undefined));
    await promise;
    expect(button("Refresh CAD catalog").disabled).toBe(false);
  });
  it("locks all remote and enable actions during any project run", () => {
    for (const name of ["Refresh CAD catalog", "Turn off CAD", "Sync snapshot"]) {
      const control = button(name, true);
      expect(control.disabled).toBe(true);
      control.onClick!();
    }
    expect(commands.start).not.toHaveBeenCalled();
    expect(commands.enabled).not.toHaveBeenCalled();
  });
  it("turns CAD off without invoking a sync and permits re-enabling retained data", async () => {
    button("Turn off CAD").onClick!();
    await commands.enabled.mock.results[0]!.value;
    expect(commands.enabled).toHaveBeenCalledWith({
      environmentId: project.environmentId,
      input: { projectId: project.id, enabled: false },
    });
    const disabled = { ...project, cad: { ...project.cad!, enabled: false } };
    expect(button("Refresh CAD catalog", false, disabled).disabled).toBe(true);
    button("Turn on CAD", false, disabled).onClick!();
    expect(commands.enabled).toHaveBeenLastCalledWith({
      environmentId: project.environmentId,
      input: { projectId: project.id, enabled: true },
    });
    expect(commands.start).not.toHaveBeenCalled();
  });
});
