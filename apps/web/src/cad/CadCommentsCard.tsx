import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CAD_COMMENT_SEVERITIES,
  type CadComment,
  type CadCommentsCatalog,
  type CadCommentSeverity,
  type CadSnapshotManifest,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import { newCommandId } from "../lib/utils";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import {
  ChatIcon as MessageSquare,
  ChatCircleIcon,
  XIcon as X,
  CrosshairIcon as LocateFixed,
  CheckIcon as Check,
  ArrowCounterClockwiseIcon as RotateCcw,
  StackIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  EyeIcon,
  InfoIcon,
  ProhibitIcon,
  QuestionIcon,
  WarningCircleIcon,
  WarningIcon,
  WarningOctagonIcon,
  type Icon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  COMMENT_FOCUS_AGENT_VIEW,
  COMMENT_FOCUS_FAILURES,
  COMMENT_FOCUS_UNAVAILABLE,
} from "./cadCommentFocus";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useAtomCommand } from "../state/use-atom-command";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import type { CadCommentLocation } from "./cadCommentReviewStore";
import {
  CAD_COMMENT_PIN_SIZE,
  groupOverlappingCommentPins,
  type CadCommentScreenPin,
} from "./CadCommentGeometry";
import { useDiscussCadComment } from "./useDiscussCadComment";

/** How long the card animates when it opens or closes; matches the transitions in CadPanel.css. */
const CARD_ANIMATION_MS = 240;
/** Plain wording for why a newer model revision invalidated a comment's targets. */
const OUTDATED_REASONS: Record<NonNullable<CadComment["outdated"]>["reason"], string> = {
  removed: "part removed",
  moved: "part moved",
  "geometry-changed": "geometry changed",
};
/** The location of `comment` to focus: "all" means its only location when it has just one. */
const locationOf = (comment: CadComment, target: CadCommentLocation): CadCommentLocation =>
  target === "all" && comment.targets.length === 1 ? 0 : target;
/** Open findings sort from most to least consequential; comments without a severity sort last. */
const severityRank = (comment: CadComment) =>
  comment.severity === null
    ? CAD_COMMENT_SEVERITIES.length
    : CAD_COMMENT_SEVERITIES.indexOf(comment.severity);
/** A pin's label: the comment number, plus a letter per location when it has several. */
const pinLabel = (comment: CadComment, target: number) =>
  `${comment.number}${comment.targets.length > 1 ? String.fromCharCode(97 + target) : ""}`;
/** A pin's width without measuring it: round up to two characters, a pill beyond that. */
const pinWidth = (label: string) =>
  label.length <= 2 ? CAD_COMMENT_PIN_SIZE : 12 + 7 * label.length;
/** Shape, placement and type shared by comment pins and group count markers. */
const PIN_SHAPE =
  "pointer-events-auto absolute flex h-5.5 min-w-5.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-[11px] leading-none font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** A single finding's pin. Yellow marks a finding ID here and in CommentBadge, nowhere else. */
const PIN_CLASS = `${PIN_SHAPE} border-[1.5px] border-neutral-950/80 bg-amber-200 px-1.5 text-neutral-950 shadow-[0_1px_3px_rgb(0_0_0/0.45)]`;
/** A group's count marker: a neutral surface, so it never reads as a finding ID. */
const PIN_GROUP_CLASS = `${PIN_SHAPE} gap-1 border border-foreground/25 bg-popover ps-1.5 pe-2 text-foreground shadow-[0_1px_4px_rgb(0_0_0/0.6)]`;
/**
 * Width of the open comments card in CSS px, kept in step with CadPanel.css. The card sits
 * 12px from the viewport's right edge, so framing that avoids it reserves this plus 12px.
 */
export const CAD_COMMENTS_CARD_WIDTH = 328;
export interface CadCommentSelection {
  id: string;
  target: CadCommentLocation;
  request: number;
}
export interface CadCommentsCardProps {
  threadRef: ScopedThreadRef;
  comments: readonly CadComment[];
  /** Agent captures behind point targets, replayed when a point is selected. */
  captureViews: CadCommentsCatalog["captureViews"];
  manifest: CadSnapshotManifest | null;
  displayedSnapshotId: string;
  renderer: RefObject<CadSceneRenderer | null>;
  open: boolean;
  setOpen: (open: boolean) => void;
  selection: CadCommentSelection | null;
  clearSelection: (id?: string) => void;
  choose: (comment: CadComment, target: CadCommentLocation) => void;
  historical: boolean;
  back: () => void;
  /** True in the picture-in-picture preview, where the open card can cover the composer. */
  floating?: boolean;
}
export function CadCommentsCard({
  threadRef,
  comments,
  captureViews,
  manifest,
  displayedSnapshotId,
  renderer,
  open,
  setOpen,
  selection,
  clearSelection,
  choose,
  historical,
  back,
  floating = false,
}: CadCommentsCardProps) {
  const [filter, setFilter] = useState<"open" | "reviewed" | "history">(
    historical ? "history" : "open",
  );
  // How the selected location was framed (shown as an icon on its chip), and the outcome of
  // the last resolve/dismiss/reopen. Successes clear themselves; failures stay until closed.
  const [focusNotice, setFocusNotice] = useState("");
  const [reviewNotice, setReviewNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [pendingReviews, setPendingReviews] = useState<ReadonlySet<string>>(new Set());
  // The comment whose Dismiss control is showing its reason input, and the draft reason.
  const [dismissing, setDismissing] = useState<{ id: string; reason: string } | null>(null);
  const inFlightReviews = useRef(new Set<string>());
  const [layoutVersion, setLayoutVersion] = useState(0);
  // The pin group fanned out around its count marker, by the key of its first pin.
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The card animates whenever `open` changes. `settledOpen` is the state it last finished
  // animating to, so the open panel stays mounted until a close has played out.
  const [settledOpen, setSettledOpen] = useState(open);
  const settling = settledOpen !== open;
  useEffect(() => {
    if (!settling) return;
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setSettledOpen(open), reducedMotion ? 0 : CARD_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [open, settling]);
  const settlingRef = useRef(settling);
  useEffect(() => {
    settlingRef.current = settling;
  }, [settling]);
  const card = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    markers = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null);
  // Selection and free area of the last focus, so re-renders never re-run an unchanged focus.
  const lastFocus = useRef("");
  /**
   * The part of the viewport the card leaves free, where a focused comment is framed. The
   * open card's content already has its final width and right edge while the card animates,
   * so this stays put through the opening animation instead of changing every frame.
   */
  const focusArea = () => {
    if (!host.current) return null;
    const bounds = host.current.getBoundingClientRect();
    // Layout sizes, not the content's box: its open animation scales it slightly, and the
    // card's right edge never moves.
    const cardBox = card.current?.getBoundingClientRect();
    const occupied = cardBox && {
      left: cardBox.right - (content.current?.offsetWidth ?? cardBox.width),
      bottom: cardBox.top + (content.current?.offsetHeight ?? cardBox.height),
    };
    const width = occupied ? Math.max(120, occupied.left - bounds.left - 16) : bounds.width;
    const below = occupied !== undefined && width < 240;
    const belowTop = occupied ? occupied.bottom - bounds.top + 16 : 0;
    const height = below ? Math.max(120, bounds.height - belowTop) : bounds.height;
    const areaWidth = below ? bounds.width : width;
    return {
      width: Math.round(areaWidth),
      height: Math.round(height),
      centerX: Math.round(areaWidth / 2),
      centerY: Math.round((below ? belowTop : 0) + height / 2),
    };
  };
  const review = useAtomCommand(cadPanelEnvironment.review, { reportFailure: false });
  const discussComment = useDiscussCadComment(threadRef);
  const descriptor = useMemo(
    () => (manifest ? cadCommentModelDescriptor(manifest) : null),
    [manifest],
  );
  const displayed = comments.filter((c) =>
    descriptor ? c.modelDescriptor === descriptor : c.snapshotId === displayedSnapshotId,
  );
  const selected = comments.find((c) => c.id === selection?.id);
  const openComments = displayed.filter((c) => c.state === "open");
  const openCount = openComments.length;
  const blockerCount = openComments.filter((c) => c.severity === "blocker").length;
  const toggleLabel = `Comments (${openCount} unresolved${blockerCount ? `, ${blockerCount} blocking` : ""})`;
  const lists = {
    // Open findings group by severity, most consequential first; headings name each group.
    open: openComments.sort((a, b) => severityRank(a) - severityRank(b) || a.number - b.number),
    reviewed: displayed.filter((c) => c.state !== "open"),
    history: comments.filter((c) => c.modelDescriptor !== descriptor || historical),
  };
  const visible = lists[filter];
  /**
   * Collapsed, the toggle is a chip like the view changes chip across the viewport: the icon
   * and the open count. Its width follows the count's digits (`ch`, with tabular numerals).
   */
  const toggleWidth = openCount
    ? `calc(var(--cad-overlay-control) + 0.75rem + ${String(openCount).length}ch)`
    : "var(--cad-overlay-control)";
  useEffect(() => {
    if (historical) setFilter("history");
  }, [historical]);
  useEffect(() => {
    if (selected)
      setFilter(
        selected.modelDescriptor !== descriptor || historical
          ? "history"
          : selected.state === "open"
            ? "open"
            : "reviewed",
      );
  }, [selection?.id, descriptor, historical]);
  useEffect(() => {
    if (!open) {
      renderer.current?.endCommentReview();
      lastFocus.current = "";
      setFocusNotice("");
      setReviewNotice(null);
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, renderer, setOpen]);
  useEffect(() => {
    // Leaving a focus (clicking empty space, resolving) eases back to the pre-focus camera.
    if (open && !selection)
      renderer.current?.endCommentReview({
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
  }, [open, selection, renderer]);
  useEffect(() => {
    if (!open || !host.current || !card.current) return;
    // Re-frame only when the free area really changes (a panel resize, a narrow layout's card
    // growing), never for every frame of the card's own animation.
    let area = JSON.stringify(focusArea());
    const observer = new ResizeObserver(() => {
      if (settlingRef.current) return;
      const next = JSON.stringify(focusArea());
      if (next !== area) {
        area = next;
        setLayoutVersion((v) => v + 1);
      }
    });
    observer.observe(host.current);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (
      !open ||
      !selection ||
      !selected ||
      selected.modelDescriptor !== descriptor ||
      !host.current
    )
      return;
    const area = focusArea();
    const location = locationOf(selected, selection.target);
    const target = location === "all" ? null : selected.targets[location];
    if (!area || target === undefined) return;
    const key = JSON.stringify([selection, descriptor, area]);
    if (key === lastFocus.current) return;
    lastFocus.current = key;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A comment with several locations opens on one view framing all of them.
    const notice =
      target === null
        ? renderer.current?.focusCommentTargets(selected.targets, area, reducedMotion)
        : renderer.current?.focusComment(
            target,
            area,
            reducedMotion,
            target.kind === "point" ? captureViews[target.captureId] : undefined,
          );
    setFocusNotice(notice ?? COMMENT_FOCUS_UNAVAILABLE);
    card.current?.querySelector('[aria-expanded="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selection, descriptor, open, layoutVersion, settling]);
  useEffect(() => {
    let frame = 0;
    const current = renderer.current;
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const place = (element: HTMLElement, x: number, y: number) => {
      element.style.visibility = "visible";
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    };
    const draw = () => {
      frame = 0;
      const root = markers.current;
      if (!root) return;
      // Read every projection first, then group pins that would pile up on screen.
      const pins: Array<CadCommentScreenPin & { element: HTMLElement; label: string }> = [];
      root.querySelectorAll<HTMLElement>("[data-comment]").forEach((element) => {
        const comment = byId.get(element.dataset.comment ?? "");
        const shown =
          manifest &&
          comment &&
          (comment.state === "open" ||
            (open && filter === "reviewed" && comment.id === selection?.id));
        const target = shown ? comment.targets[Number(element.dataset.target)] : null;
        const point = target ? current?.commentProjection(target) : null;
        if (!comment || !point?.visible) {
          element.style.visibility = "hidden";
          return;
        }
        const label = pinLabel(comment, Number(element.dataset.target));
        pins.push({
          element,
          label,
          x: point.x,
          y: point.y,
          width: pinWidth(label),
          pinned: open && comment.id === selection?.id,
        });
      });
      const counters = new Map<string, HTMLElement>();
      root.querySelectorAll<HTMLElement>("[data-pin-group]").forEach((element) => {
        counters.set(element.dataset.pinGroup ?? "", element);
        element.style.visibility = "hidden";
      });
      for (const indices of groupOverlappingCommentPins(pins)) {
        const group = indices.map((i) => pins[i]!);
        const head = group[0]!;
        if (group.length === 1) {
          place(head.element, head.x, head.y);
          head.element.style.zIndex = "";
          continue;
        }
        // A group shows one count marker at its centre, owned by its first pin. Expanded, its
        // pins fan out around that marker; collapsed, they hide behind it.
        const cx = group.reduce((sum, pin) => sum + pin.x, 0) / group.length;
        const cy = group.reduce((sum, pin) => sum + pin.y, 0) / group.length;
        const key = head.element.dataset.pinKey ?? "";
        const counter = counters.get(key);
        if (counter) {
          place(counter, cx, cy);
          counter.dataset.count = String(group.length);
          counter.setAttribute("aria-expanded", String(expandedGroup === key));
          counter.setAttribute(
            "aria-label",
            `${group.length} comments here: ${group.map((pin) => pin.label).join(", ")}`,
          );
        }
        if (expandedGroup !== key) {
          group.forEach((pin) => (pin.element.style.visibility = "hidden"));
          continue;
        }
        // Each pin gets a share of the ring as wide as itself plus a gap, starting at the top,
        // so wide pills never crowd their neighbours.
        const arcs = group.map((pin) => pin.width + 8);
        const circumference = arcs.reduce((sum, arc) => sum + arc, 0);
        const radius = Math.max(CAD_COMMENT_PIN_SIZE + 6, circumference / (2 * Math.PI));
        let along = -arcs[0]! / 2;
        group.forEach((pin, i) => {
          along += arcs[i]! / 2;
          const angle = -Math.PI / 2 + (2 * Math.PI * along) / circumference;
          along += arcs[i]! / 2;
          place(pin.element, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
          pin.element.style.zIndex = "20";
        });
      }
    };
    // Project once after layout, then after renders in the same frame they were drawn:
    // deferring to the next animation frame paints markers one frame behind the model, which
    // shows as markers jumping away from their parts on a resize or orbit. A microtask still
    // runs before the browser paints and coalesces several renders into one update.
    // Projection runs on every pan/orbit frame, so it must stay cheap: no scene raycasts here.
    let queued = false;
    let active = true;
    frame = requestAnimationFrame(draw);
    const unsubscribe = current?.subscribeFrames(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!active) return;
        cancelAnimationFrame(frame);
        draw();
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
      cancelAnimationFrame(frame);
    };
  }, [comments, manifest, renderer, open, filter, selection?.id, expandedGroup]);
  useEffect(() => () => clearTimeout(collapseTimer.current), []);
  // A group stays expanded while the pointer is over its marker or any of its pins; leaving
  // them all collapses it after a short grace period, so moving between them never flickers.
  const holdGroup = (key?: string) => {
    clearTimeout(collapseTimer.current);
    if (key !== undefined) setExpandedGroup(key);
  };
  const releaseGroup = () => {
    clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setExpandedGroup(null), 300);
  };
  const change = async (c: CadComment, state: CadComment["state"], reason = "") => {
    // Guard synchronously as two clicks can arrive before React disables the controls.
    if (inFlightReviews.current.has(c.id)) return;
    inFlightReviews.current.add(c.id);
    setPendingReviews(new Set(inFlightReviews.current));
    setReviewNotice(null);
    const trimmed = reason.trim();
    try {
      const result = await review({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          commentId: c.id,
          expectedVersion: c.version,
          state,
          ...(trimmed ? { reason: trimmed } : {}),
          commandId: newCommandId(),
        },
      });
      if (result._tag !== "Failure") setDismissing((d) => (d?.id === c.id ? null : d));
      if (result._tag !== "Failure" && state !== "open") clearSelection(c.id);
      setReviewNotice(
        result._tag === "Failure"
          ? {
              text: "Could not update this finding. Reload its latest review state and try again.",
              failed: true,
            }
          : { text: `Comment ${c.number} ${state}.`, failed: false },
      );
    } finally {
      inFlightReviews.current.delete(c.id);
      setPendingReviews(new Set(inFlightReviews.current));
    }
  };
  useEffect(() => {
    if (!reviewNotice || reviewNotice.failed) return;
    const timer = setTimeout(() => setReviewNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [reviewNotice]);
  const discuss = (c: CadComment) => {
    discussComment(c);
    if (floating) setOpen(false);
  };
  return (
    <div
      ref={host}
      className="pointer-events-none absolute inset-0 z-20"
      style={{ containerType: "inline-size" }}
    >
      <div ref={markers} className="absolute inset-0 overflow-hidden">
        {displayed
          .filter(
            (c) =>
              manifest &&
              (c.state === "open" || (open && filter === "reviewed" && c.id === selection?.id)),
          )
          // By number, so a group's count marker belongs to its lowest-numbered pin.
          .sort((a, b) => a.number - b.number)
          .flatMap((c) =>
            c.targets.map((t, i) => {
              const key = `${c.id}:${i}`;
              const focused = open && c.id === selection?.id;
              // While a comment is focused, the others step back but return on hover.
              const dimmed = open && selection !== null && !focused;
              return (
                <Fragment key={key}>
                  <button
                    type="button"
                    data-comment={c.id}
                    data-target={i}
                    data-pin-key={key}
                    style={{ visibility: "hidden" }}
                    aria-label={`Comment ${c.number}: ${t.label}`}
                    onClick={() => {
                      setExpandedGroup(null);
                      choose(c, i);
                    }}
                    onPointerEnter={() => holdGroup()}
                    onPointerLeave={releaseGroup}
                    className={cn(
                      PIN_CLASS,
                      "transition-[opacity,scale] duration-150",
                      // A white ring, then a dark one that separates it from light geometry.
                      focused &&
                        "z-10 scale-[1.18] shadow-[0_0_0_2px_var(--color-white),0_0_0_3.5px_rgb(10_10_10/0.85)]",
                      dimmed && "opacity-70 hover:opacity-100",
                    )}
                  >
                    {pinLabel(c, i)}
                  </button>
                  <button
                    type="button"
                    data-pin-group={key}
                    style={{ visibility: "hidden" }}
                    onClick={() => setExpandedGroup((g) => (g === key ? null : key))}
                    onPointerEnter={() => holdGroup(key)}
                    onPointerLeave={releaseGroup}
                    className={cn(
                      PIN_GROUP_CLASS,
                      "after:content-[attr(data-count)]",
                      dimmed && "opacity-70 hover:opacity-100",
                    )}
                  >
                    <StackIcon aria-hidden className="size-3 text-muted-foreground" />
                  </button>
                </Fragment>
              );
            }),
          )}
      </div>
      {historical && (
        <div className="pointer-events-auto absolute left-3 top-3 flex max-w-[calc(100%-72px)] items-center gap-2 rounded-md border bg-popover px-2 py-1 text-xs">
          <span className="min-w-0 truncate">Previous CAD revision</span>
          <Button size="compact" variant="outline" className="shrink-0" onClick={back}>
            Back to current
          </Button>
        </div>
      )}
      <div
        ref={card}
        data-comments-surface
        data-open={open}
        data-closing={!open && settling}
        data-historical={historical}
        // Collapsed, the surface is as wide as the toggle chip; open, CadPanel.css sizes it.
        style={open ? undefined : { width: toggleWidth }}
        className="cad-comments-surface pointer-events-auto absolute right-3 top-3 rounded-lg border bg-popover text-xs text-popover-foreground shadow-lg"
      >
        {!open && (
          // Collapsed, the surface itself is the toggle: this button fills its inside edge to
          // edge with the same rounding, so hover lights up the one shape that then grows into
          // the card. It stays pinned to the corner while the card shrinks back into it.
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={toggleLabel}
                  aria-expanded={false}
                  onClick={() => setOpen(true)}
                  style={{ width: `calc(${toggleWidth} - 2px)` }}
                  className="absolute inset-y-0 right-0 flex cursor-pointer items-center justify-center gap-1.5 rounded-[calc(var(--radius-lg)-1px)] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <MessageSquare aria-hidden className="size-4 shrink-0" />
              {openCount > 0 && <span className="tabular-nums">{openCount}</span>}
            </TooltipTrigger>
            <TooltipPopup side="left">{toggleLabel}</TooltipPopup>
          </Tooltip>
        )}
        {(open || settling) && (
          <div
            ref={content}
            aria-label="CAD comments"
            inert={!open}
            className="cad-comments-content flex flex-col"
          >
            {/* Labelled tabs and a close button, laid out like the view changes card. */}
            <div className="flex shrink-0 items-center gap-0.5 border-b ps-1.5 pe-1.5 pt-1.5 pb-[7px]">
              <div role="group" aria-label="Show comments" className="flex items-center gap-0.5">
                {COMMENT_FILTERS.map(({ id, label, tooltip }) => (
                  <Tooltip key={id}>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-pressed={filter === id}
                          onClick={() => setFilter(id)}
                          className={cn(
                            "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                            filter === id &&
                              "text-foreground after:absolute after:inset-x-2 after:-bottom-[7px] after:h-0.5 after:rounded-full after:bg-foreground",
                          )}
                        />
                      }
                    >
                      {label}
                      {lists[id].length > 0 && (
                        <span className="tabular-nums text-muted-foreground">
                          {lists[id].length}
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{tooltip}</TooltipPopup>
                  </Tooltip>
                ))}
              </div>
              <span className="flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Close comments"
                onClick={() => setOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            {reviewNotice && (
              <div
                role="status"
                className={cn(
                  "flex shrink-0 items-center gap-2 border-b ps-3 pe-1.5 py-1 text-xs",
                  reviewNotice.failed ? "text-destructive-foreground" : "text-muted-foreground",
                )}
              >
                <span className="min-w-0 flex-1">{reviewNotice.text}</span>
                {reviewNotice.failed && (
                  <IconAction
                    label="Close message"
                    icon={<X />}
                    onClick={() => setReviewNotice(null)}
                  />
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {visible.length ? (
                visible.flatMap((c, index) => {
                  const location = selection?.id === c.id ? locationOf(c, selection.target) : null;
                  const expanded = location !== null;
                  const previousRevision = c.modelDescriptor !== descriptor;
                  const outdated = c.outdated
                    ? `Outdated: ${OUTDATED_REASONS[c.outdated.reason]} in a newer revision`
                    : null;
                  const heading =
                    filter === "open" && visible[index - 1]?.severity !== c.severity ? (
                      <h3
                        key={`severity:${c.severity}`}
                        className="flex gap-1.5 px-2 pt-2 pb-1 text-[11px] font-normal text-muted-foreground"
                      >
                        {c.severity === null ? "Other" : SEVERITY_GROUPS[c.severity]}
                        <span className="tabular-nums">
                          {visible.filter((x) => x.severity === c.severity).length}
                        </span>
                      </h3>
                    ) : null;
                  const row = (
                    <article
                      key={c.id}
                      className={cn(
                        "rounded-md text-xs",
                        expanded ? "bg-foreground/[0.035]" : "hover:bg-foreground/[0.03]",
                      )}
                    >
                      {/* The padding lives on the button so the whole row is clickable. */}
                      <button
                        className="flex w-full cursor-pointer items-start gap-2 px-2 py-1.5 text-left"
                        aria-expanded={expanded}
                        onClick={() => choose(c, "all")}
                      >
                        {/* Fixed slot so one- and two-digit badges keep titles aligned. */}
                        <span className="flex w-5 shrink-0">
                          <CommentBadge number={c.number} reviewed={c.state !== "open"} />
                        </span>
                        <CadSeverityIcon severity={c.severity} category={c.category} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 leading-[18px]",
                            expanded ? "font-semibold" : "line-clamp-2",
                          )}
                        >
                          {c.title}
                        </span>
                        {c.targets.length > 1 && (
                          <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                            <LocateFixed className="size-3" />
                            {c.targets.length}
                          </span>
                        )}
                        {previousRevision && (
                          <RowStatusIcon
                            icon={ClockCounterClockwiseIcon}
                            label="Previous revision"
                          />
                        )}
                        {outdated && (
                          <RowStatusIcon
                            icon={WarningCircleIcon}
                            label={outdated}
                            className="text-warning"
                          />
                        )}
                      </button>
                      {expanded && (
                        <div className="space-y-2.5 pe-2 pb-2 ps-9 pt-0.5">
                          <p className="whitespace-pre-wrap leading-relaxed text-foreground/85">
                            {c.body}
                          </p>
                          {outdated && <p className="text-muted-foreground">{outdated}</p>}
                          {c.link && (
                            <button
                              className="cursor-pointer text-left underline"
                              onClick={() => {
                                const old = comments.find((x) => x.id === c.link?.commentId);
                                if (old) choose(old, 0);
                              }}
                            >
                              {c.link.kind}: {c.link.explanation}
                            </button>
                          )}
                          {comments
                            .filter((x) => x.link?.commentId === c.id)
                            .map((x) => (
                              <button
                                key={x.id}
                                className="block cursor-pointer text-left underline"
                                onClick={() => choose(x, 0)}
                              >
                                See {x.link?.kind}: {x.title}
                              </button>
                            ))}
                          {c.proposal && c.state === "open" && (
                            <p className="whitespace-pre-wrap">
                              Proposed resolution: {c.proposal.explanation}
                            </p>
                          )}
                          {c.state === "dismissed" && c.reviewReason && (
                            <p className="text-muted-foreground">Dismissed: {c.reviewReason}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-1">
                            {c.targets.length > 1 && (
                              <LocationChip
                                label="All locations"
                                icon={StackIcon}
                                selected={location === "all"}
                                notice={location === "all" ? focusNotice : ""}
                                wholePartNote={undefined}
                                onClick={() => choose(c, "all")}
                              />
                            )}
                            {c.targets.map((t, i) => (
                              <LocationChip
                                key={i}
                                label={t.label}
                                selected={location === i}
                                notice={location === i ? focusNotice : ""}
                                wholePartNote={
                                  t.kind === "part" ? t.preciseLocationLimitation : undefined
                                }
                                onClick={() => choose(c, i)}
                              />
                            ))}
                            {c.targets.length > 1 && (
                              <>
                                <IconAction
                                  label="Previous location"
                                  icon={<CaretLeftIcon />}
                                  disabled={location === "all"}
                                  onClick={() =>
                                    choose(
                                      c,
                                      location === "all" || location === 0 ? "all" : location - 1,
                                    )
                                  }
                                />
                                <IconAction
                                  label="Next location"
                                  icon={<CaretRightIcon />}
                                  disabled={location === c.targets.length - 1}
                                  onClick={() => choose(c, location === "all" ? 0 : location + 1)}
                                />
                              </>
                            )}
                          </div>
                          {/* Named review actions on their own row, below the locations. Dismiss
                              is the quieter trailing action. */}
                          {dismissing?.id !== c.id && (
                            <div className="flex items-center gap-1">
                              {c.state === "open" ? (
                                <CardAction
                                  label="Resolve"
                                  tooltip="Mark resolved: the model now addresses this"
                                  icon={<Check />}
                                  emphasis
                                  disabled={pendingReviews.has(c.id)}
                                  onClick={() => void change(c, "resolved")}
                                />
                              ) : (
                                <CardAction
                                  label="Reopen"
                                  icon={<RotateCcw />}
                                  emphasis
                                  disabled={pendingReviews.has(c.id)}
                                  onClick={() => void change(c, "open")}
                                />
                              )}
                              <CardAction
                                label="Discuss"
                                tooltip="Discuss this finding in chat"
                                icon={<ChatCircleIcon />}
                                onClick={() => discuss(c)}
                              />
                              {c.state === "open" && (
                                <span className="ms-auto">
                                  <CardAction
                                    label="Dismiss"
                                    tooltip="Dismiss: no change needed. A reason teaches later reviews."
                                    icon={<ProhibitIcon />}
                                    disabled={pendingReviews.has(c.id)}
                                    onClick={() => setDismissing({ id: c.id, reason: "" })}
                                  />
                                </span>
                              )}
                            </div>
                          )}
                          {c.state === "open" && dismissing?.id === c.id && (
                            <form
                              className="flex min-w-0 gap-1"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void change(c, "dismissed", dismissing.reason);
                              }}
                            >
                              <input
                                autoFocus
                                aria-label="Dismiss reason"
                                className="h-7 min-w-0 flex-1 border-b bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
                                placeholder="Why? (optional, becomes a review learning)"
                                maxLength={500}
                                value={dismissing.reason}
                                disabled={pendingReviews.has(c.id)}
                                onChange={(event) =>
                                  setDismissing({ id: c.id, reason: event.target.value })
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Escape") return;
                                  event.preventDefault();
                                  setDismissing(null);
                                }}
                              />
                              <Button
                                size="compact"
                                variant="ghost"
                                type="submit"
                                disabled={pendingReviews.has(c.id)}
                              >
                                Confirm
                              </Button>
                            </form>
                          )}
                        </div>
                      )}
                    </article>
                  );
                  return heading ? [heading, row] : [row];
                })
              ) : (
                <p className="p-3 text-xs text-muted-foreground">
                  {filter === "open"
                    ? "No open comments. Reviewed findings remain in Reviewed."
                    : "No findings in this group."}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const SEVERITY_CLASS: Record<CadCommentSeverity, string> = {
  blocker: "text-foreground",
  concern: "text-muted-foreground",
  question: "text-muted-foreground",
  nit: "text-muted-foreground/60",
};
/** The severity word ahead of a finding's title. Comments published without one show nothing. */
export function CadSeverityLabel({ severity }: { severity: CadCommentSeverity | null }) {
  return severity === null ? null : (
    <span data-severity={severity} className={`mr-1.5 shrink-0 ${SEVERITY_CLASS[severity]}`}>
      {severity}
    </span>
  );
}

const COMMENT_FILTERS = [
  { id: "open", label: "Open", tooltip: "Open findings on this revision" },
  { id: "reviewed", label: "Reviewed", tooltip: "Resolved and dismissed findings" },
  { id: "history", label: "History", tooltip: "Findings on previous revisions" },
] as const;

/** Headings for the open list's severity groups. */
const SEVERITY_GROUPS: Record<CadCommentSeverity, string> = {
  blocker: "Blockers",
  concern: "Concerns",
  question: "Questions",
  nit: "Nits",
};

/** A small filled dot on the same 24px grid as the other severity icons. */
const NitIcon: Icon = ({ size: _size, weight: _weight, ...props }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <circle cx="12" cy="12" r="4" />
  </svg>
);

const SEVERITY_ICON: Record<CadCommentSeverity, { icon: Icon; className: string }> = {
  blocker: { icon: WarningOctagonIcon, className: "text-destructive-foreground" },
  concern: { icon: WarningIcon, className: "text-warning" },
  question: { icon: QuestionIcon, className: "text-info-foreground" },
  nit: { icon: NitIcon, className: "text-muted-foreground" },
};
const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A finding's severity as a colored icon; the tooltip names the severity and category. */
export function CadSeverityIcon({
  severity,
  category,
}: {
  severity: CadCommentSeverity | null;
  category: string | null;
}) {
  if (severity === null) return null;
  const { icon: SeverityIcon, className } = SEVERITY_ICON[severity];
  const label = [severity, category]
    .filter(Boolean)
    .map((part) => capitalize(part!))
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="mt-px inline-flex shrink-0" />}
      >
        <SeverityIcon className={cn("size-3.5", className)} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A small status mark at the end of a comment row, explained by its tooltip. */
function RowStatusIcon({
  icon: StatusIcon,
  label,
  className,
}: {
  icon: Icon;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="mt-px inline-flex shrink-0" />}
      >
        <StatusIcon className={cn("size-3.5 text-muted-foreground", className)} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A named review action under an expanded finding: an icon and its label, with an optional
 * tooltip explaining the outcome. `emphasis` marks the primary action of the row.
 */
function CardAction(props: {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  emphasis?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const buttonProps = {
    size: "compact",
    variant: props.emphasis ? "outline" : "ghost",
    disabled: props.disabled,
    onClick: props.onClick,
    className: cn("gap-1.5 [&_svg]:mx-0", !props.emphasis && "text-muted-foreground"),
  } as const;
  const content = (
    <>
      {props.icon}
      {props.label}
    </>
  );
  if (!props.tooltip) return <Button {...buttonProps}>{content}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {props.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Icon-only card control. The label is its accessible name and default tooltip. */
function IconAction(props: {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.icon}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {props.tooltip ?? props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One location of a finding. The selected chip shows how the viewer framed it (the agent's
 * view, a ghosted or revealed part, or a failure) as an icon, with the details in its tooltip.
 */
function LocationChip(props: {
  label: string;
  /** Defaults to the crosshair used for a single location. */
  icon?: Icon;
  selected: boolean;
  notice: string;
  wholePartNote: string | undefined;
  onClick: () => void;
}) {
  const NoticeIcon = !props.notice
    ? null
    : props.notice === COMMENT_FOCUS_AGENT_VIEW
      ? EyeIcon
      : COMMENT_FOCUS_FAILURES.has(props.notice)
        ? WarningCircleIcon
        : InfoIcon;
  const details = [props.notice, props.wholePartNote ? `Whole part: ${props.wholePartNote}` : ""]
    .filter(Boolean)
    .join(". ");
  // A bordered chip; the selected one takes the neutral active treatment. The button's negative
  // icon margins are reset so the label never runs into the notice icon.
  const chipProps = {
    size: "compact",
    variant: "outline",
    className: cn(
      "max-w-56 gap-1.5 font-normal [&_svg]:mx-0",
      props.selected && "border-foreground/30 bg-accent dark:bg-accent",
    ),
    onClick: props.onClick,
  } as const;
  const ChipIcon = props.icon ?? LocateFixed;
  const content = (
    <>
      <ChipIcon className="size-3.5 text-muted-foreground" />
      <span className="truncate">{props.label}</span>
      {NoticeIcon && (
        <NoticeIcon
          className={cn(
            "size-3.5",
            COMMENT_FOCUS_FAILURES.has(props.notice) ? "text-warning" : "text-muted-foreground",
          )}
        />
      )}
    </>
  );
  if (!details) return <Button {...chipProps}>{content}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button {...chipProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {details}
      </TooltipPopup>
    </Tooltip>
  );
}

export function CommentBadge({ number, reviewed = false }: { number: number; reviewed?: boolean }) {
  return (
    <span
      data-comment-badge
      className={`inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] leading-none font-semibold tabular-nums ${reviewed ? "bg-muted text-muted-foreground" : "bg-amber-200 text-neutral-950"}`}
    >
      {number}
    </span>
  );
}
