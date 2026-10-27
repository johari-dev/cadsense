/** Height of one parts tree row in px. The tree is virtualized on this fixed height. */
export const CAD_HIERARCHY_ROW_HEIGHT = 28;

/** The slice of rows to render for a scroll position, with overscan above and below. */
export function cadHierarchyWindow(scrollTop: number, viewportHeight: number, rowCount: number) {
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / CAD_HIERARCHY_ROW_HEIGHT) + 1;
  const start = Math.max(
    0,
    Math.min(Math.floor(scrollTop / CAD_HIERARCHY_ROW_HEIGHT) - 6, rowCount - visibleRows),
  );
  return { start, end: Math.min(rowCount, start + visibleRows + 12) };
}
