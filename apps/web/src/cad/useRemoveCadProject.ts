import type { EnvironmentId, ProjectId } from "@cadsense/contracts";
import { useCallback } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { cadStorageEnvironment } from "../state/cadStorage";
import { requestCadRemoval } from "./CadRemovalDialog";
export function useRemoveCadProject() {
  const run = useAtomCommand(cadStorageEnvironment.run, { reportFailure: false });
  return useCallback(
    async (project: {
      id: ProjectId;
      environmentId: EnvironmentId;
      title: string;
      workspaceRoot: string;
    }) => {
      const choices = await requestCadRemoval(project);
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
