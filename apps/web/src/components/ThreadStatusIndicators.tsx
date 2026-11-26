import { useCallback } from "react";
import { cn } from "../lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MOTION_CLASS = {
  pulse: "animate-status-pulse",
  shake: "animate-status-shake",
} as const satisfies Record<NonNullable<ThreadStatusPill["motion"]>, string>;

/**
 * A status's dot, sized by `className`: it pulses while the agent works and shakes while the
 * agent waits on the user. Reduced-motion users get a still dot. Every dot with the same motion
 * runs in phase, however late it mounted.
 */
export function ThreadStatusDot({
  status,
  className,
}: {
  status: ThreadStatusPill;
  className: string;
}) {
  // A CSS animation starts when its element mounts, so a dot that appears later (a new chat,
  // "Show more") would run out of step. Starting each one at the document timeline's origin
  // puts all same-length animations in phase. Keyed on motion: a new motion is a new animation.
  const syncToTimeline = useCallback(
    (element: HTMLSpanElement | null) => {
      for (const animation of element?.getAnimations() ?? []) animation.startTime = 0;
    },
    [status.motion],
  );
  return (
    <span
      ref={syncToTimeline}
      className={cn(
        "rounded-full motion-reduce:animate-none",
        className,
        status.dotClass,
        status.motion && MOTION_CLASS[status.motion],
      )}
    />
  );
}

/** A status dot with its label in a tooltip, for rows that summarize hidden threads. */
export function ThreadStatusLabel({ status }: { status: ThreadStatusPill }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
          />
        }
      >
        <ThreadStatusDot status={status} className="size-[9px]" />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}
