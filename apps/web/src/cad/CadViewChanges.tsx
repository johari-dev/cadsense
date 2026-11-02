// The viewport's top-left chip: a summary of how the view differs from the full model
// (isolated, hidden, ghosted, highlighted parts). Agents change these far more often than
// people do, so the summary is always visible. It opens a card listing the changes, each
// with an undo, plus the full parts tree.
import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { indexCadSnapshot, revealCadOccurrences } from "@cadsense/shared/cadScene";
import { useEffect, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { ArrowUUpLeftIcon, ListTreeIcon, XIcon } from "~/lib/icons";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { CadHierarchyTree } from "./CadHierarchyTree";

type CadIndex = ReturnType<typeof indexCadSnapshot>;
type ChangeKind = "isolated" | "hidden" | "ghosted" | "highlighted";

const CHANGES: Record<
  ChangeKind,
  { title: string; summary: (count: number) => string; undo: string }
> = {
  isolated: { title: "Isolated", summary: (n) => `Isolated ${n}`, undo: "Remove from isolation" },
  hidden: { title: "Hidden", summary: (n) => `${n} hidden`, undo: "Show again" },
  ghosted: { title: "Ghosted", summary: (n) => `${n} ghosted`, undo: "Stop ghosting" },
  highlighted: {
    title: "Highlighted",
    summary: (n) => `${n} highlighted`,
    undo: "Remove highlight",
  },
};
/** Rows a change group shows before it collapses the rest behind "and N more". */
const GROUP_PREVIEW = 5;
/** Matches the close transition in CadPanel.css. */
const CARD_ANIMATION_MS = 200;

/** How `view` differs from the model's defaults, as non-empty groups of occurrence ids. */
function viewChanges(index: CadIndex, view: CadViewState) {
  const known = (ids: readonly string[]) => ids.filter((id) => index.nodes.has(id));
  const groups: Array<{ kind: ChangeKind; ids: readonly string[] }> = [
    { kind: "isolated", ids: known(view.isolatedOccurrenceIds) },
    {
      kind: "hidden",
      ids: known(
        Object.entries(view.visibility)
          .filter(([id, shown]) => !shown && index.nodes.get(id)?.defaultVisible !== false)
          .map(([id]) => id),
      ),
    },
    { kind: "ghosted", ids: known(view.ghost?.occurrenceIds ?? []) },
    { kind: "highlighted", ids: known(view.highlightedOccurrenceIds ?? []) },
  ];
  return groups.filter((group) => group.ids.length > 0);
}

/** `view` with one change undone for one occurrence. */
function undoChange(index: CadIndex, view: CadViewState, kind: ChangeKind, id: string) {
  const without = (ids: readonly string[]) => ids.filter((other) => other !== id);
  switch (kind) {
    case "isolated":
      return { ...view, isolatedOccurrenceIds: without(view.isolatedOccurrenceIds) };
    case "hidden":
      return { ...view, visibility: revealCadOccurrences(index, view, [id]) };
    case "ghosted": {
      const remaining = without(view.ghost?.occurrenceIds ?? []);
      return {
        ...view,
        ghost: remaining.length && view.ghost ? { ...view.ghost, occurrenceIds: remaining } : null,
      };
    }
    case "highlighted":
      return { ...view, highlightedOccurrenceIds: without(view.highlightedOccurrenceIds ?? []) };
  }
}

export function CadViewChanges({
  manifest,
  view,
  disabled,
  onChange,
  belowRevisionNotice,
  onOpenDrawing,
}: {
  manifest: CadSnapshotManifest;
  view: CadViewState;
  /** The viewer is locked (the agent owns it): changes are listed but cannot be undone. */
  disabled: boolean;
  onChange: (view: CadViewState) => void;
  /** Sit below the "Previous CAD revision" notice, which also uses the top-left corner. */
  belowRevisionNotice: boolean;
  /** Opens a part drawing for parts, or a packet for an assembly. */
  onOpenDrawing?: (occurrenceIds: string[], title: string) => void;
}) {
  const index = useMemo(() => indexCadSnapshot(manifest), [manifest]);
  const partCount = useMemo(
    () => manifest.nodes.filter((node) => node.sourcePartKey !== null).length,
    [manifest],
  );
  const changes = viewChanges(index, view);
  const changeCount = changes.reduce((sum, group) => sum + group.ids.length, 0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"changes" | "parts">("changes");
  // The Changes tab hides while there are none, so the card shows parts then.
  const shownTab = changeCount ? tab : "parts";
  const [expanded, setExpanded] = useState<ReadonlySet<ChangeKind>>(new Set());
  // The card stays mounted while its close transition plays.
  const [settledOpen, setSettledOpen] = useState(open);
  const settling = settledOpen !== open;
  useEffect(() => {
    if (!settling) return;
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setSettledOpen(open), reducedMotion ? 0 : CARD_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [open, settling]);
  const toggle = () => {
    if (!open) {
      setTab(changeCount ? "changes" : "parts");
      setExpanded(new Set());
    }
    setOpen(!open);
  };
  const reset = () =>
    onChange({
      ...view,
      visibility: {},
      isolatedOccurrenceIds: [],
      ghost: null,
      highlightedOccurrenceIds: [],
    });
  const summary = changes.map((group) => CHANGES[group.kind].summary(group.ids.length));
  const chipLabel = changeCount
    ? summary.slice(0, 2).join(" · ") + (summary.length > 2 ? ` +${summary.length - 2}` : "")
    : `${partCount} parts`;

  return (
    <div
      className={cn(
        // Spans down to 16px above the camera toolbar (16px inset, 38px tall), so the card can
        // grow or shrink to fit.
        "pointer-events-none absolute bottom-[70px] left-3 z-20 flex w-[min(300px,calc(100%-72px))] flex-col items-start gap-2",
        belowRevisionNotice ? "top-14" : "top-3",
      )}
    >
      <div className="pointer-events-auto flex h-8 shrink-0 items-center rounded-[8px] border border-input bg-popover text-[13px] font-medium shadow-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-label={changeCount ? `View changes: ${summary.join(", ")}` : "Parts"}
          className={cn(
            "flex h-full cursor-pointer items-center gap-2 rounded-[7px] px-3 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground",
            !changeCount && "text-foreground/75",
          )}
          onClick={toggle}
        >
          {changeCount ? (
            <span aria-hidden="true" className="mx-[5px] size-1.5 rounded-full bg-foreground" />
          ) : (
            <ListTreeIcon aria-hidden="true" className="size-4" />
          )}
          <span className="whitespace-nowrap">{chipLabel}</span>
        </button>
        {changeCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Show every part"
                  disabled={disabled}
                  className="me-0.5"
                  onClick={reset}
                />
              }
            >
              <ArrowUUpLeftIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Show every part normally</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {(open || settling) && (
        <div
          role="dialog"
          aria-label="View changes and parts"
          inert={!open}
          data-closing={!open}
          className={cn(
            "cad-view-changes-card pointer-events-auto flex min-h-0 w-full shrink flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg",
            // The tree is virtualized and needs a definite height, so it takes the room down to
            // the toolbar (up to a cap); the change list fits its rows.
            shownTab === "parts" ? "max-h-[640px] flex-1" : "max-h-[400px]",
          )}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="flex shrink-0 items-center gap-0.5 border-b ps-1.5 pe-1.5 pt-1.5 pb-[7px]">
            {/* With nothing changed, the card is only the parts list: a plain title, no tabs. */}
            {changeCount === 0 ? (
              <h2 className="flex h-7 items-center gap-2 px-2 text-[13px] font-medium">
                Parts
                <span className="rounded-md bg-foreground/8 px-1.5 text-xs leading-5 font-normal text-muted-foreground tabular-nums">
                  {partCount}
                </span>
              </h2>
            ) : (
              (
                [
                  ["changes", "Changes", changeCount],
                  ["parts", "All parts", partCount],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={shownTab === id}
                  className={cn(
                    "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    shownTab === id &&
                      "text-foreground after:absolute after:inset-x-2 after:-bottom-[7px] after:h-0.5 after:rounded-full after:bg-foreground",
                  )}
                  onClick={() => setTab(id)}
                >
                  {label}
                  <span className="tabular-nums text-muted-foreground">{count}</span>
                </button>
              ))
            )}
            <span className="flex-1" />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close view changes"
              onClick={() => setOpen(false)}
            >
              <XIcon />
            </Button>
          </div>
          {shownTab === "parts" ? (
            <CadHierarchyTree
              manifest={manifest}
              view={view}
              disabled={disabled}
              onChange={onChange}
              fullHeight
              {...(onOpenDrawing ? { onOpenDrawing } : {})}
            />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {changes.map((group) => {
                  const showAll = expanded.has(group.kind) || group.ids.length <= GROUP_PREVIEW + 1;
                  const shown = showAll ? group.ids : group.ids.slice(0, GROUP_PREVIEW);
                  return (
                    <section key={group.kind} aria-label={CHANGES[group.kind].title}>
                      <h3 className="px-2 pt-2 pb-1 text-[11px] font-normal text-muted-foreground">
                        {CHANGES[group.kind].title}
                      </h3>
                      {shown.map((id) => (
                        <div
                          key={id}
                          className="group flex h-7 items-center gap-2 rounded-md ps-2 pe-1 text-[13px] hover:bg-accent"
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate",
                                    group.kind === "hidden" && "text-muted-foreground",
                                  )}
                                />
                              }
                            >
                              {index.nodes.get(id)?.name}
                            </TooltipTrigger>
                            <TooltipPopup side="top">{index.nodes.get(id)?.name}</TooltipPopup>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`${CHANGES[group.kind].undo}: ${index.nodes.get(id)?.name}`}
                                  disabled={disabled}
                                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                  onClick={() => onChange(undoChange(index, view, group.kind, id))}
                                />
                              }
                            >
                              <ArrowUUpLeftIcon />
                            </TooltipTrigger>
                            <TooltipPopup side="top">{CHANGES[group.kind].undo}</TooltipPopup>
                          </Tooltip>
                        </div>
                      ))}
                      {!showAll && (
                        <button
                          type="button"
                          className="h-7 cursor-pointer ps-2 text-[13px] text-muted-foreground hover:text-foreground"
                          onClick={() => setExpanded(new Set([...expanded, group.kind]))}
                        >
                          and {group.ids.length - GROUP_PREVIEW} more
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>
              <div className="flex shrink-0 justify-end border-t p-1.5">
                <Button size="compact" variant="ghost" disabled={disabled} onClick={reset}>
                  <ArrowUUpLeftIcon />
                  Show every part
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
