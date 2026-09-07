import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CadComment, CadSnapshotManifest, ScopedThreadRef } from "@cadsense/contracts";
import { newCommandId } from "../lib/utils";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import { MessageSquare, X, LocateFixed, Check, RotateCcw, Box } from "lucide-react";
import { Button } from "../components/ui/button";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useAtomCommand } from "../state/use-atom-command";
import type { CadSceneRenderer } from "./CadSceneRenderer";

export interface CadCommentSelection {
  id: string;
  target: number;
  request: number;
}
export interface CadCommentsCardProps {
  threadRef: ScopedThreadRef;
  comments: readonly CadComment[];
  manifest: CadSnapshotManifest | null;
  displayedSnapshotId: string;
  renderer: RefObject<CadSceneRenderer | null>;
  open: boolean;
  setOpen: (open: boolean) => void;
  selection: CadCommentSelection | null;
  clearSelection: (id?: string) => void;
  choose: (comment: CadComment, target: number) => void;
  historical: boolean;
  back: () => void;
}
export function CadCommentsCard({
  threadRef,
  comments,
  manifest,
  displayedSnapshotId,
  renderer,
  open,
  setOpen,
  selection,
  clearSelection,
  choose,
  historical,
  back,
}: CadCommentsCardProps) {
  const [filter, setFilter] = useState<"open" | "reviewed" | "history">(
    historical ? "history" : "open",
  );
  const [notice, setNotice] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const card = useRef<HTMLDivElement>(null),
    markers = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null);
  const review = useAtomCommand(cadPanelEnvironment.review, { reportFailure: false });
  const descriptor = useMemo(
    () => (manifest ? cadCommentModelDescriptor(manifest) : null),
    [manifest],
  );
  const displayed = comments.filter((c) =>
    descriptor ? c.modelDescriptor === descriptor : c.snapshotId === displayedSnapshotId,
  );
  const selected = comments.find((c) => c.id === selection?.id);
  const openCount = displayed.filter((c) => c.state === "open").length;
  const visible =
    filter === "history"
      ? comments.filter((c) => c.modelDescriptor !== descriptor || historical)
      : displayed.filter((c) => (filter === "open" ? c.state === "open" : c.state !== "open"));
  useEffect(() => {
    if (historical) setFilter("history");
  }, [historical]);
  useEffect(() => {
    if (selected)
      setFilter(
        selected.modelDescriptor !== descriptor || historical
          ? "history"
          : selected.state === "open"
            ? "open"
            : "reviewed",
      );
  }, [selection?.id, descriptor, historical]);
  useEffect(() => {
    if (!open) {
      renderer.current?.endCommentReview();
      setNotice("");
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, renderer, setOpen]);
  useEffect(() => {
    if (open && !selection) renderer.current?.endCommentReview();
  }, [open, selection, renderer]);
  useEffect(() => {
    if (!open || !host.current || !card.current) return;
    let dimensions = "";
    const observer = new ResizeObserver(() => {
      const hostBox = host.current?.getBoundingClientRect();
      const cardBox = card.current?.getBoundingClientRect();
      const next = `${hostBox?.width}:${hostBox?.height}:${cardBox?.width}:${cardBox?.height}`;
      if (next !== dimensions) {
        dimensions = next;
        setLayoutVersion((v) => v + 1);
      }
    });
    observer.observe(host.current);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (
      !open ||
      !selection ||
      !selected ||
      selected.modelDescriptor !== descriptor ||
      !host.current
    )
      return;
    const bounds = host.current.getBoundingClientRect(),
      occupied = card.current?.getBoundingClientRect();
    const width = occupied ? Math.max(120, occupied.left - bounds.left - 16) : bounds.width;
    const below = occupied && width < 240;
    const belowTop = occupied ? occupied.bottom - bounds.top + 16 : 0;
    const safeHeight = below ? Math.max(120, bounds.height - belowTop) : bounds.height;
    const safeWidth = below ? bounds.width : width;
    const target = selected.targets[selection.target];
    if (!target) return;
    setNotice(
      renderer.current?.focusComment(
        target,
        {
          width: safeWidth,
          height: safeHeight,
          centerX: safeWidth / 2,
          centerY: (below ? belowTop : 0) + safeHeight / 2,
        },
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ) ?? "Location unavailable",
    );
    card.current?.querySelector('[aria-expanded="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selection, descriptor, open, layoutVersion]);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      markers.current?.querySelectorAll<HTMLButtonElement>("[data-comment]").forEach((button) => {
        const comment = comments.find((c) => c.id === button.dataset.comment),
          target = comment?.targets[Number(button.dataset.target)];
        const point = target ? renderer.current?.commentProjection(target) : null;
        button.style.visibility = point?.visible ? "visible" : "hidden";
        if (point) {
          button.style.left = `${point.x}px`;
          button.style.top = `${point.y}px`;
          button.dataset.occluded = String(point.occluded);
          button.style.borderStyle = "solid";
        }
      });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [comments, manifest, renderer]);
  const change = async (c: CadComment, state: CadComment["state"]) => {
    const result = await review({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        commentId: c.id,
        expectedVersion: c.version,
        state,
        commandId: newCommandId(),
      },
    });
    if (result._tag !== "Failure" && state !== "open") clearSelection(c.id);
    setNotice(
      result._tag === "Failure"
        ? "Could not update this finding. Reload its latest review state and try again."
        : `Comment ${c.number} ${state}.`,
    );
  };
  return (
    <div
      ref={host}
      className="pointer-events-none absolute inset-0 z-20"
      style={{ containerType: "inline-size" }}
    >
      <div ref={markers} className="absolute inset-0 overflow-hidden">
        {displayed
          .filter(
            (c) => c.state === "open" || (open && filter === "reviewed" && c.id === selection?.id),
          )
          .flatMap((c) =>
            c.targets.map((t, i) => (
              <button
                key={`${c.id}:${i}`}
                data-comment={c.id}
                data-target={i}
                aria-label={`Comment ${c.number}: ${t.label}`}
                onClick={() => choose(c, i)}
                className={`pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border-2 border-solid border-neutral-800 bg-amber-200 px-1.5 py-1 text-[11px] font-semibold text-neutral-950 shadow ${open && c.id === selection?.id ? "ring-2 ring-foreground" : ""}`}
              >
                {t.kind === "part" && <Box size={12} />} {c.number}
                {c.targets.length > 1 ? String.fromCharCode(97 + i) : ""}
              </button>
            )),
          )}
      </div>
      {historical && (
        <div className="pointer-events-auto absolute left-3 top-3 flex items-center gap-2 rounded-md border bg-popover px-2 py-1 text-xs">
          <span>Previous CAD revision</span>
          <Button size="compact" variant="outline" onClick={back}>
            Back to current
          </Button>
        </div>
      )}
      <div
        ref={card}
        data-comments-surface
        data-open={open}
        className="cad-comments-surface pointer-events-auto absolute right-3 top-3 rounded-lg border bg-popover text-popover-foreground shadow-lg"
      >
        {!open && (
          <Button
            size="icon"
            variant="ghost"
            className="absolute right-0 top-0 size-8"
            aria-label={`Comments (${openCount} unresolved)`}
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            <MessageSquare size={16} />
            {openCount > 0 && (
              <span className="absolute -right-1 -top-1">
                <CommentBadge number={openCount} />
              </span>
            )}
          </Button>
        )}
        {open && (
          <div
            aria-label="CAD comments"
            className="cad-comments-content flex h-full min-h-0 flex-col"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-sm">
              <span className="flex items-center gap-2">
                <MessageSquare size={16} />
                <strong>Comments</strong>
                {openCount > 0 && <CommentBadge number={openCount} />}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close comments"
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>
            <div className="flex gap-1 border-b p-1">
              {(["open", "reviewed", "history"] as const).map((tab) => (
                <Button
                  key={tab}
                  size="compact"
                  variant={filter === tab ? "secondary" : "ghost"}
                  onClick={() => setFilter(tab)}
                >
                  {tab === "open" ? "Open" : tab === "reviewed" ? "Reviewed" : "Previous revisions"}
                </Button>
              ))}
            </div>
            {notice && (
              <p
                role="status"
                className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground"
              >
                {notice}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {visible.length ? (
                visible.map((c) => (
                  <article key={c.id} className="border-b px-3 py-2 text-xs">
                    <button
                      className="flex w-full gap-2 text-left"
                      aria-expanded={selection?.id === c.id}
                      onClick={() => choose(c, 0)}
                    >
                      <CommentBadge number={c.number} reviewed={c.state !== "open"} />
                      <span>
                        <strong>{c.title}</strong>
                        <span className="mt-1 block text-muted-foreground">
                          {c.targets.length} locations · {c.state}
                          {c.modelDescriptor !== descriptor ? " · previous revision" : ""}
                        </span>
                      </span>
                    </button>
                    {selection?.id === c.id && (
                      <div className="mt-3 space-y-3">
                        <p className="whitespace-pre-wrap leading-relaxed">{c.body}</p>
                        {c.targets.map((t, i) => (
                          <div key={i}>
                            <Button
                              size="compact"
                              variant={selection.target === i ? "secondary" : "ghost"}
                              onClick={() => choose(c, i)}
                            >
                              <LocateFixed />
                              {t.label}
                            </Button>
                            {t.kind === "part" && (
                              <p className="mt-1 text-muted-foreground">
                                Whole part · {t.preciseLocationLimitation}
                              </p>
                            )}
                          </div>
                        ))}
                        {c.targets.length > 1 && (
                          <div className="flex items-center justify-between">
                            <Button
                              size="compact"
                              variant="ghost"
                              disabled={selection.target === 0}
                              onClick={() => choose(c, selection.target - 1)}
                            >
                              Previous
                            </Button>
                            <span>
                              {selection.target + 1} / {c.targets.length}
                            </span>
                            <Button
                              size="compact"
                              variant="ghost"
                              disabled={selection.target === c.targets.length - 1}
                              onClick={() => choose(c, selection.target + 1)}
                            >
                              Next
                            </Button>
                          </div>
                        )}
                        {c.link && (
                          <button
                            className="text-left underline"
                            onClick={() => {
                              const old = comments.find((x) => x.id === c.link?.commentId);
                              if (old) choose(old, 0);
                            }}
                          >
                            {c.link.kind}: {c.link.explanation}
                          </button>
                        )}
                        {comments
                          .filter((x) => x.link?.commentId === c.id)
                          .map((x) => (
                            <button
                              key={x.id}
                              className="block text-left underline"
                              onClick={() => choose(x, 0)}
                            >
                              See {x.link?.kind}: {x.title}
                            </button>
                          ))}
                        <div className="flex gap-1">
                          {c.state === "open" ? (
                            <>
                              <Button
                                size="compact"
                                variant="outline"
                                onClick={() => void change(c, "resolved")}
                              >
                                <Check />
                                Resolve · {c.targets.length}
                              </Button>
                              <Button
                                size="compact"
                                variant="ghost"
                                onClick={() => void change(c, "dismissed")}
                              >
                                Dismiss
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="compact"
                              variant="outline"
                              onClick={() => void change(c, "open")}
                            >
                              <RotateCcw />
                              Reopen
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  {filter === "open"
                    ? "No open comments. Reviewed findings remain in Reviewed."
                    : "No findings in this group."}
                </p>
              )}
            </div>
            <p className="border-t p-2 text-[11px] text-muted-foreground">
              Resolve = addressed. Dismiss = no action needed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentBadge({ number, reviewed = false }: { number: number; reviewed?: boolean }) {
  return (
    <span
      data-comment-badge
      className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ${reviewed ? "bg-muted text-muted-foreground" : "bg-amber-200 text-neutral-950"}`}
    >
      {number}
    </span>
  );
}
