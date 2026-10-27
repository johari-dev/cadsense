import type { ApprovalRequestId, ProviderApprovalDecision } from "@cadsense/contracts";
import { memo, useEffect, useId, useState, type ReactNode } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import type { PendingApproval, WorkLogEntry } from "../../session-logic";
import {
  CameraIcon,
  CaretRightIcon as ChevronRightIcon,
  ChatCircleIcon,
  CheckIcon,
  CubeIcon,
  EyeIcon,
  FileIcon,
  GlobeIcon,
  HammerIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import type { ToolCallCard, ToolCallKind, ToolCallRow } from "./ToolCallCard.logic";

/** Long cards show their latest calls; the rest sit behind "Show N earlier calls". */
const VISIBLE_CALL_LIMIT = 6;

export interface ToolCallCardViewProps {
  card: ToolCallCard;
  expanded: boolean;
  showAllCalls: boolean;
  workspaceRoot: string | undefined;
  respondingApprovalIds: ReadonlyArray<ApprovalRequestId>;
  onToggle: () => void;
  onToggleShowAll: () => void;
  onRespondToApproval: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
}

/**
 * One run of consecutive tool calls. The header stacks each kind's icon and counts the calls;
 * the body lists them and folds away with a short height transition.
 */
export const ToolCallCardView = memo(function ToolCallCardView(props: ToolCallCardViewProps) {
  const { card, expanded, showAllCalls } = props;
  const bodyId = useId();
  // The body mounts the first time the card opens, then stays mounted so closing can animate.
  // Opening a never-mounted body starts closed and opens on the next frame for the same reason.
  const [bodyMounted, setBodyMounted] = useState(expanded);
  const [bodyOpen, setBodyOpen] = useState(expanded);
  useEffect(() => {
    if (!expanded) {
      setBodyOpen(false);
      return;
    }
    setBodyMounted(true);
    const frame = requestAnimationFrame(() => setBodyOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  const hiddenCount = showAllCalls ? 0 : Math.max(0, card.calls.length - VISIBLE_CALL_LIMIT);
  const visibleCalls = hiddenCount > 0 ? card.calls.slice(hiddenCount) : card.calls;

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        data-scroll-anchor-ignore
        onClick={props.onToggle}
        className="flex min-h-9 w-full cursor-pointer select-none items-center gap-2 px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ToolKindStack kinds={card.kinds} />
        <span className="min-w-0 truncate">{card.title}</span>
        <span className="ms-auto flex shrink-0 items-center gap-2 text-xs tabular-nums">
          {card.failedCount > 0 ? (
            <span className="text-destructive">{card.failedCount} failed</span>
          ) : null}
          {card.duration ? <span className="text-muted-foreground/80">{card.duration}</span> : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 opacity-70 transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      <div
        id={bodyId}
        inert={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          bodyOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {bodyMounted ? (
            <div className="flex flex-col gap-px border-t border-border/60 p-1">
              {hiddenCount > 0 || (showAllCalls && card.calls.length > VISIBLE_CALL_LIMIT) ? (
                <button
                  type="button"
                  onClick={props.onToggleShowAll}
                  className="flex min-h-7 cursor-pointer items-center rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                >
                  {hiddenCount > 0
                    ? `Show ${hiddenCount} earlier ${hiddenCount === 1 ? "call" : "calls"}`
                    : "Show fewer calls"}
                </button>
              ) : null}
              {visibleCalls.map((call) => (
                <ToolCallRowView
                  key={call.id}
                  call={call}
                  animateEntrance={card.live}
                  workspaceRoot={props.workspaceRoot}
                  responding={
                    call.approval !== null &&
                    props.respondingApprovalIds.includes(call.approval.requestId)
                  }
                  onRespondToApproval={props.onRespondToApproval}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});

const ToolCallRowView = memo(function ToolCallRowView(props: {
  call: ToolCallRow;
  animateEntrance: boolean;
  workspaceRoot: string | undefined;
  responding: boolean;
  onRespondToApproval: ToolCallCardViewProps["onRespondToApproval"];
}) {
  const { call } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const details = buildToolCallExpandedBody(call.entry, props.workspaceRoot);
  const meta = [call.summary, call.duration].filter(Boolean).join(" · ");
  const secondLine = call.error ?? (call.approval ? approvalExplanation(call.approval) : null);
  const toggleDetails = () => setDetailsOpen((open) => !open);

  return (
    <div
      className={cn(
        "rounded-md",
        props.animateEntrance && "tool-call-enter",
        // Matches the composer, which marks a pending approval with its warning variant.
        call.status === "approval" && "bg-warning/[0.05] ring-1 ring-inset ring-warning/40",
      )}
    >
      <div className="flex min-h-8 items-center gap-2 px-1.5 py-1">
        <div
          className={cn("flex min-w-0 flex-1 items-center gap-2", details && "cursor-pointer")}
          onClick={details ? toggleDetails : undefined}
        >
          <ToolKindIcon kind={call.kind} className="size-4 shrink-0 text-icon-muted" />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-[13px] leading-5",
                call.status === "running" ? "text-muted-foreground" : "text-foreground/90",
              )}
            >
              {call.label}
            </p>
            {secondLine ? (
              <p className="truncate text-xs leading-4 text-muted-foreground">{secondLine}</p>
            ) : null}
          </div>
          {meta ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">{meta}</span>
          ) : null}
        </div>
        {call.approval ? (
          <ApprovalActions
            approval={call.approval}
            responding={props.responding}
            onRespond={props.onRespondToApproval}
          />
        ) : null}
        <StatusGlyph status={call.status} />
        {details ? (
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-label={`Details for ${call.label}`}
            onClick={toggleDetails}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-icon-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-200 motion-reduce:transition-none",
                detailsOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
      </div>
      {detailsOpen && details ? (
        <div className="mx-1.5 mb-1.5 ms-7.5 border-s border-border/45 ps-3">
          <pre className={toolCallExpandedBodyClassName}>{details}</pre>
        </div>
      ) : null}
    </div>
  );
});

function approvalExplanation(approval: PendingApproval): string {
  switch (approval.requestKind) {
    case "command":
      return "Needs your approval to run";
    case "file-change":
      return "Needs your approval to change files";
    case "file-read":
      return "Needs your approval to read";
    default:
      return `${approval.appName ?? "An app"} needs your approval`;
  }
}

const DENY_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = ["decline", "cancel"];
const ALLOW_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = ["accept", "acceptForSession"];

/** Deny and Allow map onto the decisions the provider offers for this request. */
function ApprovalActions(props: {
  approval: PendingApproval;
  responding: boolean;
  onRespond: ToolCallCardViewProps["onRespondToApproval"];
}) {
  const offered = props.approval.options?.map((option) => option.decision) ?? ["decline", "accept"];
  const deny = DENY_DECISIONS.find((decision) => offered.includes(decision));
  const allow = ALLOW_DECISIONS.find((decision) => offered.includes(decision));
  const { requestId } = props.approval;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {deny ? (
        <Button
          size="micro"
          variant="ghost-muted"
          disabled={props.responding}
          onClick={() => props.onRespond(requestId, deny)}
        >
          Deny
        </Button>
      ) : null}
      {allow ? (
        <Button
          size="micro"
          disabled={props.responding}
          onClick={() => props.onRespond(requestId, allow)}
        >
          Allow
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Running uses the stepped status pulse (a handful of frames per cycle), not a spinner, so a
 * long run does not repaint every frame. Each glyph carries its status for screen readers.
 */
function StatusGlyph({ status }: { status: ToolCallRow["status"] }) {
  switch (status) {
    case "running":
      return (
        <span
          role="img"
          aria-label="Running"
          className="flex size-4 shrink-0 items-center justify-center"
        >
          <span className="size-1.5 rounded-full bg-foreground/70 animate-status-pulse motion-reduce:animate-none" />
        </span>
      );
    case "done":
      return (
        <CheckIcon
          role="img"
          aria-label="Done"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      );
    case "failed":
      return (
        <WarningCircleIcon
          role="img"
          aria-label="Failed"
          className="size-3.5 shrink-0 text-destructive"
        />
      );
    case "approval":
      return (
        <LockSimpleIcon
          role="img"
          aria-label="Needs approval"
          className="size-3.5 shrink-0 text-warning"
        />
      );
  }
}

function ToolKindStack({ kinds }: { kinds: ReadonlyArray<ToolCallKind> }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {kinds.map((kind, index) => (
        <span
          key={kind}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border border-card bg-muted text-icon-muted",
            index > 0 && "-ms-1.5",
          )}
        >
          <ToolKindIcon kind={kind} className="size-3" />
        </span>
      ))}
    </span>
  );
}

function ToolKindIcon({ kind, className }: { kind: ToolCallKind; className: string }): ReactNode {
  switch (kind) {
    case "cad-capture":
      return <CameraIcon aria-hidden className={className} />;
    case "cad-view":
      return <EyeIcon aria-hidden className={className} />;
    case "cad":
      return <CubeIcon aria-hidden className={className} />;
    case "comments":
      return <ChatCircleIcon aria-hidden className={className} />;
    case "read":
      return <FileIcon aria-hidden className={className} />;
    case "edit":
      return <NotePencilIcon aria-hidden className={className} />;
    case "shell":
      return <TerminalWindowIcon aria-hidden className={className} />;
    case "search":
      return <MagnifyingGlassIcon aria-hidden className={className} />;
    case "web":
      return <GlobeIcon aria-hidden className={className} />;
    case "mcp":
      return <WrenchIcon aria-hidden className={className} />;
    case "generic":
      return <HammerIcon aria-hidden className={className} />;
  }
}

function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

/** A call's details: its MCP payload, command, output detail, and changed files. */
export function buildToolCallExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text";
