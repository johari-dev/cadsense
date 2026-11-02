import { EventId, TurnId, type OrchestrationThreadActivity } from "@cadsense/contracts";
import { toolCallFactsForActivity } from "@cadsense/shared/toolCallFacts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";

// Payload shapes are copied from real Claude and Codex runs in the Elevator Cascade fixture.
// Each carries the `toolCall` facts the server's payload projection attaches before sending.

const turnId = TurnId.make("turn-1");
let nextId = 0;

function activity(
  kind: OrchestrationThreadActivity["kind"],
  createdAt: string,
  payload: Record<string, unknown>,
  summary = "Tool call",
): OrchestrationThreadActivity {
  const toolCall = toolCallFactsForActivity(kind, payload);
  return {
    id: EventId.make(`activity-${nextId++}`),
    createdAt: `2026-09-28T18:10:${createdAt}Z`,
    kind,
    summary,
    tone: kind.startsWith("approval.") ? "approval" : "tool",
    payload: toolCall ? { ...payload, toolCall } : payload,
    turnId,
  };
}

const claudeCapture = (status: string) => ({
  itemType: "mcp_tool_call",
  toolCallId: "toolu_capture",
  status,
  detail: 'mcp__cadsense_cad__cad_capture: {"expectedRevision":0}',
  data: { toolName: "mcp__cadsense_cad__cad_capture", input: { expectedRevision: 0 } },
});

const codexChecks = (status: string, contentItems: unknown, success: boolean | null) => ({
  itemType: "dynamic_tool_call",
  toolCallId: "exec-checks",
  status,
  data: {
    item: {
      arguments: { expectedRevision: 0, limit: 200 },
      contentItems,
      id: "exec-checks",
      namespace: null,
      status,
      success,
      tool: "cad_checks",
      type: "dynamicToolCall",
    },
  },
});

describe("tool call lifecycle", () => {
  it("shows a Codex call while it runs, since Codex sends no update between start and completion", () => {
    const started = activity("tool.started", "00.000", codexChecks("inProgress", null, null));
    const running = deriveWorkLogEntries([started]);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      toolLifecycleStatus: "inProgress",
      startedAt: started.createdAt,
    });

    const completed = activity(
      "tool.completed",
      "02.500",
      codexChecks(
        "completed",
        [{ type: "inputText", text: JSON.stringify({ summary: { totalFindings: 206 } }) }],
        true,
      ),
    );
    const done = deriveWorkLogEntries([started, completed]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      toolLifecycleStatus: "completed",
      startedAt: started.createdAt,
      completedAt: completed.createdAt,
      toolCall: { name: "cad_checks", resultSummary: "206 findings" },
    });
  });

  it("keeps a call at its start time so parallel calls do not reorder as updates arrive", () => {
    const first = activity("tool.started", "00.000", claudeCapture("inProgress"));
    const update = activity("tool.updated", "05.000", claudeCapture("inProgress"));
    const entries = deriveWorkLogEntries([first, update]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.createdAt).toBe(first.createdAt);
  });

  it("still omits a start that cannot be matched to its completion", () => {
    const { toolCallId: _omitted, ...withoutId } = claudeCapture("inProgress");
    expect(deriveWorkLogEntries([activity("tool.started", "00.000", withoutId)])).toEqual([]);
  });

  it("has no start time when only the completion was seen", () => {
    const completed = activity("tool.completed", "03.000", claudeCapture("completed"));
    const [entry] = deriveWorkLogEntries([completed]);
    expect(entry?.toolCall).toEqual({ name: "cad_capture", server: "cadsense_cad" });
    expect(entry?.startedAt).toBeUndefined();
    expect(entry?.completedAt).toBe(completed.createdAt);
  });

  it("keeps a failure's error line through the start-to-completion merge", () => {
    const error = JSON.stringify({
      _tag: "CadViewError",
      reason: "invalid-operation",
      details: 'Expected a value between 1 and 100\n  at ["limit"]',
    });
    const [entry] = deriveWorkLogEntries([
      activity("tool.started", "00.000", codexChecks("inProgress", null, null)),
      activity(
        "tool.completed",
        "00.016",
        codexChecks("failed", [{ type: "inputText", text: error }], false),
      ),
    ]);
    expect(entry?.toolCall).toEqual({
      name: "cad_checks",
      errorText: "Expected a value between 1 and 100",
    });
  });
});

describe("approvals", () => {
  it("links an approval to the tool call it gates", () => {
    const [entry] = deriveWorkLogEntries([
      activity(
        "approval.requested",
        "01.000",
        {
          requestId: "req-1",
          requestKind: "command",
          requestType: "command_execution_approval",
          toolCallId: "toolu_bash",
          detail: "Bash: git status",
        },
        "Command approval requested",
      ),
    ]);
    expect(entry).toMatchObject({ approvalRequestId: "req-1", toolCallId: "toolu_bash" });
  });
});
