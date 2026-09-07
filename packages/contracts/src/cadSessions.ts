import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { CadSnapshotId } from "./cad.ts";
import { CadViewState } from "./cadView.ts";

export const CadAgentContextId = CadSnapshotId;
export const CadContextKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Compact, server-private command index. Full semantic state stays in its SQL projection. */
export const CadSessionIndex = Schema.Struct({
  contextId: CadAgentContextId,
  threadId: ThreadId,
  childKey: Schema.NullOr(CadContextKey),
  revision: Schema.NullOr(Revision),
});
export type CadSessionIndex = typeof CadSessionIndex.Type;
export const CadViewerSession = Schema.Struct({
  ...CadSessionIndex.fields,
  view: Schema.NullOr(CadViewState),
});
export type CadViewerSession = typeof CadViewerSession.Type;
export const CadUserViewIndex = Schema.Struct({ threadId: ThreadId, revision: Revision });
export const CadUserView = Schema.Struct({ threadId: ThreadId, view: CadViewState });
export type CadUserView = typeof CadUserView.Type;

/** Internal commands only: adapters bind trusted app-owned context keys before calling CAD. */
export const CadContextEnsureCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.context.ensure"),
  commandId: CommandId,
  threadId: ThreadId,
  contextId: CadAgentContextId,
  childKey: Schema.NullOr(CadContextKey),
});
export const CadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.view.set"),
  commandId: CommandId,
  threadId: ThreadId,
  contextId: CadAgentContextId,
  expectedRevision: Schema.NullOr(Revision),
  view: CadViewState,
});
export const CadUserViewSetCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.user-view.set"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedRevision: Schema.NullOr(Revision),
  view: CadViewState,
});
export const CadContextEnsuredPayload = Schema.Struct({ session: CadSessionIndex });
export const CadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  contextId: CadAgentContextId,
  view: CadViewState,
});
export const CadUserViewSetPayload = CadUserView;
