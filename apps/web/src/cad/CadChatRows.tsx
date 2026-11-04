import type {
  AssetResource,
  CadCaptureCard,
  CadCommentSeverity,
  CadCommentsPublishedCard,
  CadPartDrawingCard,
  ScopedThreadRef,
} from "@cadsense/contracts";
import {
  CubeIcon,
  WarningCircleIcon as CircleAlertIcon,
  ChatIcon as MessageSquareIcon,
  PartDrawingIcon,
} from "~/lib/icons";
import { useEffect, useMemo, type ReactNode } from "react";
import { useAssetUrls } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";
import { useRightPanelStore } from "../rightPanelStore";
import { useCadCommentReviewStore } from "./cadCommentReviewStore";
import { CommentBadge } from "./CadCommentsCard";

const MAX_THUMBNAILS = 6;
const MAX_LISTED_COMMENTS = 4;

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

/**
 * The card's heading: "11 review comments" when the turn only wrote comments, otherwise the
 * full summary so resolution proposals stay named.
 */
export function describeCadCommentsHeading(card: CadCommentsPublishedCard): string {
  const count = card.published.length;
  return count > 0 && card.proposed.length === 0
    ? `${count} review comment${count === 1 ? "" : "s"}`
    : describeCadCommentsPublished(card);
}

/**
 * The frame every agent artifact in the chat shares: part drawings and review comments. The
 * 4px side margin puts its edge on the prose column's text edge (assistant rows inset 4px).
 */
const ARTIFACT_CARD = "mx-1 rounded-lg border border-border bg-card px-2.5 py-2";
/** The one action an artifact card offers, at the right of its header row. */
const ARTIFACT_ACTION =
  "flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-medium text-foreground text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

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
  const heading = describeCadCommentsHeading(card);
  // A card of its own, so the review's result reads as the main outcome of the turn rather
  // than more narration. It shares the artifact card frame with part drawings (ARTIFACT_CARD).
  return (
    <section aria-label={heading} className={`${ARTIFACT_CARD} text-[0.9333rem]`}>
      <div className="flex min-h-7 items-center gap-1.5 px-0.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-(--accent-text)">
          <MessageSquareIcon className="size-4 shrink-0" aria-hidden />
        </span>
        <h3 className="min-w-0 flex-1 truncate font-semibold text-foreground text-sm">{heading}</h3>
        {count > 0 || card.proposed.length > 0 ? (
          <button
            type="button"
            className={ARTIFACT_ACTION}
            onClick={() => openCadComments(threadRef)}
          >
            <CubeIcon aria-hidden className="size-3.5 text-(--accent-text)" />
            {unlisted > 0 ? `Show all ${count} in CAD` : "Open in CAD"}
          </button>
        ) : null}
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5">
        {listed.map((comment) =>
          commentRow({
            key: comment.commentId,
            number: comment.number,
            title: comment.title,
            severity: comment.severity,
            onOpen: () => openCadComments(threadRef, comment.commentId),
            detail: comment.location ?? null,
          }),
        )}
        {unlisted > 0 ? (
          // Lines up with the titles: row inset, badge column, and gap.
          <p className="ps-8.5 pt-0.5 text-[0.8rem] text-muted-foreground">+{unlisted} more</p>
        ) : null}
        {card.proposed.map((proposal) =>
          commentRow({
            key: proposal.commentId,
            number: proposal.number,
            title: proposal.title,
            severity: null,
            onOpen: () => openCadComments(threadRef, proposal.commentId),
            detail: "Resolution proposed",
          }),
        )}
      </div>
      {card.rejected.map((rejection) => (
        <p
          key={rejection.publicationKey}
          className="flex items-baseline gap-2 px-1 pt-1.5 pb-0.5 text-destructive"
        >
          <CircleAlertIcon className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="min-w-0 flex-1">{describeCadCommentRejection(rejection)}</span>
        </p>
      ))}
    </section>
  );
}

/**
 * One comment in the chat list: its severity-colored number, full title, and severity pill on the
 * first line, then the secondary detail (the part, or the proposal state) on a second, quieter line.
 * The badge sits in the header icon's column so titles line up with the header text.
 * A plain function, not a component, so each row stays a `<button>` in the element tree.
 */
function commentRow({
  key,
  number,
  title,
  severity,
  onOpen,
  detail,
}: {
  key: string;
  number: number;
  title: string;
  severity: CadCommentSeverity | null;
  onOpen: () => void;
  detail: ReactNode;
}) {
  return (
    <button
      key={key}
      type="button"
      className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-1.5 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
      onClick={onOpen}
    >
      <span className="flex h-5 items-center justify-center">
        <CommentBadge number={number} severity={severity} />
      </span>
      <span className="line-clamp-2 leading-5 text-foreground">{title}</span>
      {/* The pin's color as a labeled pill at the title row's end, so the legend is on every
          row and the detail below keeps a clean left edge. */}
      {severity ? (
        <span className="cad-severity-pill mt-px self-start" data-severity={severity}>
          {severity}
        </span>
      ) : (
        <span />
      )}
      {detail ? (
        <span className="col-span-2 col-start-2 line-clamp-2 min-w-0 text-[13px] leading-[18px] text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </button>
  );
}

// Cards already opened on arrival, so remounting a row never reopens the panel.
const autoOpenedDrawings = new Set<string>();
const AUTO_OPEN_WINDOW_MS = 20_000;

/**
 * The part drawings an agent opened. Each sheet opens the Part drawing panel, and a
 * card that just arrived opens it once by itself.
 */
export function CadPartDrawings({
  id,
  createdAt,
  card,
  threadRef,
}: {
  id: string;
  createdAt: string;
  card: CadPartDrawingCard;
  threadRef: ScopedThreadRef;
}) {
  const open = () =>
    useRightPanelStore.getState().openDrawing(threadRef, {
      snapshotId: card.snapshotId,
      occurrenceIds: [...card.occurrenceIds],
      title: card.title,
    });
  useEffect(() => {
    if (autoOpenedDrawings.has(id)) return;
    autoOpenedDrawings.add(id);
    if (Date.now() - Date.parse(createdAt) < AUTO_OPEN_WINDOW_MS) open();
    // Opens once per card on arrival; later renders must not reopen a closed panel.
  }, [id]);
  const listed = card.sheets.slice(0, MAX_LISTED_COMMENTS);
  return (
    // A drawing is an artifact the agent made, so it shares the review comments card's frame
    // rather than reading as tool history.
    <div className={`${ARTIFACT_CARD} text-sm leading-relaxed`} data-testid="cad-part-drawing-card">
      <div className="flex min-h-7 items-center gap-1.5 px-0.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-(--accent-text)">
          <PartDrawingIcon className="size-4 shrink-0" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-foreground">
          {card.sheets.length === 1
            ? `Part drawing: ${card.title}`
            : `${card.sheets.length} part drawings: ${card.title}`}
        </span>
        <button type="button" className={ARTIFACT_ACTION} onClick={open}>
          Open drawing
        </button>
      </div>
      {/* Mirrored or reworked parts can share a name, so a row's place is its key. */}
      {listed.map((sheet, index) => (
        <button
          key={index}
          type="button"
          className="flex w-full items-baseline gap-2 rounded-md py-0.5 pr-0.5 pl-[30px] text-left hover:bg-accent/20"
          onClick={open}
        >
          <span className="shrink-0 tabular-nums text-secondary-label">{sheet.qty}×</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{sheet.name}</span>
          {sheet.material && (
            <span className="shrink-0 text-xs text-secondary-label">{sheet.material}</span>
          )}
        </button>
      ))}
      {card.sheets.length > listed.length && (
        <p className="pl-[30px] text-xs text-secondary-label">
          +{card.sheets.length - listed.length} more
        </p>
      )}
      {card.skipped && (
        <p className="pl-[30px] text-xs text-secondary-label">
          Not drawn:{" "}
          {[
            card.skipped.cnc
              ? `${card.skipped.cnc} plate${card.skipped.cnc === 1 ? "" : "s"} for the router`
              : null,
            card.skipped.print
              ? `${card.skipped.print} printed part${card.skipped.print === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(", ")}
        </p>
      )}
    </div>
  );
}
