export function cadHierarchyWindow(scrollTop: number, viewportHeight: number, rowCount: number) {
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / 28) + 1;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / 28) - 6, rowCount - visibleRows));
  return { start, end: Math.min(rowCount, start + visibleRows + 12) };
}
