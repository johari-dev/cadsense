import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type StepMarkKind = "done" | "failed" | "waiting" | "pending";

/**
 * A setup step's state as a 16px mark: a check that draws itself in once, a cross, a ring
 * with a dot for "waiting on this" that scales in once, and an empty ring for "not yet". Nothing
 * loops; a waiting step stays still.
 */
export function StepMark({ mark }: { readonly mark: StepMarkKind }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      {mark === "done" ? (
        <svg
          viewBox="0 0 16 16"
          className="onboarding-check size-4 text-foreground"
          aria-label="Done"
        >
          <circle cx="8" cy="8" r="7.25" className="fill-foreground/12" />
          <path
            d="M4.9 8.2l2.1 2.1 4.2-4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
          />
        </svg>
      ) : mark === "failed" ? (
        <XIcon
          className="onboarding-mark-in size-3.5 text-destructive-foreground"
          aria-label="Failed"
        />
      ) : mark === "waiting" ? (
        <span
          className="onboarding-mark-in flex size-3.5 items-center justify-center rounded-full border-[1.5px] border-foreground"
          aria-label="In progress"
        >
          <span className="size-1.5 rounded-full bg-foreground" />
        </span>
      ) : (
        <span className="size-3.5 rounded-full border-[1.5px] border-input" aria-hidden />
      )}
    </span>
  );
}

/**
 * One line inside a step: its mark and its text. The text is keyed by the mark, so a new status
 * (installing to installed, waiting to failed) fades into place instead of cutting.
 */
export function StepRow({
  mark,
  dim = false,
  children,
}: {
  readonly mark: StepMarkKind;
  readonly dim?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3.5 py-3 text-sm transition-opacity duration-300",
        dim && "opacity-45",
      )}
    >
      <StepMark mark={mark} />
      <div key={mark} className="onboarding-swap min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}

/**
 * Three thin segments under the checklist header, one per step, that fill as steps finish. Each
 * fill eases once when its step completes.
 */
export function ChecklistProgress({ done }: { readonly done: ReadonlyArray<boolean> }) {
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={0}
      aria-valuemax={done.length}
      aria-valuenow={done.filter(Boolean).length}
      className="mx-auto mt-2.5 flex w-24 gap-1"
    >
      {done.map((stepDone, index) => (
        // Steps never reorder, so the index is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <span key={index} className="h-[3px] flex-1 overflow-hidden rounded-full bg-foreground/10">
          <span
            className={cn(
              "block h-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
              stepDone ? "scale-x-100" : "scale-x-0",
            )}
          />
        </span>
      ))}
    </div>
  );
}

const FOLD_MS = 320;

/**
 * Expands to its content's height while open and folds to nothing when closed. Content mounts
 * when the fold opens and stays mounted until the fold finishes closing, so it animates both ways
 * without keeping a closed step's hooks running.
 */
function Fold({ open, children }: { readonly open: boolean; readonly children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setMounted(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  );
}

/**
 * Eases its height to follow its content, so an open step grows or shrinks smoothly when its
 * content changes (a new tab, the key step, a failure message) instead of jumping. The first
 * measurement sets the height without a transition.
 */
function AutoHeight({ children }: { readonly children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      style={height === null ? undefined : { height }}
      className="overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}

export type ChecklistRowStatus = "done" | "open" | "todo";

/**
 * One step of the onboarding checklist. The open step shows its content; a finished one folds to
 * its title and a one-line summary.
 */
export function ChecklistRow({
  title,
  status,
  summary,
  children,
}: {
  readonly title: string;
  readonly status: ChecklistRowStatus;
  readonly summary?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      aria-current={status === "open" ? "step" : undefined}
      className="border-border border-t first:border-t-0"
    >
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-3.5 text-sm transition-colors duration-300",
          status === "todo" && "text-tertiary-foreground",
        )}
      >
        <StepMark mark={status === "done" ? "done" : status === "open" ? "waiting" : "pending"} />
        <h2 className="shrink-0 font-medium">{title}</h2>
        {status === "done" && summary ? (
          <span className="onboarding-fade ml-auto flex min-w-0 items-center gap-1.5 text-tertiary-foreground text-xs">
            {summary}
          </span>
        ) : null}
      </div>
      <Fold open={status === "open"}>
        {/* The body rises in as a whole and then eases its height as its content changes; steps
            slide their own content when it changes. The top padding keeps focus rings clear of
            the clipping edges. */}
        <div className="onboarding-enter">
          <AutoHeight>
            <div className="px-4 pt-0.5 pb-4 pl-11">{children}</div>
          </AutoHeight>
        </div>
      </Fold>
    </section>
  );
}
