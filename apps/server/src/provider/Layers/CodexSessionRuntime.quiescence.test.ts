// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const encodeScript = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const makeRuntime = (hideExit = false, notifications: readonly unknown[] = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-codex-exit-" });
    const scriptPath = NodePath.join(cwd, "script.json");
    yield* fs.writeFileString(
      scriptPath,
      encodeScript({ rootThreadId: wireFixture.rootThreadId, notifications }),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const peer = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs");
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("idle-codex"),
      binaryPath: process.execPath,
      cwd,
      runtimeMode: "full-access",
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          spawner
            .spawn(
              ChildProcess.make(process.execPath, [peer], {
                cwd,
                env: { ...process.env, CADSENSE_CODEX_COLLAB_SCRIPT: scriptPath },
                forceKillAfter: "1 second",
              }),
            )
            .pipe(
              Effect.map((handle) =>
                hideExit
                  ? ChildProcessSpawner.makeHandle({
                      ...handle,
                      kill: () => Effect.void,
                      exitCode: Effect.never,
                      isRunning: Effect.succeed(true),
                    })
                  : handle,
              ),
            ),
        ),
      ),
    );
    yield* runtime.start();
    return runtime;
  });

it.effect("confirms actual Codex process exit before completing idle shutdown", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    assert.strictEqual(yield* runtime.processExited, false);
    yield* runtime.closeIdleConfirmed;
    assert.strictEqual(yield* runtime.processExited, true);
    assert.strictEqual((yield* Effect.exit(runtime.sendTurn({ input: "late" })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not terminate a running Codex turn", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    yield* runtime.sendTurn({ input: "work" });
    assert.strictEqual((yield* Effect.exit(runtime.closeIdleConfirmed))._tag, "Failure");
    assert.strictEqual(yield* runtime.processExited, false);
    yield* runtime.close;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails closed when process termination has no exit receipt", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime(true);
    const shutdown = yield* runtime.closeIdleConfirmed.pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual((yield* Fiber.join(shutdown))._tag, "Failure");
    assert.strictEqual(yield* runtime.processExited, false);
    assert.strictEqual((yield* Effect.exit(runtime.sendTurn({ input: "late" })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a working child fenced after its primary turn completes", () =>
  Effect.gen(function* () {
    const spawned = wireFixture.notifications.find((event) => event.method === "thread/started");
    assert.ok(spawned);
    const childId = wireFixture.childThreadIds[0];
    assert.ok(childId);
    const childSpawned = {
      ...spawned,
      params: {
        thread: {
          ...spawned.params.thread,
          id: childId,
          parentThreadId: wireFixture.rootThreadId,
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: wireFixture.rootThreadId,
                depth: 1,
                agent_nickname: "worker",
                agent_role: "worker",
                agent_path: "/root/worker",
              },
            },
          },
        },
      },
    };
    const runtime = yield* makeRuntime(false, [
      childSpawned,
      {
        method: "turn/started",
        params: {
          threadId: childId,
          turn: { ...wireFixture.responses.turnStart.turn, id: "child-working" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: wireFixture.rootThreadId,
          turn: { ...wireFixture.responses.turnStart.turn, status: "completed" },
        },
      },
    ]);
    const completed = yield* runtime.events.pipe(
      Stream.filter((event) => event.method === "turn/completed"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* runtime.sendTurn({ input: "delegate" });
    yield* Fiber.join(completed);
    assert.strictEqual((yield* runtime.getSession).status, "ready");
    assert.strictEqual((yield* Effect.exit(runtime.closeIdleConfirmed))._tag, "Failure");
    assert.strictEqual(yield* runtime.processExited, false);
    yield* runtime.close;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
