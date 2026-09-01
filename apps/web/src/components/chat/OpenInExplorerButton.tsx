import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@cadsense/contracts";
import { FolderOpenIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const OpenInExplorerButton = memo(function OpenInExplorerButton({
  environmentId,
  path,
  reveal = false,
}: {
  environmentId: EnvironmentId;
  path: string | null;
  reveal?: boolean;
}) {
  const openInExplorer = useAtomCommand(shellEnvironment.openInFileManager, {
    reportFailure: false,
  });

  const onOpen = useCallback(async () => {
    if (!path) return;
    const nativeOpen = window.desktopBridge?.openInFileManager;
    if (environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID && nativeOpen) {
      const opened = await nativeOpen({ cwd: path, reveal });
      if (opened) return;
    }
    const result = await openInExplorer({
      environmentId,
      input: { cwd: path, reveal },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Unable to open Explorer",
        description: "Check that this workspace is available on this computer.",
      });
    }
  }, [environmentId, openInExplorer, path, reveal]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in Explorer"
            disabled={!path}
            onClick={() => void onOpen()}
            size="xs"
            variant="outline"
            className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
            data-toolbar-control=""
          />
        }
      >
        <FolderOpenIcon className="size-3.5" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </TooltipTrigger>
      <TooltipPopup>Open in Explorer</TooltipPopup>
    </Tooltip>
  );
});
