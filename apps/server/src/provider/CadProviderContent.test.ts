import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vite-plus/test";
import { compactClaudeCadMessage, compactCodexCadItem } from "./CadProviderContent.ts";

it("retains capture metadata without copying native Codex images into event history", () => {
  const item = {
    type: "dynamicToolCall" as const,
    id: "capture",
    tool: "cad_capture",
    arguments: { expectedRevision: 0 },
    status: "completed" as const,
    contentItems: [
      { type: "inputText" as const, text: "managed artifact metadata" },
      { type: "inputImage" as const, imageUrl: "data:image/png;base64,native-bytes" },
    ],
  };
  expect(compactCodexCadItem(item).contentItems).toEqual([item.contentItems[0]]);
  expect(item.contentItems).toHaveLength(2);
  expect(compactCodexCadItem({ ...item, tool: "other_tool" }).contentItems).toHaveLength(2);
  expect(
    compactCodexCadItem({ ...item, tool: "cad_capture", namespace: "other" }).contentItems,
  ).toHaveLength(2);
  // Comment locate and inspect return renders too.
  for (const tool of ["cad_comment_locate", "cad_comment_inspect"])
    expect(compactCodexCadItem({ ...item, tool }).contentItems).toEqual([item.contentItems[0]]);
});

it("removes only CAD tool image echoes from Claude history, preserving native input", () => {
  const message: Extract<SDKMessage, { type: "user" }> = {
    type: "user",
    session_id: "session",
    parent_tool_use_id: null,
    tool_use_result: { image: "native-bytes" },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "capture",
          content: [
            { type: "text", text: "managed artifact metadata" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "native-bytes" },
            },
          ],
        },
      ],
    },
  };
  const compact = compactClaudeCadMessage(message, new Set(["capture"]));
  expect(JSON.stringify(compact)).not.toContain("native-bytes");
  expect(JSON.stringify(compact)).toContain("managed artifact metadata");
  expect(JSON.stringify(message)).toContain("native-bytes");
  expect(compactClaudeCadMessage(message, new Set())).toBe(message);
});
