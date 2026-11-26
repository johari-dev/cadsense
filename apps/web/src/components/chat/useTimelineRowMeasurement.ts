import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Rows pinned per idle callback; each batch renders this many rows off screen. */
const ROWS_PER_BATCH = 6;

const requestIdle = (callback: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 16);
  return () => window.clearTimeout(handle);
};

/**
 * Measures every timeline row at the current width, a few at a time in idle time.
 *
 * LegendList sizes its scroll area from the last height it measured for each row, guesses the
 * height of rows it has never drawn, and re-measures only the rows on screen when the width
 * changes. So right after a chat opens or the chat column resizes, the scroll length is wrong,
 * and it shifts as each row is scrolled past and measured. `measureAll()` pins the rows through
 * the list's `alwaysRender` in small batches, so each is drawn and measured off screen; the
 * list's own position keeping holds the visible text in place while their heights update.
 *
 * Pass `pinnedKeys` as `alwaysRender.keys`. Call `measureAll()` after a chat opens, after rows
 * are added above the ones already drawn, and once a width change settles.
 */
export function useTimelineRowMeasurement(rows: readonly { readonly id: string }[]) {
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([]);
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const queueRef = useRef<string[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
  }, []);

  const pinNextBatch = useCallback(() => {
    cancelRef.current = requestIdle(() => {
      const current = new Set(rowsRef.current.map((row) => row.id));
      const batch: string[] = [];
      while (batch.length < ROWS_PER_BATCH && queueRef.current.length > 0) {
        const id = queueRef.current.shift();
        // Rows removed since the sweep started need no measuring.
        if (id !== undefined && current.has(id)) batch.push(id);
      }
      setPinnedKeys(batch);
      if (batch.length === 0) {
        cancelRef.current = null;
        return;
      }
      // The list measures pinned rows in the commit's layout effects. Two frames later they
      // have been measured and positioned, and the next batch can replace them.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(pinNextBatch);
      });
      cancelRef.current = () => cancelAnimationFrame(frame);
    });
  }, []);

  const measureAll = useCallback(() => {
    stop();
    queueRef.current = rowsRef.current.map((row) => row.id);
    pinNextBatch();
  }, [pinNextBatch, stop]);

  useEffect(() => stop, [stop]);

  return { pinnedKeys, measureAll };
}
