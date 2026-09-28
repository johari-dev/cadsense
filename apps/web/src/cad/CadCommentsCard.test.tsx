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
const chat = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  navigate: vi.fn(),
  seedPrompt: vi.fn(),
  composer: { readSnapshot: vi.fn(), focusAt: vi.fn(), focusAtEnd: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => chat.navigate,
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(chat.params),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ seedPrompt: chat.seedPrompt }) },
}));
vi.mock("../composerHandleContext", () => ({
  useComposerHandleContext: () => ({ current: chat.composer }),
}));

import { CadCommentsCard, CadSeverityLabel } from "./CadCommentsCard";

afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
  commands.review.mockReset();
  chat.params = {};
  chat.navigate.mockReset();
  chat.seedPrompt.mockReset();
  chat.composer.readSnapshot.mockReset();
  chat.composer.focusAt.mockReset();
  chat.composer.focusAtEnd.mockReset();
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
    (buttons[0]!.props.onClick as () => void)();
    expect(commands.review).toHaveBeenCalledTimes(1);
    expect(actions(render()).every((button) => button.props.disabled === true)).toBe(true);
    complete({ _tag: outcome });
    await Promise.resolve();
    expect(props.clearSelection).toHaveBeenCalledTimes(outcome === "Success" ? 1 : 0);
    expect(actions(render()).every((button) => !button.props.disabled)).toBe(true);
  },
);

const REASON_PLACEHOLDER = "Why? (optional, becomes a review learning)";
it("asks for a dismiss reason, sends it trimmed once, and cancels on Escape", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  commands.review.mockResolvedValue({ _tag: "Success" });
  const comment = {
    id: "dismiss-comment",
    number: 2,
    state: "open",
    version: 0,
    snapshotId: "snapshot",
    modelDescriptor: "model",
    title: "Vent hole",
    body: "Open hole",
    targets: [{ kind: "part", occurrenceId: "plate", label: "Plate" }],
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
  const render = (current = props) => {
    hooks.beginRender();
    return CadCommentsCard(current);
  };
  const byText = (tree: ReactNode, text: string) =>
    elements(tree).find((element) => element.props.children === text);
  const reasonInput = (tree: ReactNode) =>
    elements(tree).find((element) => element.props.placeholder === REASON_PLACEHOLDER);
  expect(reasonInput(render())).toBeUndefined();
  (byText(render(), "Dismiss")!.props.onClick as () => void)();
  expect(commands.review).not.toHaveBeenCalled();
  const input = reasonInput(render())!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "  Vent holes are intentional  " },
  });
  const form = elements(render()).find((element) => typeof element.props.onSubmit === "function")!;
  const submit = form.props.onSubmit as (event: { preventDefault: () => void }) => void;
  submit({ preventDefault: vi.fn() });
  submit({ preventDefault: vi.fn() });
  expect(commands.review).toHaveBeenCalledTimes(1);
  expect(commands.review.mock.calls[0]![0]).toMatchObject({
    environmentId: "test",
    input: { commentId: comment.id, state: "dismissed", reason: "Vent holes are intentional" },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(props.clearSelection).toHaveBeenCalledWith(comment.id);
  expect(reasonInput(render())).toBeUndefined();
  // Escape closes the input without reviewing; an empty reason is simply omitted.
  (byText(render(), "Dismiss")!.props.onClick as () => void)();
  (reasonInput(render())!.props.onKeyDown as (event: unknown) => void)({
    key: "Escape",
    preventDefault: vi.fn(),
  });
  expect(reasonInput(render())).toBeUndefined();
  expect(commands.review).toHaveBeenCalledTimes(1);
  // A dismissed finding shows the reason that was kept with it.
  const dismissed: CadComment = {
    ...comment,
    state: "dismissed",
    reviewReason: "Intentional vent",
  };
  expect(
    elements(render({ ...props, comments: [dismissed] })).some(
      (element) =>
        Array.isArray(element.props.children) &&
        element.props.children.join("") === "Dismissed: Intentional vent",
    ),
  ).toBe(true);
});

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

it("seeds the active thread's composer at its cursor for a point finding", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  chat.params = { environmentId: "test", threadId: "thread" };
  chat.composer.readSnapshot.mockReturnValue({ value: "why is", cursor: 3, expandedCursor: 3 });
  chat.seedPrompt.mockReturnValue(42);
  const comment = {
    id: "point-comment",
    number: 7,
    state: "open",
    snapshotId: "snapshot",
    modelDescriptor: "model",
    title: "Missing screw",
    body: "No screw in the rim hole.",
    targets: [
      { kind: "point", occurrenceId: "rim", label: "Rim hole A" },
      { kind: "point", occurrenceId: "rim", label: "Rim hole B" },
    ],
  } as unknown as CadComment;
  const setOpen = vi.fn();
  hooks.beginRender();
  const tree = CadCommentsCard({
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    comments: [comment],
    manifest: null,
    displayedSnapshotId: "snapshot",
    renderer: { current: null },
    open: true,
    setOpen,
    selection: { id: comment.id, target: 1, request: 1 },
    clearSelection() {},
    choose() {},
    historical: true,
    back() {},
  });
  const discuss = elements(tree).find((element) => element.props.children === "Discuss");
  (discuss!.props.onClick as () => void)();
  expect(chat.seedPrompt).toHaveBeenCalledWith(
    { environmentId: "test", threadId: "thread" },
    'About CAD comment #7 "Missing screw" (Rim hole A): ',
    3,
  );
  expect(chat.navigate).not.toHaveBeenCalled();
  expect(setOpen).not.toHaveBeenCalled();
  frames.forEach((callback) => callback(0));
  expect(chat.composer.focusAt).toHaveBeenCalledWith(42);
});

it("opens the finding's thread from the floating card for a whole-part finding", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  chat.params = { environmentId: "test", threadId: "other-thread" };
  chat.seedPrompt.mockReturnValue(null);
  const comment = {
    id: "part-comment",
    number: 2,
    state: "resolved",
    snapshotId: "snapshot",
    modelDescriptor: "model",
    title: "Battery location",
    body: "Battery",
    targets: [
      { kind: "part", occurrenceId: "battery", label: "Battery", preciseLocationLimitation: "x" },
    ],
  } as unknown as CadComment;
  const setOpen = vi.fn();
  hooks.beginRender();
  const tree = CadCommentsCard({
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    comments: [comment],
    manifest: null,
    displayedSnapshotId: "snapshot",
    renderer: { current: null },
    open: true,
    setOpen,
    selection: { id: comment.id, target: 0, request: 1 },
    clearSelection() {},
    choose() {},
    historical: true,
    back() {},
    floating: true,
  });
  const discuss = elements(tree).find((element) => element.props.children === "Discuss");
  (discuss!.props.onClick as () => void)();
  expect(chat.composer.readSnapshot).not.toHaveBeenCalled();
  expect(chat.seedPrompt).toHaveBeenCalledWith(
    { environmentId: "test", threadId: "thread" },
    'About CAD comment #2 "Battery location" (Battery): ',
    null,
  );
  expect(chat.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "test", threadId: "thread" },
  });
  expect(setOpen).toHaveBeenCalledWith(false);
  expect(chat.composer.focusAt).not.toHaveBeenCalled();
});

it("orders open findings by severity then number and labels each one", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const comment = (number: number, severity: CadComment["severity"], state = "open") =>
    ({
      id: `c${number}`,
      number,
      state,
      severity,
      category: severity === null ? null : "access",
      snapshotId: "snapshot",
      modelDescriptor: "model",
      title: `Finding ${number}`,
      body: "Body",
      targets: [{ kind: "part", occurrenceId: "part", label: "Part" }],
    }) as unknown as CadComment;
  const comments = [
    comment(1, "nit"),
    comment(2, "blocker"),
    comment(3, null),
    comment(4, "concern"),
    comment(5, "blocker"),
    comment(6, "blocker", "resolved"),
  ];
  const props = {
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    comments,
    manifest: null,
    displayedSnapshotId: "snapshot",
    renderer: { current: null },
    open: true,
    setOpen() {},
    selection: { id: "c2", target: 0, request: 1 },
    clearSelection() {},
    choose() {},
    historical: false,
    back() {},
  };
  hooks.beginRender();
  const tree = CadCommentsCard(props);
  const listed = elements(tree).filter((element) => element.type === "article");
  expect(listed.map((element) => element.key)).toEqual(["c2", "c5", "c4", "c1", "c3"]);
  const labels = elements(tree).filter((element) => element.type === CadSeverityLabel);
  // Each listed finding shows its label once, and the expanded finding repeats it above the body.
  expect(labels.map((element) => element.props.severity)).toEqual([
    "blocker",
    "blocker",
    "blocker",
    "concern",
    "nit",
    null,
  ]);
  expect(CadSeverityLabel({ severity: "blocker" })?.props.className).toContain("text-foreground");
  expect(CadSeverityLabel({ severity: "nit" })?.props.className).toContain(
    "text-muted-foreground/60",
  );
  expect(CadSeverityLabel({ severity: null })).toBeNull();
  hooks.reset();
  hooks.beginRender();
  const closed = elements(CadCommentsCard({ ...props, open: false, selection: null }));
  const toggle = closed.find((element) => element.props["aria-expanded"] === false);
  expect(toggle?.props["aria-label"]).toBe("Comments (5 unresolved, 2 blocking)");
  expect(toggle?.props.title).toBe("2 blocking");
});

it("shows why a comment is outdated and the proposed resolution beside the Resolve control", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const comment = {
    id: "stale",
    number: 1,
    state: "open",
    snapshotId: "snapshot",
    modelDescriptor: "model",
    title: "Battery location",
    body: "Battery",
    targets: [{ kind: "part", occurrenceId: "battery", label: "Battery" }],
    outdated: { snapshotId: "newer", reason: "geometry-changed" },
    proposal: { snapshotId: "newer", explanation: "The new revision adds the bracket." },
  } as unknown as CadComment;
  hooks.beginRender();
  const tree = CadCommentsCard({
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    comments: [comment],
    manifest: null,
    displayedSnapshotId: "snapshot",
    renderer: { current: null },
    open: true,
    setOpen() {},
    selection: { id: comment.id, target: 0, request: 1 },
    clearSelection() {},
    choose() {},
    historical: true,
    back() {},
  });
  const text = (node: ReactNode): string =>
    Array.isArray(node)
      ? node.map(text).join("")
      : isValidElement<Record<string, unknown>>(node)
        ? text(node.props.children as ReactNode)
        : typeof node === "string" || typeof node === "number"
          ? String(node)
          : "";
  expect(text(tree)).toContain("Outdated: geometry changed in a newer revision");
  expect(text(tree)).toContain("Proposed resolution: The new revision adds the bracket.");
  expect(text(tree)).toContain("Resolve · 1");
});
