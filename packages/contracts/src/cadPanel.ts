import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ThreadId, TurnId } from "./baseSchemas.ts";
import { CadHash, CadSnapshotId } from "./cad.ts";
import { CadViewState } from "./cadView.ts";

export const CadPanelInput = Schema.Struct({ threadId: ThreadId });
export const CadPanelState = Schema.Struct({
  threadId: ThreadId,
  agentControlling: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  agentActivityTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  userRevision: Schema.NullOr(Schema.Int),
  view: Schema.NullOr(CadViewState),
  captureId: Schema.NullOr(CadSnapshotId),
  unavailableRootId: Schema.optional(CadHash),
});
export type CadPanelState = typeof CadPanelState.Type;
export const CadPanelSaveInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Schema.NullOr(Schema.Int),
  view: CadViewState,
});
export const CadPanelSceneInput = Schema.Struct({ threadId: ThreadId, snapshotId: CadSnapshotId });
export const CadPanelSceneTicket = Schema.Struct({ sceneId: CadSnapshotId, token: CadSnapshotId });
export type CadPanelSceneTicket = typeof CadPanelSceneTicket.Type;
