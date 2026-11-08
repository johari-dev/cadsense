import {
  CadUserOperationError,
  isSolidWorksFile,
  type CadProjectState,
  type CadUserStartInput,
} from "@cadsense/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { ArrowsClockwiseIcon } from "~/lib/icons";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import { cadProgressEnvironment } from "../state/cadProgress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useThreadShells } from "../state/entities";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";
import { cadSyncBlocker } from "./CadProjectState";
import {
  CadSyncOutcomeDescription,
  CadSyncProgressDescription,
  cadSyncFailureText,
} from "./CadSyncToast";

type CadSyncRoot = Extract<CadUserStartInput, { kind: "sync" }>["root"];
type CadOperationId = NonNullable<CadProjectState["lastOutcome"]>["operationId"];
type ToastId = ReturnType<typeof toastManager.add>;
const isCadUserOperationError = Schema.is(CadUserOperationError);

/**
 * The root one click syncs: the one the panel shows, in its own configuration. Before anything is
 * shown, the project's own element from the catalog: a local project's linked file, or the Onshape
 * element its link named, in the project's configuration. Null when the panel has nothing to sync.
 */
function cadSyncTarget(project: Project, rootId: string | null): CadSyncRoot | null {
  const cad = project.cad;
  const root = cad?.roots.find((entry) => entry.rootId === rootId);
  if (root)
    return { elementId: root.elementId, kind: root.kind, configuration: root.configuration };
  const source = cad?.catalog?.sourceElement;
  if (!source) return null;
  // The catalog names a local project's file even when its first import failed.
  if (project.localCadSource)
    return { elementId: source.elementId, kind: "assembly", configuration: "default" };
  const entry = cad?.catalog?.roots.find((item) => item.elementId === source.elementId);
  if (!project.onshapeSource || !entry) return null;
  return {
    elementId: entry.elementId,
    kind: entry.kind,
    configuration: project.onshapeSource.configuration || "default",
  };
}

/**
 * What one click on the panel's Sync button does: sync a root, or first refresh the catalog of an
 * Onshape project that was never refreshed, as only the catalog says whether its linked element is
 * an Assembly or a Part Studio. Null when the panel has nothing to sync.
 */
export function cadSyncPlan(
  project: Project,
  rootId: string | null,
): { kind: "sync"; root: CadSyncRoot } | { kind: "discover" } | null {
  const root = cadSyncTarget(project, rootId);
  if (root) return { kind: "sync", root };
  if (project.onshapeSource?.elementId && !project.cad?.catalog) return { kind: "discover" };
  return null;
}

/** Why a refreshed catalog leaves nothing to sync for the project's linked Onshape element. */
function unsyncableDescription(project: Project): string {
  return project.cad?.catalog?.sourceElement?.status === "missing"
    ? "The Onshape tab this project links to is no longer in the document. Choose CAD in project settings."
    : "The Onshape tab this project links to is not an Assembly or Part Studio. Choose CAD in project settings.";
}

/** The toast for a start the server refused. Busy and throttled are expected, so they explain. */
function refusedDescription(cause: unknown): string {
  if (isCadUserOperationError(cause) && cause.reason === "busy")
    return "CAD is busy. Wait for agent runs and the current CAD operation to finish.";
  if (isCadUserOperationError(cause) && cause.reason === "throttled")
    return "Onshape is limiting requests. Try again in a few minutes.";
  return cause instanceof Error && cause.message ? cause.message : "The sync could not start.";
}

/** Keeps a running Onshape sync's loading toast on the step the server reports. */
function CadSyncProgressToast({
  environmentId,
  operationId,
  toastId,
  showApiCalls,
}: {
  environmentId: Project["environmentId"];
  operationId: CadOperationId;
  toastId: ToastId;
  showApiCalls: boolean;
}) {
  const state = useAtomValue(cadProgressEnvironment.watch({ environmentId, input: {} }));
  const progress = AsyncResult.isSuccess(state)
    ? state.value.find((entry) => entry.operationId === operationId)
    : undefined;
  useEffect(() => {
    if (!progress) return;
    toastManager.update(toastId, {
      description: <CadSyncProgressDescription progress={progress} showApiCalls={showApiCalls} />,
    });
  }, [progress, toastId, showApiCalls]);
  return null;
}

/**
 * Syncs the CAD the panel shows with one click: downloads it again from Onshape, or re-imports a
 * local file after it was re-exported (a SolidWorks file converts with SolidWorks again). It is
 * disabled while any chat in the project runs, as the server would refuse the sync, and its tooltip
 * names those chats. While an Onshape sync runs, a loading toast shows its step. Once the server
 * records the outcome of a sync it started, that toast (a new one for a local file) says whether
 * the model changed, stayed the same, or failed and why, and how many of the Onshape connection's
 * yearly API calls remain. The calls the sync used show only with `showOnshapeSyncApiCalls`. For an
 * Onshape project that was never refreshed, the click refreshes the catalog and then syncs the
 * linked element. Renders nothing
 * without a root to sync. While `prompted`, the panel's empty state tells the user to press Sync,
 * so the button shows its label in the accent color until the first download.
 */
export function CadSyncButton({
  project,
  rootId,
  disabled,
  prompted,
}: {
  project: Project;
  rootId: string | null;
  disabled: boolean;
  prompted: boolean;
}) {
  const start = useAtomCommand(onshapeProjectEnvironment.startCadOperation, {
    reportFailure: false,
  });
  const threads = useThreadShells();
  const showApiCalls = useClientSettings((settings) => settings.showOnshapeSyncApiCalls);
  // The operation this button started, until the server records its outcome.
  const [started, setStarted] = useState<
    | {
        kind: "sync";
        operationId: CadOperationId;
        root: CadSyncRoot;
        name: string;
        before: string | null;
        // The loading toast of an Onshape sync. Local imports report no progress.
        toastId: ToastId | null;
      }
    | { kind: "discover"; operationId: CadOperationId }
    | null
  >(null);
  const cad = project.cad;
  const outcome = cad?.lastOutcome;
  // A loading toast that no outcome replaced yet. Closed if the button goes away first, as nothing
  // would end its spinner.
  const loadingToast = useRef<ToastId | null>(null);
  useEffect(
    () => () => {
      if (loadingToast.current) toastManager.close(loadingToast.current);
    },
    [],
  );
  /**
   * The CAD version of `root`'s current snapshot (a root is one element in one configuration). A
   * re-import of unchanged CAD can write a new snapshot, but its microversion stays the same: the
   * Onshape document's, or a hash of the local file's bytes.
   */
  const currentVersion = (root: CadSyncRoot) =>
    cad?.roots.find(
      (entry) => entry.elementId === root.elementId && entry.configuration === root.configuration,
    )?.current?.microversionId ?? null;
  const startedVersion = started?.kind === "sync" ? currentVersion(started.root) : null;
  const nameOf = (root: CadSyncRoot) =>
    cad?.catalog?.roots.find((entry) => entry.elementId === root.elementId)?.name ??
    project.localCadSource?.filePath ??
    "CAD";
  /** The toast for a start the server refused, from the start command's settled result. */
  const refused = (name: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: `Could not sync ${name}`,
      description: refusedDescription(squashAtomCommandFailure(result)),
    });
  };
  const sync = async (root: CadSyncRoot) => {
    const name = nameOf(root);
    const before = currentVersion(root);
    const result = await start({
      environmentId: project.environmentId,
      input: { projectId: project.id, kind: "sync", root },
    });
    if (result._tag !== "Success") return refused(name, result);
    const toastId = project.onshapeSource
      ? toastManager.add({
          type: "loading",
          title: `Syncing ${name}`,
          description: "Checking Onshape for changes.",
        })
      : null;
    loadingToast.current = toastId;
    setStarted({
      kind: "sync",
      operationId: result.value.operationId,
      root,
      name,
      before,
      toastId,
    });
  };
  const discover = async () => {
    const result = await start({
      environmentId: project.environmentId,
      input: { projectId: project.id, kind: "discover" },
    });
    if (result._tag === "Success")
      setStarted({ kind: "discover", operationId: result.value.operationId });
    else refused("CAD", result);
  };
  useEffect(() => {
    if (!started || !outcome || outcome.operationId !== started.operationId) return;
    setStarted(null);
    if (started.kind === "discover") {
      if (outcome.status === "failed")
        toastManager.add({
          type: "error",
          title: "Could not sync CAD",
          description: outcome.reason ?? "The CAD catalog could not be refreshed.",
        });
      if (outcome.status !== "succeeded") return;
      // The refreshed catalog now says which kind the linked element is, so the sync can start.
      const root = cadSyncTarget(project, rootId);
      if (root) void sync(root);
      else
        toastManager.add({
          type: "error",
          title: "Could not sync CAD",
          description: unsyncableDescription(project),
        });
      return;
    }
    const { toastId } = started;
    loadingToast.current = null;
    // Replaces the loading toast in place, so one toast follows the sync from start to end.
    const show = (options: Parameters<typeof toastManager.add>[0]) => {
      if (toastId) toastManager.update(toastId, options);
      else toastManager.add(options);
    };
    const apiCalls = outcome.apiCalls;
    if (outcome.status === "failed")
      show({
        type: "error",
        title: `Could not sync ${started.name}`,
        description: cadSyncFailureText(
          outcome.reason ?? "The sync failed.",
          apiCalls,
          showApiCalls,
        ),
      });
    else if (outcome.status !== "succeeded") {
      if (toastId) toastManager.close(toastId);
    } else if (startedVersion === started.before)
      show({
        type: "info",
        title: `${started.name} is already up to date`,
        ...(apiCalls
          ? {
              description: (
                <CadSyncOutcomeDescription
                  text={null}
                  apiCalls={apiCalls}
                  showApiCalls={showApiCalls}
                />
              ),
            }
          : {}),
      });
    else {
      // Every chat's saved view of this root moves to the new snapshot (`rebaseCadView`).
      const text = "Chats showing it now show the new revision.";
      show({
        type: "success",
        title: `${started.name} synced`,
        description: apiCalls ? (
          <CadSyncOutcomeDescription text={text} apiCalls={apiCalls} showApiCalls={showApiCalls} />
        ) : (
          text
        ),
      });
    }
  }, [started, outcome, startedVersion, showApiCalls]);

  const plan = cadSyncPlan(project, rootId);
  if (!plan) return null;
  const root = plan.kind === "sync" ? plan.root : null;
  const name = root ? nameOf(root) : "CAD";
  const solidWorks = project.localCadSource !== undefined && isSolidWorksFile(name);
  const syncing = cad?.operation?.kind === "sync" || started?.kind === "discover";
  const blocker = cadSyncBlocker(project, threads);
  return (
    <>
      {started?.kind === "sync" && started.toastId ? (
        <CadSyncProgressToast
          environmentId={project.environmentId}
          operationId={started.operationId}
          toastId={started.toastId}
          showApiCalls={showApiCalls}
        />
      ) : null}
      <Tooltip>
        {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          {/* A muted icon beside the model name, like the header's other controls. It shows a
            label while it runs, and an accent "Sync" label while the empty state points at it. */}
          <Button
            size={syncing || prompted ? "xs" : "icon-xs"}
            variant="ghost-muted"
            className={
              prompted && !syncing
                ? "[--control-icon-color:currentColor] bg-(--accent-text)/14 text-(--accent-text) [:hover,[data-pressed]]:bg-(--accent-text)/22 [:hover,[data-pressed]]:text-(--accent-text)"
                : undefined
            }
            aria-label={syncing || prompted ? undefined : "Sync"}
            disabled={disabled || blocker !== null}
            onClick={() => void (root ? sync(root) : discover())}
          >
            <ArrowsClockwiseIcon />
            {syncing
              ? project.localCadSource
                ? solidWorks
                  ? "Converting…"
                  : "Importing…"
                : "Syncing…"
              : prompted
                ? "Sync"
                : null}
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {blocker ??
            (!project.localCadSource
              ? `Download ${name} from Onshape${root && currentVersion(root) ? " again" : ""}`
              : solidWorks
                ? `Convert ${name} with SolidWorks again after saving it`
                : `Import ${name} again after re-exporting it`)}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
