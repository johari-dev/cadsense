import type { ToolCallFacts, ToolCallInputFacts } from "@cadsense/contracts";

/**
 * Reads what chat shows about a tool call from a `tool.*` activity's full payload. Claude
 * reports `data.toolName` / `data.input` / `data.result`; Codex reports `data.item` with `tool`,
 * `arguments`, `contentItems`, `aggregatedOutput`, or an MCP `result`. The server attaches the
 * result as `payload.toolCall` before it slims payloads for clients, because the slimmed
 * payload no longer holds the output these facts come from.
 */
export function toolCallFactsForActivity(
  kind: string,
  payload: unknown,
): ToolCallFacts | undefined {
  if (kind !== "tool.started" && kind !== "tool.updated" && kind !== "tool.completed") {
    return undefined;
  }
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  const item = asRecord(data?.item);
  const status = record?.status ?? item?.status;
  return deriveToolCallFacts(data, item, {
    // Results are read only from the completion; in-progress updates carry truncated previews.
    terminal: kind === "tool.completed",
    failed: status === "failed" || status === "declined" || item?.success === false,
  });
}

const LINE_MAX_LENGTH = 160;

function deriveToolCallFacts(
  data: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
  options: { terminal: boolean; failed: boolean },
): ToolCallFacts | undefined {
  const identity = toolIdentity(data, item);
  const input = inputFacts(
    asRecord(data?.input) ?? asRecord(item?.arguments) ?? asRecord(item?.input),
    item,
  );
  const output = options.terminal ? toolOutputText(data, item) : null;
  const errorText = output !== null && options.failed ? toolErrorText(output) : null;
  const resultSummary =
    output !== null && !options.failed && identity.name !== undefined
      ? summarizeResult(identity.name, output)
      : null;
  const facts: ToolCallFacts = {
    ...identity,
    ...(input ? { input } : {}),
    ...(resultSummary ? { resultSummary } : {}),
    ...(errorText ? { errorText } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function toolIdentity(
  data: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): { name?: string; server?: string } {
  const qualified = asString(data?.toolName);
  if (qualified) {
    // Claude names MCP tools `mcp__<server>__<tool>`.
    const mcp = /^mcp__(.+?)__(.+)$/u.exec(qualified);
    return mcp?.[1] && mcp[2] ? { server: mcp[1], name: mcp[2] } : { name: qualified };
  }
  const tool = asString(item?.tool);
  if (!tool) return {};
  const server = asString(item?.server) ?? asString(item?.namespace);
  return server ? { name: tool, server } : { name: tool };
}

/** Keeps only what labels name, so the facts stay small however large the input is. */
function inputFacts(
  input: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): ToolCallInputFacts | undefined {
  const path = line(input?.file_path ?? input?.notebook_path ?? input?.path);
  const pattern = line(input?.pattern);
  const query = line(input?.query ?? input?.nameQuery ?? item?.query);
  const url = line(input?.url);
  const mode = line(input?.mode);
  const operations = Array.isArray(input?.operations)
    ? input.operations.flatMap((value) => {
        const operation = asRecord(value);
        const type = asString(operation?.type);
        if (!type) return [];
        const parts = operation?.occurrenceIds;
        return [{ type, partCount: Array.isArray(parts) ? parts.length : 0 }];
      })
    : null;
  const list = [input?.items, input?.picks, input?.candidateIds].find(Array.isArray);
  const facts: ToolCallInputFacts = {
    ...(path ? { path } : {}),
    ...(pattern ? { pattern } : {}),
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    ...(mode ? { mode } : {}),
    ...(operations ? { operations } : {}),
    ...(list ? { itemCount: list.length } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function toolOutputText(
  data: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): string | null {
  return (
    textContent(asRecord(data?.result)?.content) ??
    textContent(item?.contentItems) ??
    textContent(asRecord(item?.result)?.content) ??
    textContent(item?.aggregatedOutput)
  );
}

/** A string, or the joined `text` parts of a content array. */
function textContent(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  if (!Array.isArray(value)) return null;
  const texts = value.flatMap((part) => {
    const text = asRecord(part)?.text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : null;
}

function summarizeResult(name: string, output: string): string | null {
  switch (name) {
    case "cad_find_parts": {
      const total = asNumber(parseJsonRecord(output)?.totalMatches);
      return total === null ? null : plural(total, "match", "matches");
    }
    case "cad_hierarchy":
      return pagedCount(parseJsonRecord(output), "entries", "component", "components");
    case "cad_checks": {
      const total = asNumber(asRecord(parseJsonRecord(output)?.summary)?.totalFindings);
      return total === null ? null : plural(total, "finding", "findings");
    }
    case "cad_comments_list":
      return pagedCount(parseJsonRecord(output), "comments", "comment", "comments");
    case "cad_comments_publish": {
      const results = parseJsonRecord(output)?.results;
      return Array.isArray(results) ? `${results.length} published` : null;
    }
    case "cad_measure": {
      const result = parseJsonRecord(output);
      const meters = asNumber(result?.distanceMeters);
      return result?.status === "measured" && meters !== null
        ? `${(meters * 1000).toFixed(1)} mm`
        : null;
    }
    case "Read": {
      // Claude numbers each line it returns: "     1\tcontent" or "     1→content".
      const lines = output.split("\n").filter((text) => /^\s*\d+[\t→]/u.test(text)).length;
      return lines > 0 ? plural(lines, "line", "lines") : null;
    }
    case "Grep": {
      const found = /^Found (\d+) files?\b/u.exec(output);
      return found ? plural(Number(found[1]), "file", "files") : null;
    }
    case "WebSearch": {
      const results = output.match(/"url":/gu)?.length ?? 0;
      return results > 0 ? plural(results, "result", "results") : null;
    }
    default:
      return null;
  }
}

/** Counts a list in the result; a next-page cursor means there are more than it holds. */
function pagedCount(
  result: Record<string, unknown> | null,
  key: string,
  singular: string,
  pluralNoun: string,
): string | null {
  const list = result?.[key];
  if (!Array.isArray(list)) return null;
  const more = typeof result?.nextCursor === "string" && result.nextCursor.length > 0;
  return `${list.length}${more ? "+" : ""} ${list.length === 1 && !more ? singular : pluralNoun}`;
}

/** The error's first meaningful line: a tool error's `details`, or the first output line. */
function toolErrorText(output: string): string | null {
  const error = parseJsonRecord(output);
  const reason = asString(error?.reason);
  const message =
    asString(error?.details) ??
    asString(error?.message) ??
    asString(error?.error) ??
    (reason ? humanize(reason) : null);
  const text = message ?? output.replace(/<\/?tool_use_error>/gu, "");
  const first = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !/^Exit code \d+$/iu.test(candidate));
  return first ? line(first) : null;
}

/** First line of a string, cut to a short length. */
function line(value: unknown): string | null {
  const first = asString(value)?.split("\n")[0]?.trim();
  if (!first) return null;
  return first.length > LINE_MAX_LENGTH
    ? `${first.slice(0, LINE_MAX_LENGTH - 1).trimEnd()}…`
    : first;
}

function humanize(value: string): string {
  const words = value.replace(/[-_]+/gu, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function plural(count: number, singular: string, pluralNoun: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralNoun}`;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
