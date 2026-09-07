import {
  CAD_CAPTURE_SIZE,
  CadViewError,
  CommandId,
  type CadCaptureResult,
  type ThreadId,
  type TurnId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { CadRenderBroker, type CadRenderRequest } from "./CadRenderBroker.ts";

export interface CadCaptureDelivery {
  readonly result: typeof CadCaptureResult.Type;
  readonly png: Uint8Array;
}
export class CadCaptureArtifacts extends Context.Service<
  CadCaptureArtifacts,
  {
    readonly capture: (
      input: CadRenderRequest & { readonly threadId: ThreadId; readonly turnId: TurnId },
    ) => Effect.Effect<CadCaptureDelivery, CadViewError>;
  }
>()("@cadsense/server/cad/CadCaptureArtifacts") {}
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });

export const make = Effect.gen(function* () {
  const broker = yield* CadRenderBroker;
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const capture = Effect.fn("CadCaptureArtifacts.capture")(function* (
    input: CadRenderRequest & { readonly threadId: ThreadId; readonly turnId: TurnId },
  ) {
    const rendered = yield* broker.capture(input).pipe(Effect.mapError(unavailable));
    const captureId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
    const artifactPath = path.join(config.attachmentsDir, `cad-${captureId}.png`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const result = {
      captureId,
      rootId: input.state.rootId,
      snapshotId: input.state.snapshotId,
      revision: input.state.revision,
      artifact: {
        path: artifactPath,
        mimeType: "image/png" as const,
        ...CAD_CAPTURE_SIZE,
        byteLength: rendered.png.byteLength,
        createdAt,
      },
      summary: "CAD view captured.",
    };
    // Once file publication starts, wait for the durable record receipt before returning or cancelling.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fs.writeFile(artifactPath, rendered.png, { flag: "wx" });
        yield* engine
          .dispatch({
            type: "thread.cad.capture.record",
            commandId: CommandId.make(captureId),
            threadId: input.threadId,
            contextId: input.sessionId,
            turnId: input.turnId,
            capture: result,
            cameraPose: rendered.receipt.pose,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                if (
                  cause._tag !== "OrchestrationCommandInvariantError" &&
                  cause._tag !== "OrchestrationCommandPreviouslyRejectedError"
                ) {
                  yield* Effect.logWarning(
                    "CAD capture record receipt is uncertain; preserving its artifact",
                    { captureId },
                  );
                  return yield* cause;
                }
                yield* fs
                  .remove(artifactPath)
                  .pipe(
                    Effect.catch(() =>
                      Effect.logWarning("CAD capture artifact cleanup is pending", { captureId }),
                    ),
                  );
                return yield* cause;
              }),
            ),
          );
      }),
    ).pipe(Effect.mapError(unavailable));
    return { result, png: rendered.png };
  });
  return CadCaptureArtifacts.of({ capture });
});
export const layer = Layer.effect(CadCaptureArtifacts, make);
