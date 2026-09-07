import { useCallback, useLayoutEffect, useState } from "react";

/** Retain closing panel content until its finite exit animation completes. */
export function usePanelPresence(open: boolean) {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) setPresent(true);
  }, [open]);
  const onExited = useCallback(() => {
    if (!open) setPresent(false);
  }, [open]);
  return { present: open || present, onExited };
}
