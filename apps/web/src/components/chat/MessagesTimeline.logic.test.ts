import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@cadsense/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  collapsedUserMessagePreview,
  deriveMessagesTimelineRows,
  computeMessageDurationStart,
  knownToolActionLabel,
  normalizeCompactToolLabel,
  timelineShowsCadActivity,
  resolveAssistantMessageCopyState,
  shouldPreserveAssistantLineBreaks,
} from "./MessagesTimeline.logic";

it("labels CAD tools the same way for every provider title format", () => {
  for (const title of [
    "cad_capture",
    "cadsense_cad · cad_capture",
    "mcp__cadsense_cad__cad_capture",
  ])
    expect(knownToolActionLabel(title)).toBe("Looking at CAD");
  expect(knownToolActionLabel("MCP tool call")).toBeUndefined();
});

it("keeps CAD activity tied to the live chat row, including completed tool gaps", () => {
  const turnId = TurnId.make("cad-turn");
  const createdAt = "2026-09-07T00:00:00Z";
  // Codex dynamic tools, prefixed MCP names, and Claude's `server · tool` MCP titles.
  for (const toolTitle of [
    "cad_capture",
    "cad_comments_publish",
    "mcp__cad__cad_update_view",
    "cad_find_parts",
    "mcp__cad__cad_find_parts",
    "cadsense_cad · cad_capture",
  ]) {
    for (const toolLifecycleStatus of ["inProgress", "completed"] as const) {
      const timelineEntries: TimelineEntry[] = [
        {
          kind: "work",
          id: "cad-work",
          createdAt,
          entry: {
            id: "cad-work",
            createdAt,
            turnId,
            tone: "info",
            label: toolTitle,
            toolTitle,
            itemType: "dynamic_tool_call",
            toolLifecycleStatus,
          },
        },
      ];
      const derive = (isWorking: boolean) =>
        deriveMessagesTimelineRows({
          timelineEntries,
          isWorking,
          runningTurnId: isWorking ? turnId : null,
          activeTurnStartedAt: createdAt,
        });
      expect(timelineShowsCadActivity(derive(true))).toBe(true);
      expect(timelineShowsCadActivity(derive(false))).toBe(false);
      timelineEntries.push({
        kind: "work",
        id: "next-work",
        createdAt,
        entry: {
          id: "next-work",
          createdAt,
          turnId,
          tone: "info",
          label: "Read File",
          toolTitle: "Read File",
          itemType: "dynamic_tool_call",
          toolLifecycleStatus: "inProgress",
        },
      });
      expect(timelineShowsCadActivity(derive(true))).toBe(false);
    }
  }
});

describe("captured images in turn folds", () => {
  const turnId = TurnId.make("captured-turn");
  const entries: TimelineEntry[] = [0, 1, 2, 3, 4].map((index) => {
    const id = `entry-${index}`;
    const createdAt = `2026-09-06T00:00:0${index}Z`;
    if (index % 2 === 0) {
      return {
        kind: "message",
        id,
        createdAt,
        message: {
          id: MessageId.make(id),
          role: "assistant",
          text: `Commentary ${index}`,
          turnId,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      };
    }
    return {
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId,
        tone: "info",
        label: "CAD view captured",
        cadCapture: {
          captureId: `00000000-0000-4000-8000-00000000000${index}`,
          snapshotId: "00000000-0000-4000-8000-000000000002",
          revision: 1,
        },
      },
    };
  });

  it("collapses screenshots with commentary and restores their chronological order", () => {
    for (const expanded of [false, true, false]) {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        isWorking: false,
        activeTurnStartedAt: null,
        expandedTurnIds: expanded ? new Set([turnId]) : new Set(),
      });
      expect(rows.map((row) => row.id)).toEqual(
        expanded
          ? [
              "entry-0",
              `turn-fold:${turnId}`,
              "cad-filmstrip:entry-1",
              "entry-2",
              "cad-filmstrip:entry-3",
              "entry-4",
            ]
          : ["entry-0", `turn-fold:${turnId}`, "entry-4"],
      );
      expect(rows.find((row) => row.kind === "turn-fold")).toMatchObject({
        label: "Worked for 4.0s",
        expanded,
      });
      expect(
        rows.flatMap((row) => (row.kind === "cad-filmstrip" ? row.captures : [])),
      ).toHaveLength(expanded ? 2 : 0);
    }
  });

  it("keeps screenshots visible in sequence while the turn is running", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: true,
      runningTurnId: turnId,
      activeTurnStartedAt: entries[0]!.createdAt,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      ...entries.map((entry) => (entry.kind === "work" ? `cad-filmstrip:${entry.id}` : entry.id)),
    ]);
  });
});

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves insight blocks without changing ordinary markdown", () => {
    expect(shouldPreserveAssistantLineBreaks("★ Insight ───\nOne\nTwo\n───")).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("An ordinary\nparagraph")).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("measures the first assistant response from the preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "user-1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result.get("assistant-1")).toBe("2026-01-01T00:00:00Z");
  });
});

describe("compact message helpers", () => {
  it("normalizes tool labels", () => {
    expect(normalizeCompactToolLabel("  Read   file  ")).toBe("Read   file");
  });

  it("does not expose copy controls for an empty assistant response", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: null, visible: false });
  });
});

describe("CAD review rows", () => {
  const turnId = TurnId.make("cad-review");
  let second = 0;
  const nextTime = () => `2026-09-10T00:00:${String(second++).padStart(2, "0")}Z`;
  const tool = (
    id: string,
    toolTitle: string,
    toolLifecycleStatus: "inProgress" | "completed" = "completed",
  ): TimelineEntry => {
    const createdAt = nextTime();
    return {
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId,
        tone: "tool",
        label: toolTitle,
        toolTitle,
        itemType: "dynamic_tool_call",
        toolLifecycleStatus,
      },
    };
  };
  const capture = (id: string): TimelineEntry => {
    const createdAt = nextTime();
    return {
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId,
        tone: "info",
        label: "CAD view captured",
        cadCapture: {
          captureId: `00000000-0000-4000-8000-0000000000${id.slice(-2)}`,
          snapshotId: "00000000-0000-4000-8000-000000000002",
          revision: 1,
        },
      },
    };
  };
  const published = (
    id: string,
    card: NonNullable<Extract<TimelineEntry, { kind: "work" }>["entry"]["cadComments"]>,
  ): TimelineEntry => {
    const createdAt = nextTime();
    return {
      kind: "work",
      id,
      createdAt,
      entry: { id, createdAt, turnId, tone: "info", label: "Wrote comments", cadComments: card },
    };
  };
  const reply = (id: string): TimelineEntry => {
    const createdAt = nextTime();
    return {
      kind: "message",
      id,
      createdAt,
      message: {
        id: MessageId.make(id),
        role: "assistant",
        text: "The main concern is motor access.",
        turnId,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    };
  };
  const comment = (publicationKey: string, number: number) => ({
    publicationKey,
    commentId: `comment-${number}`,
    number,
    title: `Finding ${number}`,
    severity: null,
    category: null,
    location: "Motor mount",
  });

  it("splits a CAD group at each capture, so its images show in capture order", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        tool("context", "cad_context"),
        tool("claude-capture", "cadsense_cad · cad_capture"),
        capture("capture-01"),
        tool("codex-capture", "cad_capture"),
        capture("capture-02"),
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set([turnId]),
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "turn-fold",
      "tool-card",
      "cad-filmstrip",
      "tool-card",
      "cad-filmstrip",
    ]);
    expect(rows[1]).toMatchObject({ expanded: false, card: { title: "Used 2 tools" } });
    expect(rows[3]).toMatchObject({ expanded: false, card: { title: "Used 1 tool" } });
    expect(
      rows.flatMap((row) =>
        row.kind === "cad-filmstrip" ? row.captures.map((capture) => capture.captureId) : [],
      ),
    ).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
  });

  it("shows each kind of tool in a mixed card's header", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [tool("capture-tool", "cad_capture"), tool("read", "Read File")],
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set([turnId]),
    });
    expect(rows.find((row) => row.kind === "tool-card")).toMatchObject({
      card: { kinds: ["cad-capture", "read"] },
    });
  });

  it("shows the captures so far in order, with the live card after them", () => {
    const entries = [
      tool("capture-tool", "cad_capture"),
      capture("capture-04"),
      tool("adjust", "cad_update_view", "inProgress"),
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: true,
      runningTurnId: turnId,
      activeTurnStartedAt: entries[0]!.createdAt,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "working",
      "tool-card",
      "cad-filmstrip",
      "tool-card",
    ]);
    // The capture ended the first card; the call after the image is the live one.
    expect(rows[1]?.kind === "tool-card" && rows[1].expanded).toBe(false);
    const live = rows[3];
    expect(live?.kind === "tool-card" && live.expanded).toBe(true);
    expect(live?.kind === "tool-card" && live.card.calls.at(-1)?.label).toBe(
      "Updating the CAD view",
    );
  });

  it("keeps rejections that no later publication fixed", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        published("published-5", {
          // Same call: a different finding that happens to share a published title.
          published: [comment("fillet", 5)],
          rejected: [{ publicationKey: "fillet-2", title: "Finding 5", reason: "invalid-input" }],
          proposed: [],
        }),
        // A later conflict on an already-published key is a new failure, not a fix.
        published("published-6", {
          published: [],
          rejected: [{ publicationKey: "fillet", title: "Other", reason: "idempotency-conflict" }],
          proposed: [],
        }),
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set([turnId]),
    });
    const row = rows.find((candidate) => candidate.kind === "cad-comments");
    expect(row?.kind === "cad-comments" && row.card.rejected.map((r) => r.publicationKey)).toEqual([
      "fillet-2",
      "fillet",
    ]);
  });

  it("lists an opened card before its filmstrip", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [tool("look", "cad_capture"), capture("capture-07")],
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set([turnId]),
      toolCardOpenOverrides: new Map([["work-group:look", true]]),
    });
    expect(rows.map((row) => row.kind)).toEqual(["turn-fold", "tool-card", "cad-filmstrip"]);
    expect(rows[1]?.kind === "tool-card" && rows[1].expanded).toBe(true);
  });

  it("merges a turn's publications into one comments row that stays visible when folded", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        tool("publish-1", "cad_comments_publish"),
        published("published-1", {
          published: [comment("first", 1)],
          rejected: [
            { publicationKey: "retried", title: "Finding 2", reason: "invalid-input" },
            { publicationKey: "dropped", title: null, reason: "candidate-expired" },
          ],
          proposed: [],
        }),
        tool("publish-2", "cad_comments_publish"),
        published("published-2", {
          published: [comment("retried", 2)],
          rejected: [],
          proposed: [{ publicationKey: "fixed", commentId: "c0", number: 0, title: "Earlier" }],
        }),
        reply("reply"),
      ],
      isWorking: false,
      activeTurnStartedAt: null,
    });
    expect(rows.map((row) => row.id)).toEqual([`turn-fold:${turnId}`, "published-2", "reply"]);
    // Unfolded, the merged publication does not split the CAD group in two.
    const unfolded = deriveMessagesTimelineRows({
      timelineEntries: [
        tool("publish-3", "cad_comments_publish"),
        published("published-3", { published: [comment("third", 3)], rejected: [], proposed: [] }),
        tool("publish-4", "cad_comments_publish"),
        published("published-4", { published: [comment("fourth", 4)], rejected: [], proposed: [] }),
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set([turnId]),
    });
    expect(unfolded.map((row) => row.kind)).toEqual(["turn-fold", "tool-card", "cad-comments"]);
    const comments = rows[1];
    expect(comments?.kind === "cad-comments" && comments.card).toEqual({
      published: [comment("first", 1), comment("retried", 2)],
      rejected: [{ publicationKey: "dropped", title: null, reason: "candidate-expired" }],
      proposed: [{ publicationKey: "fixed", commentId: "c0", number: 0, title: "Earlier" }],
    });
  });
});

describe("collapsedUserMessagePreview", () => {
  it("keeps whole source lines while they fit", () => {
    const text = ["Intro line.", "", "- one", "- two", "- three", "- four", "- five"].join("\n");
    expect(collapsedUserMessagePreview(text)).toBe(
      ["Intro line.", "", "- one", "- two", "- three", "- four"].join("\n"),
    );
  });

  it("cuts a long line at a word boundary and marks it with an ellipsis", () => {
    const long = `- ${"word ".repeat(100)}`;
    const preview = collapsedUserMessagePreview(`Short intro.\n${long}`);
    const [intro, cut] = preview.split("\n");
    expect(intro).toBe("Short intro.");
    expect(cut?.endsWith("word…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(290);
  });

  it("drops a long line when too little budget is left to show part of it", () => {
    const text = `${"a".repeat(240)}\n${"b ".repeat(100)}`;
    expect(collapsedUserMessagePreview(text)).toBe("a".repeat(240));
  });

  it("closes a code fence the cut left open", () => {
    const text = [
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "```",
    ].join("\n");
    expect(collapsedUserMessagePreview(text).split("\n").at(-1)).toBe("```");
  });
});
