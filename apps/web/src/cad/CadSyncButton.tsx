import {
  CadUserOperationError,
  isSolidWorksFile,
  type CadProjectState,
  type CadUserStartInput,
} from "@cadsense/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { ArrowsClockwiseIcon } from "~/lib/icons";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useThreadShells } from "../state/entities";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";
import { cadSyncBlocker } from "./CadProjectState";

type CadSyncRoot = Extract<CadUserStartInput, { kind: "sync" }>["root"];
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

/** The toast for a start the server refused. Busy and throttled are expected, so they explain. */
function refusedDescription(cause: unknown): string {
  if (isCadUserOperationError(cause) && cause.reason === "busy")
    return "CAD is busy. Wait for agent runs and the current CAD operation to finish.";
  if (isCadUserOperationError(cause) && cause.reason === "throttled")
    return "Onshape is limiting requests. Try again in a few minutes.";
  return cause instanceof Error && cause.message ? cause.message : "The sync could not start.";
}

/**
 * Syncs the CAD the panel shows with one click: downloads it again from Onshape, or re-imports a
 * local file after it was re-exported (a SolidWorks file converts with SolidWorks again). It is
 * disabled while any chat in the project runs, as the server would refuse the sync, and its tooltip
 * names those chats. Once the server records the outcome of a sync it started, a toast says whether
 * the model changed, stayed the same, or failed and why. Renders nothing without a root to sync.
 */
export function CadSyncButton({
  project,
  rootId,
  disabled,
}: {
  project: Project;
  rootId: string | null;
  disabled: boolean;
}) {
  const start = useAtomCommand(onshapeProjectEnvironment.startCadOperation, {
    reportFailure: false,
  });
  const threads = useThreadShells();
  // The sync this button started, until the server records its outcome.
  const [started, setStarted] = useState<{
    operationId: NonNullable<CadProjectState["lastOutcome"]>["operationId"];
    root: CadSyncRoot;
    name: string;
    before: string | null;
  } | null>(null);
  const cad = project.cad;
  const outcome = cad?.lastOutcome;
  /**
   * The CAD version of `root`'s current snapshot (a root is one element in one configuration). A
   * re-import of unchanged CAD can write a new snapshot, but its microversion stays the same: the
   * Onshape document's, or a hash of the local file's bytes.
   */
  const currentVersion = (root: CadSyncRoot) =>
    cad?.roots.find(
      (entry) => entry.elementId === root.elementId && entry.configuration === root.configuration,
    )?.current?.microversionId ?? null;
  const startedVersion = started ? currentVersion(started.root) : null;
  useEffect(() => {
    if (!started || !outcome || outcome.operationId !== started.operationId) return;
    setStarted(null);
    if (outcome.status === "failed")
      toastManager.add({
        type: "error",
        title: `Could not sync ${started.name}`,
        description: outcome.reason ?? "The sync failed.",
      });
    else if (outcome.status !== "succeeded") return;
    else if (startedVersion === started.before)
      toastManager.add({ type: "info", title: `${started.name} is already up to date` });
    else
      // Every chat's saved view of this root moves to the new snapshot (`rebaseCadView`).
      toastManager.add({
        type: "success",
        title: `${started.name} synced`,
        description: "Chats showing it now show the new revision.",
      });
  }, [started, outcome, startedVersion]);

  const root = cadSyncTarget(project, rootId);
  if (!root) return null;
  const name =
    cad?.catalog?.roots.find((entry) => entry.elementId === root.elementId)?.name ??
    project.localCadSource?.filePath ??
    "CAD";
  const solidWorks = project.localCadSource !== undefined && isSolidWorksFile(name);
  const syncing = cad?.operation?.kind === "sync";
  const blocker = cadSyncBlocker(project, threads);
  const sync = async () => {
    const before = currentVersion(root);
    const result = await start({
      environmentId: project.environmentId,
      input: { projectId: project.id, kind: "sync", root },
    });
    if (result._tag === "Success") {
      setStarted({ operationId: result.value.operationId, root, name, before });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: `Could not sync ${name}`,
      description: refusedDescription(squashAtomCommandFailure(result)),
    });
  };
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || blocker !== null}
          onClick={() => void sync()}
        >
          <ArrowsClockwiseIcon />
          {syncing
            ? project.localCadSource
              ? solidWorks
                ? "Converting…"
                : "Importing…"
              : "Syncing…"
            : "Sync"}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        {blocker ??
          (!project.localCadSource
            ? `Download ${name} from Onshape again`
            : solidWorks
              ? `Convert ${name} with SolidWorks again after saving it`
              : `Import ${name} again after re-exporting it`)}
      </TooltipPopup>
    </Tooltip>
  );
}
