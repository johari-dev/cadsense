/** Parts tree row heights in px: a name alone, or a name with a muted detail line under it. */
export const CAD_HIERARCHY_ROW_HEIGHT = 32;
export const CAD_HIERARCHY_DETAIL_ROW_HEIGHT = 44;
const OVERSCAN = 6;

/** The last row whose top is at or above `y`. `offsets` holds each row's top, then the total. */
function rowAt(offsets: readonly number[], y: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The slice of rows to render for a scroll position, with overscan above and below.
 * `offsets[i]` is row i's top in px and the last entry is the list's total height, so rows can
 * differ in height.
 */
export function cadHierarchyWindow(
  scrollTop: number,
  viewportHeight: number,
  offsets: readonly number[],
) {
  const rowCount = Math.max(0, offsets.length - 1);
  // A stale scroll position past the end (the list just shrank) shows the last screen of rows.
  const top = Math.max(0, Math.min(scrollTop, (offsets[rowCount] ?? 0) - viewportHeight));
  const start = Math.max(0, rowAt(offsets, top) - OVERSCAN);
  const end = Math.min(rowCount, rowAt(offsets, top + Math.max(0, viewportHeight)) + 1 + OVERSCAN);
  return { start, end };
}
