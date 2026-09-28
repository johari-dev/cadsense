import { useEffect } from "react";

import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";

/**
 * Asks the server to check the chat view's project for new Onshape versions when the view
 * switches to that project, or when its environment reconnects. Only fires for projects with
 * "Review new Onshape versions" on. Keyed on ids, so re-renders and thread switches inside the
 * same project do not fire again; the server also throttles "opened" checks per project.
 */
export function useOnshapeVersionCheckOnOpen(project: Project | null, connected: boolean) {
  const checkVersions = useAtomCommand(onshapeProjectEnvironment.checkVersions, {
    reportFailure: false,
  });
  const environmentId = project?.environmentId;
  const projectId = project?.id;
  const enabled = project?.onshapeSource?.autoReviewVersions === true;
  useEffect(() => {
    if (!connected || !enabled || !environmentId || !projectId) return;
    void checkVersions({ environmentId, input: { projectId, reason: "opened" } });
  }, [checkVersions, connected, enabled, environmentId, projectId]);
}
