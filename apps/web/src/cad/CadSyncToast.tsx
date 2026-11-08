import {
  CAD_SYNC_STEPS,
  type CadOperationApiCalls,
  type CadOperationProgress,
} from "@cadsense/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

const count = new Intl.NumberFormat();
const calls = (value: number) => `${count.format(value)} API ${value === 1 ? "call" : "calls"}`;

/**
 * What the sync is doing, for the toast. Only the export shows elapsed time: Onshape runs it with
 * no progress to report, and it is the step that can take minutes.
 */
export function cadSyncStepText(progress: CadOperationProgress, elapsedSeconds: number): string {
  const { done, total } = progress;
  switch (progress.step) {
    case "checking":
      return "Checking Onshape for changes.";
    case "reading":
      return "Reading the model's parts and structure.";
    case "exporting":
      return elapsedSeconds < 5
        ? "Onshape is exporting the model."
        : `Onshape is exporting the model. ${elapsedSeconds}s so far.`;
    case "downloading":
      if (total !== undefined)
        return `Downloading part ${Math.min((done ?? 0) + 1, total)} of ${total}.`;
      return done
        ? `Downloading the export. ${(done / 1024 ** 2).toFixed(1)} MB so far.`
        : "Downloading the export.";
    case "building":
      return total === undefined
        ? "Building part geometry."
        : `Building part geometry, ${count.format(done ?? 0)} of ${count.format(total)}.`;
    case "saving":
      return "Saving the model.";
  }
}

/** Calls left of the connection's yearly limit, never below zero. */
export function cadSyncRemainingText({ usage }: CadOperationApiCalls): string {
  return `${count.format(Math.max(0, usage.limit - usage.used))} remaining this year`;
}

function ToastFooter({ start, end }: { start: ReactNode; end: ReactNode }) {
  return (
    <span className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
      <span>{start}</span>
      <span>{end}</span>
    </span>
  );
}

/** Seconds since `since`, updated each second while `ticking`. */
function useElapsedSeconds(since: string, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [since, ticking]);
  return Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
}

/**
 * The running sync's toast description: the step, one bar per step, and with `showApiCalls` the
 * Onshape API calls it used so far.
 */
export function CadSyncProgressDescription({
  progress,
  showApiCalls,
}: {
  progress: CadOperationProgress;
  showApiCalls: boolean;
}) {
  const elapsed = useElapsedSeconds(progress.stepStartedAt, progress.step === "exporting");
  const index = CAD_SYNC_STEPS.indexOf(progress.step);
  return (
    <span className="block">
      <span className="block">{cadSyncStepText(progress, elapsed)}</span>
      <span className="mt-2 flex gap-[3px]" aria-hidden>
        {CAD_SYNC_STEPS.map((step, position) => (
          <span
            key={step}
            className={cn(
              "h-[3px] flex-1 rounded-full",
              position < index
                ? "bg-muted-foreground/70"
                : position === index
                  ? "bg-foreground"
                  : "bg-muted",
            )}
          />
        ))}
      </span>
      <ToastFooter
        start={`Step ${index + 1} of ${CAD_SYNC_STEPS.length}`}
        end={showApiCalls ? calls(progress.apiCalls) : null}
      />
    </span>
  );
}

/**
 * A finished sync's toast description: what happened, then the connection's remaining yearly
 * calls, and with `showApiCalls` the calls this sync used.
 */
export function CadSyncOutcomeDescription({
  text,
  apiCalls,
  showApiCalls,
}: {
  text: string | null;
  apiCalls: CadOperationApiCalls;
  showApiCalls: boolean;
}) {
  return (
    <span className="block">
      {text ? <span className="block">{text}</span> : null}
      <ToastFooter
        start={showApiCalls ? calls(apiCalls.calls) : null}
        end={cadSyncRemainingText(apiCalls)}
      />
    </span>
  );
}

/** The same for an error toast, as text so it keeps its copy button. */
export function cadSyncFailureText(
  reason: string,
  apiCalls: CadOperationApiCalls | undefined,
  showApiCalls: boolean,
): string {
  if (!apiCalls) return reason;
  const used = showApiCalls ? `Used ${calls(apiCalls.calls)}. ` : "";
  return `${reason} ${used}${cadSyncRemainingText(apiCalls)}.`;
}
