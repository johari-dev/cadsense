// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
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
 *
 * --seed-home <dir> starts from a copy of an earlier run's data directory, minus its reports. With a
 * microversion (/m/) URL that directory already holds, cad_open makes no Onshape requests, so
 * repeated runs neither wait on a download nor spend the key's rate limit.
 *
 * --follow-up resumes the agent's session once when it exits with cad_checks drafts still pending
 * (the server logs "CAD drafts pending"), asking it to pin or decline them. The app sends its own
 * follow-up inside the turn (see "The follow-up" in src/cad/CadChecks.md); over MCP only this
 * harness can. Its reply goes to followup-message.md; final-message.md keeps the review.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
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
    "seed-home": { type: "string" },
    "follow-up": { type: "boolean" },
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
    "Usage: --agent claude|codex --url <url> --prompt-file <file> --out <dir> [--model <id>] [--seed-home <dir>]",
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
if (values["seed-home"]) {
  NodeFS.cpSync(NodePath.resolve(values["seed-home"]), home, { recursive: true });
  NodeFS.rmSync(NodePath.join(home, "reports"), { recursive: true, force: true });
}
// Outside the repository, so neither agent finds this repo's AGENTS.md or skills.
const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-mcp-e2e-"));
const bin = NodePath.resolve(import.meta.dirname, "../src/bin.ts");
const prompt = `${NodeFS.readFileSync(values["prompt-file"], "utf8").trim()}\n\n${values.url}`;
NodeFS.writeFileSync(NodePath.join(out, "prompt.md"), `${prompt}\n`);

const env = {
  ...process.env,
  ONSHAPE_ACCESS_KEY: credential.accessKeyId,
  ONSHAPE_SECRET_KEY: credential.secretKey,
  CADSENSE_TELEMETRY_ENABLED: "false",
};
// This run owns the MCP server process, the way the app owns a provider turn. The agent reaches it
// through a relay on a Unix socket: MCP clients kill their stdio servers when they exit, which can
// cut off work the server does when a review ends (the cad_checks draft backstop). When the agent
// exits, the run ends the server's stdin and waits for it to finish.
const server = NodeChildProcess.spawn(process.execPath, [bin, "mcp", "--base-dir", home], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.pipe(NodeFS.createWriteStream(NodePath.join(out, "mcp-stderr.log"), { flags: "a" }));
const socketPath = NodePath.join(workspace, "mcp.sock");
const relayServer = NodeNet.createServer((socket) => {
  socket.pipe(server.stdin, { end: false });
  server.stdout.pipe(socket);
  socket.on("close", () => server.stdout.unpipe(socket));
});
await new Promise<void>((resolve) => relayServer.listen(socketPath, resolve));
const mcpCommand = process.execPath;
const mcpArgs = [
  "-e",
  "const s=require('node:net').connect(process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));",
  socketPath,
];
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
const transcriptFile = NodePath.join(out, "transcript.jsonl");
const transcript = NodeFS.openSync(transcriptFile, "w");
const agentLog = NodeFS.openSync(NodePath.join(out, "agent-stderr.log"), "w");
const runAgent = (file: string, args: readonly string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const child = NodeChildProcess.spawn(file, args, {
      cwd: workspace,
      env,
      stdio: ["ignore", transcript, agentLog],
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
const exitCode = await runAgent(command.file, command.args);

/** Draft keys the server last reported pending, from its "CAD drafts pending" log lines. */
const pendingDrafts = () => {
  const log = NodeFS.readFileSync(NodePath.join(out, "mcp-stderr.log"), "utf8");
  const at = log.lastIndexOf("CAD drafts pending");
  if (at < 0) return [];
  const block = log.slice(at, log.indexOf("}", at) + 1);
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
};
const pendingBefore = pendingDrafts();
let followUp:
  | { readonly sent: boolean; readonly pendingBefore: number; readonly pendingAfter: number }
  | undefined;
if (values["follow-up"]) {
  const firstLines = NodeFS.readFileSync(transcriptFile, "utf8").split("\n");
  const sessionId = firstLines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, any>)
    .map((event) => (agent === "claude" ? event.session_id : event.thread_id))
    .find((value) => typeof value === "string");
  if (pendingBefore.length > 0 && sessionId) {
    const prompt = `Your review is not finished. Cadsense's checks proved ${pendingBefore.length} defects that still have no CAD comment (cad_checks draft keys: ${pendingBefore.join(", ")}). Pin each one now with cad_comments_publish, using publishDrafts or your own wording, or decline it with declinedDrafts and a reason when the user said that part is a placeholder or not modeled yet. Then tell the student in one short sentence what you added, in their terms, without mentioning drafts or tools.`;
    const resume =
      agent === "claude"
        ? [
            ...command.args.slice(command.args.indexOf("--mcp-config")),
            "-p",
            prompt,
            "--resume",
            sessionId,
          ]
        : [
            "exec",
            "resume",
            "--json",
            "--skip-git-repo-check",
            ...command.args.flatMap((arg, i) => (command.args[i - 1] === "-c" ? ["-c", arg] : [])),
            "-c",
            'sandbox_mode="read-only"',
            "-o",
            NodePath.join(out, "followup-message.md"),
            ...(values.model ? ["--model", values.model] : []),
            sessionId,
            prompt,
          ];
    await runAgent(command.file, resume);
  }
  followUp = {
    sent: pendingBefore.length > 0 && sessionId !== undefined,
    pendingBefore: pendingBefore.length,
    pendingAfter: pendingDrafts().length,
  };
}
const durationMs = Date.now() - startedAt;
// End the server's session and let it finish its turn-end work before reading the report.
server.stdin.end();
const serverExit = await Promise.race([
  new Promise<number | null>((resolve) => server.once("exit", resolve)),
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 60_000)),
]);
if (serverExit === "timeout") server.kill();
relayServer.close();

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
    if (event.type === "result") {
      if (finalMessage === undefined) finalMessage = event.result;
      else NodeFS.writeFileSync(NodePath.join(out, "followup-message.md"), `${event.result}\n`);
    }
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
  ...(followUp ? { followUp } : {}),
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
