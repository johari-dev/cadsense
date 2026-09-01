import { describe, expect, it } from "vite-plus/test";
import {
  computeMessageDurationStart,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  shouldPreserveAssistantLineBreaks,
} from "./MessagesTimeline.logic";

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
