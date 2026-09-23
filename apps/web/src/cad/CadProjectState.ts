import type { Project, ThreadShell } from "../types";
import {
  isCadThreadRunActive,
  type CadPanelState,
  type CadProjectState,
  type ThreadId,
} from "@cadsense/contracts";

type CadProjectRef = Pick<Project, "id" | "environmentId" | "cad">;

/** A thread whose run, or pending capture presentation, keeps project CAD locked. */
export interface CadProjectRunBlocker {
  readonly threadId: ThreadId;
  /** Undefined when the thread shell is not loaded on this client. */
  readonly thread: ThreadShell | undefined;
}

/**
 * Returns the thread that keeps project CAD locked, or null when nothing does.
 * Prefers `preferredThreadId` so a panel can tell its own run apart from another chat's.
 */
export function findCadProjectRunBlocker(
  project: CadProjectRef,
  threads: readonly ThreadShell[],
  preferredThreadId?: ThreadId,
): CadProjectRunBlocker | null {
  const projectThreads = threads.filter(
    (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
  );
  const blockers: CadProjectRunBlocker[] = [
    ...(project.cad?.pendingPresentations ?? []).map(({ threadId }) => ({
      threadId,
      thread: projectThreads.find((thread) => thread.id === threadId),
    })),
    ...projectThreads
      .filter((thread) => isCadThreadRunActive(thread))
      .map((thread) => ({ threadId: thread.id, thread })),
  ];
  return blockers.find((blocker) => blocker.threadId === preferredThreadId) ?? blockers[0] ?? null;
}

export function isCadProjectRunActive(
  project: CadProjectRef,
  threads: readonly ThreadShell[],
): boolean {
  return findCadProjectRunBlocker(project, threads) !== null;
}

/** Visible explanation for a locked CAD panel. */
export interface CadPanelLockStatus {
  readonly message: string;
  /** This chat's agent owns the lock through its CAD work, so the viewer stays undimmed. */
  readonly agent: boolean;
}

/**
 * Explains why the CAD panel for `threadId` is locked, or returns null when no run, agent, or
 * operation locks it. Once this chat's agent has used CAD in the current run, the status stays
 * `agent` until the run ends, including the gaps between CAD tool calls.
 */
export function cadPanelLockStatus({
  threadId,
  blocker,
  panel,
  operation,
}: {
  threadId: ThreadId;
  blocker: CadProjectRunBlocker | null;
  panel: Pick<CadPanelState, "agentControlling" | "agentActivityTurnId" | "captureId"> | null;
  operation: NonNullable<CadProjectState["operation"]>["kind"] | null;
}): CadPanelLockStatus | null {
  const ownRun = blocker?.threadId === threadId ? blocker : null;
  if (ownRun || panel?.agentControlling) {
    const thread = ownRun?.thread;
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
  if (blocker)
    return {
      message: blocker.thread
        ? `Locked while "${blocker.thread.title}" runs.`
        : "Locked while another chat runs.",
      agent: false,
    };
  if (operation)
    return {
      message: operation === "cleanup" ? "Cleaning up CAD files." : "Updating CAD from Onshape.",
      agent: false,
    };
  return null;
}
