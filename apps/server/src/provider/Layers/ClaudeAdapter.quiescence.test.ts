// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ThreadId, ProviderInstanceId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.testFixtures.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

class Process extends NodeEvents.EventEmitter {
  stdin = new NodeStream.PassThrough();
  stdout = new NodeStream.PassThrough();
  killed = false;
  exitCode: number | null = null;
  kill() {
    this.killed = true;
    return true;
  }
  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}
const dependencies = Layer.mergeAll(
  ServerSettingsService.layerTest(),
  ServerConfig.layerTest("/tmp/cad-quiescence", { prefix: "cadsense-quiescence-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const settings = Schema.decodeSync(ClaudeSettings)({});
const threadId = ThreadId.make("quiescent-claude");

const makeHarness = Effect.gen(function* () {
  const process = new Process();
  const closeReceipt = Promise.withResolvers<void>();
  let closeCalls = 0;
  const adapter = yield* makeClaudeAdapter(settings, {
    modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    spawnClaudeCodeProcess: () => process,
    createQuery: (input) => {
      input.options.spawnClaudeCodeProcess?.({
        command: "fake",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      return {
        setModel: async () => {},
        setPermissionMode: async () => {},
        setMaxThinkingTokens: async () => {},
        close: () => {
          closeCalls++;
          closeReceipt.resolve();
        },
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            await closeReceipt.promise;
            return { done: true, value: undefined };
          },
        }),
      };
    },
  });
  const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
  return {
    adapter,
    session,
    process,
    closeReceipt: Effect.promise(() => closeReceipt.promise),
    closeCalls: () => closeCalls,
  };
});

it.effect("idle shutdown waits for process exit and blocks sending another turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const gate = harness.adapter.stopIdleSession;
    assert.ok(gate);
    const shutdown = yield* gate(threadId).pipe(Effect.forkChild);
    yield* harness.closeReceipt;
    assert.lengthOf(yield* harness.adapter.listSessions(), 1);
    assert.strictEqual(
      (yield* Effect.exit(
        harness.adapter.sendTurn({
          threadId,
          input: "late",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
        }),
      ))._tag,
      "Failure",
    );
    harness.process.exit();
    yield* Fiber.join(shutdown);
    assert.lengthOf(yield* harness.adapter.listSessions(), 0);
    assert.strictEqual(harness.session.resumeCursor !== undefined, true);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("ordinary stop remains visible until its physical exit receipt", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* harness.adapter.stopSession(threadId);
    assert.lengthOf(yield* harness.adapter.listSessions(), 1);
    assert.strictEqual(yield* harness.adapter.hasSession(threadId), true);
    const gate = harness.adapter.stopIdleSession;
    assert.ok(gate);
    harness.process.exit();
    yield* gate(threadId);
    assert.lengthOf(yield* harness.adapter.listSessions(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("busy and unknown sessions fail before closing the query", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const gate = harness.adapter.stopIdleSession;
    assert.ok(gate);
    assert.strictEqual((yield* Effect.exit(gate(ThreadId.make("unknown"))))._tag, "Failure");
    yield* harness.adapter.sendTurn({ threadId, input: "work" });
    assert.strictEqual((yield* Effect.exit(gate(threadId)))._tag, "Failure");
    assert.strictEqual(harness.closeCalls(), 0);
    harness.process.exit();
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("failed startup cannot hide a spawned process from CAD admission", () =>
  Effect.gen(function* () {
    const process = new Process();
    const adapter = yield* makeClaudeAdapter(settings, {
      modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
      spawnClaudeCodeProcess: () => process,
      createQuery: (input) => {
        input.options.spawnClaudeCodeProcess?.({
          command: "fake",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        throw new Error("Startup failed after spawning");
      },
    });
    assert.strictEqual(
      (yield* Effect.exit(adapter.startSession({ threadId, runtimeMode: "full-access" })))._tag,
      "Failure",
    );
    assert.strictEqual(yield* adapter.hasSession(threadId), true);
    assert.lengthOf(yield* adapter.listSessions(), 1);
    const gate = adapter.stopIdleSession;
    assert.ok(gate);
    const shutdown = yield* gate(threadId).pipe(Effect.forkChild);
    process.exit();
    yield* Fiber.join(shutdown);
    assert.lengthOf(yield* adapter.listSessions(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
