// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
/**
 * End-to-end check of a CAD review through the app's own turn handling: the orchestration engine,
 * the provider adapters, and their CAD tools, with headless Chromium rendering and no window. Unlike
 * cad-mcp-review-e2e.ts, the agent runs inside Cadsense the way it does for a user, so this covers
 * what only the app does, such as the cad_checks follow-up (see "The follow-up" in
 * src/cad/CadChecks.md).
 *
 * It copies a data directory that already holds one synced Onshape project (an e2e run's `home`, or
 * .cadsense/gap/seed-home), starts the backend on the copy, opens a chat on that project, sends one
 * turn, waits for it to end, and keeps under --out:
 *
 *   server.log         backend logs, including "CAD follow-up sent" and backstop publications
 *   thread.json        the chat's messages and activities
 *   final-message.md   the last assistant message
 *   report/            the HTML report, comments.json, and inspection images
 *   summary.json       model, duration, turn state, comments, targets, follow-ups, backstop comments
 *
 *   node apps/server/scripts/cad-app-review-e2e.ts --home .cadsense/gap/seed-home \
 *     --provider codex --model gpt-6-luna --effort medium --prompt-file prompt.md --out <dir> \
 *     [--codex-home <dir>] [--timeout-minutes 40]
 *
 * --codex-home sets the Codex instance's CODEX_HOME, for a model provider configured there. The web
 * app must be built first (`pnpm --filter @cadsense/web build`) because Chromium loads its render
 * page.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@cadsense/contracts";
import { createModelSelection } from "@cadsense/shared/model";
import * as NetService from "@cadsense/shared/Net";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import { makeCadMcpRenderHost } from "../src/cadMcp/CadMcpRenderHost.ts";
import { writeCadMcpReport } from "../src/cadMcp/CadMcpReport.ts";
import { resolveServerConfig } from "../src/cli/config.ts";
import * as ServerConfig from "../src/config.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { BACKSTOP_NOTE } from "../src/provider/CadCheckBackstop.ts";
import { makeServerLayer } from "../src/server.ts";
import { ServerRuntimeStartup } from "../src/serverRuntimeStartup.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    home: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "prompt-file": { type: "string" },
    out: { type: "string" },
    "codex-home": { type: "string" },
    "timeout-minutes": { type: "string" },
  },
});
const provider = values.provider;
if (
  (provider !== "codex" && provider !== "claudeAgent") ||
  !values.home ||
  !values.model ||
  !values["prompt-file"] ||
  !values.out
)
  throw new Error(
    "Usage: --home <data dir> --provider codex|claudeAgent --model <id> --prompt-file <file> --out <dir> [--effort <level>] [--codex-home <dir>] [--timeout-minutes <n>]",
  );

const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
const home = NodePath.join(out, "home");
NodeFS.mkdirSync(out, { recursive: true });
NodeFS.cpSync(NodePath.resolve(values.home), home, { recursive: true });
NodeFS.rmSync(NodePath.join(home, "reports"), { recursive: true, force: true });
if (values["codex-home"]) {
  const settingsPath = NodePath.join(home, "userdata", "settings.json");
  const settings = NodeFS.existsSync(settingsPath)
    ? (JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as Record<string, any>)
    : {};
  settings.providers = {
    ...settings.providers,
    codex: { ...settings.providers?.codex, homePath: NodePath.resolve(values["codex-home"]) },
  };
  NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
const prompt = NodeFS.readFileSync(values["prompt-file"], "utf8").trim();
NodeFS.writeFileSync(NodePath.join(out, "prompt.md"), `${prompt}\n`);
const timeoutMs = Number(values["timeout-minutes"] ?? 40) * 60_000;

// Backend logs go to server.log, which the summary reads for follow-ups and backstop publications.
const logFile = NodeFS.openSync(NodePath.join(out, "server.log"), "a");
const writeLog = (...args: unknown[]) =>
  NodeFS.writeSync(logFile, `${NodeUtil.stripVTControlCharacters(NodeUtil.format(...args))}\n`);
console.log = console.info = console.debug = console.warn = console.error = writeLog;

const run = Effect.gen(function* () {
  const http = yield* HttpServer.HttpServer;
  const startup = yield* ServerRuntimeStartup;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* startup.awaitCommandReady;
  if (http.address._tag !== "TcpAddress") return yield* Effect.die("Needs a TCP address.");
  const renderHost = yield* makeCadMcpRenderHost(`http://127.0.0.1:${http.address.port}`);
  yield* renderHost.ensure;

  const projects = (yield* query.getCommandReadModel()).projects.filter(
    (project) => project.deletedAt === null && project.onshapeSource !== undefined,
  );
  const project = projects[0];
  if (projects.length !== 1 || !project)
    return yield* Effect.die(`Expected one Onshape project, found ${projects.length}.`);
  const modelSelection = createModelSelection(
    ProviderInstanceId.make(provider),
    values.model!,
    values.effort ? [{ id: "effort", value: values.effort }] : null,
  );
  const threadId = ThreadId.make(yield* uuid);
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(yield* uuid),
    threadId,
    projectId: project.id,
    title: "App review e2e",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: yield* now,
  });
  const startedAt = yield* Clock.currentTimeMillis;
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(yield* uuid),
    threadId,
    message: {
      messageId: MessageId.make(yield* uuid),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: yield* now,
  });

  // The turn has ended once the latest turn has started and left "running".
  let state = "timeout";
  while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
    yield* Effect.sleep("3 seconds");
    const shell = Option.getOrUndefined(yield* query.getThreadShellById(threadId));
    const turn = shell?.latestTurn;
    if (turn?.startedAt && turn.state !== "running") {
      state = turn.state;
      break;
    }
  }
  const durationSeconds = Math.round(((yield* Clock.currentTimeMillis) - startedAt) / 1000);

  const thread: OrchestrationThread | undefined = Option.getOrUndefined(
    yield* query.getThreadDetailById(threadId),
  );
  NodeFS.writeFileSync(
    NodePath.join(out, "thread.json"),
    `${JSON.stringify({ messages: thread?.messages, activities: thread?.activities }, null, 2)}\n`,
  );
  const assistant = (thread?.messages ?? []).filter((message) => message.role === "assistant");
  NodeFS.writeFileSync(NodePath.join(out, "final-message.md"), `${assistant.at(-1)?.text ?? ""}\n`);
  yield* writeCadMcpReport({
    threadId,
    directory: NodePath.join(out, "report"),
    title: project.title,
    sourceUrl: "",
  });

  const comments = JSON.parse(
    NodeFS.readFileSync(NodePath.join(out, "report", "comments.json"), "utf8"),
  ) as Array<{ body: string; targets: Array<{ kind: string }> }>;
  const log = NodeFS.readFileSync(NodePath.join(out, "server.log"), "utf8");
  const tools: Record<string, number> = {};
  for (const activity of thread?.activities ?? [])
    if (activity.kind === "tool.completed")
      tools[activity.summary] = (tools[activity.summary] ?? 0) + 1;
  const targets = comments.flatMap((comment) => comment.targets);
  const summary = {
    provider,
    model: values.model,
    effort: values.effort ?? "default",
    turnState: state,
    durationSeconds,
    assistantMessages: assistant.length,
    toolCalls: tools,
    followUps: log.split("CAD follow-up sent").length - 1,
    comments: comments.length,
    backstopComments: comments.filter((comment) => comment.body.includes(BACKSTOP_NOTE)).length,
    pointTargets: targets.filter((target) => target.kind === "point").length,
    partTargets: targets.filter((target) => target.kind === "part").length,
  };
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
});

const main = Effect.gen(function* () {
  const resolved = yield* resolveServerConfig(
    {
      port: Option.some(0),
      baseDir: Option.some(home),
      cwd: Option.none(),
      devUrl: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.some(false),
      logWebSocketEvents: Option.none(),
    },
    Option.none(),
  );
  const staticDir = resolved.staticDir ?? (yield* ServerConfig.resolveStaticDir());
  if (!staticDir)
    return yield* Effect.die("Build the web app first: pnpm --filter @cadsense/web build");
  const config: ServerConfig.ServerConfig["Service"] = {
    ...resolved,
    port: 0,
    devUrl: undefined,
    staticDir,
    desktopBootstrapToken: yield* (yield* Crypto.Crypto).randomUUIDv4,
    autoBootstrapProjectFromCwd: false,
  };
  // The backend lives for the run and shuts down, provider sessions included, when it ends.
  yield* run.pipe(
    Effect.provide(makeServerLayer.pipe(Layer.provideMerge(ServerConfig.layer(config)))),
    Effect.scoped,
  );
});

main.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  Effect.ensuring(Effect.sync(() => process.exit(0))),
  NodeRuntime.runMain,
);
