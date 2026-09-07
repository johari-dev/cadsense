// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class ClaudeProcessExitError extends Schema.TaggedErrorClass<ClaudeProcessExitError>()(
  "ClaudeProcessExitError",
  {},
) {}

type SpawnClaude = NonNullable<Options["spawnClaudeCodeProcess"]>;

/** Track the SDK-owned process without changing its command, environment, or grace-period signal. */
export function makeClaudeProcessExit(spawnProcess?: SpawnClaude, onSpawned?: () => void) {
  let process: SpawnedProcess | undefined;
  let exited = false;
  let failed = false;
  const spawnTracked: SpawnClaude = (options) => {
    if (process && !exited) throw new Error("A Claude process is still active.");
    exited = false;
    failed = false;
    process = spawnProcess
      ? spawnProcess(options)
      : NodeChildProcess.spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
    process.once("exit", () => {
      exited = true;
    });
    process.once("error", () => {
      failed = true;
    });
    onSpawned?.();
    return process;
  };
  const awaitExit = Effect.callback<void, ClaudeProcessExitError>((resume) => {
    const child = process;
    if (exited) {
      resume(Effect.void);
      return;
    }
    if (!child || failed) {
      resume(Effect.fail(new ClaudeProcessExitError()));
      return;
    }
    const onExit = () => resume(Effect.void);
    const onError = () => resume(Effect.fail(new ClaudeProcessExitError()));
    child.once("exit", onExit);
    child.once("error", onError);
    return Effect.sync(() => {
      child.off("exit", onExit);
      child.off("error", onError);
    });
  }).pipe(Effect.timeout("10 seconds"));
  return {
    spawn: spawnTracked,
    hasSpawned: () => process !== undefined,
    hasExited: () => exited,
    awaitExit,
  };
}
