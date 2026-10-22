import type { EnvironmentId, OnshapeProjectSource, ProjectId } from "@cadsense/contracts";
import { useCallback } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { cadStorageEnvironment } from "../state/cadStorage";
import { requestCadRemoval } from "./CadRemovalDialog";
/** Asks how to remove an Onshape or local CAD project, then removes it through CAD storage. */
export function useRemoveCadProject() {
  const run = useAtomCommand(cadStorageEnvironment.run, { reportFailure: false });
  return useCallback(
    async (project: {
      id: ProjectId;
      environmentId: EnvironmentId;
      title: string;
      workspaceRoot: string;
      onshapeSource?: OnshapeProjectSource | undefined;
    }) => {
      const choices = await requestCadRemoval({
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        source: project.onshapeSource ? "onshape" : "local",
      });
      return choices
        ? run({
            environmentId: project.environmentId,
            input: { kind: "remove", projectId: project.id, ...choices },
          })
        : null;
    },
    [run],
  );
}
