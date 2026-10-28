import type { ApprovalRequestId, ToolCallInputFacts, TurnId } from "@cadsense/contracts";

import {
  formatDuration,
  workEntryDisplayIndicatesToolFailure,
  type PendingApproval,
  type WorkLogEntry,
} from "../../session-logic";

/** What a call does, for its icon. CAD tools split by what the user sees change. */
export type ToolCallKind =
  | "cad-capture"
  | "cad-view"
  | "cad"
  | "comments"
  | "read"
  | "edit"
  | "shell"
  | "search"
  | "web"
  | "mcp"
  | "generic";

export type ToolCallStatus = "running" | "done" | "failed" | "approval";

export interface ToolCallRow {
  id: string;
  entry: WorkLogEntry;
  kind: ToolCallKind;
  status: ToolCallStatus;
  /** Present tense while running, past tense when done, "Could not …" when failed. */
  label: string;
  /** A count or value the result states, e.g. "4 matches". */
  summary: string | null;
  duration: string | null;
  /** First line of a failed call's error. */
  error: string | null;
  /** The pending approval this call waits on. */
  approval: PendingApproval | null;
}

export interface ToolCallCard {
  calls: ToolCallRow[];
  /** More calls may still join: the card is the running turn's latest output. */
  live: boolean;
  title: string;
  /** Distinct kinds in call order, for the header's icon stack. */
  kinds: ToolCallKind[];
  failedCount: number;
  awaitingApproval: boolean;
  /** Wall-clock span from the first start to the last completion, once the card is done. */
  duration: string | null;
}

const HEADER_ICON_LIMIT = 4;
const CAD_KINDS: ReadonlySet<ToolCallKind> = new Set([
  "cad-capture",
  "cad-view",
  "cad",
  "comments",
]);

export function toolCallKindIsCad(kind: ToolCallKind): boolean {
  return CAD_KINDS.has(kind);
}

/**
 * Builds one card from a run of consecutive, already visible tool entries. Approval entries
 * render only while their request is pending: on the call they gate when the provider linked
 * it, otherwise as their own row.
 */
export function buildToolCallCard(input: {
  entries: ReadonlyArray<WorkLogEntry>;
  live: boolean;
  runningTurnId: TurnId | null;
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>;
}): ToolCallCard | null {
  const pendingApprovalFor = (entry: WorkLogEntry) =>
    entry.sourceActivityKind === "approval.requested" && entry.approvalRequestId
      ? (input.pendingApprovals.get(entry.approvalRequestId) ?? null)
      : null;
  const approvalByToolCallId = new Map<string, PendingApproval>();
  for (const entry of input.entries) {
    const approval = pendingApprovalFor(entry);
    if (approval && entry.toolCallId) approvalByToolCallId.set(entry.toolCallId, approval);
  }
  const linkedCallIds = new Set(
    input.entries.flatMap((entry) =>
      entry.sourceActivityKind !== "approval.requested" &&
      entry.toolCallId &&
      approvalByToolCallId.has(entry.toolCallId)
        ? [entry.toolCallId]
        : [],
    ),
  );

  const calls = input.entries.flatMap((entry): ToolCallRow[] => {
    if (entry.approvalRequestId !== undefined) {
      const approval = pendingApprovalFor(entry);
      // Answered requests, and requests shown on their call, add no row of their own.
      if (!approval || (entry.toolCallId && linkedCallIds.has(entry.toolCallId))) return [];
      return [toolCallRow(entry, "approval", approval)];
    }
    const approval = entry.toolCallId ? (approvalByToolCallId.get(entry.toolCallId) ?? null) : null;
    const status: ToolCallStatus = approval
      ? "approval"
      : workEntryDisplayIndicatesToolFailure(entry)
        ? "failed"
        : entry.toolLifecycleStatus === "inProgress" &&
            input.runningTurnId !== null &&
            entry.turnId === input.runningTurnId
          ? "running"
          : "done";
    return [toolCallRow(entry, status, approval)];
  });
  if (calls.length === 0) return null;

  const awaitingApproval = calls.some((call) => call.status === "approval");
  const live = input.live || awaitingApproval || calls.some((call) => call.status === "running");
  const count = `${calls.length} ${calls.length === 1 ? "tool" : "tools"}`;
  return {
    calls,
    live,
    title: awaitingApproval ? "Waiting for approval" : live ? `Using ${count}` : `Used ${count}`,
    kinds: [...new Set(calls.map((call) => call.kind))].slice(0, HEADER_ICON_LIMIT),
    failedCount: calls.filter((call) => call.status === "failed").length,
    awaitingApproval,
    duration: live ? null : spanDuration(calls.map((call) => call.entry)),
  };
}

function toolCallRow(
  entry: WorkLogEntry,
  status: ToolCallStatus,
  approval: PendingApproval | null,
): ToolCallRow {
  const kind = toolCallKind(entry);
  return {
    // A call's entry id changes when its completion merges in; its call id does not.
    id:
      entry.toolCallId && entry.approvalRequestId === undefined
        ? `tool:${entry.toolCallId}`
        : entry.id,
    entry,
    kind,
    status,
    label: toolCallLabel(entry, kind, status),
    summary: status === "done" ? (entry.toolCall?.resultSummary ?? null) : null,
    duration: status === "done" || status === "failed" ? callDuration(entry) : null,
    error:
      status === "failed"
        ? (entry.toolCall?.errorText ??
          firstLine(entry.detail) ??
          (entry.toolLifecycleStatus === "declined" ? "Declined" : null))
        : null,
    approval,
  };
}

/** Tool name as the provider reported it, without MCP qualifiers. */
function toolName(entry: WorkLogEntry): string {
  if (entry.toolCall?.name) return entry.toolCall.name;
  const title = (entry.toolTitle ?? entry.label).replace(
    /\s+(?:started|complete|completed)\s*$/iu,
    "",
  );
  return (
    title
      .split(/\s*·\s*|__/u)
      .at(-1)
      ?.trim() ?? ""
  );
}

export function toolCallKind(entry: WorkLogEntry): ToolCallKind {
  const name = toolName(entry);
  if (name === "cad_capture" || entry.cadCapture !== undefined) return "cad-capture";
  if (name === "cad_update_view") return "cad-view";
  if (name.startsWith("cad_comment")) return "comments";
  if (name.startsWith("cad_")) return "cad";
  if (entry.itemType === "command_execution" || name === "Bash") return "shell";
  if (
    entry.itemType === "file_change" ||
    ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)
  )
    return "edit";
  if (name === "Read" || name === "Read File" || entry.itemType === "image_view") return "read";
  if (name === "Grep" || name === "Glob") return "search";
  if (entry.itemType === "web_search" || name === "WebSearch" || name === "WebFetch") return "web";
  if (entry.itemType === "mcp_tool_call") return "mcp";
  if (entry.approvalRequestId !== undefined) {
    if (entry.requestKind === "command") return "shell";
    if (entry.requestKind === "file-change") return "edit";
  }
  return "generic";
}

/** A label's verb in each tense: present participle, past, and base ("Could not <base>"). */
type Verb = readonly [running: string, done: string, base: string];

const VERBS = {
  ask: ["Asking", "Asked", "ask"],
  browse: ["Browsing", "Browsed", "browse"],
  call: ["Calling", "Called", "call"],
  capture: ["Capturing", "Captured", "capture"],
  change: ["Changing", "Changed", "change"],
  check: ["Checking", "Checked", "check"],
  compare: ["Comparing", "Compared", "compare"],
  edit: ["Editing", "Edited", "edit"],
  explode: ["Exploding", "Exploded", "explode"],
  fetch: ["Fetching", "Fetched", "fetch"],
  find: ["Finding", "Found", "find"],
  hide: ["Hiding", "Hid", "hide"],
  isolate: ["Isolating", "Isolated", "isolate"],
  list: ["Listing", "Listed", "list"],
  measure: ["Measuring", "Measured", "measure"],
  move: ["Moving", "Moved", "move"],
  place: ["Placing", "Placed", "place"],
  publish: ["Publishing", "Published", "publish"],
  read: ["Reading", "Read", "read"],
  run: ["Running", "Ran", "run"],
  search: ["Searching", "Searched", "search"],
  show: ["Showing", "Showed", "show"],
  update: ["Updating", "Updated", "update"],
  use: ["Using", "Used", "use"],
  write: ["Writing", "Wrote", "write"],
} as const satisfies Record<string, Verb>;

type Phrase = readonly [verb: Verb, object: string];

function toolCallLabel(entry: WorkLogEntry, kind: ToolCallKind, status: ToolCallStatus): string {
  const [verb, object] = toolCallPhrase(entry, kind);
  const text = (word: string) => (object ? `${word} ${object}` : word);
  switch (status) {
    case "running":
      return text(verb[0]);
    case "done":
      return text(verb[1]);
    case "failed":
      return `Could not ${text(verb[2])}`;
    case "approval":
      return text(`${verb[2].charAt(0).toUpperCase()}${verb[2].slice(1)}`);
  }
}

function toolCallPhrase(entry: WorkLogEntry, kind: ToolCallKind): Phrase {
  const name = toolName(entry);
  const input: ToolCallInputFacts = entry.toolCall?.input ?? {};
  if (entry.approvalRequestId !== undefined) return approvalPhrase(entry);
  switch (kind) {
    case "cad-capture":
      return [VERBS.capture, "a CAD view"];
    case "cad-view":
      return cadViewPhrase(input);
    case "comments":
      return commentsPhrase(name, input);
    case "cad":
      return cadPhrase(name, input);
    case "read":
      return [VERBS.read, fileName(input.path) ?? "a file"];
    case "edit":
      return [name === "Write" ? VERBS.write : VERBS.edit, editedFiles(entry, input)];
    case "shell":
      return [VERBS.run, commandLine(entry.command) ?? "a command"];
    case "search":
      return name === "Glob"
        ? [VERBS.find, quoted("files matching", input.pattern) ?? "files"]
        : [VERBS.search, quoted("for", input.pattern) ?? "files"];
    case "web":
      if (name === "WebFetch") return [VERBS.fetch, hostName(input.url) ?? "a web page"];
      return [VERBS.search, quoted("the web for", input.query) ?? "the web"];
    case "mcp":
    case "generic":
      if (name === "AskUserQuestion") return [VERBS.ask, "a question"];
      return [VERBS.call, readableName(name) || "a tool"];
  }
}

function approvalPhrase(entry: WorkLogEntry): Phrase {
  switch (entry.requestKind) {
    case "command":
      return [VERBS.run, "a command"];
    case "file-change":
      return [VERBS.change, "files"];
    case "file-read":
      return [VERBS.read, "a file"];
    default:
      return [VERBS.use, "a tool"];
  }
}

function cadViewPhrase(input: ToolCallInputFacts): Phrase {
  const operations = input.operations ?? [];
  for (const [type, verb] of [
    ["isolate", VERBS.isolate],
    ["hide", VERBS.hide],
    ["show", VERBS.show],
  ] as const) {
    const operation = operations.find((candidate) => candidate.type === type);
    if (operation) return [verb, count(operation.partCount, "part", "parts") ?? "parts"];
  }
  if (operations.some((operation) => operation.type === "explode"))
    return [VERBS.explode, "the assembly"];
  if (
    operations.length > 0 &&
    operations.every((operation) => /^(?:camera|fit)/u.test(operation.type))
  )
    return [VERBS.move, "the CAD camera"];
  return [VERBS.update, "the CAD view"];
}

function commentsPhrase(name: string, input: ToolCallInputFacts): Phrase {
  switch (name) {
    case "cad_comments_publish":
      return [VERBS.publish, count(input.itemCount, "comment", "comments") ?? "comments"];
    case "cad_comment_locate":
      return [
        VERBS.place,
        count(input.itemCount, "comment marker", "comment markers") ?? "comment markers",
      ];
    case "cad_comment_inspect":
      return [
        VERBS.check,
        count(input.itemCount, "comment marker", "comment markers") ?? "comment markers",
      ];
    default:
      return [VERBS.read, "CAD comments"];
  }
}

function cadPhrase(name: string, input: ToolCallInputFacts): Phrase {
  switch (name) {
    case "cad_context":
      return [VERBS.read, "the CAD context"];
    case "cad_hierarchy":
      return [VERBS.browse, "the assembly tree"];
    case "cad_checks":
      return [VERBS.run, "CAD checks"];
    case "cad_find_parts":
      return [VERBS.find, quoted("parts named", input.query) ?? "parts"];
    case "cad_measure":
      return [VERBS.measure, input.mode ? readableName(input.mode) : "the model"];
    case "cad_diff":
      return [VERBS.compare, "CAD revisions"];
    default:
      return [VERBS.use, readableName(name.replace(/^cad_/u, "CAD "))];
  }
}

/** A shell command's first line, marked when more lines follow. */
function commandLine(command: string | undefined): string | null {
  const lines = command?.trim().split("\n") ?? [];
  const first = lines[0]?.trim();
  if (!first) return null;
  return lines.length > 1 ? `${first}…` : first;
}

function editedFiles(entry: WorkLogEntry, input: ToolCallInputFacts): string {
  const files = entry.changedFiles?.length ? entry.changedFiles : input.path ? [input.path] : [];
  const first = fileName(files[0]);
  if (!first) return "files";
  return files.length > 1 ? `${first} +${files.length - 1} more` : first;
}

function quoted(prefix: string, value: string | undefined): string | null {
  return value ? `${prefix} "${value}"` : null;
}

function fileName(value: string | undefined): string | null {
  if (!value) return null;
  return (
    value
      .replace(/\\/gu, "/")
      .split("/")
      .findLast((part) => part.length > 0) ?? null
  );
}

function hostName(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function count(value: number | undefined, singular: string, plural: string): string | null {
  if (value === undefined || value === 0) return null;
  return `${value} ${value === 1 ? singular : plural}`;
}

function readableName(name: string): string {
  return name.replace(/[_-]+/gu, " ").trim();
}

function firstLine(text: string | undefined): string | null {
  return (
    text
      ?.split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? null
  );
}

function callDuration(entry: WorkLogEntry): string | null {
  const span = callSpan(entry);
  return span === null ? null : formatDuration(span.end - span.start);
}

/** Calls run in parallel, so a card's duration is its wall-clock span, not a sum. */
function spanDuration(entries: ReadonlyArray<WorkLogEntry>): string | null {
  const spans = entries.flatMap((entry) => callSpan(entry) ?? []);
  if (spans.length === 0) return null;
  const start = Math.min(...spans.map((span) => span.start));
  const end = Math.max(...spans.map((span) => span.end));
  return formatDuration(end - start);
}

/** Start and end in ms, or null when either timestamp is missing or they are out of order. */
function callSpan(entry: WorkLogEntry): { start: number; end: number } | null {
  if (!entry.startedAt || !entry.completedAt) return null;
  const start = Date.parse(entry.startedAt);
  const end = Date.parse(entry.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}
