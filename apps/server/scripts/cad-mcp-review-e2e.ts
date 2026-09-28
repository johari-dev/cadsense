// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off
/**
 * End-to-end check that an outside agent can review Onshape CAD through `cadsense mcp` with no
 * window. Runs Claude Code or Codex non-interactively against a fresh MCP data directory, then keeps
 * everything needed to judge the review under --out:
 *
 *   transcript.jsonl   the agent's event stream
 *   final-message.md   the agent's closing summary
 *   mcp-stderr.log     Cadsense backend and render host logs
 *   report/            the HTML report, comments.json, and inspection images
 *   summary.json       timings, tool call counts, and failed tool calls
 *
 *   ONSHAPE_CREDENTIAL_FILE=key.json node apps/server/scripts/cad-mcp-review-e2e.ts \
 *     --agent claude --url <onshape tab url> --prompt-file prompt.md --out .cadsense/mcp-e2e/run
 *
 * The credential file is JSON with `accessKeyId` and `secretKey`. The web app must be built first
 * (`pnpm --filter @cadsense/web build`) because headless Chromium loads its render page.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    agent: { type: "string" },
    url: { type: "string" },
    "prompt-file": { type: "string" },
    out: { type: "string" },
    model: { type: "string" },
  },
});
const agent = values.agent;
if (
  (agent !== "claude" && agent !== "codex") ||
  !values.url ||
  !values["prompt-file"] ||
  !values.out
)
  throw new Error(
    "Usage: --agent claude|codex --url <url> --prompt-file <file> --out <dir> [--model <id>]",
  );
const credentialFile = process.env.ONSHAPE_CREDENTIAL_FILE;
if (!credentialFile)
  throw new Error("Set ONSHAPE_CREDENTIAL_FILE to a JSON file with accessKeyId and secretKey.");
const credential = JSON.parse(NodeFS.readFileSync(credentialFile, "utf8")) as {
  accessKeyId: string;
  secretKey: string;
};

const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const home = NodePath.join(out, "home");
NodeFS.mkdirSync(out, { recursive: true });
// Outside the repository, so neither agent finds this repo's AGENTS.md or skills.
const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-mcp-e2e-"));
const bin = NodePath.resolve(import.meta.dirname, "../src/bin.ts");
const prompt = `${NodeFS.readFileSync(values["prompt-file"], "utf8").trim()}\n\n${values.url}`;
NodeFS.writeFileSync(NodePath.join(out, "prompt.md"), `${prompt}\n`);

// The MCP server's stderr goes to a file this run owns. Its stdout stays the MCP channel.
const mcpCommand = "/bin/sh";
const mcpArgs = [
  "-c",
  'exec "$0" "$1" mcp --base-dir "$2" 2>>"$3"',
  process.execPath,
  bin,
  home,
  NodePath.join(out, "mcp-stderr.log"),
];
const env = {
  ...process.env,
  ONSHAPE_ACCESS_KEY: credential.accessKeyId,
  ONSHAPE_SECRET_KEY: credential.secretKey,
  CADSENSE_TELEMETRY_ENABLED: "false",
};
const toml = (value: unknown) => JSON.stringify(value);
const command =
  agent === "claude"
    ? {
        file: "claude",
        args: [
          "-p",
          prompt,
          "--mcp-config",
          JSON.stringify({ mcpServers: { cadsense: { command: mcpCommand, args: mcpArgs } } }),
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__cadsense",
          "--output-format",
          "stream-json",
          "--verbose",
          ...(values.model ? ["--model", values.model] : []),
        ],
      }
    : {
        file: "codex",
        args: [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-c",
          'approval_policy="never"',
          "-c",
          `mcp_servers.cadsense.command=${toml(mcpCommand)}`,
          "-c",
          `mcp_servers.cadsense.args=${toml(mcpArgs)}`,
          // Codex starts MCP servers with a minimal environment; forward only what Cadsense reads.
          "-c",
          `mcp_servers.cadsense.env_vars=${toml(["ONSHAPE_ACCESS_KEY", "ONSHAPE_SECRET_KEY", "CADSENSE_TELEMETRY_ENABLED"])}`,
          // Without this, `codex exec` rejects every tool that is not marked read-only.
          "-c",
          'mcp_servers.cadsense.default_tools_approval_mode="approve"',
          "-o",
          NodePath.join(out, "final-message.md"),
          ...(values.model ? ["--model", values.model] : []),
          prompt,
        ],
      };

const startedAt = Date.now();
const transcript = NodeFS.openSync(NodePath.join(out, "transcript.jsonl"), "w");
const agentLog = NodeFS.openSync(NodePath.join(out, "agent-stderr.log"), "w");
const exitCode = await new Promise<number | null>((resolve, reject) => {
  const child = NodeChildProcess.spawn(command.file, command.args, {
    cwd: workspace,
    env,
    stdio: ["ignore", transcript, agentLog],
  });
  child.once("error", reject);
  child.once("exit", resolve);
});
const durationMs = Date.now() - startedAt;

// Tool calls from either agent's event stream, reduced to name, error flag, and error text.
interface ToolCall {
  readonly name: string;
  readonly isError: boolean;
  readonly error?: string;
}
const events = NodeFS.readFileSync(NodePath.join(out, "transcript.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line) as Record<string, any>);
const calls: ToolCall[] = [];
let model: string | undefined;
let finalMessage: string | undefined;
if (agent === "claude") {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") model = event.model;
    if (event.type === "result") finalMessage = event.result;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use")
        names.set(block.id, String(block.name).replace("mcp__cadsense__", ""));
      if (block.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join(" ")
          : String(block.content ?? "");
        const isError = block.is_error === true;
        calls.push({
          name: names.get(block.tool_use_id) ?? "unknown",
          isError,
          ...(isError ? { error: text.slice(0, 500) } : {}),
        });
      }
    }
  }
  if (finalMessage)
    NodeFS.writeFileSync(NodePath.join(out, "final-message.md"), `${finalMessage}\n`);
} else {
  for (const event of events) {
    if (event.type === "session.configured" || event.type === "thread.started")
      model ??= event.model;
    const item = event.item;
    if (event.type !== "item.completed" || item?.type !== "mcp_tool_call") continue;
    const text = (item.result?.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join(" ");
    const isError = item.status === "failed" || item.error != null || item.result?.isError === true;
    calls.push({
      name: item.tool,
      isError,
      ...(isError ? { error: String(item.error?.message ?? text).slice(0, 500) } : {}),
    });
  }
  const last = NodePath.join(out, "final-message.md");
  if (NodeFS.existsSync(last)) finalMessage = NodeFS.readFileSync(last, "utf8");
}

const reportsRoot = NodePath.join(home, "reports");
const reports = NodeFS.existsSync(reportsRoot) ? NodeFS.readdirSync(reportsRoot) : [];
for (const report of reports)
  NodeFS.cpSync(
    NodePath.join(reportsRoot, report),
    NodePath.join(out, reports.length === 1 ? "report" : `report-${report}`),
    {
      recursive: true,
    },
  );
const commentsFile = NodePath.join(out, "report", "comments.json");
const comments = NodeFS.existsSync(commentsFile)
  ? (JSON.parse(NodeFS.readFileSync(commentsFile, "utf8")) as Array<{
      targets: Array<{ kind: string }>;
    }>)
  : [];
const counts: Record<string, number> = {};
for (const call of calls) counts[call.name] = (counts[call.name] ?? 0) + 1;
const summary = {
  agent,
  model: model ?? values.model ?? "default",
  url: values.url,
  exitCode,
  durationSeconds: Math.round(durationMs / 1000),
  toolCalls: counts,
  failedToolCalls: calls.filter((call) => call.isError),
  comments: comments.length,
  pointTargets: comments
    .flatMap((comment) => comment.targets)
    .filter((target) => target.kind === "point").length,
  partTargets: comments
    .flatMap((comment) => comment.targets)
    .filter((target) => target.kind === "part").length,
};
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
