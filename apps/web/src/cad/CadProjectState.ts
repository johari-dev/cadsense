import type { Project, ThreadShell } from "../types";
import { isCadThreadRunActive } from "@cadsense/contracts";

export function isCadProjectRunActive(
  project: Pick<Project, "id" | "environmentId" | "cad">,
  threads: readonly ThreadShell[],
): boolean {
  return (
    (project.cad?.pendingPresentations?.length ?? 0) > 0 ||
    threads.some(
      (thread) =>
        thread.environmentId === project.environmentId &&
        thread.projectId === project.id &&
        isCadThreadRunActive(thread),
    )
  );
}
