import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@cadsense/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  computeMessageDurationStart,
  normalizeCompactToolLabel,
  timelineShowsCadActivity,
  resolveAssistantMessageCopyState,
  shouldPreserveAssistantLineBreaks,
} from "./MessagesTimeline.logic";

it("keeps CAD activity tied to the live chat row, including completed tool gaps", () => {
  const turnId = TurnId.make("cad-turn");
  const createdAt = "2026-09-07T00:00:00Z";
  for (const toolTitle of ["cad_capture", "cad_comments_publish", "mcp__cad__cad_update_view"]) {
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
          ? ["entry-0", `turn-fold:${turnId}`, "entry-1", "entry-2", "entry-3", "entry-4"]
          : ["entry-0", `turn-fold:${turnId}`, "entry-4"],
      );
      expect(rows.find((row) => row.kind === "turn-fold")).toMatchObject({
        label: "Worked for 4.0s",
        expanded,
      });
      expect(
        rows.flatMap((row) =>
          row.kind === "work" ? row.groupedEntries.map((entry) => entry.cadCapture?.captureId) : [],
        ),
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
      ...entries.map((entry) => entry.id),
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
