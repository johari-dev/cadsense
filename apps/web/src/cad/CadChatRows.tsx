import type {
  AssetResource,
  CadCaptureCard,
  CadCommentsPublishedCard,
  ScopedThreadRef,
} from "@cadsense/contracts";
import { CircleAlertIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";
import { useAssetUrls } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";
import { useRightPanelStore } from "../rightPanelStore";
import { useCadCommentReviewStore } from "./cadCommentReviewStore";
import { CommentBadge } from "./CadCommentsCard";

const MAX_THUMBNAILS = 6;
const MAX_LISTED_COMMENTS = 8;

/** Opens the CAD panel's comments, optionally focused on one comment's first location. */
function openCadComments(threadRef: ScopedThreadRef, commentId?: string) {
  useCadCommentReviewStore
    .getState()
    .request(threadRef, commentId ? { id: commentId, target: 0 } : undefined);
  useRightPanelStore.getState().open(threadRef, "cad");
}

/** The views an agent captured during one group of CAD tool calls. Thumbnails open the image viewer. */
export function CadFilmstrip({
  captures,
  threadRef,
  onImageExpand,
}: {
  captures: readonly CadCaptureCard[];
  threadRef: ScopedThreadRef;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const captureKey = captures.map((capture) => capture.captureId).join(",");
  const resources = useMemo(
    (): AssetResource[] =>
      captureKey.split(",").map((captureId) => ({
        _tag: "attachment",
        attachmentId: `cad-${captureId}`,
        fileName: "CAD capture.png",
        mimeType: "image/png",
      })),
    [captureKey],
  );
  const urls = useAssetUrls(threadRef.environmentId, resources);
  const overflow = captures.length > MAX_THUMBNAILS;
  const shown = overflow ? captures.slice(0, MAX_THUMBNAILS - 1) : captures;
  const open = (index: number) => {
    // The viewer adds its own "(2/3)" position to the name.
    const images = urls.flatMap((src) => (src ? [{ src, name: "CAD view" }] : []));
    const src = urls[index];
    if (src) onImageExpand({ images, index: images.findIndex((image) => image.src === src) });
  };
  return (
    <div className="flex flex-wrap gap-1 pl-[30px]" aria-label="CAD views captured by the agent">
      {shown.map((capture, index) => {
        const src = urls[index];
        return (
          <button
            key={capture.captureId}
            type="button"
            disabled={!src}
            aria-label={`Open CAD view ${index + 1} of ${captures.length}`}
            className="h-12 w-16 cursor-zoom-in overflow-hidden rounded bg-muted disabled:cursor-default"
            onClick={() => open(index)}
          >
            {src ? (
              <img
                src={src}
                alt=""
                width={64}
                height={48}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : null}
          </button>
        );
      })}
      {overflow ? (
        <button
          type="button"
          className="flex h-12 w-16 items-center justify-center rounded bg-muted text-xs text-muted-foreground"
          aria-label={`Open the remaining ${captures.length - shown.length} CAD views`}
          onClick={() => open(shown.length)}
        >
          +{captures.length - shown.length}
        </button>
      ) : null}
    </div>
  );
}

const REJECTION_REASONS: Readonly<Record<string, string>> = {
  "invalid-input": "the finding was incomplete",
  "candidate-expired": "its marker expired before publishing",
  "inspection-required": "its marker was never checked",
  "mixed-revision": "its marker came from another model revision",
  "occurrence-unavailable": "the part is hidden or has no geometry",
  "catalog-changed": "other comments changed while it was publishing",
  "model-equivalence-unverified": "the model changed since the original comment",
  "invalid-comment-link": "it links to a comment that does not exist",
  "idempotency-conflict": "it reused the key of a different finding",
};

/** Plain wording for why the server rejected a finding. */
export function describeCadCommentRejection(rejection: {
  readonly title: string | null;
  readonly reason: string;
}): string {
  const reason =
    REJECTION_REASONS[rejection.reason] ??
    (rejection.reason.startsWith("render-")
      ? "the CAD view could not be rendered"
      : "the server rejected it");
  return rejection.title
    ? `"${rejection.title}" was not published: ${reason}.`
    : `A finding was not published: ${reason}.`;
}

/** Comments one turn published, each opening its location in the CAD panel. */
export function CadPublishedComments({
  card,
  threadRef,
}: {
  card: CadCommentsPublishedCard;
  threadRef: ScopedThreadRef;
}) {
  const count = card.published.length;
  const listed = card.published.slice(0, MAX_LISTED_COMMENTS);
  const unlisted = count - listed.length;
  return (
    <div className="text-sm leading-relaxed">
      <div className="flex min-h-6 items-center gap-1.5 px-0.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <MessageSquareIcon className="size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {count === 0
            ? "No comments published"
            : `Wrote ${count} ${count === 1 ? "comment" : "comments"}`}
        </span>
        {count > 0 ? (
          <button
            type="button"
            className="shrink-0 text-xs text-secondary-label underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => openCadComments(threadRef)}
          >
            Open in CAD
          </button>
        ) : null}
      </div>
      {listed.map((comment) => (
        <button
          key={comment.commentId}
          type="button"
          className="flex w-full items-baseline gap-2 rounded-md py-0.5 pr-0.5 pl-[30px] text-left hover:bg-accent/20"
          onClick={() => openCadComments(threadRef, comment.commentId)}
        >
          <CommentBadge number={comment.number} />
          <span className="min-w-0 flex-1 truncate text-foreground">{comment.title}</span>
          {comment.location ? (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
              {comment.location}
            </span>
          ) : null}
        </button>
      ))}
      {unlisted > 0 ? (
        <button
          type="button"
          className="py-0.5 pl-[30px] text-xs text-secondary-label underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => openCadComments(threadRef)}
        >
          {unlisted} more in CAD
        </button>
      ) : null}
      {card.rejected.map((rejection) => (
        <p
          key={rejection.publicationKey}
          className="flex items-baseline gap-2 py-0.5 pl-[30px] text-destructive"
        >
          <CircleAlertIcon className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="min-w-0 flex-1">{describeCadCommentRejection(rejection)}</span>
        </p>
      ))}
    </div>
  );
}
