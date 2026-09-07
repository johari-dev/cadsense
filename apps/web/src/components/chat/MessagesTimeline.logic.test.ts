import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@cadsense/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  computeMessageDurationStart,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  shouldPreserveAssistantLineBreaks,
} from "./MessagesTimeline.logic";

it("keeps captured images visible outside collapsed turn and work-log details", () => {
  const turnId = TurnId.make("captured-turn");
  const capture = {
    captureId: "00000000-0000-4000-8000-000000000001",
    snapshotId: "00000000-0000-4000-8000-000000000002",
    revision: 1,
  };
  const entries: TimelineEntry[] = [0, 1, 2].map((index) => ({
    kind: "work",
    id: `work-${index}`,
    createdAt: `2026-09-06T00:00:0${index}Z`,
    entry: {
      id: `work-${index}`,
      createdAt: `2026-09-06T00:00:0${index}Z`,
      turnId,
      tone: "info",
      label: index === 1 ? "CAD view captured" : "Other work",
      ...(index === 1 ? { cadCapture: capture } : {}),
    },
  }));
  for (const isWorking of [true, false]) {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking,
      runningTurnId: isWorking ? turnId : null,
      activeTurnStartedAt: isWorking ? entries[0]!.createdAt : null,
    });
    expect(
      rows.some(
        (row) =>
          row.kind === "work" &&
          row.groupedEntries.some((entry) => entry.cadCapture?.captureId === capture.captureId),
      ),
    ).toBe(true);
  }
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
