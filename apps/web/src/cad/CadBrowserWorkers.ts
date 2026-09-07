/* eslint-disable unicorn/require-post-message-target-origin -- Dedicated Worker messages accept transfer lists, not window target origins. */
import * as Schema from "effect/Schema";
import { CadRendererError } from "./CadRendererError";
import { CadWorkerOutput } from "./CadWorkerProtocol";
import type { CadDiagnosticEvent } from "./CadDiagnostics";
import {
  createCadRendererPool,
  type CadRenderJob,
  type CadRenderResult,
  type CadRenderWorker,
  type CadRendererPoolOptions,
} from "./CadRendererPool";

const decodeOutput = Schema.decodeUnknownSync(CadWorkerOutput);
export interface CadBrowserPoolOptions {
  /** Reads only locally pinned snapshot assets; the host owns authorization and transport. */
  readonly readAsset: (
    snapshotId: string,
    sha256: string,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>;
  readonly isCurrent: CadRendererPoolOptions["isCurrent"];
  readonly onDiagnostic?: CadRendererPoolOptions["onDiagnostic"];
  readonly onRendererDiagnostic?: (event: CadDiagnosticEvent) => void;
}
const createOffscreenWorker = (
  readAsset: CadBrowserPoolOptions["readAsset"],
  onDiagnostic?: CadBrowserPoolOptions["onRendererDiagnostic"],
): Promise<CadRenderWorker> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./CadRenderer.worker.ts", import.meta.url), {
      type: "module",
    });
    const controller = new AbortController();
    let disposed = false;
    let snapshotId: string | null = null;
    let pending: {
      job: CadRenderJob;
      resolve(value: CadRenderResult): void;
      reject(error: CadRendererError): void;
      hashes: Set<string>;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => fail(), 15_000);
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const fail = () => {
      if (disposed) return;
      disposed = true;
      clearTimer();
      controller.abort();
      worker.terminate();
      const error = new CadRendererError("renderer-unavailable");
      pending?.reject(error);
      pending = null;
      reject(error);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      let message: CadWorkerOutput;
      try {
        message = decodeOutput(event.data);
      } catch {
        // A rejected result must settle the pending capture, not wait for its watchdog.
        fail();
        return;
      }
      if (disposed) return;
      if (message.type === "frame" || message.type === "context-loss") {
        onDiagnostic?.(message);
        return;
      }
      if (message.type === "ready") {
        clearTimer();
        resolve({
          mode: "offscreen",
          dispose: fail,
          capture: (job) => {
            if (disposed || pending)
              return Promise.reject(new CadRendererError("renderer-unavailable"));
            return new Promise((resolve, reject) => {
              pending = {
                job,
                resolve,
                reject,
                hashes: new Set(job.manifest.assets.map((asset) => asset.sha256)),
              };
              timer = setTimeout(fail, 60_000);
              worker.postMessage({
                type: "capture",
                jobId: job.jobId,
                state: job.state,
                ...(job.commentWork ? { commentWork: job.commentWork } : {}),
                width: job.width,
                height: job.height,
                ...(job.appearance ? { appearance: job.appearance } : {}),
                ...(snapshotId === job.state.snapshotId ? {} : { manifest: job.manifest }),
              });
            });
          },
        });
      } else if (message.type === "unavailable") fail();
      else if (message.type === "asset") {
        const current = pending;
        if (
          !current ||
          current.job.jobId !== message.jobId ||
          current.job.state.snapshotId !== message.snapshotId ||
          !current.hashes.has(message.sha256)
        )
          return;
        void readAsset(message.snapshotId, message.sha256, controller.signal).then(
          (bytes) => {
            if (disposed || pending !== current) return;
            worker.postMessage(
              { type: "asset", jobId: message.jobId, requestId: message.requestId, bytes },
              [bytes],
            );
          },
          () => {
            if (!disposed && pending === current)
              worker.postMessage({
                type: "asset",
                jobId: message.jobId,
                requestId: message.requestId,
                bytes: null,
              });
          },
        );
      } else {
        if (!pending || pending.job.jobId !== message.jobId) return;
        clearTimer();
        const current = pending;
        pending = null;
        if (message.type === "failure") current.reject(new CadRendererError(message.reason));
        else {
          snapshotId = message.snapshotId;
          current.resolve(message);
        }
      }
    });
    const canvas = new OffscreenCanvas(1, 1);
    worker.postMessage({ type: "initialize", canvas }, [canvas]);
  });
const createMainThreadWorker = async (
  readAsset: CadBrowserPoolOptions["readAsset"],
  onDiagnostic?: CadBrowserPoolOptions["onRendererDiagnostic"],
): Promise<CadRenderWorker> => {
  const { createCadSceneRenderer } = await import("./CadSceneRenderer");
  const canvas = document.createElement("canvas");
  const renderer = createCadSceneRenderer({
    canvas,
    onFrame: (milliseconds) => onDiagnostic?.({ type: "frame", milliseconds }),
    onContextLost: () => onDiagnostic?.({ type: "context-loss" }),
  });
  const controller = new AbortController();
  let snapshotId: string | null = null;
  return {
    mode: "main-thread",
    dispose: () => {
      controller.abort();
      renderer.dispose();
    },
    capture: async (job) => {
      if (snapshotId !== job.state.snapshotId) {
        await renderer.load(job.manifest, (sha) =>
          readAsset(job.state.snapshotId, sha, controller.signal),
        );
        snapshotId = job.state.snapshotId;
      }
      renderer.resize(job.width, job.height, 1);
      if (job.appearance) renderer.setAppearance(job.appearance);
      renderer.apply(job.state);
      const commentHits = job.commentWork ? renderer.commentWork(job.commentWork) : undefined;
      const pose = renderer.cameraPose();
      return {
        jobId: job.jobId,
        snapshotId: job.state.snapshotId,
        revision: job.state.revision,
        pose,
        ...(commentHits ? { commentHits } : {}),
        png: await renderer.capture(),
      };
    },
  };
};

/** Offscreen worker rendering is preferred; unsupported first-context creation falls back to one hidden renderer. */
export const createCadBrowserPool = (options: CadBrowserPoolOptions) => {
  let supported = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
  let firstCreated = false;
  return createCadRendererPool({
    isCurrent: options.isCurrent,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    createWorker: async () => {
      if (supported) {
        try {
          const worker = await createOffscreenWorker(
            options.readAsset,
            options.onRendererDiagnostic,
          );
          firstCreated = true;
          return worker;
        } catch {
          if (firstCreated) throw new CadRendererError("renderer-unavailable");
          supported = false;
        }
      }
      return createMainThreadWorker(options.readAsset, options.onRendererDiagnostic);
    },
  });
};
