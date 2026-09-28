import {
  EnvironmentId,
  OnshapeConnectionId,
  OnshapeProjectHostMismatchError,
  OnshapeProjectSource,
  OrchestrationProjectShell,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  catalog: vi.fn(),
  command: vi.fn(),
  check: vi.fn(),
  checkVersions: Symbol("checkVersions"),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useRef: reactHookHarness.useRef, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./useOnshapeConnectionsController", () => ({
  useOnshapeConnectionsController: state.catalog,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.checkVersions ? state.check : state.command,
}));
vi.mock("../../state/onshapeProjects", () => ({
  onshapeProjectEnvironment: {
    setConnection: Symbol("setConnection"),
    checkVersions: state.checkVersions,
  },
}));

import { OnshapeProjectSettings } from "./OnshapeProjectSettings";

interface ControlProps {
  children?: ReactNode;
  control?: ReactNode;
  role?: string;
  value?: string | null;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  onClick?: () => void;
}
function findAll(tree: ReactNode, predicate: (props: ControlProps) => boolean): ControlProps[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => findAll(child, predicate));
  if (!isValidElement<ControlProps>(tree)) return [];
  return [
    ...(predicate(tree.props) ? [tree.props] : []),
    ...findAll(tree.props.children, predicate),
    ...findAll(tree.props.control, predicate),
  ];
}
const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "11111111-1111-4111-8111-111111111111",
  host: "https://cad.onshape.com",
  documentId: "05760c4d8b40fba37db8fa48",
  workspaceType: "w",
  workspaceId: "f31b499c519e8471cced93dc",
  configuration: "",
});
const project = {
  ...Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "project-test",
    title: "CAD",
    workspaceRoot: "D:/managed/project-test",
    defaultModelSelection: null,
    onshapeSource: source,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }),
  environmentId: EnvironmentId.make("test"),
};
const replacement = {
  connectionId: OnshapeConnectionId.make("22222222-2222-4222-8222-222222222222"),
  name: "Replacement",
  host: source.host,
};
const incompatible = {
  connectionId: source.connectionId,
  name: "Other host",
  host: "https://enterprise.onshape.com",
};
const refresh = vi.fn();
const catalog = {
  connections: [replacement, incompatible],
  hasListData: true,
  listError: null,
  pendingKey: null,
  isListPending: false,
  refresh,
};

function render(currentSource = source) {
  hooks.beginRender();
  return OnshapeProjectSettings({
    project: { ...project, onshapeSource: currentSource },
    source: currentSource,
  });
}
function select(connectionId: string) {
  findAll(render(), (props) => props.onValueChange !== undefined)[0]?.onValueChange?.(connectionId);
}
function saveButton() {
  return findAll(render(), (props) => props.children === "Save connection")[0];
}

describe("Onshape project connection recovery", () => {
  beforeEach(() => {
    hooks.reset();
    state.command.mockReset();
    state.check.mockReset();
    refresh.mockReset();
    state.catalog.mockReturnValue(catalog);
  });
  it.each(["missing", "incompatible"])(
    "explains an %s connection and only offers compatible replacements",
    (kind) => {
      state.catalog.mockReturnValue({
        ...catalog,
        connections: kind === "missing" ? [replacement] : catalog.connections,
      });
      const tree = render();
      expect(findAll(tree, (props) => props.role === "status")[0]?.children).toContain(
        "available offline",
      );
      expect(
        findAll(
          tree,
          (props) => props.value !== undefined && props.onValueChange === undefined,
        ).map((props) => props.value),
      ).toEqual([replacement.connectionId]);
      expect(saveButton()?.disabled).toBe(true);
      saveButton()?.onClick?.();
      expect(state.command).not.toHaveBeenCalled();
    },
  );
  it("saves the chosen compatible connection without changing the CAD source", async () => {
    const result = Promise.resolve(AsyncResult.success({ projectId: project.id }));
    state.command.mockReturnValue(result);
    select(replacement.connectionId);
    saveButton()?.onClick?.();
    await result;
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: project.environmentId,
      input: { projectId: project.id, connectionId: replacement.connectionId },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const tree = render({ ...source, connectionId: replacement.connectionId });
    expect(findAll(tree, (props) => props.role === "status")).toHaveLength(0);
    expect(findAll(tree, (props) => props.children === "Save connection")[0]?.disabled).toBe(true);
  });
  it("retains the selected replacement and explains a failed save", async () => {
    const result = Promise.resolve(
      AsyncResult.failure(Cause.fail(new OnshapeProjectHostMismatchError())),
    );
    state.command.mockReturnValue(result);
    select(replacement.connectionId);
    saveButton()?.onClick?.();
    await result;
    const tree = render();
    expect(findAll(tree, (props) => props.role === "alert")[0]?.children).toBe(
      "This Onshape URL belongs to a different Onshape host.",
    );
    expect(findAll(tree, (props) => props.onValueChange !== undefined)[0]?.value).toBe(
      replacement.connectionId,
    );
    expect(refresh).not.toHaveBeenCalled();
  });
  it("does not submit while a connection mutation is pending or after the selected replacement disappears", () => {
    select(replacement.connectionId);
    state.catalog.mockReturnValue({ ...catalog, pendingKey: "remove:another-connection" });
    expect(saveButton()?.disabled).toBe(true);
    saveButton()?.onClick?.();
    expect(state.command).not.toHaveBeenCalled();
    state.catalog.mockReturnValue({ ...catalog, connections: [incompatible] });
    saveButton()?.onClick?.();
    expect(state.command).not.toHaveBeenCalled();
  });
});

describe("Onshape version check button", () => {
  const enabled: OnshapeProjectSource = { ...source, autoReviewVersions: true };
  const checkButton = (currentSource = enabled) =>
    findAll(render(currentSource), (props) => props.children === "Check now")[0];
  const statusText = () =>
    findAll(render(enabled), (props) => props.role === "status").map((props) => props.children);
  beforeEach(() => {
    hooks.reset();
    state.check.mockReset();
    state.catalog.mockReturnValue({
      ...catalog,
      connections: [{ connectionId: source.connectionId, name: "Current", host: source.host }],
    });
  });

  it("only offers Check now while version reviews are on", () => {
    expect(checkButton(source)).toBeUndefined();
    expect(checkButton()?.disabled).toBe(false);
  });

  it("sends a manual check, disables the button while it runs, then shows the result", async () => {
    let settle: (value: unknown) => void = () => {};
    state.check.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    checkButton()?.onClick?.();
    expect(state.check).toHaveBeenCalledExactlyOnceWith({
      environmentId: project.environmentId,
      input: { projectId: project.id, reason: "manual" },
    });
    expect(checkButton()?.disabled).toBe(true);
    checkButton()?.onClick?.();
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(statusText()).toEqual([]);

    const result = AsyncResult.success({
      status: "reviewing",
      versions: [{ ordinal: 12, name: "Bracket rev" }],
    });
    settle(result);
    await Promise.resolve(result);
    await Promise.resolve();
    expect(checkButton()?.disabled).toBe(false);
    expect(statusText()).toEqual(["Reviewing v12"]);
  });

  it.each([
    [AsyncResult.success({ status: "no-new-versions" }), "No new versions"],
    [AsyncResult.success({ status: "skipped", reason: "in-progress" }), "Check already running"],
    [AsyncResult.failure(Cause.fail(new Error("socket closed"))), "Could not check. Try again."],
  ])("shows %# as short text", async (value, text) => {
    const result = Promise.resolve(value);
    state.check.mockReturnValue(result);
    checkButton()?.onClick?.();
    await result;
    await Promise.resolve();
    expect(statusText()).toEqual([text]);
  });
});
