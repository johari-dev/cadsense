// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
/**
 * Replays the CAD tool calls from a recorded review (a cad-mcp-review-e2e.ts run) against the
 * current `cadsense mcp`, with no model in the loop, and reports how each cad_comment_locate and
 * cad_comment_inspect call turns out now. Use it to check a change to locating or inspection on the
 * exact views and pixels an agent actually used.
 *
 *   node apps/server/scripts/cad-mcp-replay.ts --run <run dir> --seed-home <data dir> --out <dir>
 *
 * The seed data directory must already hold the run's Onshape microversion (see --seed-home in
 * cad-mcp-review-e2e.ts), so replays make no Onshape requests. Capture, candidate, and snapshot
 * IDs in the recorded calls are mapped to the ones the replay produces. Publications are skipped.
 * Writes replay.json (original and new result for every locate and inspect) and the PNG each new
 * locate or inspect returned.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    run: { type: "string" },
    "seed-home": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.run || !values["seed-home"] || !values.out)
  throw new Error("Usage: --run <run dir> --seed-home <data dir> --out <dir>");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists.`);
NodeFS.mkdirSync(out, { recursive: true });
const home = NodePath.join(out, "home");
NodeFS.cpSync(NodePath.resolve(values["seed-home"]), home, { recursive: true });
NodeFS.rmSync(NodePath.join(home, "reports"), { recursive: true, force: true });

interface RecordedCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
}
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("")
    : String(content ?? "");
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
/** Tool calls in order from a Codex or Claude Code event stream, with their recorded results. */
const recorded: RecordedCall[] = [];
const pendingClaude = new Map<string, { tool: string; args: Record<string, unknown> }>();
for (const line of NodeFS.readFileSync(NodePath.join(values.run, "transcript.jsonl"), "utf8").split(
  "\n",
)) {
  if (!line.startsWith("{")) continue;
  const event = JSON.parse(line);
  const item = event.item;
  if (event.type === "item.completed" && item?.type === "mcp_tool_call")
    recorded.push({
      tool: item.tool,
      args: item.arguments ?? {},
      result: parse(textOf(item.result?.content)),
    });
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use" && String(block.name).startsWith("mcp__cadsense__"))
      pendingClaude.set(block.id, {
        tool: String(block.name).replace("mcp__cadsense__", ""),
        args: block.input ?? {},
      });
    if (block.type === "tool_result" && pendingClaude.has(block.tool_use_id)) {
      const call = pendingClaude.get(block.tool_use_id)!;
      recorded.push({ ...call, result: parse(textOf(block.content)) });
    }
  }
}

// One MCP session over stdio, the way an agent's client speaks to the server.
const server = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.resolve(import.meta.dirname, "../src/bin.ts"), "mcp", "--base-dir", home],
  {
    env: { ...process.env, CADSENSE_TELEMETRY_ENABLED: "false" },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
server.stderr.pipe(NodeFS.createWriteStream(NodePath.join(out, "mcp-stderr.log")));
const replies = new Map<number, (message: any) => void>();
NodeReadline.createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.id === "number") replies.get(message.id)?.(message);
});
let nextId = 1;
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    replies.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "cad-mcp-replay", version: "1" },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// Recorded IDs mapped to the IDs this replay produced, replaced anywhere in later arguments.
const mapped = new Map<string, string>();
const remap = (value: unknown): unknown =>
  typeof value === "string"
    ? (mapped.get(value) ?? value)
    : Array.isArray(value)
      ? value.map(remap)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)]))
        : value;
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

const report: unknown[] = [];
for (const [index, call] of recorded.entries()) {
  if (call.tool === "cad_comments_publish") continue;
  let response = await request("tools/call", { name: call.tool, arguments: remap(call.args) });
  // A fresh data directory may still be loading the model; cad_open asks to be called again.
  while (
    call.tool === "cad_open" &&
    field(response.result?.structuredContent, "status") === "importing"
  )
    response = await request("tools/call", { name: call.tool, arguments: remap(call.args) });
  const now = response.result?.structuredContent ?? parse(textOf(response.result?.content));
  if (call.tool === "cad_open") {
    const before = field(field(field(call.result, "context"), "state"), "snapshotId");
    const after = field(field(field(now, "context"), "state"), "snapshotId");
    if (typeof before === "string" && typeof after === "string") {
      mapped.set(before, after);
      // List every occurrence once so the server can expand any short ID the recorded calls used,
      // even when this replay's earlier results show different IDs than the recording did.
      const revision = field(field(field(now, "context"), "state"), "revision");
      let cursor: unknown;
      do {
        const page = await request("tools/call", {
          name: "cad_find_parts",
          arguments: {
            snapshotId: after,
            expectedRevision: revision,
            kind: "all",
            limit: 50,
            ...(typeof cursor === "string" ? { cursor } : {}),
          },
        });
        cursor = field(page.result?.structuredContent, "nextCursor");
      } while (typeof cursor === "string");
    }
  }
  for (const key of ["captureId", "inspectionId"]) {
    const before = field(call.result, key);
    const after = field(now, key);
    if (typeof before === "string" && typeof after === "string") mapped.set(before, after);
  }
  const beforeResults = field(call.result, "results");
  const afterResults = field(now, "results");
  if (Array.isArray(beforeResults) && Array.isArray(afterResults))
    for (const [position, before] of beforeResults.entries()) {
      const was = field(before, "candidateId");
      const is = field(afterResults[position], "candidateId");
      if (typeof was === "string" && typeof is === "string") mapped.set(was, is);
    }
  if (call.tool === "cad_comment_locate" || call.tool === "cad_comment_inspect") {
    const image = (response.result?.content ?? []).find((part: any) => part.type === "image");
    const file = `${String(index).padStart(3, "0")}-${call.tool}.png`;
    if (image) NodeFS.writeFileSync(NodePath.join(out, file), Buffer.from(image.data, "base64"));
    report.push({
      index,
      tool: call.tool,
      args: call.args,
      before: beforeResults ?? call.result,
      after: afterResults ?? now,
      image: image ? file : null,
    });
    console.log(
      `${index} ${call.tool}: ${JSON.stringify((Array.isArray(beforeResults) ? beforeResults : []).map((r) => field(r, "reason")))} -> ${JSON.stringify((Array.isArray(afterResults) ? afterResults : []).map((r) => [field(r, "reason"), field(r, "pixel") ?? null]))}`,
    );
  }
}
NodeFS.writeFileSync(NodePath.join(out, "replay.json"), `${JSON.stringify(report, null, 2)}\n`);
server.stdin.end();
await new Promise((resolve) => server.once("exit", resolve));
