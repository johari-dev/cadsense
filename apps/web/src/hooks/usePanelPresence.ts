import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Retain closing panel content until its finite exit animation completes.
 *
 * `animate` says whether the latest open change should slide. Only a change within one
 * `context` (such as a chat) slides. A panel that is already open when the view mounts, or that
 * opens or closes because `context` changed, snaps instead.
 */
export function usePanelPresence(open: boolean, context: string | null = null) {
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState({ open, context, animate: false });
  let current = shown;
  if (shown.open !== open || shown.context !== context) {
    current = { open, context, animate: shown.context === context };
    setShown(current);
  }
  useLayoutEffect(() => {
    if (open) setPresent(true);
  }, [open]);
  const onExited = useCallback(() => {
    if (!open) setPresent(false);
  }, [open]);
  return { present: open || present, onExited, animate: current.animate };
}
