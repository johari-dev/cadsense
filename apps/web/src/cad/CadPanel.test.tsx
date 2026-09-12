import {
  EnvironmentId,
  ThreadId,
  CadSnapshotManifest,
  type CadViewState,
  type CadComment,
} from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  isValidElement,
  type ReactNode,
  type RefObject,
  type EffectCallback,
  type DependencyList,
} from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import type { Project } from "../types";

const boundary = vi.hoisted(() => ({
  lease: null as unknown,
  effects: [] as Array<() => void>,
  acquire: vi.fn(),
  peek: vi.fn(),
  commentsManifest: null as unknown,
  mount: vi.fn(),
  panelState: null as unknown,
  commentState: null as unknown,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useRef: h.useRef,
    useState: h.useState,
    useMemo: h.useMemo,
    useCallback: h.useCallback,
    useSyncExternalStore: h.useSyncExternalStore,
    useDebugValue: () => {},
    useContext: () => ({ mount: boundary.mount }),
    useLayoutEffect: (effect: EffectCallback, deps: DependencyList) =>
      h.useEffect(() => {
        let cleanup: ReturnType<EffectCallback>;
        boundary.effects.push(() => {
          cleanup = effect();
        });
        return () => cleanup?.();
      }, deps),
  };
});
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: {},
  useAtomValue: (atom: string) =>
    atom === "watch"
      ? boundary.panelState
      : atom === "comments"
        ? boundary.commentState
        : boundary.lease,
}));
vi.mock("../state/cadPanel", () => ({
  cadPanelEnvironment: { scene: () => "scene", watch: () => "watch", comments: () => "comments" },
}));
vi.mock("../state/environments", () => ({ useEnvironmentHttpBaseUrl: () => "http://localhost/" }));
vi.mock("../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../hooks/useResizableWidth", () => ({ useResizableWidth: () => ({ cancelResize() {} }) }));
vi.mock("./CadVisibleViewer", () => ({ cadVisibleViewer: boundary }));
vi.mock("./CadAppearance", () => ({ observeCadAppearance: () => () => {} }));
vi.mock("./CadCommentsCard", () => ({
  CadCommentsCard: (props: { manifest: unknown }) => {
    boundary.commentsManifest = props.manifest;
    return null;
  },
}));
vi.mock("./CadPanel.css", () => ({}));
vi.mock("./useCadActivityIndicator", () => ({ useCadActivityIndicator: () => false }));
vi.mock("./cadCommentReviewStore", async (original) => {
  const actual = await original<typeof import("./cadCommentReviewStore")>();
  const store = actual.useCadCommentReviewStore;
  return {
    ...actual,
    useCadCommentReviewStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) => selector(store.getState()),
      store,
    ),
  };
});

import { CadPanel, CadScene } from "./CadPanel";
import { useCadCommentReviewStore } from "./cadCommentReviewStore";

afterEach(() => {
  hooks.reset();
  boundary.effects.length = 0;
  boundary.commentsManifest = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  useCadCommentReviewStore.setState({ pending: {}, sessions: {}, sessionOrder: [] });
});

const manifest = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: "1".repeat(64),
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: "https://cad.onshape.com",
    documentId: "1".repeat(24),
    elementId: "2".repeat(24),
    kind: "part-studio",
    originalRevision: { kind: "m", id: "3".repeat(24) },
    microversionId: "3".repeat(24),
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [],
  parts: [],
  assets: [],
  dependencies: [],
});
const harness = (
  warm = true,
  displayed = warm,
  framing: { x: number; y: number } | null = null,
) => {
  const view: CadViewState = {
    snapshotId: manifest.snapshotId,
    rootId: "root",
    revision: 0,
    camera: { kind: "preset", preset: "isometric", fit: [] },
    visibility: {},
    isolatedOccurrenceIds: [],
    explosion: 0,
  };
  const release = vi.fn();
  const releaseTicket = vi.fn();
  boundary.mount.mockReturnValue(releaseTicket);
  let cached = warm;
  let active = displayed;
  let running = false;
  let loadListener: ((state: unknown) => void) | null = null;
  const manifestsWhenLoading: unknown[] = [];
  const load = vi.fn(async () => {
    manifestsWhenLoading.push(boundary.commentsManifest);
    cached = true;
    active = true;
    return warm;
  });
  const transition = vi.fn();
  const apply = vi.fn();
  const restoreCommentFraming = vi.fn();
  const graphics = {
    cachedManifest: () => (cached ? manifest : null),
    displayedManifest: () => (active ? manifest : null),
    setInteractive() {},
    resize() {},
    apply,
    transition,
    restoreCommentFraming,
    load,
  } as unknown as CadSceneRenderer;
  boundary.peek.mockImplementation(() => (cached ? manifest : null));
  boundary.acquire.mockReturnValue({
    renderer: graphics,
    release,
    diagnostics: { record() {} },
    canvas: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    watchLoad: vi.fn((_snapshotId: string, listener: (state: unknown) => void) => {
      loadListener = listener;
      listener(active ? { status: "ready", manifest } : { status: "idle" });
      return () => {
        if (loadListener === listener) loadListener = null;
      };
    }),
    ensureLoad: vi.fn(
      (
        _snapshotId: string,
        _sourceKey: string,
        retain: () => () => void,
        run: (
          renderer: CadSceneRenderer,
          signal: AbortSignal,
          progress: (received: number, total: number) => void,
        ) => Promise<typeof manifest>,
      ) => {
        if (active || running) return;
        running = true;
        const releaseLease = retain();
        loadListener?.({ status: "loading", received: 0, total: null });
        void run(graphics, new AbortController().signal, (received, total) =>
          loadListener?.({ status: "loading", received, total }),
        ).then((loaded) => {
          running = false;
          cached = true;
          active = true;
          releaseLease();
          loadListener?.({ status: "ready", manifest: loaded });
        });
      },
    ),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const props: Parameters<typeof CadScene>[0] = {
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
    view,
    disabled: false,
    cadDimmed: false,
    onChange() {},
    captureId: null,
    fullscreen: false,
    compact: false,
    framing,
    commentsCard: {
      threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
      comments: [],
      renderer: { current: null as CadSceneRenderer | null },
      open: false,
      setOpen() {},
      selection: null,
      clearSelection() {},
      choose() {},
      historical: false,
      back() {},
    },
  };
  const attach = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(attach);
      return;
    }
    if (
      !isValidElement<{
        ref?: RefObject<unknown>;
        children?: ReactNode;
        displayedSnapshotId?: string;
        manifest?: unknown;
      }>(node)
    )
      return;
    if ("displayedSnapshotId" in node.props) boundary.commentsManifest = node.props.manifest;
    if (node.props.ref) node.props.ref.current = {};
    attach(node.props.children);
  };
  const render = async () => {
    hooks.beginRender();
    attach(CadScene(props));
    boundary.effects.splice(0).forEach((effect) => effect());
    await Promise.resolve();
  };
  boundary.lease = AsyncResult.initial();
  return {
    render,
    load,
    transition,
    apply,
    restoreCommentFraming,
    release,
    releaseTicket,
    props,
    manifestsWhenLoading,
  };
};

it("restores comment framing when the requested scene is already displayed", async () => {
  const framing = { x: 0.2, y: -0.1 };
  const { render, restoreCommentFraming } = harness(true, true, framing);
  await render();
  expect(restoreCommentFraming).toHaveBeenCalledWith(framing);
});

it("does not expose a cached comment manifest until that snapshot is displayed", async () => {
  const { render, load, manifestsWhenLoading } = harness(true, false);
  await render();
  expect(load).toHaveBeenCalledTimes(1);
  expect(manifestsWhenLoading).toEqual([null]);
  // The load resolves in a microtask; the next render exposes the now-active snapshot.
  await render();
  expect(boundary.commentsManifest).toBe(manifest);
});

it("keeps a warm scene attached when its server lease arrives or is replaced", async () => {
  const { render, load, transition, apply, release } = harness();
  await render();
  for (const sceneId of ["lease-1", "lease-1", "lease-2"]) {
    boundary.lease = AsyncResult.success({ sceneId, token: sceneId });
    await render();
  }
  expect(boundary.acquire).toHaveBeenCalledTimes(1);
  expect(load).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  hooks.reset();
  expect(release).toHaveBeenCalledTimes(1);
});

it("keeps a cold scene load alive across panel detach and rejoins it with the latest view", async () => {
  const { render, load, apply, release, releaseTicket, props } = harness(false);
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const fetch = vi.fn(
    (_url: URL, options: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({ signal: options.signal!, resolve });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  boundary.lease = AsyncResult.success({ sceneId: "old", token: "old" });
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  expect(boundary.mount).toHaveBeenCalledTimes(1);
  hooks.reset();
  expect(release).toHaveBeenCalledTimes(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  expect(releaseTicket).not.toHaveBeenCalled();

  const latestView: CadViewState = {
    ...props.view,
    camera: { kind: "preset", preset: "front", fit: [] },
  };
  props.view = latestView;
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  requests[0]!.resolve(Response.json(manifest));
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(apply).toHaveBeenLastCalledWith(latestView);
  expect(boundary.acquire).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(releaseTicket).toHaveBeenCalledOnce();
  hooks.reset();
  expect(release).toHaveBeenCalledTimes(2);
});

function reviewHarness() {
  const current: CadViewState = {
    snapshotId: "current",
    rootId: "root",
    revision: 1,
    camera: { kind: "preset", preset: "front", fit: [] },
    visibility: {},
    isolatedOccurrenceIds: [],
    explosion: 0,
  };
  const props: Parameters<typeof CadPanel>[0] = {
    project: { id: "project", environmentId: "test" } as Project,
    threadRef: { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") },
  };
  boundary.panelState = AsyncResult.success({
    view: current,
    userRevision: 1,
    agentControlling: false,
  });
  boundary.commentState = AsyncResult.success({ comments: [], modelDescriptors: {} });
  boundary.peek.mockReturnValue(null);
  const comment = {
    id: "comment",
    rootId: "historical-root",
    snapshotId: "historical",
    modelDescriptor: "previous",
  } as CadComment;
  const render = () => {
    hooks.beginRender();
    const tree = CadPanel(props);
    let scene: Parameters<typeof CadScene>[0] | undefined;
    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!isValidElement<{ children?: ReactNode }>(node)) return;
      if (node.type === CadScene) scene = node.props as Parameters<typeof CadScene>[0];
      visit(node.props.children);
    };
    visit(tree);
    boundary.effects.splice(0).forEach((effect) => effect());
    if (!scene) throw new Error("Expected CAD scene");
    return scene;
  };
  return { props, current, comment, render };
}

it("remounts a historical review on the same snapshot while its geometry is still loading", () => {
  const { render, comment } = reviewHarness();
  render().commentsCard.choose(comment, 0);
  const before = render();
  expect(before.view.snapshotId).toBe("historical");
  // No manifest or completed geometry exists. Closing the outer panel must preserve its intent.
  hooks.reset();
  const after = render();
  expect(after.view).toEqual(before.view);
  expect(after.commentsCard.open).toBe(true);
  expect(after.commentsCard.selection).toEqual(before.commentsCard.selection);
  expect(after.commentsCard.historical).toBe(true);
});

it("keeps a same-snapshot comment in the current view while its manifest is loading", () => {
  const { render, comment, current } = reviewHarness();
  const currentComment = {
    ...comment,
    rootId: current.rootId,
    snapshotId: current.snapshotId,
  };
  render().commentsCard.choose(currentComment, 0);
  const selected = render();
  expect(selected.view).toEqual(current);
  expect(selected.commentsCard.open).toBe(true);
  expect(selected.commentsCard.selection?.id).toBe(comment.id);
  expect(selected.commentsCard.historical).toBe(false);
  expect(Object.values(useCadCommentReviewStore.getState().sessions)[0]!.savedCurrent).toBeNull();
});

it("isolates review sessions by environment and thread when navigating away and back", () => {
  const { render, comment, props } = reviewHarness();
  render().commentsCard.choose(comment, 0);
  expect(render().view.snapshotId).toBe("historical");
  props.threadRef = { ...props.threadRef, threadId: ThreadId.make("other-thread") };
  expect(render().view.snapshotId).toBe("current");
  expect(render().commentsCard.open).toBe(false);
  props.threadRef = {
    ...props.threadRef,
    threadId: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("other-environment"),
  };
  expect(render().view.snapshotId).toBe("current");
  props.threadRef = { ...props.threadRef, environmentId: EnvironmentId.make("test") };
  expect(render().view.snapshotId).toBe("historical");
});

it("Back to current clears durable historical state and preserves the saved return view on remount", () => {
  const { render, comment, current } = reviewHarness();
  render().commentsCard.choose(comment, 0);
  const historical = render();
  historical.onChange({ ...historical.view, camera: { kind: "preset", preset: "top", fit: [] } });
  hooks.reset();
  render().commentsCard.back();
  hooks.reset();
  const restored = render();
  expect(restored.view).toEqual(current);
  expect(restored.framing).toEqual({ x: 0, y: 0 });
  expect(restored.commentsCard.selection).toBeNull();
  expect(restored.commentsCard.historical).toBe(false);
  expect(Object.values(useCadCommentReviewStore.getState().sessions)[0]!.savedCurrent).toBeNull();
});

it("returns to a newer current snapshot if CAD changed while the historical panel was closed", () => {
  const { render, comment, current } = reviewHarness();
  render().commentsCard.choose(comment, 0);
  hooks.reset();
  boundary.panelState = AsyncResult.success({
    view: { ...current, snapshotId: "new-current" },
    userRevision: 2,
    agentControlling: false,
  });
  render().commentsCard.back();
  hooks.reset();
  const restored = render();
  expect(restored.view.snapshotId).toBe("new-current");
  expect(restored.framing).toBeNull();
  expect(restored.commentsCard.historical).toBe(false);
});
