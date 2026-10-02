// @effect-diagnostics nodeBuiltinImport:off - owns the worker thread that runs previews.
import {
  CadFeatureScriptPreviewInput,
  CadViewError,
  type CadFeatureScriptPreviewResult,
  type CadFeatureScriptPreviewStep,
} from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";
import { decodeCadToolInput } from "../cad/CadViewState.ts";
import { ServerConfig } from "../config.ts";
import type {
  FeatureScriptWorkerData,
  PreviewJob,
  PreviewJobResult,
} from "./FeatureScriptWorker.ts";

/**
 * Local FeatureScript previews for agents (`cad_featurescript_preview`). Scripts and an optional
 * STEP base come from the project workspace; the features run on the local runtime in
 * `packages/featurescript` inside one warm worker thread, one preview at a time. Nothing calls
 * Onshape. Artifacts for each run go to `<attachments>/featurescript-previews/<run>/`.
 */
export interface FeatureScriptPreviewDelivery {
  readonly result: CadFeatureScriptPreviewResult;
  readonly png?: Uint8Array;
}
export class FeatureScriptPreviews extends Context.Service<
  FeatureScriptPreviews,
  {
    readonly preview: (
      workspaceRoot: string,
      input: unknown,
    ) => Effect.Effect<FeatureScriptPreviewDelivery, CadViewError>;
  }
>()("@cadsense/server/featurescript/FeatureScriptPreviews") {}

export interface FeatureScriptPreviewOptions {
  /** A preview's limit, including the worker's first load of std and OpenCascade (a few seconds). */
  readonly timeout: Duration.Input;
  /** Shut the worker down when idle this long; it holds roughly 1 GB of WASM memory. */
  readonly idleShutdown: Duration.Input;
  /** Start a fresh worker after this many previews. Geometry is never freed inside a worker. */
  readonly recycleAfter: number;
  /** Keep the newest artifact directories and remove older ones. */
  readonly keepRuns: number;
}
const DEFAULT_OPTIONS: FeatureScriptPreviewOptions = {
  timeout: "2 minutes",
  idleShutdown: "10 minutes",
  recycleAfter: 20,
  keepRuns: 50,
};
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_BASE_BYTES = 256 * 1024 * 1024;

const invalid = (details: string) => new CadViewError({ reason: "invalid-operation", details });
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });

const STATUS_RANK = { OK: 0, INFO: 1, WARNING: 2, ERROR: 3, NOT_RUN: 3 } as const;
const STATUS_BY_RANK = ["OK", "INFO", "WARNING", "ERROR"] as const;

export const make = (options: Partial<FeatureScriptPreviewOptions> = {}) =>
  Effect.gen(function* () {
    const { timeout, idleShutdown, recycleAfter, keepRuns } = { ...DEFAULT_OPTIONS, ...options };
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const scope = yield* Effect.scope;

    // Bundled builds put the worker and the vendored std beside the server entry (see
    // apps/server/vite.config.ts and scripts/build.ts); from source, the worker runs as TypeScript and
    // std is read from packages/featurescript.
    const bundledWorker = path.join(import.meta.dirname, "featurescript-worker.mjs");
    const workerUrl = (yield* fs.exists(bundledWorker).pipe(Effect.orElseSucceed(() => false)))
      ? NodeURL.pathToFileURL(bundledWorker)
      : new URL("./FeatureScriptWorker.ts", import.meta.url);
    const bundledStd = path.join(import.meta.dirname, "featurescript-std");
    const workerData: FeatureScriptWorkerData = {
      stdDir: (yield* fs.exists(bundledStd).pipe(Effect.orElseSucceed(() => false)))
        ? NodeURL.pathToFileURL(`${bundledStd}/`).href
        : null,
    };

    interface Running {
      readonly worker: NodeWorkerThreads.Worker;
      jobs: number;
    }
    let current: Running | null = null;
    let idle: Fiber.Fiber<void> | undefined;
    let nextJob = 0;
    const stop = (running: Running | null) => {
      if (!running) return;
      if (current === running) current = null;
      void running.worker.terminate();
    };
    const start = (): Running => {
      const worker = new NodeWorkerThreads.Worker(workerUrl, { workerData });
      const running: Running = { worker, jobs: 0 };
      // Errors between jobs would otherwise be thrown on the main thread.
      worker.on("error", () => stop(running));
      worker.on("exit", () => stop(running));
      return running;
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => stop(current)));

    /** Sends one job. Interrupting it (the timeout) terminates the worker mid-run. */
    const send = (job: PreviewJob) =>
      Effect.callback<PreviewJobResult, string>((resume) => {
        const running = (current ??= start());
        running.jobs += 1;
        const { worker } = running;
        const onMessage = (result: PreviewJobResult) => {
          if (result.id !== job.id) return;
          detach();
          if (running.jobs >= recycleAfter) stop(running);
          resume(Effect.succeed(result));
        };
        const onError = (error: Error) => {
          detach();
          resume(Effect.fail(`The preview worker crashed: ${error.message}`));
        };
        const onExit = (code: number) => {
          detach();
          resume(Effect.fail(`The preview worker exited with code ${code}.`));
        };
        const detach = () => {
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.on("exit", onExit);
        // oxlint-disable-next-line require-post-message-target-origin -- a worker thread, not a window.
        worker.postMessage(job);
        return Effect.sync(() => {
          detach();
          stop(running);
        });
      });
    const gate = yield* Semaphore.make(1);

    /** Reads a workspace file, refusing paths that leave the workspace (including through links). */
    const readWorkspaceFile = Effect.fn("FeatureScriptPreviews.readWorkspaceFile")(function* (
      workspaceRoot: string,
      field: string,
      relative: string,
      maxBytes: number,
    ) {
      const root = yield* fs.realPath(workspaceRoot).pipe(Effect.mapError(unavailable));
      const real = yield* fs
        .realPath(path.resolve(root, relative))
        .pipe(
          Effect.mapError(() => invalid(`${field} ${relative} doesn't exist in the workspace.`)),
        );
      const inside = path.relative(root, real);
      if (inside.startsWith("..") || path.isAbsolute(inside))
        return yield* invalid(`${field} must be a file inside the project workspace.`);
      const info = yield* fs
        .stat(real)
        .pipe(Effect.mapError(() => invalid(`${field} ${relative} can't be read.`)));
      if (info.type !== "File") return yield* invalid(`${field} ${relative} is not a file.`);
      if (Number(info.size) > maxBytes)
        return yield* invalid(`${field} ${relative} is larger than ${maxBytes} bytes.`);
      const bytes = yield* fs
        .readFile(real)
        .pipe(Effect.mapError(() => invalid(`${field} ${relative} can't be read.`)));
      // Module paths are what diagnostics print, so keep them workspace-relative.
      return { path: inside.split(path.sep).join("/"), bytes };
    });

    /** Removes all but the newest `keepRuns` run directories. Run names sort by time. */
    const prune = Effect.fn("FeatureScriptPreviews.prune")(function* (directory: string) {
      const runs = (yield* fs.readDirectory(directory)).toSorted();
      for (const run of runs.slice(0, Math.max(0, runs.length - keepRuns)))
        yield* fs.remove(path.join(directory, run), { recursive: true });
    });

    const preview = Effect.fn("FeatureScriptPreviews.preview")(function* (
      workspaceRoot: string,
      input: unknown,
    ) {
      const request = yield* decodeCadToolInput(CadFeatureScriptPreviewInput, input);
      const readStep = Effect.fn(function* (
        field: string,
        step: typeof CadFeatureScriptPreviewStep.Type,
      ) {
        const file = yield* readWorkspaceFile(workspaceRoot, field, step.path, MAX_SCRIPT_BYTES);
        return {
          path: file.path,
          source: new TextDecoder().decode(file.bytes),
          ...(step.feature === undefined ? {} : { feature: step.feature }),
          ...(step.parameters === undefined ? {} : { parameters: step.parameters }),
        };
      });
      const steps = [
        ...(yield* Effect.forEach(request.before ?? [], (step, i) =>
          readStep(`before[${i}].path`, step),
        )),
        yield* readStep("path", request),
      ];
      const base =
        request.base === undefined
          ? null
          : (yield* readWorkspaceFile(workspaceRoot, "base", request.base, MAX_BASE_BYTES)).bytes;
      const view = request.view ?? "iso";
      const runsDir = path.join(config.attachmentsDir, "featurescript-previews");
      const runId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
      const outDir = path.join(runsDir, `${yield* Clock.currentTimeMillis}-${runId}`);
      const job: PreviewJob = { id: nextJob++, steps, base, view, outDir };

      const outcome = yield* gate.withPermits(1)(
        Effect.gen(function* () {
          if (idle) yield* Fiber.interrupt(idle);
          const outcome = yield* send(job).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  `The preview took longer than ${Duration.format(Duration.fromInputUnsafe(timeout))} and was stopped. Look for loops that never end or very large patterns.`,
                ),
            }),
            Effect.result,
          );
          idle = yield* Effect.sleep(idleShutdown).pipe(
            Effect.andThen(Effect.sync(() => stop(current))),
            Effect.forkIn(scope),
          );
          return outcome;
        }),
      );
      yield* prune(runsDir).pipe(Effect.ignore);
      if (outcome._tag === "Failure")
        return {
          result: {
            status: "STOPPED",
            summary: outcome.failure,
            features: [],
            solids: [],
            artifacts: null,
          },
        } satisfies FeatureScriptPreviewDelivery;
      const ran = outcome.success;
      if (ran.kind === "invalid")
        return {
          result: {
            status: "INVALID",
            summary: ran.summary,
            features: [],
            solids: [],
            artifacts: null,
          },
        } satisfies FeatureScriptPreviewDelivery;
      const worst = Math.max(0, ...ran.features.map((feature) => STATUS_RANK[feature.status]));
      return {
        result: {
          status: STATUS_BY_RANK[worst] ?? "ERROR",
          summary: ran.summary,
          features: ran.features,
          solids: ran.solids,
          artifacts: { directory: outDir, image: path.join(outDir, `${view}.png`), view },
        },
        png: ran.png,
      } satisfies FeatureScriptPreviewDelivery;
    });
    return FeatureScriptPreviews.of({ preview });
  });

export const layer = (options?: Partial<FeatureScriptPreviewOptions>) =>
  Layer.effect(FeatureScriptPreviews, make(options));
