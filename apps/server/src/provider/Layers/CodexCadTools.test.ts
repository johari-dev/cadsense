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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import wire from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import type { CadProviderTools } from "../CadProviderTools.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResponses = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        success: Schema.Boolean,
        contentItems: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            imageUrl: Schema.optionalKey(Schema.String),
            text: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    }),
  ),
);
const decodeStart = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      params: Schema.Struct({ dynamicTools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
  ),
);
it.effect.each([
  { attached: true, registered: false },
  { attached: false, registered: true },
  { attached: true, registered: true },
])("preserves native CAD registration across resume %j", ({ attached, registered }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-cad-resume-" });
    const scriptPath = NodePath.join(cwd, "script.json");
    yield* fs.writeFileString(
      scriptPath,
      encodeJson({
        rootThreadId: wire.rootThreadId,
        notifications: [],
        holdTurnOpen: true,
        recordRequests: true,
        recordStartRequests: true,
        recordTurnRequests: true,
      }),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("cad-resume"),
      binaryPath: process.execPath,
      cwd,
      runtimeMode: "full-access",
      resumeCursor: { threadId: wire.rootThreadId, cadTools: registered },
      ...(attached
        ? {
            cad: {
              close: Effect.void,
              invoke: () => Effect.succeed({ result: {} }),
              end: () => Effect.void,
            },
          }
        : {}),
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs")],
              {
                cwd,
                env: { ...process.env, CADSENSE_CODEX_COLLAB_SCRIPT: scriptPath },
                forceKillAfter: "1 second",
              },
            ),
          ),
        ),
      ),
    );
    const session = yield* runtime.start();
    assert.deepEqual(session.resumeCursor, { threadId: wire.rootThreadId, cadTools: registered });
    if (attached && !registered) {
      const warnings = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "session/cad-unavailable"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.include(warnings[0]!.message, "Your existing conversation is unchanged");
    }
    const turn = yield* runtime.sendTurn({
      input: "Continue the conversation",
      interactionMode: "default",
    });
    assert.deepEqual(turn.resumeCursor, session.resumeCursor);
    const requests = yield* fs.readFileString(`${scriptPath}.requests`);
    assert.include(requests, '"method":"thread/resume"');
    assert.notInclude(requests, '"method":"thread/start"');
    assert.strictEqual(requests.includes("## Local CAD tools"), attached && registered);
    yield* runtime.close;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "delivers native images from two trusted concurrent Codex children without sharing identities",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-codex-cad-" });
      const scriptPath = NodePath.join(cwd, "script.json");
      const parentTurnId = wire.responses.turnStart.turn.id;
      const childTurns = wire.notifications.filter(
        (event) => event.method === "turn/started" && event.params.threadId !== wire.rootThreadId,
      );
      const notifications = wire.notifications.filter(
        (event) =>
          (event.method === "thread/started" && event.params.thread?.id !== wire.rootThreadId) ||
          childTurns.includes(event) ||
          event.params.item?.type === "collabAgentToolCall" ||
          event.params.item?.type === "subAgentActivity",
      );
      yield* fs.writeFileString(
        scriptPath,
        encodeJson({
          rootThreadId: wire.rootThreadId,
          notifications,
          turnIds: [parentTurnId],
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          completeAfterResponses: childTurns.length,
          recordRequests: true,
          recordStartRequests: true,
          serverRequests: childTurns.map((event, index) => ({
            id: `cad-call-${index}`,
            method: "item/tool/call",
            params: {
              threadId: event.params.threadId,
              turnId: event.params.turn?.id,
              callId: `cad-call-${index}`,
              tool: "cad_capture",
              arguments: { expectedRevision: 0, childKey: "forged" },
            },
          })),
        }),
      );
      const calls: { childKey: string | null; turnId: string }[] = [];
      const cad: CadProviderTools = {
        close: Effect.void,
        invoke: (childKey, turnId) =>
          Effect.sync(() => {
            calls.push({ childKey, turnId });
            return { result: { revision: 0 }, png: new Uint8Array([1, 2, 3]) };
          }),
        end: () => Effect.void,
      };
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("cad-native"),
        binaryPath: process.execPath,
        cwd,
        runtimeMode: "full-access",
        cad,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs")],
                {
                  cwd,
                  env: { ...process.env, CADSENSE_CODEX_COLLAB_SCRIPT: scriptPath },
                  forceKillAfter: "1 second",
                },
              ),
            ),
          ),
        ),
      );
      yield* runtime.start();
      const complete = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* runtime.sendTurn({ input: "look at CAD" });
      yield* Fiber.join(complete);
      assert.isAtLeast(calls.length, 2, yield* fs.readFileString(`${scriptPath}.responses`));
      assert.deepEqual(
        new Set(calls.map((call) => call.childKey)),
        new Set(wire.childThreadIds.map((id) => `codex:${id}`)),
      );
      assert.isTrue(calls.every((call) => call.turnId === parentTurnId));
      const responses = (yield* fs.readFileString(`${scriptPath}.responses`))
        .trim()
        .split("\n")
        .map((line) => decodeResponses(line));
      assert.lengthOf(responses, 2);
      for (const response of responses) {
        assert.isTrue(response.result.success);
        assert.equal(response.result.contentItems[1]?.imageUrl, "data:image/png;base64,AQID");
      }
      const start = decodeStart(
        (yield* fs.readFileString(`${scriptPath}.requests`)).split("\n")[0]!,
      );
      assert.deepEqual(
        start.params.dynamicTools.map((tool) => tool.name),
        [
          "cad_context",
          "cad_hierarchy",
          "cad_search",
          "cad_memory",
          "cad_inspection",
          "cad_update_view",
          "cad_capture",
        ],
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
