import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { V2ItemCompletedNotification__ThreadItem } from "effect-codex-app-server/schema";

/** Native image bytes belong in the provider response, not duplicated into event history or WebSocket frames. */
export function compactCodexCadItem<T extends V2ItemCompletedNotification__ThreadItem>(item: T): T {
  if (item.type !== "dynamicToolCall" || item.tool !== "cad_capture" || !item.contentItems)
    return item;
  return {
    ...item,
    contentItems: item.contentItems.filter((content) => content.type !== "inputImage"),
  };
}

export function compactClaudeCadMessage(
  message: Extract<SDKMessage, { type: "user" }>,
  captureToolIds: ReadonlySet<string>,
): Extract<SDKMessage, { type: "user" }> {
  const content = message.message.content;
  if (
    !Array.isArray(content) ||
    !content.some((block) => block.type === "tool_result" && captureToolIds.has(block.tool_use_id))
  )
    return message;
  const { tool_use_result: _nativeResult, ...rest } = message;
  return {
    ...rest,
    message: {
      ...message.message,
      content: content.map((block) =>
        block.type === "tool_result" &&
        captureToolIds.has(block.tool_use_id) &&
        Array.isArray(block.content)
          ? { ...block, content: block.content.filter((part) => part.type !== "image") }
          : block,
      ),
    },
  };
}
