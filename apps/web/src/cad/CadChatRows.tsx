import type {
  AssetResource,
  CadCaptureCard,
  CadCommentsPublishedCard,
  ScopedThreadRef,
} from "@cadsense/contracts";
import {
  ArrowRightIcon,
  WarningCircleIcon as CircleAlertIcon,
  ChatIcon as MessageSquareIcon,
} from "~/lib/icons";
import { useMemo, type ReactNode } from "react";
import { useAssetUrls } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";
import { useRightPanelStore } from "../rightPanelStore";
import { useCadCommentReviewStore } from "./cadCommentReviewStore";
import { CadSeverityIcon, CommentBadge } from "./CadCommentsCard";

const MAX_THUMBNAILS = 6;
const MAX_LISTED_COMMENTS = 6;

/** Opens the CAD panel's comments, optionally focused on one comment with all its locations. */
function openCadComments(threadRef: ScopedThreadRef, commentId?: string) {
  useCadCommentReviewStore
    .getState()
    .request(threadRef, commentId ? { id: commentId, target: "all" } : undefined);
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
  "comment-unavailable": "the comment it refers to is not in this chat",
  "comment-not-open": "the comment it refers to is already reviewed",
  "snapshot-not-newer": "its evidence is not from a newer model revision",
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

/** "Wrote 2 comments, proposed 1 resolution", or the fallback when nothing was published. */
export function describeCadCommentsPublished(card: CadCommentsPublishedCard): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const summary = [
    card.published.length ? `wrote ${count(card.published.length, "comment")}` : "",
    card.proposed.length ? `proposed ${count(card.proposed.length, "resolution")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return summary ? summary.charAt(0).toUpperCase() + summary.slice(1) : "No comments published";
}

/** Comments one turn published or proposed to resolve, each opening its location in the CAD panel. */
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
    <div className="text-sm">
      <div className="flex min-h-6 items-center gap-1.5 px-0.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <MessageSquareIcon className="size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {describeCadCommentsPublished(card)}
        </span>
        {/* The footer's "Show all" link takes over when the list is cut short. */}
        {unlisted === 0 && (count > 0 || card.proposed.length > 0) ? (
          <button
            type="button"
            className="shrink-0 text-xs text-secondary-label underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => openCadComments(threadRef)}
          >
            Open in CAD
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex flex-col">
        {listed.map((comment) =>
          commentRow({
            key: comment.commentId,
            number: comment.number,
            title: comment.title,
            onOpen: () => openCadComments(threadRef, comment.commentId),
            detail:
              comment.severity || comment.location ? (
                <>
                  <CadSeverityIcon severity={comment.severity} category={comment.category} />
                  {comment.location ? (
                    <span className="min-w-0 truncate">{comment.location}</span>
                  ) : null}
                </>
              ) : null,
          }),
        )}
        {card.proposed.map((proposal) =>
          commentRow({
            key: proposal.commentId,
            number: proposal.number,
            title: proposal.title,
            onOpen: () => openCadComments(threadRef, proposal.commentId),
            detail: "Resolution proposed",
          }),
        )}
      </div>
      {unlisted > 0 ? (
        <button
          type="button"
          className="mt-0.5 ml-[30px] flex items-center gap-1 rounded-sm py-1 text-xs font-medium text-secondary-label transition-colors hover:text-foreground"
          onClick={() => openCadComments(threadRef)}
        >
          Show all {count} in CAD
          <ArrowRightIcon className="size-3.5" aria-hidden />
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

/**
 * One comment in the chat list: its number and full title on the first line, then the
 * secondary detail (severity and part, or the proposal state) on a second, quieter line.
 * The badge sits in the header icon's column so titles line up with the header text.
 */
function commentRow({
  key,
  number,
  title,
  onOpen,
  detail,
}: {
  key: string;
  number: number;
  title: string;
  onOpen: () => void;
  detail: ReactNode;
}) {
  return (
    <button
      key={key}
      type="button"
      className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5 rounded-md px-0.5 py-1 text-left transition-colors hover:bg-accent/20"
      onClick={onOpen}
    >
      <span className="flex h-5 items-center justify-center">
        <CommentBadge number={number} />
      </span>
      <span className="line-clamp-2 leading-5 text-foreground">{title}</span>
      {detail ? (
        <span className="col-start-2 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </button>
  );
}
