// @effect-diagnostics nodeBuiltinImport:off - owns the worker thread that runs previews.
import {
  CadFeatureScriptPreviewInput,
  CadViewError,
  FEATURESCRIPT_PREVIEW_VIEWS,
  type CadFeatureScriptPreviewCard,
  type CadFeatureScriptPreviewResult,
  type CadFeatureScriptPreviewStep,
  type FeatureScriptPanelPreview,
  type FeatureScriptPanelPreviewInput,
  type ThreadId,
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
import { createAttachmentId } from "../attachmentStore.ts";
import { decodeCadToolInput } from "../cad/CadViewState.ts";
import { ServerConfig } from "../config.ts";
import type {
  FeatureScriptWorkerData,
  PreviewJob,
  PreviewJobResult,
} from "./FeatureScriptWorker.ts";

/**
 * Local FeatureScript previews, for agents (`cad_featurescript_preview`) and the file panel. Scripts
 * and an optional STEP base come from the project workspace; the features run on the local runtime
 * in `packages/featurescript` inside one warm worker thread, one preview at a time. Nothing calls
 * Onshape. An agent's run writes its artifacts to `<attachments>/featurescript-previews/<run>/`;
 * the panel's models are attachments named `fspanel-*`, and only the newest are kept.
 */
export interface FeatureScriptPreviewDelivery {
  readonly result: CadFeatureScriptPreviewResult;
  readonly png?: Uint8Array;
  /** The chat card, when the preview ran for a thread. Its images are that thread's attachments. */
  readonly card?: CadFeatureScriptPreviewCard;
}
export class FeatureScriptPreviews extends Context.Service<
  FeatureScriptPreviews,
  {
    readonly preview: (
      workspaceRoot: string,
      input: unknown,
      threadId?: ThreadId,
    ) => Effect.Effect<FeatureScriptPreviewDelivery, CadViewError>;
    readonly panel: (
      input: FeatureScriptPanelPreviewInput,
    ) => Effect.Effect<FeatureScriptPanelPreview, CadViewError>;
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
  /** Keep the newest panel models (before and after each count) and remove older ones... */
  readonly keepPanelModels: number;
  /**
   * ...but not ones younger than this, which the panel may still show as the last good run under
   * a burst of failures. Past five times the count, the oldest go regardless.
   */
  readonly keepPanelModelsFor: Duration.Input;
}
const DEFAULT_OPTIONS: FeatureScriptPreviewOptions = {
  timeout: "2 minutes",
  idleShutdown: "10 minutes",
  recycleAfter: 20,
  keepRuns: 50,
  keepPanelModels: 40,
  keepPanelModelsFor: "30 minutes",
};
/** Panel model attachments: `fspanel-<time>-<uuid>.bin`, so names sort by age. */
const PANEL_MODEL_PREFIX = "fspanel-";
/**
 * Exactly a panel model's name, so pruning never takes a thread attachment that shares the prefix.
 * The group is the time it was written.
 */
const PANEL_MODEL_FILE =
  /^fspanel-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_BASE_BYTES = 256 * 1024 * 1024;

const invalid = (details: string) => new CadViewError({ reason: "invalid-operation", details });
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });

const STATUS_RANK = { OK: 0, INFO: 1, WARNING: 2, ERROR: 3, NOT_RUN: 3 } as const;
const STATUS_BY_RANK = ["OK", "INFO", "WARNING", "ERROR"] as const;

export const make = (options: Partial<FeatureScriptPreviewOptions> = {}) =>
  Effect.gen(function* () {
    const { timeout, idleShutdown, recycleAfter, keepRuns, keepPanelModels, keepPanelModelsFor } = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
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

    /** A workspace-relative module path for `relative`, refusing paths that leave the workspace. */
    const workspacePath = (root: string, field: string, relative: string) => {
      const inside = path.relative(root, path.resolve(root, relative));
      return inside.startsWith("..") || path.isAbsolute(inside) || inside === ""
        ? Effect.fail(invalid(`${field} must be a file inside the project workspace.`))
        : Effect.succeed(inside.split(path.sep).join("/"));
    };

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
      const inside = yield* workspacePath(root, field, real);
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
      return { path: inside, bytes };
    });

    /** Removes all but the newest `keepRuns` run directories. Run names sort by time. */
    const pruneRuns = Effect.fn("FeatureScriptPreviews.pruneRuns")(function* (directory: string) {
      const runs = (yield* fs.readDirectory(directory)).toSorted();
      for (const run of runs.slice(0, Math.max(0, runs.length - keepRuns)))
        yield* fs.remove(path.join(directory, run), { recursive: true });
    });

    /**
     * Removes panel models past the newest `keepPanelModels` once they're older than
     * `keepPanelModelsFor`, and any past five times that count. Nothing else in the attachments
     * directory is touched.
     */
    const prunePanelModels = Effect.fn("FeatureScriptPreviews.prunePanelModels")(function* () {
      const youngest = (yield* Clock.currentTimeMillis) - Duration.toMillis(keepPanelModelsFor);
      const newestFirst = (yield* fs.readDirectory(config.attachmentsDir))
        .flatMap((name) => {
          const written = PANEL_MODEL_FILE.exec(name)?.[1];
          return written === undefined ? [] : [{ name, written: Number(written) }];
        })
        .toSorted((a, b) => b.written - a.written);
      for (const [rank, model] of newestFirst.entries())
        if (rank >= keepPanelModels * 5 || (rank >= keepPanelModels && model.written < youngest))
          yield* fs.remove(path.join(config.attachmentsDir, model.name));
    });

    /** Runs one job on the worker, under the timeout, one at a time. Failures become a message. */
    const runJob = (job: PreviewJob) =>
      gate.withPermits(1)(
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
    /** The worst feature status, as the result's status. */
    const worstStatus = (features: readonly { readonly status: keyof typeof STATUS_RANK }[]) =>
      STATUS_BY_RANK[Math.max(0, ...features.map((feature) => STATUS_RANK[feature.status]))] ??
      "ERROR";
    const runName = Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
      return `${yield* Clock.currentTimeMillis}-${id}`;
    });

    /**
     * Copies a run's views into `threadId`'s attachments for the chat card, so they load through
     * the asset route and are removed with the thread. Display only: a failed copy drops the image.
     */
    const cardImages = Effect.fn("FeatureScriptPreviews.cardImages")(function* (
      threadId: ThreadId,
      directory: string,
      views: readonly CadFeatureScriptPreviewCard["images"][number]["view"][],
    ) {
      const images: CadFeatureScriptPreviewCard["images"][number][] = [];
      for (const view of views) {
        const attachmentId = createAttachmentId(threadId);
        if (!attachmentId) continue;
        const copied = yield* fs
          .copyFile(
            path.join(directory, `${view}.png`),
            path.join(config.attachmentsDir, `${attachmentId}.png`),
          )
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (copied) images.push({ view, attachmentId });
      }
      return images;
    });

    /** A step whose script is read from the workspace. */
    const readStep = Effect.fn("FeatureScriptPreviews.readStep")(function* (
      root: string,
      field: string,
      step: typeof CadFeatureScriptPreviewStep.Type,
    ) {
      const file = yield* readWorkspaceFile(root, field, step.path, MAX_SCRIPT_BYTES);
      return {
        path: file.path,
        source: new TextDecoder().decode(file.bytes),
        ...(step.feature === undefined ? {} : { feature: step.feature }),
        ...(step.parameters === undefined ? {} : { parameters: step.parameters }),
      };
    });

    const preview = Effect.fn("FeatureScriptPreviews.preview")(function* (
      workspaceRoot: string,
      input: unknown,
      threadId?: ThreadId,
    ) {
      const request = yield* decodeCadToolInput(CadFeatureScriptPreviewInput, input);
      const root = yield* fs.realPath(workspaceRoot).pipe(Effect.mapError(unavailable));
      const steps = [
        ...(yield* Effect.forEach(request.before ?? [], (step, i) =>
          readStep(root, `before[${i}].path`, step),
        )),
        yield* readStep(root, "path", request),
      ];
      const base =
        request.base === undefined
          ? null
          : yield* readWorkspaceFile(workspaceRoot, "base", request.base, MAX_BASE_BYTES);
      const view = request.view ?? "iso";
      const runsDir = path.join(config.attachmentsDir, "featurescript-previews");
      const outDir = path.join(runsDir, yield* runName);
      const outcome = yield* runJob({
        id: nextJob++,
        steps,
        workspace: { root, maxModuleBytes: MAX_SCRIPT_BYTES },
        connectors: [],
        base: base?.bytes ?? null,
        output: { kind: "agent", view, outDir },
      });
      yield* pruneRuns(runsDir).pipe(Effect.ignore);
      const delivery: FeatureScriptPreviewDelivery =
        outcome._tag === "Failure"
          ? {
              result: {
                status: "STOPPED",
                summary: outcome.failure,
                failure: { message: outcome.failure, location: null, unsupported: false },
                changes: null,
                features: [],
                solids: [],
                artifacts: null,
              },
            }
          : outcome.success.kind === "invalid"
            ? {
                result: {
                  status: "INVALID",
                  summary: outcome.success.summary,
                  failure: outcome.success.failure,
                  changes: null,
                  features: [],
                  solids: [],
                  artifacts: null,
                },
              }
            : {
                result: {
                  status: worstStatus(outcome.success.features),
                  summary: outcome.success.summary,
                  failure: outcome.success.failure,
                  changes: outcome.success.changes,
                  features: outcome.success.features,
                  solids: outcome.success.solids,
                  artifacts: { directory: outDir, image: path.join(outDir, `${view}.png`), view },
                },
                ...(outcome.success.png ? { png: outcome.success.png } : {}),
              };
      if (threadId === undefined) return delivery;
      const { result } = delivery;
      const card: CadFeatureScriptPreviewCard = {
        status: result.status,
        path: steps.at(-1)!.path,
        // A script that didn't load names no feature; keep the one the agent asked for.
        feature: result.features.at(-1)?.feature ?? request.feature ?? null,
        typeName: result.features.at(-1)?.typeName ?? null,
        failure: result.failure,
        changes: result.changes,
        parameters: request.parameters ?? {},
        before: request.before ?? [],
        base: base?.path ?? null,
        // A failed feature rolled back, so one view of the unchanged model is enough.
        images: result.artifacts
          ? yield* cardImages(
              threadId,
              result.artifacts.directory,
              result.status === "ERROR" ? ["iso"] : FEATURESCRIPT_PREVIEW_VIEWS,
            )
          : [],
      };
      return { ...delivery, card };
    });

    const panel = Effect.fn("FeatureScriptPreviews.panel")(function* (
      input: FeatureScriptPanelPreviewInput,
    ) {
      const root = yield* fs.realPath(input.cwd).pipe(Effect.mapError(unavailable));
      // The agent's earlier features, when the panel opened its card, run from disk.
      const earlier = yield* Effect.forEach(input.before ?? [], (step, i) =>
        readStep(root, `before[${i}].path`, step),
      );
      const step = {
        path: yield* workspacePath(root, "path", input.path),
        source: input.source,
        ...(input.feature === undefined ? {} : { feature: input.feature }),
        ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
        // The panel's saved feature may have been renamed or moved since.
        fallbackToFirst: true,
      };
      const base =
        input.base === undefined
          ? null
          : (yield* readWorkspaceFile(root, "base", input.base, MAX_BASE_BYTES)).bytes;
      const model = (name: string) => `${PANEL_MODEL_PREFIX}${name}`;
      const after = model(yield* runName);
      const before = model(yield* runName);
      const file = (attachmentId: string) =>
        path.join(config.attachmentsDir, `${attachmentId}.bin`);
      yield* fs
        .makeDirectory(config.attachmentsDir, { recursive: true })
        .pipe(Effect.mapError(unavailable));
      const outcome = yield* runJob({
        id: nextJob++,
        steps: [...earlier, step],
        workspace: { root, maxModuleBytes: MAX_SCRIPT_BYTES },
        connectors: input.connectors ?? [],
        base,
        output: { kind: "panel", after: file(after), before: file(before) },
      });
      yield* prunePanelModels().pipe(Effect.ignore);
      const empty = {
        failure: null,
        features: [],
        feature: null,
        inputs: [],
        changes: null,
        solids: [],
        elapsedMs: 0,
        model: null,
      } satisfies Omit<FeatureScriptPanelPreview, "status">;
      if (outcome._tag === "Failure")
        return {
          ...empty,
          status: "STOPPED",
          failure: { message: outcome.failure, location: null, unsupported: false },
        } satisfies FeatureScriptPanelPreview;
      const ran = outcome.success;
      if (ran.kind === "invalid")
        return {
          ...empty,
          status: "INVALID",
          failure: ran.failure,
        } satisfies FeatureScriptPanelPreview;
      return {
        status: worstStatus(ran.features),
        failure: ran.failure,
        features: ran.panel?.features ?? [],
        feature: ran.panel?.feature ?? null,
        inputs: ran.panel?.inputs ?? [],
        changes: ran.changes,
        solids: ran.solids,
        elapsedMs: ran.elapsedMs,
        model:
          ran.panel?.after || ran.panel?.before
            ? { after: ran.panel.after ? after : null, before: ran.panel.before ? before : null }
            : null,
      } satisfies FeatureScriptPanelPreview;
    });
    return FeatureScriptPreviews.of({ preview, panel });
  });

export const layer = (options?: Partial<FeatureScriptPreviewOptions>) =>
  Layer.effect(FeatureScriptPreviews, make(options));
