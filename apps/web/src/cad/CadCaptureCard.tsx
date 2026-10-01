import type { CadCaptureCard as Capture, ScopedThreadRef } from "@cadsense/contracts";
import { CubeIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useRightPanelStore } from "../rightPanelStore";
import { Button } from "../components/ui/button";
import { useThreadActivities } from "../state/entities";
import { deriveWorkLogEntries } from "../session-logic";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { useMemo, useState } from "react";
import { LoadingMark } from "../components/LoadingMark";
import { useAssetUrlState } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";

export function CadCaptureCard({
  capture,
  threadRef,
  onImageExpand,
  summary,
}: {
  capture: Capture;
  summary?: string;
  threadRef: ScopedThreadRef;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const [comparing, setComparing] = useState(false);
  const activities = useThreadActivities(threadRef);
  const previousCapture = useMemo(() => {
    const captures = deriveWorkLogEntries(activities).flatMap((entry) =>
      entry.cadCapture ? [entry.cadCapture] : [],
    );
    const index = captures.findIndex((entry) => entry.captureId === capture.captureId);
    return index > 0 ? captures[index - 1] : undefined;
  }, [activities, capture.captureId]);
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: `cad-${capture.captureId}`,
    fileName: "CAD capture.png",
    mimeType: "image/png",
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const unavailable =
    asset._tag === "Failure" || (asset._tag === "Success" && failedUrl === asset.url);
  return (
    <>
      <figure
        className="my-3 max-w-md overflow-hidden rounded-md border border-border bg-card"
        aria-label="Captured CAD view"
      >
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="flex items-center gap-2 text-xs font-medium">
            <CubeIcon className="size-4 text-primary" />
            Design snapshot
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            VIEW {capture.revision}
          </span>
        </div>
        {asset._tag === "Success" && !unavailable ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            aria-label="Open CAD capture image"
            onClick={() =>
              onImageExpand({ images: [{ src: asset.url, name: "CAD capture.png" }], index: 0 })
            }
          >
            <img
              src={asset.url}
              alt="CAD view captured by the agent"
              width={1280}
              height={960}
              loading="lazy"
              className="aspect-[4/3] w-full object-contain"
              onError={() => setFailedUrl(asset.url)}
            />
          </button>
        ) : (
          <div
            className="flex aspect-[4/3] items-center justify-center p-4 text-xs text-muted-foreground"
            role="status"
          >
            {unavailable ? "This capture image is unavailable." : <LoadingMark kind="cad" />}
          </div>
        )}
        <figcaption className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0">{summary ?? "Captured during design review"}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useRightPanelStore.getState().open(threadRef, "cad")}
          >
            <ArrowSquareOutIcon className="size-3.5" />
            Current model
          </Button>
        </figcaption>
        {previousCapture ? (
          <Button
            variant="ghost"
            className="w-full justify-center rounded-none border-t text-xs"
            onClick={() => setComparing(true)}
          >
            Compare with previous capture
          </Button>
        ) : null}
      </figure>
      {previousCapture && comparing ? (
        <Dialog open={comparing} onOpenChange={setComparing}>
          <DialogPopup className="w-[min(960px,95vw)] max-w-none">
            <DialogTitle>Compare captured views</DialogTitle>
            <DialogDescription>
              Two recorded views of this design. Camera position and visible parts may differ.
            </DialogDescription>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <ComparisonImage
                capture={previousCapture}
                threadRef={threadRef}
                label="Previous capture"
              />
              <ComparisonImage capture={capture} threadRef={threadRef} label="This capture" />
            </div>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}

function ComparisonImage({
  capture,
  threadRef,
  label,
}: {
  capture: Capture;
  threadRef: ScopedThreadRef;
  label: string;
}) {
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: `cad-${capture.captureId}`,
    fileName: "CAD capture.png",
    mimeType: "image/png",
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <figure className="overflow-hidden rounded border border-border bg-card">
      {asset._tag === "Success" && asset.url !== failedUrl ? (
        <img
          src={asset.url}
          alt={`${label}, view ${capture.revision}`}
          className="aspect-[4/3] w-full object-contain"
          onError={() => setFailedUrl(asset.url)}
        />
      ) : (
        <div
          role="status"
          className="flex aspect-[4/3] items-center justify-center text-xs text-muted-foreground"
        >
          {asset._tag === "Failure" || failedUrl ? "Capture unavailable" : "Loading capture…"}
        </div>
      )}
      <figcaption className="border-t px-3 py-2 text-xs">
        {label}
        <span className="float-right font-mono text-muted-foreground">View {capture.revision}</span>
      </figcaption>
    </figure>
  );
}
