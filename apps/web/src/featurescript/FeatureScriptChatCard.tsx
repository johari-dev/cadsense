import type {
  AssetResource,
  CadFeatureScriptPreviewCard,
  ScopedThreadRef,
} from "@cadsense/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { failureLocationLabel, formatVolumeChange } from "./FeatureScriptPreview";
import {
  featureScriptFileKey,
  useFeatureScriptPanelStore,
  withDefaultInputs,
} from "./featureScriptPanelStore";

const FAILED = new Set(["ERROR", "INVALID", "STOPPED"]);
/** Inputs longer than this (picked faces, mostly) are left out of the summary line. */
const MAX_SHOWN_PARAMETER = 32;

/**
 * One agent `cad_featurescript_preview` call in the chat: the outcome, the failure and its line,
 * the views the agent saw, and what changed. Links open the script in the file panel, at the
 * failing line when there is one, with the agent's inputs and base, so the panel shows the run
 * the card describes.
 */
export function FeatureScriptChatCard(props: {
  readonly card: CadFeatureScriptPreviewCard;
  readonly threadRef: ScopedThreadRef;
  /** The workspace the file panel reads, to hand it the agent's inputs. */
  readonly workspaceRoot: string | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { card, threadRef } = props;
  const failed = FAILED.has(card.status);
  // Timeline updates decode a new card object; the key keeps the URL requests stable.
  const imageKey = card.images.map((image) => image.attachmentId).join(",");
  const resources = useMemo(
    (): AssetResource[] =>
      imageKey
        .split(",")
        .filter(Boolean)
        .map((attachmentId) => ({
          _tag: "attachment",
          attachmentId,
          fileName: "FeatureScript preview.png",
          mimeType: "image/png",
        })),
    [imageKey],
  );
  const urls = useAssetUrls(threadRef.environmentId, resources);
  const location = card.failure?.location ?? null;
  const open = () => {
    if (props.workspaceRoot !== undefined)
      useFeatureScriptPanelStore
        .getState()
        .update(
          featureScriptFileKey(threadRef.environmentId, props.workspaceRoot, card.path),
          ({ feature: _feature, ...current }) => ({
            ...withDefaultInputs(current),
            ...(card.feature === null ? {} : { feature: card.feature }),
            parameters: card.parameters,
            before: card.before,
            base: card.base,
          }),
        );
    useRightPanelStore
      .getState()
      .openFile(threadRef, location?.path ?? card.path, location?.line ?? undefined);
  };
  const parameters = Object.entries(card.parameters)
    .filter(([, expression]) => expression.length <= MAX_SHOWN_PARAMETER)
    .map(([id, expression]) => `${id} ${expression.replaceAll(" * ", " ")}`);
  const expand = (index: number) => {
    const images = urls.flatMap((src, i) =>
      src ? [{ src, name: `${card.typeName ?? card.path} ${card.images[i]!.view}` }] : [],
    );
    const src = urls[index];
    if (src) props.onImageExpand({ images, index: images.findIndex((image) => image.src === src) });
  };

  return (
    <div
      className="ml-[30px] max-w-xl rounded-xl border border-border/70 bg-card/40 text-sm"
      data-testid="featurescript-chat-card"
    >
      <div className="flex min-h-9 items-center gap-2 px-2.5">
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium",
            failed ? "bg-destructive/12 text-destructive-foreground" : "bg-muted text-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              failed ? "bg-destructive" : card.status === "WARNING" ? "bg-warning" : "bg-success",
            )}
          />
          {card.status}
        </span>
        <span className="min-w-0 truncate font-medium text-foreground">
          {card.typeName ?? "FeatureScript"}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {card.path.split("/").at(-1)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="shrink-0 text-xs text-secondary-label underline-offset-2 hover:text-foreground hover:underline"
          onClick={open}
        >
          {location ? `Open line ${location.line}` : "Open file"}
        </button>
      </div>
      {card.failure ? (
        <p className="flex gap-2 border-t border-border/60 px-2.5 py-2 font-mono text-[11.5px] break-words text-red-200">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0">
            {failureLocationLabel(card.failure) ? (
              <span className="mr-1.5 text-foreground">{failureLocationLabel(card.failure)}</span>
            ) : null}
            {card.failure.message}
          </span>
        </p>
      ) : null}
      {card.images.length > 0 ? (
        <div className="flex gap-1.5 border-t border-border/60 p-2">
          {card.images.map((image, index) => (
            <button
              key={image.attachmentId}
              type="button"
              disabled={!urls[index]}
              aria-label={`Open the ${image.view} view`}
              className="relative aspect-square w-full max-w-28 cursor-zoom-in overflow-hidden rounded-md bg-muted disabled:cursor-default"
              onClick={() => expand(index)}
            >
              {urls[index] ? (
                <img
                  src={urls[index]}
                  alt=""
                  loading="lazy"
                  className={cn("h-full w-full object-cover", failed && "opacity-60")}
                />
              ) : null}
              <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
                {failed ? "unchanged" : image.view}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {card.changes || parameters.length > 0 || card.base ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          {card.changes && !failed ? (
            <>
              <span>
                Volume{" "}
                <span className="text-foreground">
                  {formatVolumeChange(card.changes.volumeMm3)}
                </span>
              </span>
              <span>
                <span className="text-foreground">{card.changes.createdFaces}</span> new{" "}
                {card.changes.createdFaces === 1 ? "face" : "faces"}
              </span>
            </>
          ) : null}
          {parameters.length > 0 ? <span>{parameters.join(", ")}</span> : null}
          {card.base ? <span>on {card.base.split("/").at(-1)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
