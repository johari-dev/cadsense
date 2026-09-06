import * as Schema from "effect/Schema";
import {
  createCadSceneRenderer,
  CadRendererError,
  type CadSceneRenderer,
} from "./CadSceneRenderer";
import { CadWorkerInput, type CadWorkerOutput } from "./CadWorkerProtocol";

const decode = Schema.decodeUnknownSync(CadWorkerInput);
// Dedicated workers post to their owner; this API has no target origin argument.
// eslint-disable-next-line unicorn/require-post-message-target-origin
const post = (message: CadWorkerOutput) => globalThis.postMessage(message);
let renderer: CadSceneRenderer | null = null;
let snapshotId: string | null = null;
let jobId: string | null = null;
let sequence = 0;
const reads = new Map<
  number,
  { jobId: string; resolve(value: ArrayBuffer): void; reject(error: CadRendererError): void }
>();
const capture = async (message: Extract<CadWorkerInput, { type: "capture" }>) => {
  if (!renderer || jobId !== null) {
    post({ type: "failure", jobId: message.jobId, reason: "renderer-unavailable" });
    return;
  }
  jobId = message.jobId;
  try {
    if (snapshotId !== message.state.snapshotId) {
      if (!message.manifest || message.manifest.snapshotId !== message.state.snapshotId)
        throw new CadRendererError("invalid-snapshot");
      await renderer.load(
        message.manifest,
        (sha256) =>
          new Promise((resolve, reject) => {
            const requestId = ++sequence;
            reads.set(requestId, { jobId: message.jobId, resolve, reject });
            post({
              type: "asset",
              requestId,
              jobId: message.jobId,
              snapshotId: message.state.snapshotId,
              sha256,
            });
          }),
      );
      snapshotId = message.state.snapshotId;
    }
    renderer.resize(message.width, message.height, 1);
    if (message.appearance) renderer.setAppearance(message.appearance);
    const pose = renderer.apply(message.state);
    const png = await renderer.capture();
    post({
      type: "result",
      jobId: message.jobId,
      snapshotId: message.state.snapshotId,
      revision: message.state.revision,
      pose,
      png,
    });
  } catch (error) {
    post({
      type: "failure",
      jobId: message.jobId,
      reason: error instanceof CadRendererError ? error.reason : "renderer-unavailable",
    });
  } finally {
    jobId = null;
  }
};
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  let message: CadWorkerInput;
  try {
    message = decode(event.data);
  } catch {
    return;
  }
  if (message.type === "initialize") {
    if (renderer) return;
    if (!(message.canvas instanceof OffscreenCanvas)) {
      post({ type: "unavailable" });
      return;
    }
    try {
      renderer = createCadSceneRenderer({
        canvas: message.canvas,
        onFrame: (milliseconds) => post({ type: "frame", milliseconds }),
        onContextLost: () => post({ type: "context-loss" }),
        onUnavailable: () => post({ type: "unavailable" }),
      });
      post({ type: "ready" });
    } catch {
      post({ type: "unavailable" });
    }
  } else if (message.type === "capture") {
    void capture(message);
  } else {
    const read = reads.get(message.requestId);
    if (!read || read.jobId !== message.jobId || jobId !== message.jobId) return;
    reads.delete(message.requestId);
    if (message.bytes) read.resolve(message.bytes);
    else read.reject(new CadRendererError("invalid-snapshot"));
  }
});
