import { useEffect, useState } from "react";

import { CircleNotchIcon as LoaderCircleIcon } from "~/lib/icons";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";

/** How long a resync of messages already on screen runs before its drawer shows. */
const SYNCING_DRAWER_DELAY_MS = 600;

/**
 * The sync phase the composer should show. "Loading" (no messages yet) shows at once. A resync
 * of messages already on screen runs each time the tab becomes visible again and usually settles
 * in well under a second; showing it at once flashed the drawer, which grew the composer overlay
 * and scrolled the transcript. So it only shows once it has run for SYNCING_DRAWER_DELAY_MS.
 */
export function useShownThreadSyncPhase(phase: ThreadSyncPhase | null): ThreadSyncPhase | null {
  const [slowSync, setSlowSync] = useState(false);
  useEffect(() => {
    if (phase !== "syncing") {
      setSlowSync(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowSync(true), SYNCING_DRAWER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return phase === "syncing" && !slowSync ? null : phase;
}

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const label = threadSyncLabel(phase);

  return (
    <div
      aria-label={label}
      className="chat-composer-drawer-surface chat-composer-drawer-attached chat-composer-drawer-slot pointer-events-none flex items-center gap-2 px-3 pt-2 pb-[calc(var(--chat-composer-attachment-overlap)_+_0.375rem)] text-foreground text-xs font-medium sm:px-4"
      data-thread-sync-drawer="true"
      role="status"
    >
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}
