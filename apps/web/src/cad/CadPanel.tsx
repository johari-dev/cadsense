import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CadSnapshotManifest,
  isSolidWorksFile,
  type CadComment,
  type CadViewState,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { CadLoadingProgress, type CadLoadProgress } from "./CadLoadingProgress";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { loadCadAssetDelivery } from "./CadAssetDelivery";
import { cadVisibleViewer } from "./CadVisibleViewer";
import { CadViewChanges } from "./CadViewChanges";
import {
  cadPanelLockStatus,
  findCadThreadRunBlocker,
  type CadPanelLockStatus,
} from "./CadProjectState";
import { observeCadAppearance } from "./CadAppearance";
import { CadCameraToolbar } from "./CadCameraToolbar";
import { captureModelThumbnail } from "./modelThumbnails";
import { createCadViewEdits } from "./CadViewEdits";
import { CadScenePicker } from "./CadScenePicker";
import { CadLocalSyncButton } from "./CadLocalSyncButton";
import { CadFilePrompt } from "./CadFilePrompt";
import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import { useCadActivityIndicator } from "./useCadActivityIndicator";
import { onshapeProjectUrl } from "../lib/onshapeProjects";
import { useOpenInFileManager } from "../components/chat/OpenInExplorerButton";
import { toastManager } from "../components/ui/toast";
import { resolvePathLinkTarget } from "../path-links";
import "./CadPanel.css";
import {
  EMPTY_CAD_PANEL_REVIEW,
  useCadCommentReviewStore,
  type CadPanelReviewSession,
  type CadCommentLocation,
} from "./cadCommentReviewStore";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import {
  CAD_COMMENTS_CARD_WIDTH,
  CadCommentsCard,
  type CadCommentsCardProps,
} from "./CadCommentsCard";
import { holdInspection } from "../components/sidebarInspection";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const EMPTY_CAPTURE_VIEWS: CadCommentsCardProps["captureViews"] = {};
/**
 * Overlay chrome fits and comment focus keep the model clear of: the parts chip along the top,
 * the camera toolbar along the bottom, and a floating comments card (12px from the right edge)
 * plus 32px of clearance. A docked card sits beside the canvas, so it needs no inset. The
 * compact preview shows no chip or toolbar.
 */
const frameInsets = (compact: boolean, cardFloating: boolean) => ({
  top: compact ? 0 : 48,
  bottom: compact ? 0 : 64,
  right: cardFloating ? CAD_COMMENTS_CARD_WIDTH + 12 + 32 : 0,
});
/** Width of the docked comments column, in CSS px. */
const DOCK_WIDTH = 320;
/**
 * Below this scene width the open comments card floats over the viewport; at or above it, the
 * card docks as a column beside a viewport that keeps at least 420px, so it never covers the
 * model. The default CAD panel in a 1440px window (about 760px) docks.
 */
const DOCK_MIN_WIDTH = DOCK_WIDTH + 420;
const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One-line reason the CAD panel ignores input, shown along the bottom of the viewer. */
function CadLockStrip({ status }: { status: CadPanelLockStatus }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-secondary-label"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${status.agent ? "bg-emerald-400" : "bg-muted-foreground"}`}
      />
      <span className="truncate">{status.message}</span>
    </div>
  );
}

function PendingCadScene({ environmentId }: { environmentId: string }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!container.current) return;
    try {
      const attachment = cadVisibleViewer.acquire(container.current, environmentId, {});
      attachment.renderer.setInteractive(false);
      return () => attachment.release();
    } catch {
      // The resolved scene owns graphics error reporting; a pending view has no scene yet.
      return;
    }
  }, [environmentId]);
  return (
    <div
      ref={container}
      aria-label="Updating CAD view"
      aria-busy="true"
      className="min-h-48 flex-1 overflow-hidden pointer-events-none"
    />
  );
}

export function CadScene({
  threadRef,
  view,
  disabled,
  cadDimmed,
  onChange,
  captureId,
  fullscreen,
  compact,
  commentsCard,
  framing,
  lockStatus = null,
}: {
  threadRef: ScopedThreadRef;
  view: CadViewState;
  disabled: boolean;
  cadDimmed: boolean;
  onChange: (view: CadViewState) => void;
  captureId: string | null;
  fullscreen: boolean;
  compact: boolean;
  framing: { x: number; y: number } | null;
  commentsCard: Omit<CadCommentsCardProps, "manifest" | "displayedSnapshotId">;
  lockStatus?: CadPanelLockStatus | null;
}) {
  const sceneAtom = cadPanelEnvironment.scene({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, snapshotId: view.snapshotId },
  });
  const lease = useAtomValue(sceneAtom);
  const registry = useContext(RegistryContext);
  const baseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const ticket = AsyncResult.isSuccess(lease) ? lease.value : null;
  const canvas = useRef<HTMLDivElement>(null);
  const renderer = commentsCard.renderer;
  // Where the primary pointer went down on the viewer, to tell a click from an orbit drag.
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const attachmentRef = useRef<ReturnType<typeof cadVisibleViewer.acquire> | null>(null);
  // The docked comments column, mounted while the scene is wide enough to dock (hidden while the
  // card is closed), so the card can portal into it from the moment it opens.
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [dockable, setDockable] = useState(false);
  const sceneRow = useRef<HTMLDivElement>(null);
  const cardFloating = commentsCard.open && !dock;
  const latest = useRef({ view, disabled, onChange, compact, cardFloating });
  const [manifest, setManifest] = useState<CadSnapshotManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<CadLoadProgress | null>(null);
  const previousCapture = useRef(captureId);
  const previousCamera = useRef(view.camera);
  const previousExplosion = useRef(view.explosion);
  const applied = useRef<{ manifest: CadSnapshotManifest | null; state: string } | null>(null);
  useLayoutEffect(() => {
    latest.current = { view, disabled, onChange, compact, cardFloating };
  }, [cardFloating, compact, disabled, onChange, view]);
  useLayoutEffect(() => {
    const row = sceneRow.current;
    if (compact || !row) return;
    const measure = () => setDockable(row.getBoundingClientRect().width >= DOCK_MIN_WIDTH);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, [compact]);
  // Opening or closing the docked column resizes the canvas in the same commit. Resize the
  // renderer now, so the card's focus (a passive effect) frames the comment in the new canvas
  // instead of the old one; the ResizeObserver below would only catch up after it.
  const docked = commentsCard.open && dock !== null;
  // Docked comments are an inspection: the app sidebar folds to its icon rail before the
  // docked layout paints.
  useLayoutEffect(() => (docked ? holdInspection("cad-comments-docked") : undefined), [docked]);
  useLayoutEffect(() => {
    const attachment = attachmentRef.current;
    if (!attachment) return;
    try {
      const bounds = attachment.canvas.getBoundingClientRect();
      attachment.renderer.resize(
        Math.max(1, bounds.width),
        Math.max(1, bounds.height),
        Math.min(devicePixelRatio, 2),
      );
    } catch {
      setError("The CAD viewer is unavailable.");
    }
  }, [docked]);
  // A layout effect, so the card's focus (a passive effect) already frames clear of the card it
  // just opened. Closing the card ends its review afterwards, which recenters the model.
  useLayoutEffect(() => {
    renderer.current?.setFrameInsets(frameInsets(compact, cardFloating), {
      reducedMotion: prefersReducedMotion(),
    });
  }, [cardFloating, compact]);
  useLayoutEffect(() => {
    try {
      renderer.current?.setInteractive(!disabled);
    } catch {
      setError("The CAD viewer is unavailable. Close and reopen the CAD panel to retry locally.");
    }
  }, [disabled]);
  useLayoutEffect(() => {
    try {
      // Save acknowledgements must not interrupt an unchanged visual transition.
      const serialized = JSON.stringify({ ...view, revision: 0 });
      if (applied.current?.manifest === manifest && applied.current.state === serialized) return;
      applied.current = { manifest, state: serialized };
      if (manifest) {
        if (
          ((captureId && previousCapture.current !== captureId) ||
            previousExplosion.current !== view.explosion ||
            (view.camera.kind === "preset" &&
              (previousCamera.current.kind !== "preset" ||
                previousCamera.current.preset !== view.camera.preset)) ||
            // The toolbar's Fit: a pose that now fits its shown parts.
            (view.camera.kind === "pose" &&
              view.camera.fit !== null &&
              !(previousCamera.current.kind === "pose" && previousCamera.current.fit !== null))) &&
          !matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          renderer.current?.transition(view);
        else renderer.current?.apply(view);
      }
      previousCapture.current = captureId;
      previousCamera.current = view.camera;
      previousExplosion.current = view.explosion;
    } catch {
      setError("The CAD viewer is unavailable. Close and reopen the CAD panel to retry locally.");
    }
  }, [captureId, manifest, view]);
  // OrbitControls disconnects from canvas.getRootNode(); dispose before React detaches that root.
  useLayoutEffect(() => {
    if (!baseUrl || !canvas.current) return;
    setError(null);
    setLoadProgress(null);
    const controller = new AbortController();
    let attachment: ReturnType<typeof cadVisibleViewer.acquire>;
    try {
      attachment = cadVisibleViewer.acquire(canvas.current, threadRef.environmentId, {
        onInteractionEnd: (pose) => {
          const state = latest.current;
          if (!state.disabled)
            state.onChange({ ...state.view, camera: { kind: "pose", pose, fit: null } });
        },
        onUnavailable: () =>
          setError(
            "The CAD renderer lost its graphics context. Close and reopen the CAD panel to retry locally.",
          ),
      });
    } catch {
      setError("A graphics renderer is not available on this device.");
      return;
    }
    const { renderer: current, canvas: node, diagnostics } = attachment;
    attachmentRef.current = attachment;
    renderer.current = current;
    current.setFrameInsets(frameInsets(latest.current.compact, latest.current.cardFloating), {
      reducedMotion: true,
    });
    const stopLoad = attachment.watchLoad(view.snapshotId, (state) => {
      try {
        if (state.status === "idle") {
          setManifest(null);
          setLoadProgress(null);
          return;
        }
        if (state.status === "loading") {
          setError(null);
          setManifest(null);
          setLoadProgress(
            state.total === null ? null : { received: state.received, total: state.total },
          );
          return;
        }
        if (state.status === "failure") {
          setManifest(null);
          setError(
            "Downloaded CAD could not be opened. Existing CAD is unchanged; no Onshape request was made.",
          );
          return;
        }
        current.setInteractive(!latest.current.disabled);
        const readyView = latest.current.view;
        current.apply(readyView);
        if (framing) current.restoreCommentFraming(framing);
        applied.current = {
          manifest: state.manifest,
          state: JSON.stringify({ ...readyView, revision: 0 }),
        };
        diagnostics.record({
          type: "worker-count",
          workers: 1,
          snapshotIds: [state.manifest.snapshotId],
        });
        setLoadProgress(null);
        setError(null);
        setManifest(state.manifest);
        void captureModelThumbnail(threadRef.environmentId, view.snapshotId, current);
      } catch {
        setError("The CAD viewer is unavailable. Close and reopen the CAD panel to retry locally.");
      }
    });
    const stopAppearance = observeCadAppearance((appearance) => {
      try {
        if (!controller.signal.aborted) current.setAppearance(appearance);
      } catch {
        setError("The CAD viewer is unavailable. Close and reopen the CAD panel to retry locally.");
      }
    });
    diagnostics.record({ type: "worker-count", workers: 1 });
    const resize = () => {
      try {
        const bounds = node.getBoundingClientRect();
        current.resize(
          Math.max(1, bounds.width),
          Math.max(1, bounds.height),
          Math.min(devicePixelRatio, 2),
        );
      } catch {
        if (!controller.signal.aborted) setError("The CAD viewer is unavailable.");
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => {
      controller.abort();
      stopAppearance();
      stopLoad();
      observer.disconnect();
      renderer.current = null;
      attachmentRef.current = null;
      attachment.release();
    };
  }, [baseUrl, threadRef.environmentId, view.snapshotId]);
  useLayoutEffect(() => {
    const attachment = attachmentRef.current;
    if (!baseUrl || !attachment) return;
    const cached = attachment.renderer.cachedManifest(view.snapshotId);
    if (!ticket && !cached) return;
    attachment.ensureLoad(
      view.snapshotId,
      ticket ? `${ticket.sceneId}:${ticket.token}` : `cached:${view.snapshotId}`,
      () => (ticket ? registry.mount(sceneAtom) : () => {}),
      async (current, signal, onProgress) => {
        const request = async (hash?: string, requestSignal: AbortSignal = signal) => {
          if (!ticket) throw new Error("CAD scene lease unavailable");
          const response = await fetch(
            new URL(
              `api/cad-panel/${ticket.sceneId}${hash ? `/${hash}` : "?delivery=meshopt-bin-v1"}`,
              baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
            ),
            {
              signal: requestSignal,
              credentials: "omit",
              headers: { "x-cad-panel-token": ticket.token },
            },
          );
          if (!response.ok) throw new Error("CAD scene unavailable");
          return response;
        };
        const snapshot =
          current.cachedManifest(view.snapshotId) ?? decodeManifest(await (await request()).json());
        if (signal.aborted) throw new Error("CAD scene load cancelled");
        if (current.cachedManifest(snapshot.snapshotId)) {
          await current.load(snapshot, async () => {
            throw new Error("Cached CAD unexpectedly requested geometry");
          });
        } else {
          await loadCadAssetDelivery({
            assets: snapshot.assets,
            namespace: {
              baseUrl,
              environmentId: threadRef.environmentId,
              snapshotId: snapshot.snapshotId,
            },
            signal,
            request,
            load: async (readAsset) => {
              await current.load(snapshot, readAsset);
            },
            onProgress,
          });
        }
        if (signal.aborted) throw new Error("CAD scene load cancelled");
        return snapshot;
      },
    );
  }, [baseUrl, registry, sceneAtom, ticket, view.snapshotId]);
  const unavailable =
    error ?? (AsyncResult.isFailure(lease) ? "The local CAD scene is unavailable." : null);
  return (
    <div className={`flex min-h-0 flex-1 ${fullscreen ? "flex-row" : "flex-col"}`}>
      {/* The wrapper holds the viewer's minimum height so the strip never pushes it over the tree. */}
      <div className={`flex ${compact ? "min-h-0" : "min-h-48"} min-w-0 flex-1 flex-col`}>
        {/* The viewport and, when docked, the comments column beside it. Viewport overlays stay
            inside the viewport, so they follow its narrower width. */}
        <div ref={sceneRow} className="flex min-h-0 min-w-0 flex-1">
          <div
            className={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background ${disabled ? "cursor-not-allowed [&_button:disabled]:cursor-not-allowed [&_[role=toolbar]]:grayscale [&_[role=toolbar]_svg]:opacity-50" : ""}`}
          >
            <div
              ref={canvas}
              className={`h-full w-full ${cadDimmed ? "grayscale opacity-55" : ""}`}
              style={{ pointerEvents: disabled ? "none" : "auto" }}
              onPointerDown={(event) => {
                press.current =
                  event.isPrimary && event.button === 0
                    ? { id: event.pointerId, x: event.clientX, y: event.clientY }
                    : null;
              }}
              onPointerUp={(event) => {
                // A click (not a drag) on empty space leaves the focused comment.
                const start = press.current;
                press.current = null;
                if (!start || start.id !== event.pointerId || !commentsCard.selection) return;
                if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
                const box = event.currentTarget.getBoundingClientRect();
                if (renderer.current?.isEmptyAt(event.clientX - box.left, event.clientY - box.top))
                  commentsCard.clearSelection();
              }}
            />
            {(!manifest || unavailable) && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-background/90 p-8 text-center text-sm text-muted-foreground"
                role="status"
              >
                {unavailable ?? <CadLoadingProgress progress={loadProgress} />}
              </div>
            )}
            <CadCommentsCard
              {...commentsCard}
              manifest={manifest}
              displayedSnapshotId={view.snapshotId}
              dock={dock}
            />
            {manifest && !unavailable && !compact && (
              <CadCameraToolbar
                renderer={renderer}
                view={view}
                disabled={disabled}
                onChange={onChange}
              />
            )}
            {manifest && !unavailable && !compact && (
              <CadViewChanges
                manifest={manifest}
                view={view}
                disabled={disabled}
                onChange={onChange}
                belowRevisionNotice={commentsCard.historical}
              />
            )}
          </div>
          {dockable && !compact && (
            <aside
              ref={setDock}
              aria-label="Comments panel"
              style={{ width: DOCK_WIDTH }}
              className={`shrink-0 flex-col border-l bg-popover text-popover-foreground ${commentsCard.open ? "flex" : "hidden"}`}
            />
          )}
        </div>
        {lockStatus && <CadLockStrip status={lockStatus} />}
      </div>
    </div>
  );
}

export function CadPanel({
  project,
  threadRef,
  fullscreen = false,
  compact = false,
  titleSlot = null,
  onOpenComments,
}: {
  project: Project;
  threadRef: ScopedThreadRef;
  fullscreen?: boolean;
  compact?: boolean;
  /** The right panel's title row. The scene picker renders there when given, else in its own row. */
  titleSlot?: HTMLElement | null;
  onOpenComments?: (target?: { id: string; target: CadCommentLocation }) => void;
}) {
  const state = useAtomValue(
    cadPanelEnvironment.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const commentState = useAtomValue(
    cadPanelEnvironment.comments({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const comments = useMemo(
    () =>
      AsyncResult.isSuccess(commentState)
        ? commentState.value.comments.map((c) => ({
            ...c,
            modelDescriptor: commentState.value.modelDescriptors[c.modelKey] ?? "",
          }))
        : [],
    [commentState],
  );
  const captureViews = AsyncResult.isSuccess(commentState)
    ? commentState.value.captureViews
    : EMPTY_CAPTURE_VIEWS;
  const renderer = useRef<CadSceneRenderer | null>(null);
  const openPath = useOpenInFileManager();
  const reviewKey = scopedThreadKey(threadRef);
  const { commentsOpen, selection, historicalView, savedCurrent, localFraming, localView } =
    useCadCommentReviewStore((state) => state.sessions[reviewKey] ?? EMPTY_CAD_PANEL_REVIEW);
  const updateReview = useCallback(
    (update: (current: CadPanelReviewSession) => CadPanelReviewSession) =>
      useCadCommentReviewStore.getState().updateSession(threadRef, update),
    [threadRef.environmentId, threadRef.threadId],
  );
  const clearSelection = useCallback(
    (id?: string) => {
      updateReview((current) => ({
        ...current,
        selection: !id || current.selection?.id === id ? null : current.selection,
      }));
    },
    [updateReview],
  );
  const setCommentsOpen = useCallback(
    (open: boolean) => {
      if (open && onOpenComments) {
        onOpenComments();
        return;
      }
      updateReview((current) => ({
        ...current,
        commentsOpen: open,
        selection: open ? current.selection : null,
      }));
    },
    [onOpenComments, updateReview],
  );
  const pendingReview = useCadCommentReviewStore((s) => s.pending[scopedThreadKey(threadRef)]);
  useLayoutEffect(() => {
    if (compact || pendingReview === undefined) return;
    updateReview((current) => ({
      ...current,
      commentsOpen: true,
      selection: pendingReview ? { ...pendingReview, request: 1 } : null,
    }));
    useCadCommentReviewStore.getState().consume(threadRef);
  }, [compact, pendingReview, threadRef, updateReview]);
  const threads = useThreadShells();
  const runBlocker = findCadThreadRunBlocker(project, threads, threadRef.threadId);
  const save = useAtomCommand(cadPanelEnvironment.save, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const data = AsyncResult.isSuccess(state) ? state.value : null;
  const showActivity = useCadActivityIndicator(
    scopedThreadKey(threadRef),
    !!data?.agentControlling,
  );
  const locked = !!runBlocker || data?.agentControlling || !!project.cad?.operation || !data;
  const lockStatus = cadPanelLockStatus({
    blocker: runBlocker,
    panel: data,
    operation: project.cad?.operation?.kind ?? null,
    localCadFile: project.localCadSource?.filePath ?? null,
  });
  // Comments and history keep the viewer usable locally, so only a real lock gets the strip.
  const viewerLocked = locked && !commentsOpen && !historicalView;
  // Keep the outline for a live tool call or a locked viewer the agent owns, not a usable one.
  const agentControl = showActivity || (viewerLocked && !!lockStatus?.agent);
  const [edits] = useState(() =>
    createCadViewEdits(
      async (view, expectedRevision) => {
        const result = await save({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, expectedRevision, view },
        });
        if (result._tag === "Failure") throw new Error("CAD view save failed");
        return result.value;
      },
      () =>
        setError(
          "The view could not be saved. CAD may be busy or the view changed; your latest saved view is preserved.",
        ),
    ),
  );
  const optimistic = useSyncExternalStore(edits.subscribe, edits.getSnapshot, edits.getSnapshot);
  const currentView = (!locked && optimistic) || data?.view || null;
  const view =
    historicalView ||
    (localView?.snapshotId === currentView?.snapshotId ? localView : null) ||
    currentView;
  useLayoutEffect(() => {
    edits.observe(data?.userRevision ?? null, locked);
  }, [edits, data, locked]);
  const change = (next: CadViewState) => {
    if (historicalView) {
      updateReview((current) => ({ ...current, historicalView: next }));
      return;
    }
    if (locked) {
      if (commentsOpen) updateReview((current) => ({ ...current, localView: next }));
      return;
    }
    updateReview((current) => ({ ...current, localView: null }));
    setError(null);
    edits.select(next);
  };
  const choose = (comment: CadComment, target: CadCommentLocation) => {
    if (onOpenComments) {
      onOpenComments({ id: comment.id, target });
      return;
    }
    updateReview((current) => ({
      ...current,
      commentsOpen: true,
      selection: { id: comment.id, target, request: (current.selection?.request ?? 0) + 1 },
    }));
    const manifest = view ? cadVisibleViewer.peek(threadRef.environmentId, view.snapshotId) : null;
    if (
      (manifest && cadCommentModelDescriptor(manifest) === comment.modelDescriptor) ||
      (!manifest && comment.snapshotId === view?.snapshotId)
    )
      return;
    if (!savedCurrent && currentView) {
      const currentManifest = cadVisibleViewer.peek(
        threadRef.environmentId,
        currentView.snapshotId,
      );
      const pose = renderer.current?.cameraPose();
      const saved = {
        view: pose
          ? { ...(view ?? currentView), camera: { kind: "pose" as const, pose, fit: null } }
          : (view ?? currentView),
        descriptor: currentManifest ? cadCommentModelDescriptor(currentManifest) : null,
        framing: renderer.current?.commentFraming() ?? { x: 0, y: 0 },
      };
      updateReview((current) => ({ ...current, savedCurrent: current.savedCurrent ?? saved }));
    }
    updateReview((current) => ({
      ...current,
      historicalView: {
        rootId: comment.rootId,
        snapshotId: comment.snapshotId,
        revision: 0,
        camera: { kind: "preset", preset: "isometric", fit: [] },
        visibility: {},
        isolatedOccurrenceIds: [],
        explosion: 0,
      },
    }));
  };
  const back = () => {
    renderer.current?.endCommentReview();
    const saved = savedCurrent;
    const manifest = currentView
      ? cadVisibleViewer.peek(threadRef.environmentId, currentView.snapshotId)
      : null;
    const equivalent =
      currentView &&
      saved &&
      (currentView.snapshotId === saved.view.snapshotId ||
        (manifest && cadCommentModelDescriptor(manifest) === saved.descriptor));
    const restoredView = equivalent
      ? { ...saved.view, snapshotId: currentView.snapshotId, rootId: currentView.rootId }
      : null;
    if (saved && !equivalent)
      setError("CAD changed during review. Showing the newest current model with its saved view.");
    updateReview((current) => ({
      ...current,
      localView: restoredView,
      localFraming: equivalent ? saved.framing : null,
      savedCurrent: null,
      historicalView: null,
      selection: null,
    }));
  };
  const roots = project.cad?.roots.filter((root) => root.current) ?? [];
  const shownRootId = view?.rootId ?? data?.unavailableRootId ?? null;
  const shownElementId = project.cad?.roots.find((root) => root.rootId === shownRootId)?.elementId;
  // A local CAD project's catalog names each root by its file's path in the project folder.
  const shownFile = project.localCadSource
    ? project.cad?.catalog?.roots.find((entry) => entry.elementId === shownElementId)?.name
    : undefined;
  // The header row: the scene picker and, for a local CAD file, its Sync button.
  const scenePicker = !compact && (
    <>
      <CadScenePicker
        documentUrl={project.onshapeSource ? onshapeProjectUrl(project.onshapeSource) : undefined}
        openFile={
          shownFile
            ? {
                // Its default app is SolidWorks wherever Cadsense can convert the file.
                action: isSolidWorksFile(shownFile) ? "Open in SolidWorks" : "Open file",
                onOpen: () =>
                  void openPath(
                    project.environmentId,
                    resolvePathLinkTarget(shownFile, project.workspaceRoot),
                    false,
                  ).then((opened) => {
                    if (!opened)
                      toastManager.add({
                        type: "error",
                        title: `Could not open ${shownFile}`,
                        description: "Check that the file is still in the project folder.",
                      });
                  }),
              }
            : undefined
        }
        scenes={roots.map((root) => {
          const name =
            project.cad?.catalog?.roots.find((entry) => entry.elementId === root.elementId)?.name ??
            (root.kind === "assembly" ? "Assembly" : "Part Studio");
          return {
            id: root.rootId,
            label: roots.some(
              (other) => other.rootId !== root.rootId && other.elementId === root.elementId,
            )
              ? `${name} · ${root.configuration}`
              : name,
          };
        })}
        selectedId={shownRootId}
        disabled={locked || !!historicalView}
        onSelect={(id) => {
          const root = roots.find((root) => root.rootId === id);
          if (root?.current)
            void change({
              rootId: root.rootId,
              snapshotId: root.current.snapshotId,
              revision: 0,
              camera: { kind: "preset", preset: "isometric", fit: [] },
              visibility: {},
              isolatedOccurrenceIds: [],
              explosion: 0,
            });
        }}
      />
      <CadLocalSyncButton
        project={project}
        rootId={shownRootId}
        disabled={!!runBlocker || !!data?.agentControlling || !!historicalView}
      />
    </>
  );
  return (
    <section
      aria-label="CAD panel"
      data-cad-agent-controlling={agentControl}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {scenePicker &&
        (titleSlot ? (
          createPortal(scenePicker, titleSlot)
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">{scenePicker}</div>
        ))}
      {error && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {view ? (
        <>
          <CadScene
            framing={historicalView ? null : localFraming}
            captureId={data?.captureId ?? null}
            key={`${threadRef.threadId}:${view.snapshotId}`}
            threadRef={threadRef}
            view={view}
            disabled={viewerLocked}
            cadDimmed={viewerLocked && !agentControl}
            lockStatus={viewerLocked ? lockStatus : null}
            commentsCard={{
              threadRef,
              comments,
              captureViews,
              renderer,
              open: commentsOpen,
              setOpen: setCommentsOpen,
              selection,
              clearSelection,
              choose,
              historical: !!historicalView,
              back,
              floating: compact,
            }}
            fullscreen={fullscreen}
            compact={compact}
            onChange={(next) => void change(next)}
          />
        </>
      ) : !data &&
        !AsyncResult.isFailure(state) &&
        cadVisibleViewer.hasResident(threadRef.environmentId) ? (
        <PendingCadScene environmentId={threadRef.environmentId} />
      ) : data && !data.unavailableRootId && !roots.length && project.localCadSource ? (
        <CadFilePrompt project={project} />
      ) : (
        <div
          role="status"
          className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground"
        >
          {AsyncResult.isFailure(state) ? (
            "CAD is unavailable for this thread."
          ) : !data ? (
            <CadLoadingProgress />
          ) : data.unavailableRootId ? (
            "This downloaded CAD is unavailable. You can select another cached scene."
          ) : roots.length ? (
            "Select a CAD scene above."
          ) : (
            "No CAD has been downloaded. Select and sync CAD in project settings."
          )}
        </div>
      )}
      {!view && viewerLocked && lockStatus && <CadLockStrip status={lockStatus} />}
      {!view && comments.length > 0 && (
        <CadCommentsCard
          threadRef={threadRef}
          comments={comments}
          captureViews={captureViews}
          renderer={renderer}
          manifest={null}
          displayedSnapshotId=""
          open={commentsOpen}
          setOpen={setCommentsOpen}
          selection={selection}
          clearSelection={clearSelection}
          choose={choose}
          historical={false}
          back={back}
          floating={compact}
        />
      )}
    </section>
  );
}
