import { useAtomValue } from "@effect/atom-react";
import { CadSnapshotManifest, type CadViewState, type ScopedThreadRef } from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { cadVisibleViewer } from "./CadVisibleViewer";
import { CadHierarchyTree } from "./CadHierarchyTree";
import { isCadProjectRunActive } from "./CadProjectState";
import { observeCadAppearance } from "./CadAppearance";
import { CadCameraToolbar } from "./CadCameraToolbar";
import { createCadViewEdits } from "./CadViewEdits";
import { CadScenePicker } from "./CadScenePicker";
import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import { useCadActivityIndicator } from "./useCadActivityIndicator";
import { onshapeProjectUrl } from "../lib/onshapeProjects";
import { useResizableWidth } from "../hooks/useResizableWidth";
import "./CadPanel.css";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);

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

function CadScene({
  threadRef,
  view,
  disabled,
  cadDimmed,
  onChange,
  captureId,
  fullscreen,
  compact,
}: {
  threadRef: ScopedThreadRef;
  view: CadViewState;
  disabled: boolean;
  cadDimmed: boolean;
  onChange: (view: CadViewState) => void;
  captureId: string | null;
  fullscreen: boolean;
  compact: boolean;
}) {
  const lease = useAtomValue(
    cadPanelEnvironment.scene({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, snapshotId: view.snapshotId },
    }),
  );
  const baseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const ticket = AsyncResult.isSuccess(lease) ? lease.value : null;
  const canvas = useRef<HTMLDivElement>(null);
  const renderer = useRef<CadSceneRenderer | null>(null);
  const latest = useRef({ view, disabled, onChange });
  const [manifest, setManifest] = useState<CadSnapshotManifest | null>(() =>
    cadVisibleViewer.peek(threadRef.environmentId, view.snapshotId),
  );
  const [error, setError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const sceneContainer = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const maxTreeWidth = Math.max(1, Math.min(480, (containerWidth ?? 1067) * 0.45));
  const minTreeWidth = Math.min(180, maxTreeWidth);
  const treeResize = useResizableWidth({
    storageKey: "cadsense:cad-components-width",
    defaultWidth: 256,
    minWidth: minTreeWidth,
    maxWidth: maxTreeWidth,
    edge: "right",
  });
  const cancelTreeResize = treeResize.cancelResize;
  useLayoutEffect(() => {
    if (!fullscreen || disabled) cancelTreeResize();
  }, [fullscreen, disabled, cancelTreeResize]);
  useLayoutEffect(() => {
    if (!fullscreen || !sceneContainer.current) return;
    const node = sceneContainer.current;
    const measure = () => setContainerWidth(node.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [fullscreen]);
  const previousCapture = useRef(captureId);
  const previousCamera = useRef(view.camera);
  const previousExplosion = useRef(view.explosion);
  const applied = useRef<{ manifest: CadSnapshotManifest | null; state: string } | null>(null);
  useLayoutEffect(() => {
    latest.current = { view, disabled, onChange };
  }, [disabled, onChange, view]);
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
                previousCamera.current.preset !== view.camera.preset))) &&
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
    setManifest(current.cachedManifest(view.snapshotId));
    renderer.current = current;
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
    const request = async (hash?: string) => {
      if (!ticket) throw new Error("CAD scene lease unavailable");
      const response = await fetch(
        new URL(
          `api/cad-panel/${ticket.sceneId}${hash ? `/${hash}` : ""}`,
          baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        ),
        {
          signal: controller.signal,
          credentials: "omit",
          headers: { "x-cad-panel-token": ticket.token },
        },
      );
      if (!response.ok) throw new Error("CAD scene unavailable");
      return response;
    };
    void (async () => {
      try {
        if (!ticket && !current.cachedManifest(view.snapshotId)) return;
        const snapshot =
          current.cachedManifest(view.snapshotId) ?? decodeManifest(await (await request()).json());
        const sameScene = await current.load(snapshot, async (hash) =>
          (await request(hash)).arrayBuffer(),
        );
        if (controller.signal.aborted) return;
        diagnostics.record({
          type: "worker-count",
          workers: 1,
          snapshotIds: [snapshot.snapshotId],
        });
        current.setInteractive(!latest.current.disabled);
        if (sameScene && !matchMedia("(prefers-reduced-motion: reduce)").matches)
          current.transition(latest.current.view);
        else current.apply(latest.current.view);
        setError(null);
        setManifest(snapshot);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "Downloaded CAD could not be opened. Existing CAD is unchanged; no Onshape request was made.",
          );
      }
    })();
    return () => {
      controller.abort();
      stopAppearance();
      observer.disconnect();
      renderer.current = null;
      attachment.release();
    };
  }, [baseUrl, ticket]);
  const unavailable =
    error ?? (AsyncResult.isFailure(lease) ? "The local CAD scene is unavailable." : null);
  return (
    <div
      ref={sceneContainer}
      className={`flex min-h-0 flex-1 ${fullscreen ? "flex-row" : "flex-col"}`}
    >
      <div
        className={`relative ${compact ? "min-h-0" : "min-h-48"} min-w-0 flex-1 overflow-hidden bg-background ${disabled ? "cursor-not-allowed [&_button:disabled]:cursor-not-allowed [&_[role=toolbar]]:grayscale [&_[role=toolbar]_svg]:opacity-50" : ""}`}
      >
        <div
          ref={canvas}
          className={`h-full w-full ${cadDimmed ? "grayscale opacity-55" : ""}`}
          style={{ pointerEvents: disabled ? "none" : "auto" }}
        />
        {(!manifest || unavailable) && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background/90 p-8 text-center text-sm text-muted-foreground"
            role="status"
          >
            {unavailable ?? "Opening downloaded CAD…"}
          </div>
        )}
        {manifest && !unavailable && !compact && (
          <CadCameraToolbar view={view} disabled={disabled} onChange={onChange} />
        )}
      </div>
      {manifest && !compact && (
        <Collapsible
          open={fullscreen || treeOpen}
          onOpenChange={(open) => {
            if (!fullscreen) setTreeOpen(open);
          }}
          className={
            fullscreen
              ? `relative order-first flex min-h-0 shrink-0 flex-col border-r ${disabled ? "cursor-not-allowed [&_:disabled]:cursor-not-allowed [&_[aria-label='CAD_components']]:grayscale [&_[aria-label='CAD_components']]:opacity-55" : ""}`
              : `shrink-0 ${disabled ? "cursor-not-allowed [&_:disabled]:cursor-not-allowed [&_[aria-label='CAD_components']]:grayscale [&_[aria-label='CAD_components']]:opacity-55" : ""}`
          }
          style={fullscreen ? { width: treeResize.width } : undefined}
        >
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                className={`w-full shrink-0 justify-start rounded-none px-3 text-xs disabled:opacity-100 ${disabled ? "text-muted-foreground" : ""} ${fullscreen ? "" : `border-t ${treeOpen ? "" : "h-10 pb-1 sm:h-9"}`}`}
                disabled={disabled || fullscreen}
              />
            }
            disabled={disabled || fullscreen}
          >
            {!fullscreen && (treeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}{" "}
            Components{" "}
            <span className="ml-auto text-muted-foreground">{manifest.nodes.length}</span>
          </CollapsibleTrigger>
          <CollapsiblePanel className={fullscreen ? "flex min-h-0 flex-1 flex-col" : undefined}>
            <CadHierarchyTree
              manifest={manifest}
              view={view}
              disabled={disabled}
              onChange={onChange}
              fullHeight={fullscreen}
            />
          </CollapsiblePanel>
          {fullscreen && (
            <div
              role="separator"
              aria-label="Resize CAD components"
              aria-orientation="vertical"
              aria-valuemin={Math.round(minTreeWidth)}
              aria-valuemax={Math.round(maxTreeWidth)}
              aria-valuenow={Math.round(treeResize.width)}
              aria-disabled={disabled}
              tabIndex={disabled ? -1 : 0}
              className={`absolute inset-y-0 -right-1 z-10 w-2 touch-none outline-none focus-visible:bg-ring/40 ${disabled ? "cursor-not-allowed" : "cursor-col-resize hover:bg-border/70"}`}
              {...(disabled ? {} : treeResize.handlers)}
              onPointerDown={(event) => {
                if (disabled) return;
                event.currentTarget.focus();
                treeResize.handlers.onPointerDown(event);
              }}
              onKeyDown={(event) => {
                if (disabled) return;
                const step = event.shiftKey ? 40 : 10;
                const next =
                  event.key === "ArrowLeft"
                    ? treeResize.width - step
                    : event.key === "ArrowRight"
                      ? treeResize.width + step
                      : event.key === "Home"
                        ? minTreeWidth
                        : event.key === "End"
                          ? maxTreeWidth
                          : null;
                if (next === null) return;
                event.preventDefault();
                treeResize.setWidth(next);
              }}
            />
          )}
        </Collapsible>
      )}
    </div>
  );
}

export function CadPanel({
  project,
  threadRef,
  fullscreen = false,
  compact = false,
}: {
  project: Project;
  threadRef: ScopedThreadRef;
  fullscreen?: boolean;
  compact?: boolean;
}) {
  const state = useAtomValue(
    cadPanelEnvironment.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const threads = useThreadShells();
  const runActive = isCadProjectRunActive(project, threads);
  const save = useAtomCommand(cadPanelEnvironment.save, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const data = AsyncResult.isSuccess(state) ? state.value : null;
  const showActivity = useCadActivityIndicator(
    scopedThreadKey(threadRef),
    !!data?.agentControlling,
  );
  const locked = runActive || data?.agentControlling || !!project.cad?.operation || !data;
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
  const view = (!locked && optimistic) || data?.view || null;
  useLayoutEffect(() => {
    edits.observe(data?.userRevision ?? null, locked);
  }, [edits, data, locked]);
  const change = (next: CadViewState) => {
    if (locked) return;
    setError(null);
    edits.select(next);
  };
  const roots = project.cad?.roots.filter((root) => root.current) ?? [];
  return (
    <section
      aria-label="CAD panel"
      data-cad-agent-controlling={showActivity}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {!compact && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <CadScenePicker
            documentUrl={
              project.onshapeSource ? onshapeProjectUrl(project.onshapeSource) : undefined
            }
            scenes={roots.map((root) => {
              const name =
                project.cad?.catalog?.roots.find((entry) => entry.elementId === root.elementId)
                  ?.name ?? (root.kind === "assembly" ? "Assembly" : "Part Studio");
              return {
                id: root.rootId,
                label: roots.some(
                  (other) => other.rootId !== root.rootId && other.elementId === root.elementId,
                )
                  ? `${name} · ${root.configuration}`
                  : name,
              };
            })}
            selectedId={view?.rootId ?? data?.unavailableRootId ?? null}
            disabled={locked}
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
        </div>
      )}
      {runActive && (
        <div role="status" className="sr-only">
          {data?.captureId
            ? "Agent’s captured view · controls locked"
            : "Agent running · CAD controls locked"}
        </div>
      )}
      {error && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {view ? (
        <>
          <CadScene
            captureId={data?.captureId ?? null}
            key={`${threadRef.threadId}:${view.snapshotId}`}
            threadRef={threadRef}
            view={view}
            disabled={locked}
            cadDimmed={locked && !showActivity}
            fullscreen={fullscreen}
            compact={compact}
            onChange={(next) => void change(next)}
          />
        </>
      ) : !data &&
        !AsyncResult.isFailure(state) &&
        cadVisibleViewer.hasResident(threadRef.environmentId) ? (
        <PendingCadScene environmentId={threadRef.environmentId} />
      ) : (
        <div
          role="status"
          className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground"
        >
          {AsyncResult.isFailure(state)
            ? "CAD is unavailable for this thread."
            : !data
              ? "Loading CAD view…"
              : data.unavailableRootId
                ? "This downloaded CAD is unavailable. You can select another cached scene."
                : roots.length
                  ? "Select a CAD scene above."
                  : "No CAD has been downloaded. Select and sync CAD in project settings."}
        </div>
      )}
    </section>
  );
}
