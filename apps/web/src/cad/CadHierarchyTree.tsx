import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { indexCadSnapshot, revealCadOccurrences } from "@cadsense/shared/cadScene";
import { ChevronDown, ChevronRight, Focus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";

export function CadHierarchyTree({
  manifest,
  view,
  disabled,
  onChange,
}: {
  manifest: CadSnapshotManifest;
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
}) {
  const index = useMemo(() => indexCadSnapshot(manifest), [manifest]);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
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
  const start = Math.max(0, Math.floor(scrollTop / 28) - 6);
  return (
    <div className="flex min-h-0 flex-col border-t" aria-label="CAD components">
      <div className="flex items-center gap-2 p-2">
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
        className="h-60 overflow-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * 28, position: "relative" }}>
          {rows.slice(start, start + 22).map((row, offset) => {
            const node = index.nodes.get(row.id)!;
            const branch = (index.children.get(row.id)?.length ?? 0) > 0;
            const expanded = !!search.trim() || !collapsed.has(row.id);
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={branch ? expanded : undefined}
                className="absolute left-0 flex h-7 w-full items-center gap-1 pr-2 text-xs hover:bg-muted/50"
                style={{ top: (start + offset) * 28, paddingLeft: 8 + row.depth * 14 }}
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
                  aria-label={`Isolate ${node.name}`}
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
      </div>
    </div>
  );
}
