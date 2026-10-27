import {
  ApprovalRequestId,
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import { toolCallFactsForActivity } from "@cadsense/shared/toolCallFacts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type PendingApproval,
} from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows, timelineShowsCadActivity } from "./MessagesTimeline.logic";

const turnId = TurnId.make("turn-1");
let nextId = 0;
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 28, 18, 10, 0, seconds * 1000)).toISOString();

/** An activity as the client receives it, with the `toolCall` facts the server attaches. */
function activity(
  kind: OrchestrationThreadActivity["kind"],
  seconds: number,
  payload: Record<string, unknown>,
  summary = "Tool call",
): OrchestrationThreadActivity {
  const toolCall = toolCallFactsForActivity(kind, payload);
  return {
    id: EventId.make(`activity-${nextId++}`),
    createdAt: at(seconds),
    kind,
    summary,
    tone: kind.startsWith("approval.") ? "approval" : "tool",
    payload: toolCall ? { ...payload, toolCall } : payload,
    turnId,
  };
}

/** One Codex-style dynamic tool call: a start and, unless still running, a completion. */
function call(
  id: string,
  tool: string,
  start: number,
  end: number | null,
  options: {
    input?: Record<string, unknown>;
    output?: unknown;
    status?: "completed" | "failed";
  } = {},
): OrchestrationThreadActivity[] {
  const payload = (status: string, contentItems: unknown) => ({
    itemType: "dynamic_tool_call",
    toolCallId: id,
    status,
    data: { item: { arguments: options.input ?? {}, contentItems, tool, type: "dynamicToolCall" } },
  });
  const started = activity("tool.started", start, payload("inProgress", null), `${tool} started`);
  if (end === null) return [started];
  const status = options.status ?? "completed";
  const output =
    typeof options.output === "string" ? options.output : JSON.stringify(options.output ?? {});
  return [
    started,
    activity("tool.completed", end, payload(status, [{ type: "inputText", text: output }]), tool),
  ];
}

function message(id: string, seconds: number, text: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text,
    turnId,
    createdAt: at(seconds),
    updatedAt: at(seconds),
    streaming: false,
  };
}

function rows(
  activities: OrchestrationThreadActivity[],
  options: {
    messages?: ChatMessage[];
    running?: boolean;
    pendingApprovals?: PendingApproval[];
    toolCardOpenOverrides?: ReadonlyMap<string, boolean>;
  } = {},
) {
  const running = options.running ?? false;
  return deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntries(
      options.messages ?? [],
      [],
      deriveWorkLogEntries(activities),
    ),
    isWorking: running,
    runningTurnId: running ? turnId : null,
    activeTurnStartedAt: running ? at(0) : null,
    // Keeps settled turns unfolded, so the cards themselves are visible.
    expandedTurnIds: new Set([turnId]),
    ...(options.pendingApprovals ? { pendingApprovals: options.pendingApprovals } : {}),
    ...(options.toolCardOpenOverrides
      ? { toolCardOpenOverrides: options.toolCardOpenOverrides }
      : {}),
  });
}

/** Row kinds without the settled turn's "Worked for" fold, which these tests do not exercise. */
const kinds = (timelineRows: ReturnType<typeof rows>) =>
  timelineRows.flatMap((row) => (row.kind === "turn-fold" ? [] : [row.kind]));

const cards = (timelineRows: ReturnType<typeof rows>) =>
  timelineRows.flatMap((row) => (row.kind === "tool-card" ? [row] : []));

describe("grouping", () => {
  it("puts consecutive calls in one card and starts a new card after the assistant speaks", () => {
    const timelineRows = rows(
      [
        ...call("a", "cad_context", 1, 2),
        ...call("b", "cad_hierarchy", 2, 3),
        ...call("c", "cad_checks", 5, 6),
      ],
      { messages: [message("m1", 4, "Checking the parts.")] },
    );
    expect(kinds(timelineRows)).toEqual(["tool-card", "message", "tool-card"]);
    expect(cards(timelineRows).map((card) => card.card.calls.length)).toEqual([2, 1]);
  });

  it("keeps a capture inside its card and shows the image once, below the card", () => {
    const timelineRows = rows([
      ...call("look", "cad_capture", 1, 3),
      activity("cad.captured", 2.9, {
        captureId: "00000000-0000-4000-8000-000000000001",
        snapshotId: "00000000-0000-4000-8000-000000000002",
        revision: 0,
      }),
      ...call("next", "cad_checks", 4, 5),
    ]);
    expect(kinds(timelineRows)).toEqual(["tool-card", "cad-filmstrip"]);
    expect(cards(timelineRows)[0]!.card.calls.map((row) => row.kind)).toEqual([
      "cad-capture",
      "cad",
    ]);
  });

  it("does not let a runtime warning join a card", () => {
    const timelineRows = rows([
      ...call("a", "cad_context", 1, 2),
      { ...activity("runtime.warning", 3, {}, "Reconnecting... 2/5"), tone: "info" },
      ...call("b", "cad_checks", 4, 5),
    ]);
    expect(kinds(timelineRows)).toEqual(["tool-card", "work", "tool-card"]);
  });
});

describe("live and finished cards", () => {
  const twoCalls = [
    ...call("look", "cad_capture", 0, 1.2),
    ...call("check", "cad_checks", 1.5, null),
  ];

  it("stays open and present tense while the turn runs, including between calls", () => {
    const [live] = cards(rows(twoCalls, { running: true }));
    expect(live).toMatchObject({ expanded: true, card: { live: true, title: "Using 2 tools" } });
    expect(live!.card.calls.map((row) => [row.status, row.label])).toEqual([
      ["done", "Captured a CAD view"],
      ["running", "Running CAD checks"],
    ]);
    expect(live!.card.duration).toBeNull();

    // The last call finished and the agent is thinking: the card must not flap closed.
    const [between] = cards(rows(call("look", "cad_capture", 0, 1.2), { running: true }));
    expect(between).toMatchObject({ expanded: true, card: { live: true, title: "Using 1 tool" } });
  });

  it("collapses to past tense and wall-clock duration once the answer starts", () => {
    const finished = [
      ...call("look", "cad_capture", 0, 1.2),
      ...call("check", "cad_checks", 0.5, 3, { output: { summary: { totalFindings: 12 } } }),
    ];
    const timelineRows = rows(finished, {
      running: true,
      messages: [message("answer", 4, "Done.")],
    });
    expect(kinds(timelineRows)).toEqual(["working", "tool-card", "message"]);
    const [card] = cards(timelineRows);
    expect(card).toMatchObject({
      expanded: false,
      card: { live: false, title: "Used 2 tools", duration: "3.0s", failedCount: 0 },
    });
    expect(card!.card.calls[1]).toMatchObject({
      label: "Ran CAD checks",
      summary: "12 findings",
      duration: "2.5s",
    });
  });

  it("keeps its id from running to done, so the list keeps the row and its state", () => {
    const [running] = cards(rows(twoCalls, { running: true }));
    const [done] = cards(
      rows([...call("look", "cad_capture", 0, 1.2), ...call("check", "cad_checks", 1.5, 2)]),
    );
    expect(done!.id).toBe(running!.id);
    expect(done!.groupId).toBe(running!.groupId);
  });

  it("lets the user's toggle win over the automatic state", () => {
    const [live] = cards(rows(twoCalls, { running: true }));
    const closed = new Map([[live!.groupId, false]]);
    expect(
      cards(rows(twoCalls, { running: true, toolCardOpenOverrides: closed }))[0]!.expanded,
    ).toBe(false);
    const open = new Map([[live!.groupId, true]]);
    expect(cards(rows(twoCalls, { toolCardOpenOverrides: open }))[0]!.expanded).toBe(true);
  });

  it("hides a call that never finished in a settled turn instead of showing it running forever", () => {
    const [card] = cards(rows(twoCalls));
    expect(card!.card.calls.map((row) => row.label)).toEqual(["Captured a CAD view"]);
  });

  it("shows no duration for a call whose start was never seen", () => {
    const completedOnly = call("look", "cad_capture", 0, 1.2).slice(1);
    const [card] = cards(rows(completedOnly));
    expect(card!.card.calls[0]!.duration).toBeNull();
    expect(card!.card.duration).toBeNull();
  });

  it("follows CAD activity only while a live card's latest call is a CAD tool", () => {
    expect(timelineShowsCadActivity(rows(twoCalls, { running: true }))).toBe(true);
    expect(timelineShowsCadActivity(rows(twoCalls))).toBe(false);
    const thenRead = [
      ...twoCalls,
      activity("tool.started", 3, {
        itemType: "dynamic_tool_call",
        toolCallId: "read",
        status: "inProgress",
        data: { item: { tool: "Read File", arguments: {} } },
      }),
    ];
    expect(timelineShowsCadActivity(rows(thenRead, { running: true }))).toBe(false);
  });
});

describe("failures", () => {
  it("reads 'Could not' with the error line and counts the failure in the header", () => {
    const [card] = cards(
      rows([
        ...call("ok", "cad_context", 0, 1),
        ...call("bad", "cad_checks", 1, 2, {
          status: "failed",
          output: {
            _tag: "CadViewError",
            reason: "invalid-operation",
            details: "Expected a value between 1 and 100",
          },
        }),
      ]),
    );
    expect(card!.card).toMatchObject({ title: "Used 2 tools", failedCount: 1 });
    expect(card!.card.calls[1]).toMatchObject({
      status: "failed",
      label: "Could not run CAD checks",
      error: "Expected a value between 1 and 100",
      summary: null,
    });
  });
});

describe("approvals", () => {
  const requestId = ApprovalRequestId.make("req-1");
  const pending: PendingApproval = {
    requestId,
    requestKind: "command",
    createdAt: at(2),
    detail: "Bash: git status",
  };
  const bashStarted = activity("tool.started", 1, {
    itemType: "command_execution",
    toolCallId: "toolu_bash",
    status: "inProgress",
    // The server's projection copies Claude's `input.command` to `data.command`.
    data: { toolName: "Bash", input: { command: "git status" }, command: "git status" },
  });
  const requested = (toolCallId?: string) =>
    activity(
      "approval.requested",
      2,
      {
        requestId,
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "Bash: git status",
        ...(toolCallId ? { toolCallId } : {}),
      },
      "Command approval requested",
    );

  it("asks inline on the call it gates and says so in the header", () => {
    const [card] = cards(
      rows([...call("look", "cad_capture", 0, 0.5), bashStarted, requested("toolu_bash")], {
        running: true,
        pendingApprovals: [pending],
      }),
    );
    expect(card!.card).toMatchObject({ title: "Waiting for approval", awaitingApproval: true });
    expect(card!.card.calls.map((row) => [row.status, row.label])).toEqual([
      ["done", "Captured a CAD view"],
      ["approval", "Run git status"],
    ]);
    expect(card!.card.calls[1]!.approval?.requestId).toBe(requestId);
  });

  it("shows an approval it cannot link as its own row", () => {
    const [card] = cards(
      rows([bashStarted, requested()], { running: true, pendingApprovals: [pending] }),
    );
    expect(card!.card.calls.map((row) => row.status)).toEqual(["running", "approval"]);
    expect(card!.card.calls[1]!.label).toBe("Run a command");
  });

  it("drops approval bookkeeping rows once the request is answered", () => {
    const [card] = cards(
      rows([
        bashStarted,
        requested("toolu_bash"),
        activity(
          "approval.resolved",
          3,
          {
            requestId,
            requestKind: "command",
            requestType: "command_execution_approval",
            decision: "accept",
          },
          "Approval resolved",
        ),
        activity("tool.completed", 4, {
          itemType: "command_execution",
          toolCallId: "toolu_bash",
          status: "completed",
          data: {
            toolName: "Bash",
            command: "git status",
            result: { content: "clean" },
          },
        }),
      ]),
    );
    expect(card!.card.title).toBe("Used 1 tool");
    expect(card!.card.calls.map((row) => row.label)).toEqual(["Ran git status"]);
  });
});

describe("labels", () => {
  const label = (activities: OrchestrationThreadActivity[]) =>
    cards(rows(activities))[0]!.card.calls.map((row) => row.label);
  const claude = (
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    activity("tool.completed", 1, {
      itemType: "mcp_tool_call",
      toolCallId: `toolu_${nextId}`,
      status: "completed",
      data: { toolName, input, result: { content: "" } },
      ...extra,
    });

  it("names CAD tools the same way for every provider name format", () => {
    expect(
      label([
        claude("mcp__cadsense_cad__cad_capture", {}),
        ...call("codex", "cad_capture", 2, 3),
        activity("tool.completed", 4, {
          itemType: "mcp_tool_call",
          toolCallId: "titled",
          status: "completed",
          title: "cadsense_cad · cad_capture",
        }),
      ]),
    ).toEqual(["Captured a CAD view", "Captured a CAD view", "Captured a CAD view"]);
  });

  it("describes each kind of tool from its real input", () => {
    expect(
      label([
        claude("mcp__cadsense_cad__cad_update_view", {
          operations: [
            { type: "isolate", occurrenceIds: ["a", "b"] },
            { type: "fit", occurrenceIds: [] },
          ],
        }),
        claude("mcp__cadsense_cad__cad_update_view", {
          operations: [{ type: "camera-preset", preset: "top" }],
        }),
        claude("mcp__cadsense_cad__cad_find_parts", { nameQuery: "motor" }),
        claude("mcp__cadsense_cad__cad_comments_publish", { items: [{}, {}] }),
        claude("Read", { file_path: "/repo/src/gearbox.ts" }),
        claude("Edit", { file_path: "/repo/src/gearbox.ts" }, { itemType: "file_change" }),
        claude("Write", { file_path: "/repo/notes.md" }, { itemType: "file_change" }),
        claude("Grep", { pattern: "NEO" }),
        claude("WebSearch", { query: "MAXPlanetary ratio" }, { itemType: "web_search" }),
        claude("WebFetch", { url: "https://www.revrobotics.com/rev-21-1650/" }),
        claude("mcp__cadsense__preview_status", {}),
        claude("TodoWrite", { todos: [] }, { itemType: "dynamic_tool_call" }),
      ]),
    ).toEqual([
      "Isolated 2 parts",
      "Moved the CAD camera",
      'Found parts named "motor"',
      "Published 2 comments",
      "Read gearbox.ts",
      "Edited gearbox.ts",
      "Wrote notes.md",
      'Searched for "NEO"',
      'Searched the web for "MAXPlanetary ratio"',
      "Fetched www.revrobotics.com",
      "Called preview status",
      "Called TodoWrite",
    ]);
  });

  it("uses the command for shell calls, first line only", () => {
    expect(
      label([
        activity("tool.completed", 1, {
          itemType: "command_execution",
          toolCallId: "cmd",
          status: "completed",
          data: {
            item: { type: "commandExecution", command: "/bin/bash -lc 'ls -la\necho done'" },
          },
        }),
      ]),
    ).toEqual(["Ran ls -la…"]);
  });
});
