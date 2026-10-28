import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type PendingApproval,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { buildToolCallCard, toolCallKindIsCad, type ToolCallCard } from "./ToolCallCard.logic";
import { type ChatMessage, type ProposedPlan } from "../../types";
import {
  type CadCaptureCard,
  type CadCommentsPublishedCard,
  type MessageId,
  type OrchestrationLatestTurn,
  type TurnId,
} from "@cadsense/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      /** Thumbnails of the captures one CAD tool group recorded, in capture order. */
      kind: "cad-filmstrip";
      id: string;
      createdAt: string;
      captures: CadCaptureCard[];
    }
  | {
      /** Every comment a turn published, merged into one row that stays visible when the turn folds. */
      kind: "cad-comments";
      id: string;
      createdAt: string;
      card: CadCommentsPublishedCard;
    }
  | {
      /** One run of consecutive tool calls, shown as a card that folds to its header. */
      kind: "tool-card";
      id: string;
      createdAt: string;
      groupId: string;
      card: ToolCallCard;
      expanded: boolean;
      /** Long cards show only their latest calls until the user asks for the rest. */
      showAllCalls: boolean;
    }
  | {
      /** Log entries that are not tool calls, such as runtime warnings. */
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      /** "+N previous log entries" for a long run of non-tool log entries. */
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      /** The thread's latest settled reply while nothing runs; offers redo with feedback. */
      canRedoWithFeedback: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "turn-plan";
      id: string;
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      showThinking: boolean;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

const toolActionLabels: Readonly<Record<string, string>> = {
  cad_context: "Reading CAD context",
  cad_hierarchy: "Exploring CAD structure",
  cad_checks: "Running CAD checks",
  cad_diff: "Comparing CAD versions",
  cad_measure: "Measuring CAD",
  cad_find_parts: "Finding CAD parts",
  cad_drive_options: "Finding drive options",
  cad_update_view: "Adjusting CAD view",
  cad_capture: "Looking at CAD",
  cad_comments_list: "Reading CAD comments",
  cad_comment_locate: "Placing comment markers",
  cad_comment_inspect: "Checking comment markers",
  cad_comments_publish: "Publishing comments",
};

/** Providers qualify tool names as `server · tool`, `namespace.tool`, or `mcp__server__tool`. */
function providerToolName(value: string): string {
  return (
    normalizeCompactToolLabel(value)
      .split(/\s*·\s*|\.|__/u)
      .at(-1)
      ?.toLowerCase() ?? ""
  );
}

export function knownToolActionLabel(value: string): string | undefined {
  const toolName = providerToolName(value);
  return Object.hasOwn(toolActionLabels, toolName) ? toolActionLabels[toolName] : undefined;
}

/** CAD tool calls and the captures they record. Chat summarizes these as "Checked CAD". */
export function workEntryIsCadStep(entry: WorkLogEntry): boolean {
  return (
    entry.cadCapture !== undefined ||
    (workLogEntryIsToolLike(entry) &&
      providerToolName(entry.toolTitle ?? entry.label).startsWith("cad_"))
  );
}

/** Captures stay in the tool group that produced them instead of splitting it. */
function workEntryJoinsToolGroup(entry: WorkLogEntry): boolean {
  return (
    entry.cadCapture !== undefined ||
    (workLogEntryIsToolLike(entry) && entry.agentSpawn === undefined && entry.tone !== "error")
  );
}

export function formatToolActionLabel(value: string): string {
  const label = normalizeCompactToolLabel(value);
  const action = knownToolActionLabel(label);
  if (action) return action;
  const readable = label.replace(/_/gu, " ");
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
}

/** Follow the live card's latest call, including gaps after it completes, until chat moves on. */
export function timelineShowsCadActivity(rows: readonly MessagesTimelineRow[]): boolean {
  return rows.some((row) => {
    if (row.kind !== "tool-card" || !row.card.live) return false;
    const latest = row.card.calls.at(-1);
    return latest !== undefined && toolCallKindIsCad(latest.kind);
  });
}

type ToolGroupAction = "cad" | "read" | "edit" | "command" | "code-search" | "search" | "other";

export function workLogEntryIsLocalCodeSearch(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogEntry): ToolGroupAction {
  if (workEntryIsCadStep(entry)) return "cad";
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    (entry.itemType === "dynamic_tool_call" && entry.toolTitle === "Read File")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return "other";
}

function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (workEntry.sourceActivityKind === "tool.started" ||
        workEntry.sourceActivityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      workEntry.sourceActivityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

/**
 * Merges each turn's comment publications into the turn's last publication entry, keyed by that
 * timeline entry id. Agents publish incrementally and retry rejected findings, so a rejection is
 * dropped only when a later publication in the same turn publishes its key or title. Same-call and
 * earlier matches stay visible: they are different findings or conflicts, not fixed retries.
 */
function mergeCadCommentCards(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, CadCommentsPublishedCard> {
  const turns = new Map<string, Array<{ id: string; card: CadCommentsPublishedCard }>>();
  for (const entry of entries) {
    if (entry.kind !== "work" || entry.entry.cadComments === undefined) continue;
    const key = entry.entry.turnId ?? entry.id;
    turns.set(key, [...(turns.get(key) ?? []), { id: entry.id, card: entry.entry.cadComments }]);
  }
  const merged = new Map<string, CadCommentsPublishedCard>();
  for (const publications of turns.values()) {
    const published = [
      ...new Map(
        publications.flatMap(({ card }) => card.published).map((c) => [c.commentId, c]),
      ).values(),
    ];
    const rejected = publications.flatMap(({ card }, index) => {
      const later = publications.slice(index + 1).flatMap(({ card: next }) => next.published);
      const fixed = new Set(later.flatMap((c) => [c.publicationKey, c.title.trim()]));
      return card.rejected.filter(
        (r) => !fixed.has(r.publicationKey) && (r.title === null || !fixed.has(r.title.trim())),
      );
    });
    // A key rejected again in a later call keeps only its latest reason.
    const latestRejected = [...new Map(rejected.map((r) => [r.publicationKey, r])).values()];
    const proposed = [
      ...new Map(
        publications.flatMap(({ card }) => card.proposed).map((p) => [p.commentId, p]),
      ).values(),
    ];
    if (published.length > 0 || latestRejected.length > 0 || proposed.length > 0)
      merged.set(publications.at(-1)!.id, { published, rejected: latestRejected, proposed });
  }
  return merged;
}

/** Tool calls keep one identity from start to completion, though their entry id changes. */
function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  // An approval names the call it gates; it must not take that call's identity.
  return entry.toolCallId && entry.approvalRequestId === undefined
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  if (entry.kind === "turn-plan") {
    return entry.turnPlan.turnId;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

/**
 * Settled turns keep their first and terminal assistant messages visible.
 * Everything between them folds behind a "Worked for ..." row anchored at
 * the first hidden entry. Keeping both ends prevents a short follow-up from
 * hiding a substantive opening response while still bounding noisy turns.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const firstAssistantEntry = group.entries.find(
      (entry): entry is Extract<TimelineEntry, { kind: "message" }> => entry.kind === "message",
    );
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id === firstAssistantEntry?.id || entry.id === group.terminalEntry?.id) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      // Published comments are the result of a CAD review, so they stay visible too.
      if (entry.kind === "work" && entry.entry.cadComments !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstHiddenEntry.id, {
      turnId,
      anchorEntryId: firstHiddenEntry.id,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  /** Cards the user opened or closed; the rest are open exactly while live. */
  toolCardOpenOverrides?: ReadonlyMap<string, boolean>;
  /** Shown inline on the tool calls they gate. */
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  // Only the newest message can be redone, and only when it is an assistant
  // reply: a user message after it means a new turn has already started.
  const lastMessageEntry = input.timelineEntries.findLast((entry) => entry.kind === "message");
  const redoableMessageId =
    !input.isWorking && lastMessageEntry?.message.role === "assistant"
      ? lastMessageEntry.message.id
      : null;
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  let activeTurnHeaderIndex = input.timelineEntries.length;
  if (input.isWorking) {
    const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
    const firstOwnedAfterUser =
      unsettledTurnId === null
        ? -1
        : input.timelineEntries.findIndex(
            (entry, index) =>
              index > latestUserMessageIndex && timelineEntryTurnId(entry) === unsettledTurnId,
          );
    activeTurnHeaderIndex =
      firstOwnedAfterUser >= 0 ? firstOwnedAfterUser : latestUserMessageIndex + 1;
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number) =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    unsettledTurnId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.turnId === unsettledTurnId;
  const isVisibleActiveToolEntry = (entry: WorkLogEntry) =>
    workLogEntryIsToolLike(entry) && workEntryIsVisibleInGroup(entry, true);
  const activeEntries = input.isWorking
    ? input.timelineEntries.filter((entry, index) => entryBelongsToActiveTurn(entry, index))
    : [];
  const activeTurnHasVisibleContent = activeEntries.some((entry) => {
    if (entry.kind === "message") {
      return entry.message.role === "assistant" && (entry.message.text?.trim().length ?? 0) > 0;
    }
    if (entry.kind === "work") {
      return (
        entry.entry.agentSpawn === undefined &&
        workLogEntryIsToolLike(entry.entry) &&
        entry.entry.toolLifecycleStatus === "inProgress"
      );
    }
    if (entry.kind === "proposed-plan" || entry.kind === "turn-plan") return true;
    return false;
  });

  // The running turn's trailing tool calls form its live card: more calls may still join it,
  // so it stays open (and in the present tense) until the turn moves on.
  const liveToolEntryIds = new Set<string>();
  let showsLiveToolCard = false;
  for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
    const entry = input.timelineEntries[index]!;
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== "work" ||
      !workEntryJoinsToolGroup(entry.entry)
    ) {
      break;
    }
    liveToolEntryIds.add(entry.id);
    if (isVisibleActiveToolEntry(entry.entry)) showsLiveToolCard = true;
  }
  const pendingApprovals = new Map(
    (input.pendingApprovals ?? []).map((approval) => [approval.requestId, approval]),
  );
  const appendWorkingRow = () => {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      showThinking: !showsLiveToolCard && !activeTurnHasVisibleContent,
    });
  };

  /**
   * One run of tool calls, split at its captures: a capture ends the card before it, its image
   * shows at that point in the run, and the calls after it start a new card. Captures with no
   * calls between them share one filmstrip. The first card keeps the run's identity, so a card
   * that a new capture splits keeps its row while the turn streams.
   */
  const appendToolCard = (entries: ReadonlyArray<WorkLogEntry>) => {
    const first = entries[0];
    if (!first) return;
    const visibleEntries = omitSupersededLifecycleMarkers(
      entries.filter((entry) => workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry))),
      (entry) => entry,
    );
    const pieces: Array<{ captures: boolean; entries: WorkLogEntry[] }> = [];
    for (const entry of visibleEntries) {
      const isCapture = entry.cadCapture !== undefined;
      const piece = pieces.at(-1);
      if (piece?.captures === isCapture) piece.entries.push(entry);
      else pieces.push({ captures: isCapture, entries: [entry] });
    }
    // Only the run's trailing calls can still grow; a card that a capture ended is done.
    const runIsLive = entries.some((entry) => liveToolEntryIds.has(entry.id));
    pieces.forEach((piece, index) => {
      const pieceFirst = index === 0 ? first : piece.entries[0]!;
      const identity = workGroupIdentity(pieceFirst.id, pieceFirst);
      if (piece.captures) {
        nextRows.push({
          kind: "cad-filmstrip",
          id: `cad-filmstrip:${identity}`,
          createdAt: piece.entries[0]!.createdAt,
          captures: piece.entries.flatMap((entry) => (entry.cadCapture ? [entry.cadCapture] : [])),
        });
        return;
      }
      const card = buildToolCallCard({
        entries: piece.entries,
        live: runIsLive && index === pieces.length - 1,
        runningTurnId: input.isWorking ? unsettledTurnId : null,
        pendingApprovals,
      });
      if (!card) return;
      const groupId = workGroupId(pieceFirst.id, pieceFirst);
      nextRows.push({
        kind: "tool-card",
        id: `tool-card:${identity}`,
        createdAt: pieceFirst.createdAt,
        groupId,
        card,
        expanded: input.toolCardOpenOverrides?.get(groupId) ?? card.live,
        showAllCalls: input.expandedWorkGroupIds?.has(groupId) ?? false,
      });
    });
  };

  const appendLogEntries = (entries: ReadonlyArray<WorkLogEntry>) => {
    const first = entries[0];
    if (!first) return;
    const steps = entries.filter((entry) => workEntryIsVisibleInGroup(entry));
    if (steps.length === 0) return;
    if (steps.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
      nextRows.push({
        kind: "work",
        id: first.id,
        createdAt: first.createdAt,
        groupedEntries: steps,
      });
      return;
    }
    const groupId = workGroupId(first.id, first);
    const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
    // Agent-spawn CTA rows are always visible: a running fleet must
    // never hide behind a "+N log entries" toggle. Selection is by
    // membership (spawn OR recent-tail), preserving the group's
    // chronological order in both collapsed and expanded states
    // (review finding: concatenating two filtered lists moved a
    // mid-group spawn row above earlier rows).
    const overflowCandidates = steps.filter((entry) => entry.agentSpawn === undefined);
    const hiddenEntries = overflowCandidates.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
    const hiddenIds = new Set(hiddenEntries.map((entry) => entry.id));
    const renderedEntries = expanded
      ? steps
      : steps.filter((entry) => entry.agentSpawn !== undefined || !hiddenIds.has(entry.id));
    for (const workEntry of renderedEntries) {
      nextRows.push({
        kind: "work",
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        groupedEntries: [workEntry],
      });
    }
    if (hiddenEntries.length > 0) {
      const latestEntry = steps.at(-1);
      nextRows.push({
        kind: "work-toggle",
        id: `work-toggle:${first.id}`,
        createdAt: first.createdAt,
        groupId,
        hiddenCount: hiddenEntries.length,
        expanded,
        hasFailure:
          latestEntry !== undefined &&
          workEntryDisplayIndicatesToolFailure(latestEntry) &&
          hiddenEntries.some(workEntryDisplayIndicatesToolFailure),
      });
    }
  };

  const cadCommentRows = mergeCadCommentCards(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.turnId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work" && timelineEntry.entry.cadComments !== undefined) {
      const card = cadCommentRows.get(timelineEntry.id);
      if (card)
        nextRows.push({
          kind: "cad-comments",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          card,
        });
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        // A publication merged into a later comments row renders nothing, so it must not split
        // the tool group around it. The row that shows the merged comments ends the group.
        if (
          nextEntry?.kind === "work" &&
          nextEntry.entry.cadComments !== undefined &&
          !cadCommentRows.has(nextEntry.id) &&
          !collapsedEntryIds.has(nextEntry.id)
        ) {
          cursor += 1;
          continue;
        }
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.cadComments !== undefined ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      // Tool calls become cards; other log entries between them split the run, in order.
      const segments: Array<{ joinsToolGroup: boolean; entries: WorkLogEntry[] }> = [];
      for (const entry of groupedEntries) {
        const joinsToolGroup = workEntryJoinsToolGroup(entry);
        const segment = segments.at(-1);
        if (segment?.joinsToolGroup === joinsToolGroup) segment.entries.push(entry);
        else segments.push({ joinsToolGroup, entries: [entry] });
      }
      for (const segment of segments) {
        if (segment.joinsToolGroup) appendToolCard(segment.entries);
        else appendLogEntries(segment.entries);
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "turn-plan") {
      nextRows.push({
        kind: "turn-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnPlan: timelineEntry.turnPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      canRedoWithFeedback:
        showAssistantMeta &&
        !timelineEntry.message.streaming &&
        timelineEntry.message.id === redoableMessageId,
    });
  }

  if (input.isWorking && activeTurnHeaderIndex === input.timelineEntries.length) {
    appendWorkingRow();
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "cad-filmstrip": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.captures.length === bf.captures.length &&
        a.captures.every((capture, index) => capture.captureId === bf.captures[index]?.captureId)
      );
    }

    case "cad-comments":
      return Equal.equals(a.card, (b as typeof a).card);

    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt && a.showThinking === (b as typeof a).showThinking
      );

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare the snapshot's identity fields so an
      // unchanged plan keeps its row reference (virtualization stability).
      return a.createdAt === bp.createdAt && a.turnPlan.plan === bp.turnPlan.plan;
    }

    case "tool-card": {
      const bc = b as typeof a;
      return (
        a.createdAt === bc.createdAt &&
        a.groupId === bc.groupId &&
        a.expanded === bc.expanded &&
        a.showAllCalls === bc.showAllCalls &&
        Equal.equals(a.card, bc.card)
      );
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.canRedoWithFeedback === bm.canRedoWithFeedback
      );
    }
  }
}

const COLLAPSED_USER_MESSAGE_PREVIEW_LINES = 6;
const COLLAPSED_USER_MESSAGE_PREVIEW_CHARS = 280;
// A cut line keeps at least this much budget, so a preview never ends on a stub of a word.
const COLLAPSED_USER_MESSAGE_MIN_CUT_CHARS = 60;

/**
 * The source text shown while a long user message is collapsed. It is cut on whole source
 * lines (a long line at a word boundary, ending in "…"), so the collapsed bubble ends on
 * complete rendered lines instead of a half-hidden one. An unclosed code fence is closed.
 */
export function collapsedUserMessagePreview(text: string): string {
  const kept: string[] = [];
  let budget = COLLAPSED_USER_MESSAGE_PREVIEW_CHARS;
  for (const line of text.trimEnd().split("\n")) {
    if (kept.length === COLLAPSED_USER_MESSAGE_PREVIEW_LINES) break;
    if (line.length <= budget) {
      kept.push(line);
      budget -= line.length;
      continue;
    }
    if (budget >= COLLAPSED_USER_MESSAGE_MIN_CUT_CHARS) {
      const cut = line.slice(0, budget);
      const space = cut.lastIndexOf(" ");
      // Trailing punctuation before the ellipsis reads as a typo (",…"), so it goes too.
      kept.push(`${(space > budget / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`);
    }
    break;
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  if (kept.filter((line) => line.trimStart().startsWith("```")).length % 2 === 1) {
    kept.push("```");
  }
  return kept.join("\n");
}
