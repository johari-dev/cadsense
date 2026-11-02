import type { Project, ThreadShell } from "../types";
import {
  isCadThreadRunActive,
  isSolidWorksFile,
  type CadPanelState,
  type CadProjectState,
  type ThreadId,
} from "@cadsense/contracts";

type CadProjectRef = Pick<Project, "id" | "environmentId" | "cad">;

const isProjectThread = (project: CadProjectRef, thread: ThreadShell) =>
  thread.environmentId === project.environmentId && thread.projectId === project.id;

/** This chat's own run, or its pending capture presentation, which keeps its CAD panel locked. */
export interface CadThreadRunBlocker {
  /** Undefined when the thread shell is not loaded on this client. */
  readonly thread: ThreadShell | undefined;
}

/**
 * Returns what keeps the CAD panel for `threadId` locked, or null when nothing in this chat does.
 * Another chat's run never locks it: each chat saves only its own view, as the server enforces.
 */
export function findCadThreadRunBlocker(
  project: CadProjectRef,
  threads: readonly ThreadShell[],
  threadId: ThreadId,
): CadThreadRunBlocker | null {
  const thread = threads.find((item) => item.id === threadId && isProjectThread(project, item));
  const pending = project.cad?.pendingPresentations?.some((item) => item.threadId === threadId);
  return pending || (thread && isCadThreadRunActive(thread)) ? { thread } : null;
}

/** Whether any chat's run, or pending capture presentation, fences project-wide CAD changes. */
export function isCadProjectRunActive(
  project: CadProjectRef,
  threads: readonly ThreadShell[],
): boolean {
  return (
    (project.cad?.pendingPresentations?.length ?? 0) > 0 ||
    threads.some((thread) => isProjectThread(project, thread) && isCadThreadRunActive(thread))
  );
}

/**
 * Why a CAD sync cannot start now, for the panel's Sync tooltip, or null when it can. Mirrors the
 * server's reserve checks (`requireProjectCadIdle`): CAD is on, no CAD operation runs, and every
 * chat in the project is idle, this one included. Names up to three of the chats that block it.
 */
export function cadSyncBlocker(
  project: CadProjectRef,
  threads: readonly ThreadShell[],
): string | null {
  if (project.cad?.enabled === false)
    return "CAD access is off for this project. Turn it on in project settings.";
  if (project.cad?.operation) return "Wait for the current CAD operation to finish.";
  const busy = new Set<ThreadId>(project.cad?.pendingPresentations?.map((item) => item.threadId));
  for (const thread of threads)
    if (isProjectThread(project, thread) && isCadThreadRunActive(thread)) busy.add(thread.id);
  if (busy.size === 0) return null;
  // A pending presentation can belong to a chat this client has not loaded; it counts unnamed.
  const titles = threads
    .filter((thread) => isProjectThread(project, thread) && busy.has(thread.id))
    .map((thread) => thread.title);
  if (busy.size === 1)
    return titles[0]
      ? `${titles[0]} is running in this project. Sync after it finishes.`
      : "A chat in this project is running. Sync after it finishes.";
  const shown = titles.slice(0, 3);
  const more = busy.size - shown.length;
  const names = shown.length ? `: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}` : "";
  return `${busy.size} chats in this project are running${names}. Sync after they finish.`;
}

/** Visible explanation for a locked CAD panel. */
export interface CadPanelLockStatus {
  readonly message: string;
  /** This chat's agent owns the lock through its CAD work, so the viewer stays undimmed. */
  readonly agent: boolean;
}

/**
 * Explains why this chat's CAD panel is locked, or returns null when no run, agent, or operation
 * locks it. Once this chat's agent has used CAD in the current run, the status stays `agent` until
 * the run ends, including the gaps between CAD tool calls.
 */
export function cadPanelLockStatus({
  blocker,
  panel,
  operation,
  localCadFile = null,
}: {
  blocker: CadThreadRunBlocker | null;
  panel: Pick<CadPanelState, "agentControlling" | "agentActivityTurnId" | "captureId"> | null;
  operation: NonNullable<CadProjectState["operation"]>["kind"] | null;
  /** The local CAD file the project imports, or null when it syncs from Onshape. */
  localCadFile?: string | null;
}): CadPanelLockStatus | null {
  if (blocker || panel?.agentControlling) {
    const thread = blocker?.thread;
    const running = thread !== undefined && isCadThreadRunActive(thread);
    // After the run, a pending presentation holds the lock until it settles; no run is left to end.
    if (panel?.captureId)
      return {
        message: running
          ? "Showing the agent's last view. Controls unlock when the run ends."
          : "Showing the agent's last view.",
        agent: true,
      };
    // A starting run still reports the previous turn as latestTurn, so only the active turn, or a
    // latest turn that is actually running, counts as this run.
    const currentTurnId =
      thread?.session?.activeTurnId ??
      (thread?.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
    const turnId = panel?.agentActivityTurnId;
    const usedCadThisRun = panel?.agentControlling || (turnId != null && turnId === currentTurnId);
    if (usedCadThisRun)
      return {
        message: "Agent is looking at CAD. Controls unlock when the run ends.",
        agent: true,
      };
    return { message: "Locked while this chat runs.", agent: false };
  }
  if (operation)
    return {
      message:
        operation === "cleanup"
          ? "Cleaning up CAD files."
          : localCadFile === null
            ? "Updating CAD from Onshape."
            : operation === "discover"
              ? "Scanning the project folder."
              : isSolidWorksFile(localCadFile)
                ? "Converting the SolidWorks file with SolidWorks."
                : "Importing the CAD file.",
      agent: false,
    };
  return null;
}
