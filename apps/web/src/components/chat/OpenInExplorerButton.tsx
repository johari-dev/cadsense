import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@cadsense/contracts";
import { FolderOpenIcon } from "~/lib/icons";
import { memo, useCallback } from "react";

import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Opens a path from an environment, or reveals it with `reveal`. A folder opens in the file manager
 * and a file opens in its default app. The desktop app's own shell goes first, and the environment's
 * server is the fallback for paths only it can reach, such as a WSL backend's. Resolves false when
 * neither could open it.
 */
export function useOpenInFileManager() {
  const openInExplorer = useAtomCommand(shellEnvironment.openInFileManager, {
    reportFailure: false,
  });
  return useCallback(
    async (environmentId: EnvironmentId, path: string, reveal: boolean) => {
      const nativeOpen = window.desktopBridge?.openInFileManager;
      if (environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID && nativeOpen) {
        const opened = await nativeOpen({ cwd: path, reveal });
        if (opened) return true;
      }
      const result = await openInExplorer({
        environmentId,
        input: { cwd: path, reveal },
      });
      return result._tag !== "Failure";
    },
    [openInExplorer],
  );
}

export const OpenInExplorerButton = memo(function OpenInExplorerButton({
  environmentId,
  path,
  reveal = false,
}: {
  environmentId: EnvironmentId;
  path: string | null;
  reveal?: boolean;
}) {
  const open = useOpenInFileManager();

  const onOpen = useCallback(async () => {
    if (!path) return;
    if (!(await open(environmentId, path, reveal))) {
      toastManager.add({
        type: "error",
        title: "Unable to open Explorer",
        description: "Check that this workspace is available on this computer.",
      });
    }
  }, [environmentId, open, path, reveal]);

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
