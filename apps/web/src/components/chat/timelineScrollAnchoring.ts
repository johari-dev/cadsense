export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function keepTimelineEndVisibleAfterOverlayGrowth({
  timeline,
  previousOverlayHeight,
  overlayHeight,
  followingEnd,
}: {
  readonly timeline: { scrollToEnd: (options: { animated: boolean }) => unknown } | null;
  readonly previousOverlayHeight: number;
  readonly overlayHeight: number;
  readonly followingEnd: boolean;
}): void {
  if (timeline && followingEnd && overlayHeight > previousOverlayHeight) {
    void timeline.scrollToEnd({ animated: false });
  }
}

/** How long after the last width change the timeline keeps the follow decision from before it. */
export const TIMELINE_REFLOW_SETTLE_MS = 200;

/** Width-change tracking for one timeline; see observeTimelineReflow. */
export interface TimelineReflow {
  /** A width change is still settling: scroll positions come from the reflow, not the user. */
  readonly isSettling: () => boolean;
  /** Settling and the timeline was following the end, so it is pinned there every frame. */
  readonly pinningEnd: () => boolean;
  readonly dispose: () => void;
}

/**
 * Keeps the timeline's place while its width changes: the sidebar or right panel opening or
 * closing, or a window resize. A new width re-wraps every row, and the list cannot judge
 * "at the end" from the result: its end-follow gives up once rows grow past a tenth of the
 * viewport in one step, its position keeper holds the top row instead, and the scroll
 * events the re-measure fires look like user scrolls. So until TIMELINE_REFLOW_SETTLE_MS
 * after the last width change, the decision from before the change stands. A timeline that
 * was following the end is pinned to it in the same frame as each change and every frame
 * after, and `isSettling()` tells the scroll handler to ignore at-end changes the reflow
 * causes.
 */
export function observeTimelineReflow(
  element: Element,
  options: { readonly followingEnd: () => boolean; readonly pinToEnd: () => void },
): TimelineReflow {
  let width = element.getBoundingClientRect().width;
  let settling: { readonly followingEnd: boolean; readonly until: number } | null = null;
  let frame = 0;
  const pin = () => {
    frame = 0;
    if (!settling) return;
    if (performance.now() >= settling.until) {
      settling = null;
      return;
    }
    if (settling.followingEnd) options.pinToEnd();
    frame = requestAnimationFrame(pin);
  };
  const observer = new ResizeObserver(([entry]) => {
    if (!entry || entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    settling = {
      // Each frame of an animated resize extends the window; the first frame's decision holds.
      followingEnd: settling?.followingEnd ?? options.followingEnd(),
      until: performance.now() + TIMELINE_REFLOW_SETTLE_MS,
    };
    cancelAnimationFrame(frame);
    pin();
  });
  observer.observe(element);
  return {
    isSettling: () => settling !== null,
    pinningEnd: () => settling?.followingEnd === true,
    dispose: () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

/**
 * How far to scroll so the timeline's last row sits where it does at the end, measured from
 * what is on screen: the row's bottom, plus whatever the list renders after its rows (the
 * footer and the composer's end inset), lined up with the viewport's bottom. Mid-resize the
 * list's scroll height is unreliable for a frame (stale, or padded by its own scroll
 * adjustment), so pinning to it can show a half-empty or blank chat. Null when the last row
 * is not rendered.
 */
export function measureTimelineEndOffset(scroller: HTMLElement, lastRowId: string): number | null {
  const lastRow = scroller.querySelector(`[data-timeline-row-id="${CSS.escape(lastRowId)}"]`);
  const content = scroller.firstElementChild;
  if (!lastRow || !content) return null;
  let rowsWrapper: Element | null = lastRow;
  while (rowsWrapper && rowsWrapper.parentElement !== content) {
    rowsWrapper = rowsWrapper.parentElement;
  }
  if (!rowsWrapper) return null;
  let afterRows = 0;
  for (let next = rowsWrapper.nextElementSibling; next; next = next.nextElementSibling) {
    afterRows += next.getBoundingClientRect().height;
  }
  return (
    lastRow.getBoundingClientRect().bottom + afterRows - scroller.getBoundingClientRect().bottom
  );
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
