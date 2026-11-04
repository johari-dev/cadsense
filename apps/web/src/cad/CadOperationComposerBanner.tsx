import { hasCadSource, isSolidWorksFile } from "@cadsense/contracts";
import { useEffect, useState } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";

/** `m:ss`, or `h:mm:ss` past an hour. */
const elapsedLabel = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
};

/** Time since `startedAt` as text, updated once a second. Its own state keeps the tick local. */
function ElapsedClock({ startedAt }: { readonly startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{elapsedLabel(now - Date.parse(startedAt))}</>;
}

/**
 * What the composer shows while a CAD operation holds the project: a banner naming it, with an
 * elapsed clock and Cancel, and the reason Send waits. The server refuses agent runs until the
 * operation ends (`requireProjectCadIdle`), so the composer says so instead of failing the send.
 * Both are null when nothing holds the project.
 */
export function useCadOperationComposerState(project: Project | undefined | null): {
  readonly bannerItem: ComposerBannerStackItem | null;
  readonly sendDisabledReason: string | null;
} {
  const operation = project && hasCadSource(project) ? (project.cad?.operation ?? null) : null;
  // A failed cancel reports itself, so the user learns why the import goes on.
  const cancel = useAtomCommand(onshapeProjectEnvironment.cancelCadOperation);
  const [cancelling, setCancelling] = useState<string | null>(null);

  if (!project || !operation) return { bannerItem: null, sendDisabledReason: null };
  const local = project.localCadSource;
  const name =
    (operation.root &&
      project.cad?.catalog?.roots.find((entry) => entry.elementId === operation.root?.elementId)
        ?.name) ??
    local?.filePath ??
    "CAD";
  const title =
    operation.kind === "sync" ? (
      <>
        {local ? (isSolidWorksFile(name) ? "Converting " : "Importing ") : "Downloading "}
        <span className="font-semibold">{name}</span>
        {local ? (isSolidWorksFile(name) ? " with SolidWorks" : "") : " from Onshape"}
      </>
    ) : operation.kind === "discover" ? (
      local ? (
        "Refreshing the CAD file list"
      ) : (
        "Refreshing the Onshape document"
      )
    ) : (
      "Cleaning up CAD storage"
    );
  const cancellable = operation.kind !== "cleanup";
  return {
    sendDisabledReason:
      operation.kind === "sync"
        ? "You can send once the import finishes."
        : "You can send once the CAD operation finishes.",
    bannerItem: {
      id: `cad-operation:${operation.operationId}`,
      variant: "default",
      // In front of calm banners: it is why Send waits.
      urgent: true,
      icon: <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />,
      title: (
        <span role="status">
          {title}
          <span className="ms-1.5 font-normal text-tertiary-foreground tabular-nums">
            <ElapsedClock startedAt={operation.startedAt} />
          </span>
        </span>
      ),
      ...(cancellable
        ? {
            actions: (
              <Button
                size="xs"
                variant="ghost"
                disabled={cancelling === operation.operationId}
                onClick={() => {
                  setCancelling(operation.operationId);
                  void cancel({
                    environmentId: project.environmentId,
                    input: { projectId: project.id, operationId: operation.operationId },
                  }).finally(() => setCancelling(null));
                }}
              >
                {cancelling === operation.operationId ? "Cancelling..." : "Cancel"}
              </Button>
            ),
          }
        : {}),
    },
  };
}
