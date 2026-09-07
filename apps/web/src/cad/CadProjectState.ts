import type { Project, ThreadShell } from "../types";

export function isCadProjectRunActive(
  project: Pick<Project, "id" | "environmentId">,
  threads: readonly ThreadShell[],
): boolean {
  return threads.some(
    (thread) =>
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id &&
      ((thread.turnAdmission?.pending.length ?? 0) > 0 ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.session?.activeTurnId != null ||
        thread.latestTurn?.state === "running" ||
        thread.backgroundLiveness === "working"),
  );
}
