import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";
import { CommandId, IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";

const text = (max: number) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((s) => [...s].length <= max),
  );
const Id = text(160);
export const CadCommentPoint = Schema.Tuple([
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
]);
export const CadCommentState = Schema.Literals(["open", "resolved", "dismissed"]);
export const CadCommentTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("point"),
    label: text(120),
    occurrenceId: CadHash,
    point: CadCommentPoint,
    normal: Schema.NullOr(CadCommentPoint),
    captureId: Id,
    inspectionId: Id,
    confirmationReason: text(1000),
  }),
  Schema.Struct({
    kind: Schema.Literal("part"),
    label: text(120),
    occurrenceId: CadHash,
    preciseLocationLimitation: text(1000),
  }),
]);
export type CadCommentTarget = typeof CadCommentTarget.Type;
export const CadCommentLink = Schema.Struct({
  kind: Schema.Literals(["correction", "follow-up"]),
  commentId: Id,
  explanation: text(1000),
});
export const CadComment = Schema.Struct({
  id: Id,
  threadId: ThreadId,
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  modelKey: CadHash,
  modelDescriptor: Schema.String,
  title: text(160),
  body: text(4000),
  targets: Schema.Array(CadCommentTarget).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  link: Schema.NullOr(CadCommentLink),
  state: CadCommentState,
  version: Schema.Int,
  number: Schema.Int,
  createdAt: IsoDateTime,
  turnId: TurnId,
});
export type CadComment = typeof CadComment.Type;
export const CadCommentPublication = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("new"),
    publicationKey: Id,
    inspectedSnapshotId: CadSnapshotId,
    title: text(160),
    body: text(4000),
    targets: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("point"),
          label: text(120),
          candidateId: Id,
          inspectionId: Id,
          confirmationReason: text(1000),
        }),
        Schema.Struct({
          kind: Schema.Literal("part"),
          label: text(120),
          occurrenceId: CadHash,
          preciseLocationLimitation: text(1000),
        }),
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    link: Schema.optionalKey(Schema.NullOr(CadCommentLink)),
  }),
  Schema.Struct({
    kind: Schema.Literal("reuse"),
    publicationKey: Id,
    inspectedSnapshotId: CadSnapshotId,
    reuseCommentId: Id,
  }),
]);
export type CadCommentPublication = typeof CadCommentPublication.Type;
export const CadCommentsListInput = Schema.Struct({
  rootId: Schema.optionalKey(CadHash),
  modelKey: Schema.optionalKey(CadHash),
  state: Schema.optionalKey(CadCommentState),
  cursor: Schema.optionalKey(Id),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const CadCommentsListResult = Schema.Struct({
  comments: Schema.Array(CadComment),
  catalogVersion: Schema.Int,
  nextCursor: Schema.NullOr(Schema.String),
});
export const CadCommentsPublishInput = Schema.Struct({
  expectedCatalogVersion: Schema.Int,
  items: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export const CadCommentsPublishToolInput = Schema.Struct({
  expectedCatalogVersion: Schema.Int,
  items: Schema.Array(CadCommentPublication).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export const CadCommentPick = Schema.Struct({
  pickKey: Id,
  intendedOccurrenceId: CadHash,
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export const CadCommentLocateInput = Schema.Struct({
  captureId: Id,
  picks: Schema.Array(CadCommentPick).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export const CadCommentInspectInput = Schema.Struct({
  candidateIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export const CadCommentReviewInput = Schema.Struct({
  threadId: ThreadId,
  commentId: Id,
  expectedVersion: Schema.Int,
  state: CadCommentState,
  commandId: CommandId,
});
export const CadCommentReceipt = Schema.Struct({
  key: Id,
  hash: CadHash,
  commentId: Id,
  threadId: ThreadId,
});
export type CadCommentReceipt = typeof CadCommentReceipt.Type;
export const CadCommentsCommitCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.comments.commit"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedCatalogVersion: Schema.Int,
  comments: Schema.Array(CadComment),
  receipts: Schema.Array(CadCommentReceipt),
});
export const CadCommentReviewCommand = Schema.Struct({
  ...CadCommentReviewInput.fields,
  type: Schema.Literal("thread.cad.comment.review"),
  payloadHash: CadHash,
});
export const CadCommentsCommitted = Schema.Struct({
  threadId: ThreadId,
  comments: Schema.Array(CadComment),
  receipts: Schema.Array(CadCommentReceipt),
});
export const CadCommentReviewed = Schema.Struct({
  threadId: ThreadId,
  commentId: Id,
  state: CadCommentState,
  version: Schema.Int,
  commandId: CommandId,
  payloadHash: CadHash,
});
export class CadCommentError extends Schema.TaggedErrorClass<CadCommentError>()("CadCommentError", {
  reason: Schema.String,
}) {}

/** Optional renderer work runs against the capture's frozen view, never the user's later view. */
export const CadCommentRenderWork = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("locate"), picks: Schema.Array(CadCommentPick) }),
  Schema.Struct({
    kind: Schema.Literal("inspect"),
    targets: Schema.Array(
      Schema.Struct({ candidateId: Id, occurrenceId: CadHash, point: CadCommentPoint }),
    ),
  }),
]);
export type CadCommentRenderWork = typeof CadCommentRenderWork.Type;
export const CadCommentRenderHit = Schema.Struct({
  pickKey: Id,
  reason: Schema.String,
  occurrenceId: Schema.NullOr(CadHash),
  point: Schema.NullOr(CadCommentPoint),
  normal: Schema.NullOr(CadCommentPoint),
});
export type CadCommentRenderHit = typeof CadCommentRenderHit.Type;
