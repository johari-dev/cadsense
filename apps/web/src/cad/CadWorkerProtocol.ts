import { CadCameraPose, CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";

export const CadWorkerInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("initialize"), canvas: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("capture"),
    jobId: Schema.String,
    state: CadViewState,
    manifest: Schema.optionalKey(CadSnapshotManifest),
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("asset"),
    jobId: Schema.String,
    requestId: Schema.Int,
    bytes: Schema.NullOr(Schema.instanceOf(ArrayBuffer)),
  }),
]);
export type CadWorkerInput = typeof CadWorkerInput.Type;
export const CadWorkerOutput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("unavailable") }),
  Schema.Struct({
    type: Schema.Literal("asset"),
    jobId: Schema.String,
    requestId: Schema.Int,
    snapshotId: Schema.String,
    sha256: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    jobId: Schema.String,
    snapshotId: Schema.String,
    revision: Schema.Int,
    pose: CadCameraPose,
    png: Schema.instanceOf(Blob),
  }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    jobId: Schema.String,
    reason: Schema.Literals([
      "renderer-unavailable",
      "invalid-view",
      "invalid-snapshot",
      "superseded",
      "capture-failed",
      "renderer-busy",
    ]),
  }),
]);
export type CadWorkerOutput = typeof CadWorkerOutput.Type;
