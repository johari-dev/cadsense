import {
  EnvironmentId,
  ThreadId,
  type CadComment,
  type CadSnapshotManifest,
} from "@cadsense/contracts";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import { isValidElement, type ReactNode, type RefObject } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import type { CadSceneRenderer } from "./CadSceneRenderer";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useRef: h.useRef,
    useState: h.useState,
    useMemo: h.useMemo,
    useEffect: h.useEffect,
  };
});
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../state/cadPanel", () => ({ cadPanelEnvironment: { review: "review" } }));
const commands = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => commands.review }));

import { CadCommentsCard } from "./CadCommentsCard";

afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
  commands.review.mockReset();
});

function elements(node: ReactNode): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

it.each(["Success", "Failure"] as const)(
  "guards duplicate reviews and restores controls after %s",
  async (outcome) => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let complete!: (value: { _tag: "Success" | "Failure" }) => void;
    commands.review.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const comment = {
      id: "review-comment",
      number: 1,
      state: "open",
      snapshotId: "snapshot",
      modelDescriptor: "model",
      title: "Battery location",
      body: "Battery",
      targets: [{ kind: "part", occurrenceId: "battery", label: "Battery" }],
    } as unknown as CadComment;
    const props = {
      threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
      comments: [comment],
      manifest: null,
      displayedSnapshotId: "snapshot",
      renderer: { current: null },
      open: true,
      setOpen() {},
      selection: { id: comment.id, target: 0, request: 1 },
      clearSelection: vi.fn(),
      choose() {},
      historical: true,
      back() {},
    };
    const render = () => {
      hooks.beginRender();
      return CadCommentsCard(props);
    };
    const actions = (tree: ReactNode) =>
      elements(tree).filter((element) => {
        return (
          typeof element.props.onClick === "function" &&
          (element.props.children === "Dismiss" ||
            (Array.isArray(element.props.children) &&
              element.props.children.includes("Resolve · ")))
        );
      });
    const buttons = actions(render());
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props.onClick as () => void)();
    (buttons[1]!.props.onClick as () => void)();
    expect(commands.review).toHaveBeenCalledTimes(1);
    expect(actions(render()).every((button) => button.props.disabled === true)).toBe(true);
    complete({ _tag: outcome });
    await Promise.resolve();
    expect(props.clearSelection).toHaveBeenCalledTimes(outcome === "Success" ? 1 : 0);
    expect(actions(render()).every((button) => !button.props.disabled)).toBe(true);
  },
);

it("updates comment markers after scene changes without repeating idle projections", () => {
  const manifest = {
    rootId: "root",
    root: {},
    nodes: [],
    parts: [],
    assets: [],
    dependencies: [],
  } as unknown as CadSnapshotManifest;
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  const listeners = new Set<() => void>();
  const project = vi.fn(() => ({ x: 10, y: 20, visible: true, occluded: false }));
  const graphics = {
    commentProjection: project,
    endCommentReview() {},
    subscribeFrames(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  } as unknown as CadSceneRenderer;
  const comment = {
    id: "comment",
    number: 1,
    state: "open",
    snapshotId: "snapshot",
    modelDescriptor: cadCommentModelDescriptor(manifest),
    targets: [{ kind: "part", occurrenceId: "part", label: "Part" }],
  } as unknown as CadComment;
  const marker = { dataset: { comment: comment.id, target: "0" }, style: {} };
  const props = {
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    comments: [comment],
    manifest,
    displayedSnapshotId: "snapshot",
    renderer: { current: graphics },
    open: false,
    setOpen() {},
    selection: null,
    clearSelection() {},
    choose() {},
    historical: false,
    back() {},
  };
  hooks.beginRender();
  const tree = CadCommentsCard(props);
  const attach = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(attach);
      return;
    }
    if (
      !isValidElement<{ ref?: RefObject<unknown>; children?: ReactNode; className?: string }>(node)
    )
      return;
    if (node.props.className === "absolute inset-0 overflow-hidden" && node.props.ref)
      node.props.ref.current = { querySelectorAll: () => [marker] };
    attach(node.props.children);
  };
  attach(tree);
  for (let i = 0; i < 60; i++) tick();
  expect(project).toHaveBeenCalledTimes(1);
  // Multiple renders in one browser frame should coalesce into one marker update.
  for (let i = 0; i < 3; i++) for (const listener of listeners) listener();
  tick();
  expect(project).toHaveBeenCalledTimes(2);
  hooks.beginRender();
  attach(CadCommentsCard({ ...props, comments: [{ ...comment, state: "resolved" }] }));
  tick();
  expect(project).toHaveBeenCalledTimes(2);
  hooks.beginRender();
  const loadingTree = CadCommentsCard({ ...props, manifest: null });
  attach(loadingTree);
  expect(
    elements(loadingTree).some((element) => element.props["data-comment"] === comment.id),
  ).toBe(false);
  tick();
  expect(project).toHaveBeenCalledTimes(2);
  hooks.reset();
  expect(frames.size).toBe(0);
  expect(listeners.size).toBe(0);
});
