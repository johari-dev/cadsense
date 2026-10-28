import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "../../web/src/lib/contextWindow.ts";
import { deriveWorkLogEntries } from "../../web/src/session-logic.ts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "../src/orchestration/ActivityPayloadProjection.ts";

function makeActivity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    session: null,
  };
}

const fixtures = [
  makeActivity("command", "command_execution", {
    item: {
      command: ["bash", "-lc", "pnpm test"],
      input: { command: "fallback input", ignored: "input bulk" },
      result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
      commandActions: [{ type: "unknown", output: "y".repeat(5_000) }],
    },
    command: "fallback data",
    kind: "execute",
    toolCallId: "tool-command",
    rawOutput: {
      content: "\n```\nfirst useful line\nsecond line",
      stdout: "unused stdout",
      ignored: "raw bulk",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("file-change", "file_change", {
    item: {
      changes: [
        { oldPath: "src/old.ts", newPath: "src/new.ts", patch: "large patch".repeat(1_000) },
        { filePath: "src/second.ts" },
      ],
    },
    ignored: "top-level bulk",
  }),
  makeActivity("dynamic", "dynamic_tool_call", {
    toolCallId: "tool-dynamic",
    rawOutput: {
      stdout: "dynamic summary\nlong output".repeat(1_000),
    },
    ignored: "top-level bulk",
  }),
  makeActivity("collab", "collab_agent_tool_call", {
    kind: "delegate",
    rawOutput: {
      content: "``` \n```",
      stdout: "must not be used when content is present",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("mcp", "mcp_tool_call", {
    item: {
      server: "repository",
      tool: "search",
      arguments: { query: "activity projection" },
      aggregatedOutput: "mcp bulk is dropped",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("search", "web_search", {
    rawOutput: {
      totalFiles: 42,
      truncated: true,
      content: "ignored because totalFiles wins",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("image", "image_view", {
    ignored: "top-level bulk",
  }),
] satisfies ReadonlyArray<OrchestrationThreadActivity>;

describe("projectActivityPayload", () => {
  it("drops unread bulk while retaining command, file, tool, and summary inputs", () => {
    const projected = projectActivityPayload(fixtures[0]!);
    expect(projected.payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: { content: "first useful line" },
      },
    });

    expect(projectActivityPayload(fixtures[1]!).payload).toMatchObject({
      data: {
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }, { path: "src/second.ts" }],
      },
    });
  });

  it("slims MCP tool data to the fields the expanded row renders", () => {
    expect(projectActivityPayload(fixtures[4]!).payload).toEqual({
      itemType: "mcp_tool_call",
      title: "mcp_tool_call",
      detail: "mcp_tool_call detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        },
      },
      toolCall: { name: "search", server: "repository", input: { query: "activity projection" } },
    });
  });

  it("keeps current web-derived output identical for every tool item type", () => {
    for (const activity of fixtures) {
      const projected = projectActivityPayload(activity);
      if (activity === fixtures[4]) {
        // MCP is the one deliberate difference: the expanded row's toolData
        // loses result bulk but keeps the rendered identity fields.
        const [entry] = deriveWorkLogEntries([projected]);
        expect(entry?.toolData).toEqual({
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        });
        continue;
      }
      expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([activity]));
    }
  });

  it("preserves failed stored tool outcomes for the renderer", () => {
    const activities = [
      makeActivity("failed-command", "command_execution", {
        item: {
          command: "vp test run",
          exitCode: 1,
          status: "failed",
        },
      }),
      makeActivity("failed-mcp", "mcp_tool_call", {
        item: {
          server: "simulator",
          tool: "build",
          arguments: {},
          status: "failed",
        },
      }),
    ];

    for (const activity of activities) {
      const projected = projectActivityPayload(activity);
      expect(projected.payload).toMatchObject({ status: "failed" });

      const [webEntry] = deriveWorkLogEntries([projected]);
      expect(webEntry?.toolLifecycleStatus).toBe("failed");
    }
  });

  it("projects snapshot and event transports without mutating their sources", () => {
    const activity = fixtures[0]!;
    const thread = makeThread([activity]);
    const snapshot = { snapshotSequence: 7, thread };
    const projectedSnapshot = projectThreadDetailSnapshot(snapshot);

    expect(projectedSnapshot.thread.activities[0]).not.toBe(activity);
    expect(snapshot.thread.activities[0]).toBe(activity);

    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projectedEvent = projectActivityEvent(event);
    expect(projectedEvent).not.toBe(event);
    expect(
      projectedEvent.type === "thread.activity-appended"
        ? projectedEvent.payload.activity
        : undefined,
    ).toEqual(projectActivityPayload(activity));
    expect(event.payload.activity).toBe(activity);
  });
});

describe("superseded tool.updated snapshot dedup", () => {
  function makeToolLifecycleActivity(
    id: string,
    kind: "tool.updated" | "tool.completed",
    options: {
      readonly turn?: string;
      readonly title?: string;
      readonly detail?: string;
      readonly toolCallId?: string;
    } = {},
  ): OrchestrationThreadActivity {
    const { turn = "turn-a", title = "File change", detail, toolCallId } = options;
    return {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: title,
      payload: {
        itemType: "file_change",
        title,
        ...(detail ? { detail } : {}),
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          toolName: "Edit",
          input: { file_path: "src/app.ts" },
        },
      },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  function projectedIds(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    }).thread.activities.map((activity) => activity.id);
  }

  it("drops updates a later completion supersedes in the same turn", () => {
    const update1 = makeToolLifecycleActivity("upd-1", "tool.updated");
    const update2 = makeToolLifecycleActivity("upd-2", "tool.updated");
    const completed = makeToolLifecycleActivity("done-1", "tool.completed");

    expect(projectedIds([update1, update2, completed])).toEqual([completed.id]);
  });

  it("matches on toolCallId when the adapter emits one", () => {
    const otherCall = makeToolLifecycleActivity("upd-other", "tool.updated", {
      toolCallId: "call-b",
    });
    const update = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const completed = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });

    // Same itemType/title, different call: only call-a's update is superseded.
    expect(projectedIds([otherCall, update, completed])).toEqual([otherCall.id, completed.id]);
  });

  it("keeps updates with no matching completion", () => {
    const inFlight = makeToolLifecycleActivity("upd-live", "tool.updated", { title: "Running" });
    const other = makeToolLifecycleActivity("upd-other", "tool.updated", { title: "Reading" });
    const completed = makeToolLifecycleActivity("done-other", "tool.completed", {
      title: "Reading",
    });

    expect(projectedIds([inFlight, other, completed])).toEqual([inFlight.id, completed.id]);
  });

  it("drops interleaved superseded updates even when a parallel call separates them", () => {
    // Deliberate divergence from the clients' adjacency-based collapse: a
    // superseded update separated from its completion by an interleaved
    // parallel call renders as its own in-flight row on full history, and the
    // snapshot omits it. Its final state still shows via the retained
    // completion (1.5% of dropped rows on real data; see the projection's doc
    // comment).
    const updateA = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const updateB = makeToolLifecycleActivity("upd-b", "tool.updated", { toolCallId: "call-b" });
    const completedA = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });
    const completedB = makeToolLifecycleActivity("done-b", "tool.completed", {
      toolCallId: "call-b",
    });

    expect(projectedIds([updateA, updateB, completedA, completedB])).toEqual([
      completedA.id,
      completedB.id,
    ]);
  });

  it("keeps an update whose completion lives in another turn", () => {
    // Completions in another turn do not supersede this turn's in-flight row.
    const update = makeToolLifecycleActivity("upd-kept", "tool.updated", { turn: "turn-kept" });
    const completed = makeToolLifecycleActivity("done-later", "tool.completed", {
      turn: "turn-reverted",
    });

    expect(projectedIds([update, completed])).toEqual([update.id, completed.id]);
  });

  it("keeps an update that follows its completion", () => {
    // A later update under the same identity is the next call, still in flight.
    const completed = makeToolLifecycleActivity("done-first", "tool.completed");
    const nextCall = makeToolLifecycleActivity("upd-next", "tool.updated");

    expect(projectedIds([completed, nextCall])).toEqual([completed.id, nextCall.id]);
  });

  it("keeps identity-less rows the clients never collapse", () => {
    const anonymous: OrchestrationThreadActivity = {
      id: EventId.make("upd-anon"),
      tone: "tool",
      kind: "tool.updated",
      summary: " ",
      payload: { data: { toolName: "Edit" } },
      turnId: TurnId.make("turn-a"),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    const completed: OrchestrationThreadActivity = {
      ...anonymous,
      id: EventId.make("done-anon"),
      kind: "tool.completed",
    };

    expect(projectedIds([anonymous, completed])).toEqual([anonymous.id, completed.id]);
  });

  it("leaves the collapsed work log identical to the full history", () => {
    const activities = [
      makeToolLifecycleActivity("upd-1", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("upd-2", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("done-1", "tool.completed", { detail: "writing" }),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    const before = deriveWorkLogEntries(activities);
    const after = deriveWorkLogEntries(projected.thread.activities);
    expect(after).toHaveLength(before.length);
    expect(after.map((entry) => entry.label)).toEqual(before.map((entry) => entry.label));
  });
});

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale1 = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = fixtures[0]!;

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale1, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched — the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("keeps a usable meter value for each turn", () => {
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const newerTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-newer");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, newerTurn]),
    });
    const olderActivities = projected.thread.activities.filter(
      (activity) => activity.turnId === TurnId.make("turn-kept"),
    );

    expect(deriveLatestContextWindowSnapshot(olderActivities)).toEqual(
      deriveLatestContextWindowSnapshot([olderTurn]),
    );
  });

  it("matches what the web client derives from the full history", () => {
    const activities = [
      makeContextWindowActivity("ctx-1", 1_000),
      makeContextWindowActivity("ctx-2", 2_000),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot(activities),
    );
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through, the valid row survives, and the
    // client's backward walk resolves the same value as with full history.
    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      valid.id,
      malformed.id,
    ]);
    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot([valid, malformed]),
    );
  });

  it("applies only payload slimming when there are no context-window activities", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([fixtures[4]!]),
    });
    expect(projected.thread.activities).toEqual([projectActivityPayload(fixtures[4]!)]);
  });
});

// Payload shapes are copied from real Claude and Codex runs in the Elevator Cascade fixture.

function projectToolActivity(
  kind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown>,
) {
  return projectActivityPayload({
    id: EventId.make("activity"),
    createdAt: "2026-09-28T18:10:00.000Z",
    kind,
    summary: "Tool call",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
  }).payload as Record<string, unknown>;
}

const claude = (
  toolName: string,
  input: Record<string, unknown>,
  content: unknown,
  status = "completed",
) =>
  projectToolActivity("tool.completed", {
    itemType: toolName.startsWith("mcp__") ? "mcp_tool_call" : "dynamic_tool_call",
    toolCallId: `toolu_${toolName}`,
    status,
    data: { toolName, input, result: { tool_use_id: "toolu", type: "tool_result", content } },
  });

const codex = (tool: string, args: Record<string, unknown>, text: string, status = "completed") =>
  projectToolActivity("tool.completed", {
    itemType: "dynamic_tool_call",
    toolCallId: `exec-${tool}`,
    status,
    data: {
      item: {
        arguments: args,
        contentItems: [{ type: "inputText", text }],
        status,
        success: status === "completed",
        tool,
        type: "dynamicToolCall",
      },
    },
  });

const summaryOf = (payload: Record<string, unknown>) =>
  (payload.toolCall as { resultSummary?: string } | undefined)?.resultSummary;
const cad = (tool: string) => `mcp__cadsense_cad__${tool}`;

describe("tool call facts", () => {
  it("keeps a Codex call's name and inputs, which slimming otherwise drops", () => {
    const payload = codex(
      "cad_update_view",
      { expectedRevision: 0, operations: [{ type: "isolate", occurrenceIds: ["a", "b"] }] },
      JSON.stringify({ revision: 1 }),
    );
    expect(payload.data).toEqual({});
    expect(payload.toolCall).toEqual({
      name: "cad_update_view",
      input: { operations: [{ type: "isolate", partCount: 2 }] },
    });
  });

  it("splits Claude's MCP name and keeps only the inputs labels use", () => {
    const payload = projectToolActivity("tool.updated", {
      itemType: "file_change",
      toolCallId: "toolu_write",
      status: "inProgress",
      data: {
        toolName: "Write",
        input: { file_path: "/repo/notes.md", content: "x".repeat(5000) },
      },
    });
    expect(payload.toolCall).toEqual({ name: "Write", input: { path: "/repo/notes.md" } });
    expect(claude(cad("cad_capture"), { expectedRevision: 0 }, "[Image]").toolCall).toEqual({
      name: "cad_capture",
      server: "cadsense_cad",
    });
  });

  it("keeps facts a persisted, already projected update carries", () => {
    const facts = { name: "Bash" };
    const payload = projectToolActivity("tool.updated", {
      itemType: "command_execution",
      toolCallId: "toolu_bash",
      status: "inProgress",
      toolCall: facts,
      data: { command: "git status" },
    });
    expect(payload.toolCall).toBe(facts);
  });

  it("summarizes only counts the full output states", () => {
    expect(summaryOf(claude(cad("cad_find_parts"), {}, JSON.stringify({ totalMatches: 3 })))).toBe(
      "3 matches",
    );
    expect(summaryOf(codex("cad_find_parts", {}, JSON.stringify({ totalMatches: 1 })))).toBe(
      "1 match",
    );
    expect(
      summaryOf(
        claude(cad("cad_hierarchy"), {}, JSON.stringify({ entries: [{}, {}], nextCursor: "n" })),
      ),
    ).toBe("2+ components");
    expect(
      summaryOf(
        codex("cad_checks", {}, JSON.stringify({ findings: [], summary: { totalFindings: 206 } })),
      ),
    ).toBe("206 findings");
    expect(summaryOf(claude(cad("cad_comments_list"), {}, JSON.stringify({ comments: [] })))).toBe(
      "0 comments",
    );
    expect(
      summaryOf(claude(cad("cad_comments_publish"), {}, JSON.stringify({ results: [{}, {}] }))),
    ).toBe("2 published");
    expect(
      summaryOf(
        claude(
          cad("cad_measure"),
          {},
          JSON.stringify({ status: "measured", distanceMeters: 0.0475640488 }),
        ),
      ),
    ).toBe("47.6 mm");
    expect(
      summaryOf(claude("Read", { file_path: "/a.ts" }, "     1\tone\n     2\ttwo\n     3\tthree")),
    ).toBe("3 lines");
    expect(summaryOf(claude("Grep", { pattern: "x" }, "Found 4 files\na\nb\nc\nd"))).toBe(
      "4 files",
    );
    expect(
      summaryOf(
        claude(
          "WebSearch",
          { query: "q" },
          'Links: [{"title":"a","url":"u1"},{"title":"b","url":"u2"}]',
        ),
      ),
    ).toBe("2 results");
  });

  it("states no summary when the output has no count", () => {
    expect(
      summaryOf(claude(cad("cad_capture"), {}, [{ type: "text", text: "[Image: x.png]" }])),
    ).toBeUndefined();
    expect(
      summaryOf(claude(cad("cad_find_parts"), {}, '{"totalMatches":3,"entr…')),
    ).toBeUndefined();
    expect(
      summaryOf(claude(cad("cad_measure"), {}, JSON.stringify({ status: "failed" }))),
    ).toBeUndefined();
    expect(summaryOf(claude("Grep", { pattern: "x" }, "src/a.ts:12: match"))).toBeUndefined();
    // Results come only from the completion; an update's output is a truncated preview.
    const update = projectToolActivity("tool.updated", {
      itemType: "mcp_tool_call",
      toolCallId: "toolu_find",
      status: "inProgress",
      data: {
        toolName: cad("cad_find_parts"),
        input: {},
        result: { content: JSON.stringify({ totalMatches: 3 }) },
      },
    });
    expect(summaryOf(update)).toBeUndefined();
  });

  it("keeps the first line of a failure for the row's error line", () => {
    const errorOf = (payload: Record<string, unknown>) =>
      (payload.toolCall as { errorText?: string } | undefined)?.errorText;
    const cadError = JSON.stringify({
      _tag: "CadViewError",
      reason: "invalid-operation",
      details: 'Expected a value between 1 and 100\n  at ["limit"]',
    });
    expect(errorOf(codex("cad_checks", { limit: 200 }, cadError, "failed"))).toBe(
      "Expected a value between 1 and 100",
    );
    expect(errorOf(claude(cad("cad_checks"), {}, cadError, "failed"))).toBe(
      "Expected a value between 1 and 100",
    );
    expect(
      errorOf(
        claude(
          cad("cad_find_parts"),
          {},
          JSON.stringify({ _tag: "CadViewError", reason: "revision-conflict" }),
          "failed",
        ),
      ),
    ).toBe("Revision conflict");
    expect(
      errorOf(
        claude(
          "Bash",
          { command: "jq ." },
          "Exit code 127\n/bin/bash: line 4: jq: command not found",
          "failed",
        ),
      ),
    ).toBe("/bin/bash: line 4: jq: command not found");
    expect(
      errorOf(claude(cad("preview_status"), {}, "User cancelled tool execution.", "declined")),
    ).toBe("User cancelled tool execution.");
    // A successful call has no error line.
    expect(errorOf(codex("cad_update_view", {}, JSON.stringify({ revision: 1 })))).toBeUndefined();
  });
});
