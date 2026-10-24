import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { indexCadSnapshot, revealCadOccurrences } from "@cadsense/shared/cadScene";
import {
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  BoundingBoxIcon as Focus,
  HighlighterIcon as Highlighter,
  IntersectIcon as Blend,
} from "~/lib/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PartDrawingIcon } from "~/lib/icons";
import { partName } from "./drawing/drawingModel";
import { isBoughtPart } from "./drawing/shopKnowledge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { cadHierarchyWindow } from "./CadHierarchyWindow";

export function CadHierarchyTree({
  manifest,
  view,
  disabled,
  onChange,
  fullHeight = false,
  onOpenDrawing,
}: {
  manifest: CadSnapshotManifest;
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
  fullHeight?: boolean;
  /** Right-clicking a row offers a part drawing, or a packet of drawings for an assembly. */
  onOpenDrawing?: (occurrenceIds: string[], title: string) => void;
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
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  // Distinct parts under an assembly row that are not bought; the drawing panel then keeps the
  // ones the shop draws, so the menu only knows whether there is anything to sort.
  const madePartCount = (id: string) =>
    new Set(
      [...index.subtree([id])]
        .map((member) => index.nodes.get(member))
        .filter(
          (node) =>
            node?.kind === "part" &&
            !node.suppressed &&
            node.sourcePartKey &&
            !isBoughtPart(partName(node)),
        )
        .map((node) => node!.sourcePartKey),
    ).size;
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
  const rows = useMemo(() => {
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
    return all.flatMap((row) => {
      if (query && !matches.has(row.id)) return [];
      if (!query && row.depth > hiddenDepth) return [];
      hiddenDepth = !query && collapsed.has(row.id) ? row.depth : Number.POSITIVE_INFINITY;
      return [{ ...row, ...counts.get(row.id)! }];
    });
  }, [collapsed, index, manifest, search, view]);
  const { start, end } = cadHierarchyWindow(scrollTop, viewportHeight, rows.length);
  return (
    <div
      className={`flex min-h-0 flex-col ${fullHeight ? "flex-1" : "border-t"}`}
      aria-label="CAD components"
    >
      <div className="flex shrink-0 items-center gap-2 p-2">
        <Input
          aria-label="Search CAD components"
          placeholder="Search components"
          value={search}
          disabled={disabled}
          onChange={(event) => {
            setSearch(event.target.value);
            setScrollTop(0);
            scroller.current?.scrollTo(0, 0);
          }}
        />
      </div>
      <div
        ref={scroller}
        role="tree"
        aria-label="Components"
        className={fullHeight ? "min-h-0 flex-1 overflow-auto" : "h-60 overflow-auto"}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * 28, position: "relative" }}>
          {rows.slice(start, end).map((row, offset) => {
            const node = index.nodes.get(row.id)!;
            const branch = (index.children.get(row.id)?.length ?? 0) > 0;
            const expanded = !!search.trim() || !collapsed.has(row.id);
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={branch ? expanded : undefined}
                className={`group absolute left-0 flex h-7 w-full items-center gap-1 pr-2 text-xs ${disabled ? "" : "hover:bg-muted/50"} ${menu?.id === row.id ? "bg-muted/70" : ""}`}
                style={{ top: (start + offset) * 28, paddingLeft: 8 + row.depth * 14 }}
                onContextMenu={(event) => {
                  if (!onOpenDrawing || node.suppressed || (node.kind !== "part" && !branch))
                    return;
                  event.preventDefault();
                  setMenu({ id: row.id, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
                  disabled={disabled || !branch || !!search.trim()}
                  className="flex size-5 shrink-0 items-center justify-center"
                  onClick={() =>
                    setCollapsed((prior) => {
                      const next = new Set(prior);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {branch && (!expanded ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
                </button>
                <Checkbox
                  aria-label={`Show ${node.name}`}
                  checked={row.shown === row.total}
                  indeterminate={row.shown > 0 && row.shown < row.total}
                  disabled={disabled || node.suppressed}
                  onCheckedChange={() => {
                    const show = row.shown !== row.total;
                    const visibility = show
                      ? revealCadOccurrences(index, view, [row.id])
                      : { ...view.visibility };
                    if (!show) for (const id of index.subtree([row.id])) visibility[id] = false;
                    onChange({ ...view, visibility, isolatedOccurrenceIds: [] });
                  }}
                />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                    {node.name}
                    {node.suppressed ? " (suppressed)" : ""}
                  </TooltipTrigger>
                  <TooltipPopup>{node.name}</TooltipPopup>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Highlight ${node.name}`}
                  aria-pressed={highlighted.has(row.id)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-pressed:bg-accent aria-pressed:opacity-100"
                  disabled={disabled || node.suppressed}
                  onClick={() =>
                    onChange({
                      ...view,
                      highlightedOccurrenceIds: highlighted.has(row.id) ? [] : [row.id],
                    })
                  }
                >
                  <Highlighter size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Ghost ${node.name}`}
                  aria-pressed={ghosted.has(row.id)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-pressed:bg-accent aria-pressed:opacity-100"
                  disabled={disabled || node.suppressed}
                  onClick={() =>
                    onChange({
                      ...view,
                      ghost: ghosted.has(row.id) ? null : { occurrenceIds: [row.id], opacity: 0.2 },
                    })
                  }
                >
                  <Blend size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Isolate ${node.name}`}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  disabled={disabled || node.suppressed}
                  onClick={() =>
                    onChange({
                      ...view,
                      visibility: revealCadOccurrences(index, view, [row.id]),
                      isolatedOccurrenceIds: [row.id],
                      camera: { kind: "preset", preset: "isometric", fit: [row.id] },
                    })
                  }
                >
                  <Focus size={12} />
                </Button>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">No matching components.</p>
        )}
        {menu &&
          onOpenDrawing &&
          (() => {
            const node = index.nodes.get(menu.id)!;
            const single = node.kind === "part";
            const count = single ? 1 : madePartCount(menu.id);
            return (
              <div
                role="menu"
                aria-label={`${partName(node)} actions`}
                className="fixed z-50 min-w-52 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
                style={{ left: menu.x, top: menu.y }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={count === 0}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                  onClick={() => {
                    setMenu(null);
                    onOpenDrawing([menu.id], partName(node));
                  }}
                >
                  <PartDrawingIcon size={14} />
                  {single
                    ? "Make part drawing"
                    : count === 0
                      ? "No made parts to draw"
                      : "Make drawings for this group"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setMenu(null);
                    onChange({
                      ...view,
                      visibility: revealCadOccurrences(index, view, [menu.id]),
                      isolatedOccurrenceIds: [menu.id],
                      camera: { kind: "preset", preset: "isometric", fit: [menu.id] },
                    });
                  }}
                >
                  <Focus size={14} />
                  Isolate
                </button>
              </div>
            );
          })()}
      </div>
    </div>
  );
}
