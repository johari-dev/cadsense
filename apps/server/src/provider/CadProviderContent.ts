import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CAD_TOOL_INPUTS } from "@cadsense/contracts";
import type { V2ItemCompletedNotification__ThreadItem } from "effect-codex-app-server/schema";

/** Claude exposes CAD tools through the `cadsense_cad` MCP server. */
export const CLAUDE_CAD_TOOL_PREFIX = "mcp__cadsense_cad__";

/**
 * Native image bytes belong in the provider response, not duplicated into event history or
 * WebSocket frames. Any CAD tool can return a render (captures, comment locate and inspect).
 */
export function compactCodexCadItem<T extends V2ItemCompletedNotification__ThreadItem>(item: T): T {
  if (
    item.type !== "dynamicToolCall" ||
    item.namespace != null ||
    !Object.hasOwn(CAD_TOOL_INPUTS, item.tool) ||
    !item.contentItems
  )
    return item;
  return {
    ...item,
    contentItems: item.contentItems.filter((content) => content.type !== "inputImage"),
  };
}

/** Strips images from results of the given CAD tool calls. Callers pass the IDs of in-flight CAD tools. */
export function compactClaudeCadMessage(
  message: Extract<SDKMessage, { type: "user" }>,
  cadToolIds: ReadonlySet<string>,
): Extract<SDKMessage, { type: "user" }> {
  const content = message.message.content;
  if (
    !Array.isArray(content) ||
    !content.some((block) => block.type === "tool_result" && cadToolIds.has(block.tool_use_id))
  )
    return message;
  const { tool_use_result: _nativeResult, ...rest } = message;
  return {
    ...rest,
    message: {
      ...message.message,
      content: content.map((block) =>
        block.type === "tool_result" &&
        cadToolIds.has(block.tool_use_id) &&
        Array.isArray(block.content)
          ? { ...block, content: block.content.filter((part) => part.type !== "image") }
          : block,
      ),
    },
  };
}
