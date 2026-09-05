// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeClaudeProcessExit } from "./ClaudeProcessExit.ts";

class Process extends NodeEvents.EventEmitter {
  stdin = new NodeStream.PassThrough();
  stdout = new NodeStream.PassThrough();
  killed = false;
  exitCode: number | null = null;
  kill() {
    this.killed = true;
    return true;
  }
}
const options = () => ({
  command: "claude.exe",
  args: ["--input-format", "stream-json"],
  cwd: "D:/work",
  env: { HOME: "test" },
  signal: new AbortController().signal,
});

it.effect("requires an observed process and actual exit, not kill acknowledgement", () =>
  Effect.gen(function* () {
    const process = new Process();
    const receipt = makeClaudeProcessExit(() => process);
    assert.strictEqual((yield* Effect.exit(receipt.awaitExit))._tag, "Failure");
    receipt.spawn(options());
    process.kill();
    assert.strictEqual(receipt.hasExited(), false);
    const waiting = yield* receipt.awaitExit.pipe(Effect.forkChild);
    process.emit("exit", null, "SIGTERM");
    yield* Fiber.join(waiting);
    assert.strictEqual(receipt.hasExited(), true);
  }),
);

it.effect("fails closed on spawn errors and unconfirmed timeout", () =>
  Effect.gen(function* () {
    const process = new Process();
    const receipt = makeClaudeProcessExit(() => process);
    receipt.spawn(options());
    const waiting = yield* receipt.awaitExit.pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual((yield* Fiber.join(waiting))._tag, "Failure");
    assert.strictEqual(receipt.hasExited(), false);
    process.emit("error", new Error("spawn failed"));
    assert.strictEqual((yield* Effect.exit(receipt.awaitExit))._tag, "Failure");
  }),
);

it("preserves SDK command, arguments, environment and forwarded grace-period signal", () => {
  const input = options();
  let received: unknown;
  const receipt = makeClaudeProcessExit((options) => {
    received = options;
    return new Process();
  });
  receipt.spawn(input);
  assert.strictEqual(received, input);
  assert.throws(() => receipt.spawn(options()), /still active/);
});
