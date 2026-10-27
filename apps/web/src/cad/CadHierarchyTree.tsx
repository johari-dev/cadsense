import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { indexCadSnapshot, revealCadOccurrences } from "@cadsense/shared/cadScene";
import {
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  EyeIcon,
  EyeSlashIcon,
  BoundingBoxIcon as Focus,
  HighlighterIcon as Highlighter,
  IntersectIcon as Blend,
  MagnifyingGlassIcon,
} from "~/lib/icons";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollBar } from "../components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import {
  CAD_HIERARCHY_DETAIL_ROW_HEIGHT,
  CAD_HIERARCHY_ROW_HEIGHT,
  cadHierarchyWindow,
} from "./CadHierarchyWindow";

/**
 * Splits a part name for display. Onshape's instance suffix ("top support <2>") becomes a
 * number, and a trailing spec in parentheses or a part number becomes a muted detail line, so
 * '2" x 1" x 0.125" MAXTube (30" L, Full Pattern, 0.5" Pitch)' keeps its length visible
 * instead of truncating it away.
 */
function partLabel(name: string) {
  const numbered = /^(.*\S)\s*<(\d+)>$/.exec(name);
  const named = numbered?.[1] ?? name;
  const detailed =
    /^(.+?)\s+\(([^()]+)\)$/.exec(named) ?? /^(.+?)\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)$/.exec(named);
  return {
    title: detailed?.[1] ?? named,
    detail: detailed?.[2] ?? null,
    instance: numbered?.[2] ?? null,
  };
}

/** A row action. Hover actions sit over the end of the name, on the row's own background, so
    names get the full row width until the pointer or focus arrives. An active effect stays
    shown with a white icon. */
const rowAction =
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-pressed:bg-foreground/10 aria-pressed:opacity-100 aria-pressed:[--control-icon-color:var(--foreground)]";

export function CadHierarchyTree({
  manifest,
  view,
  disabled,
  onChange,
  fullHeight = false,
}: {
  manifest: CadSnapshotManifest;
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
  fullHeight?: boolean;
}) {
  const index = useMemo(() => indexCadSnapshot(manifest), [manifest]);
  const highlighted = useMemo(
    () => index.subtree(view.highlightedOccurrenceIds ?? []),
    [index, view.highlightedOccurrenceIds],
  );
  const ghosted = useMemo(
    () => index.subtree(view.ghost?.occurrenceIds ?? []),
    [index, view.ghost?.occurrenceIds],
  );
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(240);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setViewportHeight(node.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const tree = useMemo(() => {
    const visible = index.visible(view);
    const matches = new Set<string>();
    const query = search.trim().toLocaleLowerCase();
    if (query)
      for (const node of manifest.nodes)
        if (node.name.toLocaleLowerCase().includes(query)) {
          let id: string | null = node.id;
          while (id && !matches.has(id)) {
            matches.add(id);
            id = index.nodes.get(id)?.parentId ?? null;
          }
        }
    const all: { id: string; depth: number }[] = [];
    const pending = (index.children.get(null) ?? []).toReversed().map((id) => ({ id, depth: 0 }));
    while (pending.length) {
      const row = pending.pop()!;
      all.push(row);
      for (const id of (index.children.get(row.id) ?? []).toReversed())
        pending.push({ id, depth: row.depth + 1 });
    }
    const counts = new Map<string, { total: number; shown: number }>();
    for (const row of all.toReversed()) {
      const children = index.children.get(row.id) ?? [];
      counts.set(
        row.id,
        children.length
          ? children.reduce(
              (sum, id) => ({
                total: sum.total + counts.get(id)!.total,
                shown: sum.shown + counts.get(id)!.shown,
              }),
              { total: 0, shown: 0 },
            )
          : { total: 1, shown: visible.get(row.id) ? 1 : 0 },
      );
    }
    let hiddenDepth = Number.POSITIVE_INFINITY;
    const shownRows = all.flatMap((row) => {
      if (query && !matches.has(row.id)) return [];
      if (!query && row.depth > hiddenDepth) return [];
      hiddenDepth = !query && collapsed.has(row.id) ? row.depth : Number.POSITIVE_INFINITY;
      const node = index.nodes.get(row.id)!;
      const label = partLabel(node.name);
      const detail = node.suppressed
        ? ["Suppressed", label.detail].filter(Boolean).join(" · ")
        : label.detail;
      return [{ ...row, ...counts.get(row.id)!, ...label, detail }];
    });
    const offsets = [0];
    for (const row of shownRows)
      offsets.push(
        offsets.at(-1)! + (row.detail ? CAD_HIERARCHY_DETAIL_ROW_HEIGHT : CAD_HIERARCHY_ROW_HEIGHT),
      );
    // Footer counts cover parts only, not the assemblies that group them.
    const parts = manifest.nodes.filter((node) => node.sourcePartKey !== null);
    return {
      rows: shownRows,
      offsets,
      partCount: parts.length,
      matchCount: query ? parts.filter((node) => matches.has(node.id)).length : null,
      hiddenCount: parts.filter((node) => !visible.get(node.id)).length,
    };
  }, [collapsed, index, manifest, search, view]);
  const { rows, offsets, partCount, matchCount, hiddenCount } = tree;
  const listHeight = offsets.at(-1)!;
  const { start, end } = cadHierarchyWindow(scrollTop, viewportHeight, offsets);
  // Dim, but never erase, the row at an edge with more rows past it, so a cut-off row reads as
  // "keep scrolling" and its text stays legible.
  const edge = (more: boolean) => (more ? "rgb(0 0 0 / 35%)" : "black");
  const moreAbove = scrollTop > 0;
  const moreBelow = scrollTop + viewportHeight < listHeight - 1;
  const scrollFade =
    moreAbove || moreBelow
      ? `linear-gradient(to bottom, ${edge(moreAbove)}, black 1.25rem, black calc(100% - 1.25rem), ${edge(moreBelow)})`
      : undefined;
  return (
    <div
      className={`flex min-h-0 flex-col ${fullHeight ? "flex-1" : "border-t"}`}
      aria-label="CAD components"
    >
      <div className="relative shrink-0 p-2">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4.5 z-10 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search CAD components"
          placeholder="Search parts"
          size="sm"
          className="text-[13px] sm:text-[13px] [&_input]:ps-8"
          value={search}
          disabled={disabled}
          onChange={(event) => {
            setSearch(event.target.value);
            setScrollTop(0);
            scroller.current?.scrollTo(0, 0);
          }}
        />
      </div>
      <ScrollAreaPrimitive.Root
        className={cn("relative min-h-0 overflow-hidden", fullHeight ? "flex-1" : "h-60")}
      >
        <ScrollAreaPrimitive.Viewport
          ref={scroller}
          role="tree"
          aria-label="Components"
          className="h-full overscroll-contain outline-none"
          style={{ maskImage: scrollFade }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: listHeight + 4, position: "relative" }}>
            {rows.slice(start, end).map((row, offset) => {
              const node = index.nodes.get(row.id)!;
              const branch = (index.children.get(row.id)?.length ?? 0) > 0;
              const expanded = !!search.trim() || !collapsed.has(row.id);
              const shown = row.shown === row.total;
              const hidden = row.shown === 0;
              const top = offsets[start + offset]!;
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={branch ? expanded : undefined}
                  className={cn(
                    "group absolute inset-x-1 flex items-center gap-1 rounded-md pe-1 text-[13px] [--row:var(--popover)]",
                    !disabled &&
                      "hover:[--row:color-mix(in_srgb,var(--popover),var(--foreground)_5%)] focus-within:[--row:color-mix(in_srgb,var(--popover),var(--foreground)_5%)]",
                    "bg-(--row)",
                  )}
                  style={{
                    top,
                    height: offsets[start + offset + 1]! - top,
                    paddingLeft: 4 + row.depth * 12,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
                    disabled={disabled || !branch || !!search.trim()}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    onClick={() =>
                      setCollapsed((prior) => {
                        const next = new Set(prior);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    {branch && (!expanded ? <ChevronRight size={14} /> : <ChevronDown size={14} />)}
                  </button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "flex min-w-0 flex-1 flex-col",
                            (hidden || node.suppressed) && "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      <span className="truncate leading-[18px]">{row.title}</span>
                      {row.detail && (
                        <span className="truncate text-xs leading-4 text-muted-foreground">
                          {row.detail}
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipPopup>{node.name}</TooltipPopup>
                  </Tooltip>
                  {/* A fixed column, so instance numbers line up down the list. */}
                  <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {row.instance && `#${row.instance}`}
                  </span>
                  <div className="pointer-events-none absolute inset-y-0 right-7 flex items-center gap-0.5 ps-6 group-hover:pointer-events-auto group-focus-within:pointer-events-auto [background:linear-gradient(to_right,transparent,var(--row)_1.25rem)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 has-aria-pressed:opacity-100">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Highlight ${node.name}`}
                            aria-pressed={highlighted.has(row.id)}
                            className={rowAction}
                            disabled={disabled || node.suppressed}
                            onClick={() =>
                              onChange({
                                ...view,
                                highlightedOccurrenceIds: highlighted.has(row.id) ? [] : [row.id],
                              })
                            }
                          />
                        }
                      >
                        <Highlighter />
                      </TooltipTrigger>
                      <TooltipPopup>Highlight</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Ghost ${node.name}`}
                            aria-pressed={ghosted.has(row.id)}
                            className={rowAction}
                            disabled={disabled || node.suppressed}
                            onClick={() =>
                              onChange({
                                ...view,
                                ghost: ghosted.has(row.id)
                                  ? null
                                  : { occurrenceIds: [row.id], opacity: 0.2 },
                              })
                            }
                          />
                        }
                      >
                        <Blend />
                      </TooltipTrigger>
                      <TooltipPopup>Ghost: make see-through</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Isolate ${node.name}`}
                            className={rowAction}
                            disabled={disabled || node.suppressed}
                            onClick={() =>
                              onChange({
                                ...view,
                                visibility: revealCadOccurrences(index, view, [row.id]),
                                isolatedOccurrenceIds: [row.id],
                                camera: { kind: "preset", preset: "isometric", fit: [row.id] },
                              })
                            }
                          />
                        }
                      >
                        <Focus />
                      </TooltipTrigger>
                      <TooltipPopup>Isolate and zoom to fit</TooltipPopup>
                    </Tooltip>
                  </div>
                  {/* Visibility: quiet while the row is fully shown, always visible otherwise. */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-label={`Show ${node.name}`}
                    aria-checked={shown ? true : hidden ? false : "mixed"}
                    disabled={disabled || node.suppressed}
                    className={cn(
                      "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      shown && "opacity-0 group-hover:opacity-100",
                    )}
                    onClick={() => {
                      const visibility = !shown
                        ? revealCadOccurrences(index, view, [row.id])
                        : { ...view.visibility };
                      if (shown) for (const id of index.subtree([row.id])) visibility[id] = false;
                      onChange({ ...view, visibility, isolatedOccurrenceIds: [] });
                    }}
                  >
                    {hidden ? (
                      <EyeSlashIcon className="size-4" />
                    ) : (
                      <EyeIcon className={cn("size-4", !shown && "opacity-60")} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {rows.length === 0 && (
            <p className="p-3 text-[13px] text-muted-foreground">No matching parts.</p>
          )}
        </ScrollAreaPrimitive.Viewport>
        {/* Always shown, so the list reads as scrollable before anyone scrolls it. */}
        <ScrollBar className="opacity-100" />
      </ScrollAreaPrimitive.Root>
      <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-xs text-muted-foreground tabular-nums">
        <span>
          {matchCount === null
            ? `${partCount} ${partCount === 1 ? "part" : "parts"}`
            : `${matchCount} of ${partCount} parts`}
        </span>
        {hiddenCount > 0 && <span>{hiddenCount} hidden</span>}
      </div>
    </div>
  );
}
