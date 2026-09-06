import type { CadCaptureCard as Capture, ScopedThreadRef } from "@cadsense/contracts";
import { useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";

export function CadCaptureCard({
  capture,
  threadRef,
  onImageExpand,
}: {
  capture: Capture;
  threadRef: ScopedThreadRef;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
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
    <figure
      className="my-2 max-w-sm overflow-hidden rounded-lg border bg-muted/20"
      aria-label="Captured CAD view"
    >
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
          {unavailable ? "This capture image is unavailable." : "Loading CAD capture…"}
        </div>
      )}
      <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">
        CAD capture · view {capture.revision}
      </figcaption>
    </figure>
  );
}
