import * as Schema from "effect/Schema";
import { CommandId, ThreadId, TurnId } from "./baseSchemas.ts";
import { CadAgentContextId } from "./cadSessions.ts";
import { CadCaptureResult } from "./cadTools.ts";
import { CadCameraPose, CadViewState } from "./cadView.ts";
import { CadSnapshotId } from "./cad.ts";

/** Compact durable timeline metadata; image bytes remain in the attachment store. */
export const CadCaptureCard = Schema.Struct({
  captureId: CadSnapshotId,
  snapshotId: CadCaptureResult.fields.snapshotId,
  revision: CadCaptureResult.fields.revision,
});
export type CadCaptureCard = typeof CadCaptureCard.Type;

export const CadCaptureRecord = Schema.Struct({
  threadId: ThreadId,
  contextId: CadAgentContextId,
  turnId: TurnId,
  capture: CadCaptureResult,
  cameraPose: CadCameraPose,
});
export type CadCaptureRecord = typeof CadCaptureRecord.Type;
export const CadCaptureRecordCommand = Schema.Struct({
  ...CadCaptureRecord.fields,
  type: Schema.Literal("thread.cad.capture.record"),
  commandId: CommandId,
});
export const CadPresentationSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.presentation.settle"),
  commandId: CommandId,
  threadId: ThreadId,
  captureId: CadAgentContextId,
  expectedUserRevision: Schema.NullOr(Schema.Int),
  view: Schema.NullOr(CadViewState),
});
