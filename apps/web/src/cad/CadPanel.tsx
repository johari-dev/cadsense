import { useAtomValue } from "@effect/atom-react";
import { CadSnapshotManifest, type CadViewState, type ScopedThreadRef } from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Link } from "@tanstack/react-router";
import { scopeProjectRef, scopedProjectKey } from "@cadsense/client-runtime/environment";
import * as Schema from "effect/Schema";
import { Box, ChevronDown, ChevronRight, LockKeyhole } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";
import { createCadSceneRenderer, type CadSceneRenderer } from "./CadSceneRenderer";
import { CadHierarchyTree } from "./CadHierarchyTree";
import { isCadProjectRunActive } from "./CadProjectState";
import { cadDiagnostics } from "./CadDiagnostics";
import { observeCadAppearance } from "./CadAppearance";
import { CadCameraToolbar } from "./CadCameraToolbar";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);

function CadScene({
  threadRef,
  view,
  disabled,
  onChange,
  captureId,
}: {
  threadRef: ScopedThreadRef;
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
  captureId: string | null;
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
  const [manifest, setManifest] = useState<CadSnapshotManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const previousCapture = useRef(captureId);
  const previousCamera = useRef(view.camera);
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
      if (manifest) {
        if (
          ((captureId && previousCapture.current !== captureId) ||
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
    } catch {
      setError("The CAD viewer is unavailable. Close and reopen the CAD panel to retry locally.");
    }
  }, [captureId, manifest, view]);
  // OrbitControls disconnects from canvas.getRootNode(); dispose before React detaches that root.
  useLayoutEffect(() => {
    if (!ticket || !baseUrl || !canvas.current) return;
    setError(null);
    setManifest(null);
    const controller = new AbortController();
    const node = document.createElement("canvas");
    node.setAttribute("aria-label", "CAD viewer");
    node.className = "h-full w-full touch-none";
    canvas.current.append(node);
    let current: CadSceneRenderer;
    const diagnostics = cadDiagnostics.register();
    try {
      current = createCadSceneRenderer({
        canvas: node,
        onFrame: (milliseconds) => diagnostics.record({ type: "frame", milliseconds }),
        onContextLost: () => diagnostics.record({ type: "context-loss" }),
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
      diagnostics.dispose();
      node.remove();
      setError("A graphics renderer is not available on this device.");
      return;
    }
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
        const snapshot = decodeManifest(await (await request()).json());
        await current.load(snapshot, async (hash) => (await request(hash)).arrayBuffer());
        if (controller.signal.aborted) return;
        diagnostics.record({
          type: "worker-count",
          workers: 1,
          snapshotIds: [snapshot.snapshotId],
        });
        current.apply(latest.current.view);
        current.setInteractive(!latest.current.disabled);
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
      current.dispose();
      diagnostics.dispose();
      node.remove();
    };
  }, [baseUrl, ticket]);
  const unavailable =
    error ?? (AsyncResult.isFailure(lease) ? "The local CAD scene is unavailable." : null);
  return (
    <>
      <div className="relative min-h-48 flex-1 overflow-hidden bg-background">
        <div
          ref={canvas}
          className="h-full w-full"
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
        {manifest && !unavailable && (
          <CadCameraToolbar view={view} disabled={disabled} onChange={onChange} />
        )}
      </div>
      {manifest && (
        <>
          <Button
            variant="ghost"
            className="w-full justify-start rounded-none border-t px-3 text-xs"
            disabled={disabled}
            onClick={() => setTreeOpen(!treeOpen)}
          >
            {treeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Components{" "}
            <span className="ml-auto text-muted-foreground">{manifest.nodes.length}</span>
          </Button>
          {treeOpen && (
            <CadHierarchyTree
              manifest={manifest}
              view={view}
              disabled={disabled}
              onChange={onChange}
            />
          )}
        </>
      )}
    </>
  );
}

export function CadPanel({ project, threadRef }: { project: Project; threadRef: ScopedThreadRef }) {
  const state = useAtomValue(
    cadPanelEnvironment.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const threads = useThreadShells();
  const runActive = isCadProjectRunActive(project, threads);
  const save = useAtomCommand(cadPanelEnvironment.save, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const data = AsyncResult.isSuccess(state) ? state.value : null;
  const view = data?.view ?? null;
  const [explosionDraft, setExplosionDraft] = useState<{
    base: CadViewState;
    amount: number;
  } | null>(null);
  const previewAmount = !runActive && explosionDraft?.base === view ? explosionDraft.amount : null;
  const displayedView = useMemo(
    () => (view && previewAmount !== null ? { ...view, explosion: previewAmount } : view),
    [view, previewAmount],
  );
  const locked = runActive || !!project.cad?.operation || pending || !data;
  const latest = useRef({ locked, data });
  useLayoutEffect(() => {
    latest.current = { locked, data };
  }, [locked, data]);
  const change = async (next: CadViewState) => {
    if (latest.current.locked || !latest.current.data || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const expectedRevision = latest.current.data.userRevision;
    try {
      const result = await save({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          expectedRevision,
          view: { ...next, revision: expectedRevision === null ? 0 : expectedRevision + 1 },
        },
      });
      if (result._tag === "Failure")
        setError(
          "The view could not be saved. CAD may be busy or the view changed; your latest saved view is preserved.",
        );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const roots = project.cad?.roots.filter((root) => root.current) ?? [];
  const commitExplosion = () => {
    if (!view || previewAmount === null) return;
    void change({ ...view, explosion: previewAmount }).finally(() => setExplosionDraft(null));
  };
  return (
    <section aria-label="CAD panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Box size={15} className="shrink-0 text-muted-foreground" />
        <select
          aria-label="CAD scene"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
          value={view?.rootId ?? data?.unavailableRootId ?? ""}
          disabled={locked || roots.length === 0}
          onChange={(event) => {
            const root = roots.find((root) => root.rootId === event.target.value);
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
        >
          <option value="" disabled>
            Select CAD
          </option>
          {roots.map((root) => (
            <option key={root.rootId} value={root.rootId}>
              {project.cad?.catalog?.roots.find((entry) => entry.elementId === root.elementId)
                ?.name ?? (root.kind === "assembly" ? "Assembly" : "Part Studio")}
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-end border-b px-3 py-1 text-xs">
        <Link
          to="/projects/$projectKey"
          params={{
            projectKey: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          Project settings
        </Link>
      </div>
      {runActive && (
        <div
          role="status"
          className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          <LockKeyhole size={12} />
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
          <div className="flex items-center gap-3 border-b px-3 py-2 text-xs">
            <label htmlFor="cad-explode">Explode</label>
            <input
              id="cad-explode"
              aria-label="Explode CAD"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={previewAmount ?? view.explosion}
              disabled={locked}
              className="min-w-0 flex-1"
              onChange={(event) =>
                setExplosionDraft({ base: view, amount: Number(event.target.value) })
              }
              onPointerUp={commitExplosion}
              onPointerCancel={() => setExplosionDraft(null)}
              onKeyUp={commitExplosion}
              onBlur={commitExplosion}
            />
            <span className="w-8 text-right tabular-nums text-muted-foreground">
              {Math.round((previewAmount ?? view.explosion) * 100)}%
            </span>
          </div>
          <CadScene
            captureId={data?.captureId ?? null}
            key={`${threadRef.threadId}:${view.snapshotId}`}
            threadRef={threadRef}
            view={displayedView ?? view}
            disabled={locked}
            onChange={(next) => void change(next)}
          />
        </>
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
