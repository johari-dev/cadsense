import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { CommandPaletteOpenIntent } from "./CommandPalette.logic";

export function useCommandPaletteQuery(
  threadRouteKey: string | null,
  openIntent: CommandPaletteOpenIntent | null,
  clearOpenIntent: () => void,
) {
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const previousThreadRouteKey = useRef(threadRouteKey);

  useLayoutEffect(() => {
    if (!openIntent) return;
    setQuery(openIntent.kind === "add-project" ? "add project" : "new thread in");
    setHighlightedItemValue(null);
    clearOpenIntent();
  }, [openIntent, clearOpenIntent]);

  useEffect(() => {
    // Mounting the palette must not erase the query supplied by its open intent.
    if (previousThreadRouteKey.current === threadRouteKey) return;
    previousThreadRouteKey.current = threadRouteKey;
    setQuery("");
    setHighlightedItemValue(null);
  }, [threadRouteKey]);

  return { query, setQuery, highlightedItemValue, setHighlightedItemValue };
}
