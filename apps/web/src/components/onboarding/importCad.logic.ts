import { hasCadSource, type EnvironmentId, type ProjectId } from "@cadsense/contracts";

import { cadSyncPlan } from "../../cad/CadSyncButton";
import type { Project } from "../../types";

/**
 * What onboarding starts next for a project with nothing imported: the CAD panel's Sync plan, or a
 * first catalog read for an Onshape link that names no tab. `cadSyncPlan` only reads the catalog
 * for a link that names one, since the panel never needs to otherwise.
 */
export function firstImportPlan(project: Project): ReturnType<typeof cadSyncPlan> {
  const plan = cadSyncPlan(project, null);
  if (plan !== null) return plan;
  return project.onshapeSource && !project.cad?.catalog ? { kind: "discover" } : null;
}

/** Where onboarding's project is in its first import, read from its live CAD state. */
export type ImportCadStage =
  /** Idle with nothing imported and nothing failed: onboarding starts the next operation itself. */
  | { readonly kind: "starting" }
  /** Refreshing the catalog, which says what the Onshape link points at. */
  | { readonly kind: "reading"; readonly startedAt: string }
  | { readonly kind: "importing"; readonly startedAt: string }
  | { readonly kind: "failed"; readonly reason: string }
  /** The catalog is in, but the link names no Assembly or Part Studio, so the user picks one. */
  | { readonly kind: "choose" }
  | { readonly kind: "done" };

const STOPPED_REASONS = {
  failed: "The import failed.",
  cancelled: "The import was cancelled.",
  interrupted: "The import stopped before it finished.",
} as const;

/**
 * Maps a project's CAD state to the import step. Imported CAD wins, then a running operation, then
 * the last operation's failure, so a failure stays on screen until the next attempt. A discover
 * that succeeded leaves the sync to start next.
 */
export function importCadStage(project: Project): ImportCadStage {
  const cad = project.cad;
  if (cad?.roots.some((root) => root.current !== null)) return { kind: "done" };
  const operation = cad?.operation;
  if (operation)
    return operation.kind === "sync"
      ? { kind: "importing", startedAt: operation.startedAt }
      : { kind: "reading", startedAt: operation.startedAt };
  const outcome = cad?.lastOutcome;
  if (outcome && outcome.status !== "succeeded")
    return { kind: "failed", reason: outcome.reason ?? STOPPED_REASONS[outcome.status] };
  if (firstImportPlan(project) !== null) return { kind: "starting" };
  return cad?.catalog?.roots.length
    ? { kind: "choose" }
    : {
        kind: "failed",
        reason: "Cadsense found no Assembly or Part Studio to import in this document.",
      };
}

/**
 * Whether the home route should show onboarding: there is no project yet, or the only project is
 * a CAD project whose first import has not finished and that has no chats. A reload during the
 * import then lands back on the import step instead of an empty chat.
 */
export function needsOnboarding(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
): boolean {
  if (projects.length === 0) return true;
  const [project] = projects;
  return (
    projects.length === 1 &&
    project !== undefined &&
    hasCadSource(project) &&
    importCadStage(project).kind !== "done" &&
    !threads.some(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    )
  );
}
