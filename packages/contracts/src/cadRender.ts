import { CadCommentRenderWork, CadCommentRenderHit } from "./cadComments.ts";
import * as Schema from "effect/Schema";
import { CadSnapshotId, CadSnapshotManifest } from "./cad.ts";
import { CadCameraPose, CadViewState } from "./cadView.ts";

export const CAD_CAPTURE_SIZE = { width: 1280, height: 960 } as const;
export const CadRenderPayload = Schema.Struct({
  sessionId: Schema.String,
  runId: Schema.String,
  manifest: CadSnapshotManifest,
  state: CadViewState,
  commentWork: Schema.optionalKey(CadCommentRenderWork),
});

export class CadRenderError extends Schema.TaggedErrorClass<CadRenderError>()("CadRenderError", {
  reason: Schema.Literals(["unavailable", "busy", "interrupted", "invalid-result"]),
}) {}
export const CadRenderTicket = Schema.Struct({
  jobId: Schema.String.check(Schema.isUUID(4)),
  token: Schema.String.check(Schema.isUUID(4)),
});
export type CadRenderTicket = typeof CadRenderTicket.Type;
export const CadRenderEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("capture"), ticket: CadRenderTicket }),
  Schema.Struct({ type: Schema.Literal("cancel"), jobId: Schema.String.check(Schema.isUUID(4)) }),
  Schema.Struct({ type: Schema.Literal("run-ended"), runId: Schema.String }),
]);
export type CadRenderEvent = typeof CadRenderEvent.Type;
export const CadRenderReceipt = Schema.Struct({
  snapshotId: CadSnapshotId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pose: CadCameraPose,
  commentHits: Schema.optionalKey(Schema.Array(CadCommentRenderHit)),
});
export type CadRenderReceipt = typeof CadRenderReceipt.Type;
