import { useEffect, useState } from "react";

/**
 * True while `shown`, and for `lingerMs` after it turns false, so a view can stay mounted
 * through its exit animation and then go away.
 */
export function useLingeringPresence(shown: boolean, lingerMs: number): boolean {
  const [present, setPresent] = useState(shown);
  if (shown && !present) setPresent(true);
  useEffect(() => {
    if (shown) return;
    const timeout = setTimeout(() => setPresent(false), lingerMs);
    return () => clearTimeout(timeout);
  }, [shown, lingerMs]);
  return shown || present;
}
