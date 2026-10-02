import { RefreshCwIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";

/**
 * Re-imports the local CAD file shown in the panel after it was re-exported, or the project's
 * default file when nothing has imported yet. Renders nothing for Onshape projects.
 */
export function CadLocalSyncButton({
  project,
  rootId,
  disabled,
}: {
  project: Project;
  rootId: string | null;
  disabled: boolean;
}) {
  const start = useAtomCommand(onshapeProjectEnvironment.startCadOperation);
  const cad = project.cad;
  const root = cad?.roots.find((entry) => entry.rootId === rootId);
  // The catalog names the default file even when its first import failed.
  const elementId = root?.elementId ?? cad?.catalog?.sourceElement?.elementId;
  if (!project.localCadSource || !elementId) return null;
  const name =
    cad?.catalog?.roots.find((entry) => entry.elementId === elementId)?.name ??
    project.localCadSource.filePath;
  const syncing = cad?.operation?.kind === "sync";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !!cad?.operation || cad?.enabled === false}
            onClick={() =>
              void start({
                environmentId: project.environmentId,
                input: {
                  projectId: project.id,
                  kind: "sync",
                  root: { elementId, kind: "assembly", configuration: "default" },
                },
              })
            }
          >
            <RefreshCwIcon />
            {syncing ? "Importing…" : "Sync"}
          </Button>
        }
      />
      <TooltipPopup>Import {name} again after re-exporting it</TooltipPopup>
    </Tooltip>
  );
}
