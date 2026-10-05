/**
 * The CAD follow-up through the REAL CodexSessionRuntime against the scripted mock app-server.
 * Codex cannot reopen a finished turn, so the runtime continues the app's turn with a second
 * native turn; these cases come from "The follow-up" in cad/CadChecks.md.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type ProviderEvent, ThreadId, TurnId } from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import type { CadProviderTools } from "../CadProviderTools.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const CHILD = wireFixture.childThreadIds[0]!;
const MESSAGE = "Your review is not finished.";
const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.follow-up-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

/**
 * CAD tools that offer one follow-up for `turn-1` and record what the runtime asks of them. With
 * `hold`, deciding the follow-up signals `asked` and waits for `release`, like a slow ledger read.
 */
const fakeCad = (
  options: {
    readonly followUp?: boolean;
    readonly hold?: {
      readonly asked: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
) => {
  const calls: string[] = [];
  let offered = false;
  const tools: CadProviderTools = {
    invoke: (childKey, turnId, name) =>
      Effect.sync(() => {
        calls.push(`invoke ${childKey} ${turnId} ${name}`);
        return { result: { ok: true } };
      }),
    followUp: (childKey, turnId) =>
      Effect.gen(function* () {
        calls.push(`followUp ${childKey} ${turnId}`);
        if (options.hold && turnId === "turn-1") {
          yield* Deferred.succeed(options.hold.asked, undefined);
          yield* Deferred.await(options.hold.release);
        }
        if (options.followUp === false || offered || turnId !== "turn-1") return null;
        offered = true;
        return MESSAGE;
      }),
    end: (childKey, turnId, outcome) =>
      Effect.sync(() => {
        calls.push(`end ${childKey} ${turnId} ${outcome}`);
      }),
    close: Effect.void,
  };
  return { tools, calls };
};

const agentMessage = (turnId: string, text: string) => ({
  method: "item/completed",
  params: {
    threadId: ROOT,
    turnId,
    completedAtMs: 1,
    item: { type: "agentMessage", id: `msg-${turnId}`, text },
  },
});

/** A captured thread/started that registers CHILD as a spawned child agent of ROOT. */
const spawnedChild = () => {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started")!;
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: CHILD,
        sessionId: CHILD,
        parentThreadId: ROOT,
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "checker",
              agent_path: "/root/checker",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: ROOT,
            },
          },
        },
      },
    },
  };
};
const foreignTurnStarted = (threadId: string) => ({
  method: "turn/started",
  params: { threadId, turn: { id: `${threadId}-turn`, status: "inProgress", items: [] } },
});

const writeScript = (script: Record<string, unknown>) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    NodeFS.writeFileSync(scriptPath, JSON.stringify({ rootThreadId: ROOT, ...script }), "utf8");
    const sidecars = [".requests", ".interrupts", ".responses"].map(
      (suffix) => scriptPath + suffix,
    );
    for (const file of sidecars) NodeFS.rmSync(file, { force: true });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const file of [scriptPath, ...sidecars]) NodeFS.rmSync(file, { force: true });
      }),
    );
  });

const readLines = (suffix: string) =>
  NodeFS.existsSync(scriptPath + suffix)
    ? NodeFS.readFileSync(scriptPath + suffix, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, any>)
    : [];

const startRuntime = (cad: CadProviderTools, cadFollowUpStartTimeout?: Duration.Input) =>
  makeCodexSessionRuntime({
    threadId: ThreadId.make("thread-codex-follow-up"),
    binaryPath: peerPath,
    cwd: "/tmp",
    runtimeMode: "full-access",
    environment: { ...process.env, CADSENSE_CODEX_COLLAB_SCRIPT: scriptPath },
    cad,
    ...(cadFollowUpStartTimeout ? { cadFollowUpStartTimeout } : {}),
  });

/**
 * Collects the runtime's events until the app's turn `turnId` completes. The runtime's events are
 * one queue, so this is the only reader; `seen` completes on the first agent message.
 */
const untilCompleted = (
  events: Stream.Stream<ProviderEvent>,
  turnId: string,
  seen?: Deferred.Deferred<void>,
) =>
  events.pipe(
    Stream.tap((event) =>
      seen && event.method === "item/completed" ? Deferred.succeed(seen, undefined) : Effect.void,
    ),
    Stream.takeUntil((event) => event.method === "turn/completed" && event.turnId === turnId),
    Stream.runCollect,
    Effect.map((collected) => Array.from(collected)),
    Effect.forkScoped,
  );

const lifecycle = (events: readonly ProviderEvent[]) =>
  events
    .filter((event) => event.method === "turn/started" || event.method === "turn/completed")
    .map((event) => `${event.method} ${event.turnId}`);

describe("CodexSessionRuntime CAD follow-up", () => {
  it.live("continues the app's turn with a second native turn", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnNotifications: [
          [agentMessage("turn-1", "Review done.")],
          [agentMessage("turn-2", "Pinned the rest.")],
        ],
        turnServerRequests: [
          [],
          [
            {
              id: 900,
              method: "item/tool/call",
              params: {
                threadId: ROOT,
                turnId: "turn-2",
                callId: "call-1",
                tool: "cad_comments_publish",
                arguments: { publishDrafts: ["a"] },
              },
            },
          ],
        ],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer", model: "gpt-6-luna" });
      const events = yield* Fiber.join(collected);

      // The app sees one turn: no second start, no early completion.
      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      const messages = events.filter((event) => event.method === "item/completed");
      assert.deepEqual(
        messages.map((event) => `${event.turnId}`),
        ["turn-1", "turn-1"],
      );
      // CAD calls in the follow-up reach the first turn's activation, and the turn ends after it.
      assert.deepEqual(cad.calls, [
        "followUp null turn-1",
        "invoke null turn-1 cad_comments_publish",
        "followUp null turn-1",
        "end null turn-1 completed",
      ]);
      // The follow-up keeps the turn's settings and sends only the message.
      const [first, second] = readLines(".requests").map((request) => request.params);
      assert.deepEqual(second?.input, [{ type: "text", text: MESSAGE }]);
      assert.equal(second?.model, first?.model);
      assert.deepEqual(second?.collaborationMode, first?.collaborationMode);
      assert.equal((yield* runtime.getSession).activeTurnId, undefined);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("interrupts the follow-up turn, not the finished one", () =>
    Effect.gen(function* () {
      yield* writeScript({
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnNotifications: [[], [agentMessage("turn-2", "Working on it.")]],
        holdTurns: [false, true],
        expectedActiveTurnId: "turn-2",
        completeOnInterrupt: true,
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const followUpStarted = yield* Deferred.make<void>();
      const collected = yield* untilCompleted(runtime.events, "turn-1", followUpStarted);
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Deferred.await(followUpStarted);
      yield* runtime.interruptTurn(TurnId.make("turn-1"));
      const events = yield* Fiber.join(collected);

      assert.deepEqual(
        readLines(".interrupts").map((entry) => entry.turnId),
        ["turn-2"],
      );
      const completed = events.find((event) => event.method === "turn/completed");
      assert.nestedPropertyVal(completed?.payload, "turn.status", "interrupted");
      assert.deepEqual(cad.calls, ["followUp null turn-1", "end null turn-1 stopped"]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends no follow-up after an interrupted turn", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1"],
        notifications: [],
        turnStatuses: ["interrupted"],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      assert.deepEqual(cad.calls, ["end null turn-1 stopped"]);
      assert.equal(readLines(".requests").length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends no follow-up for a turn the user stopped as it finished", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnNotifications: [[agentMessage("turn-1", "Looking.")]],
        holdTurns: [true],
        completeOnInterrupt: true,
        interruptStatus: "completed",
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const working = yield* Deferred.make<void>();
      const collected = yield* untilCompleted(runtime.events, "turn-1", working);
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Deferred.await(working);
      yield* runtime.interruptTurn(TurnId.make("turn-1"));
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      // Codex finished the turn, but the user pressed Stop, so its drafts are not published either.
      assert.deepEqual(cad.calls, ["end null turn-1 stopped"]);
      assert.equal(readLines(".requests").length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a follow-up that is still being decided when Stop names no turn", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
      });
      const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const cad = fakeCad({ hold });
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Deferred.await(hold.asked);
      // The app stops a thread by session, with no turn id, and no native turn is active now.
      yield* runtime.interruptTurn();
      yield* Deferred.succeed(hold.release, undefined);
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      assert.deepEqual(cad.calls, ["followUp null turn-1", "end null turn-1 stopped"]);
      assert.equal(readLines(".requests").length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves the follow-up out when the user sends a turn while it is decided", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-3"],
        notifications: [],
      });
      const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const cad = fakeCad({ hold });
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-3");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Deferred.await(hold.asked);
      const user = yield* runtime
        .sendTurn({ input: "also check the intake" })
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("200 millis");
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(user);
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), [
        "turn/started turn-1",
        "turn/completed turn-1",
        "turn/started turn-3",
        "turn/completed turn-3",
      ]);
      assert.deepEqual(
        readLines(".requests").map((request) => request.params.input[0].text),
        ["review my transfer", "also check the intake"],
      );
      assert.include(cad.calls, "end null turn-1 completed");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("still stops a follow-up whose turn/start answers late and whose interrupt hangs", () =>
    Effect.gen(function* () {
      yield* writeScript({
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnStartDelayMs: [0, 1500],
        hangInterruptFor: ROOT,
      });
      const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const cad = fakeCad({ hold });
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Deferred.await(hold.asked);
      yield* Deferred.succeed(hold.release, undefined);
      // turn/start is now waiting on its late answer, and Codex has announced turn-2.
      yield* Effect.sleep("500 millis");
      yield* runtime.interruptTurn();
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      assert.deepEqual(cad.calls, ["followUp null turn-1", "end null turn-1 stopped"]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a follow-up Codex started although turn/start answered after its deadline", () =>
    Effect.gen(function* () {
      yield* writeScript({
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnStartDelayMs: [0, 1500],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools, "300 millis");
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      assert.deepEqual(cad.calls, [
        "followUp null turn-1",
        "followUp null turn-1",
        "end null turn-1 completed",
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("neither follows up nor publishes while a child agent is still running", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnNotifications: [[spawnedChild(), foreignTurnStarted(CHILD)]],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Fiber.join(collected);

      assert.deepEqual(cad.calls, ["end null turn-1 stopped"]);
      assert.equal(readLines(".requests").length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("is not held back by a thread that is not a child agent, such as memory upkeep", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnNotifications: [[foreignTurnStarted("unregistered-thread")]],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* Fiber.join(collected);

      assert.deepEqual(cad.calls, [
        "followUp null turn-1",
        "followUp null turn-1",
        "end null turn-1 completed",
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("completes the app's turn when the follow-up cannot start", () =>
    Effect.gen(function* () {
      yield* writeScript({ turnIds: ["turn-1", "turn-2"], notifications: [], failTurnStartAt: 1 });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), ["turn/started turn-1", "turn/completed turn-1"]);
      assert.deepEqual(cad.calls, ["followUp null turn-1", "end null turn-1 completed"]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failed follow-up as failed and still settles the review", () =>
    Effect.gen(function* () {
      yield* writeScript({
        turnIds: ["turn-1", "turn-2"],
        notifications: [],
        turnStatuses: ["completed", "failed"],
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-1");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      const events = yield* Fiber.join(collected);

      const completed = events.find((event) => event.method === "turn/completed");
      assert.nestedPropertyVal(completed?.payload, "turn.status", "failed");
      // The provider tools publish the leftovers of a failed turn only after a follow-up.
      assert.deepEqual(cad.calls, ["followUp null turn-1", "end null turn-1 failed"]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves a turn the user already queued alone", () =>
    Effect.gen(function* () {
      yield* writeScript({
        recordTurnRequests: true,
        turnIds: ["turn-1", "turn-3"],
        notifications: [],
        holdTurns: [true, false],
        completeHeldTurnOnNextStart: true,
      });
      const cad = fakeCad();
      const runtime = yield* startRuntime(cad.tools);
      const collected = yield* untilCompleted(runtime.events, "turn-3");
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review my transfer" });
      yield* runtime.sendTurn({ input: "also check the intake" });
      const events = yield* Fiber.join(collected);

      assert.deepEqual(lifecycle(events), [
        "turn/started turn-1",
        "turn/completed turn-1",
        "turn/started turn-3",
        "turn/completed turn-3",
      ]);
      assert.deepEqual(cad.calls, [
        "end null turn-1 completed",
        "followUp null turn-3",
        "end null turn-3 completed",
      ]);
      assert.equal(readLines(".requests").length, 2);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
