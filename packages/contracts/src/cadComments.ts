import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";
import { CommandId, IsoDateTime, ProjectId, ThreadId, TurnId } from "./baseSchemas.ts";

const text = (max: number) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((s) => [...s].length <= max),
  );
const Id = text(160);
/** Why a user dismissed a finding. Also the text of the review learning it creates. */
export const CadReviewReason = text(500);
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
  /** Present only while the latest review carried a reason; reopening clears it. */
  reviewReason: Schema.optionalKey(CadReviewReason),
  number: Schema.Int,
  createdAt: IsoDateTime,
  turnId: TurnId,
});
export type CadComment = typeof CadComment.Type;
/**
 * Chat record of one `cad_comments_publish` call: the findings that became comments and the
 * items the server rejected. Replayed publications are omitted because they were already shown.
 */
export const CadCommentsPublishedCard = Schema.Struct({
  published: Schema.Array(
    Schema.Struct({
      publicationKey: Schema.String,
      commentId: CadComment.fields.id,
      number: CadComment.fields.number,
      title: CadComment.fields.title,
      location: Schema.String,
    }),
  ),
  rejected: Schema.Array(
    Schema.Struct({
      publicationKey: Schema.String,
      title: Schema.NullOr(Schema.String),
      reason: Schema.String,
    }),
  ),
});
export type CadCommentsPublishedCard = typeof CadCommentsPublishedCard.Type;
export const CAD_COMMENTS_PUBLISHED_ACTIVITY = "cad.comments.published";

const { modelDescriptor: _modelDescriptor, ...summaryFields } = CadComment.fields;
export const CadCommentsCatalog = Schema.Struct({
  comments: Schema.Array(Schema.Struct(summaryFields)),
  modelDescriptors: Schema.Record(Schema.String, Schema.String),
});
/** A manifest descriptor is shared by every finding on that model, rather than repeated per item. */
export const cadCommentsCatalog = (
  comments: readonly CadComment[],
): typeof CadCommentsCatalog.Type => ({
  comments: comments.map(({ modelDescriptor: _descriptor, ...comment }) => comment),
  modelDescriptors: Object.fromEntries(comments.map((c) => [c.modelKey, c.modelDescriptor])),
});
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
  reason: Schema.optionalKey(CadReviewReason),
  commandId: CommandId,
});
/**
 * User feedback the project keeps from dismissals with a reason. Agents receive every learning
 * with the review guidance so later reviews do not repeat findings the user rejected.
 */
export const CadReviewLearning = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  text: CadReviewReason,
  sourceCommentId: Id,
  sourceThreadId: ThreadId,
  createdAt: IsoDateTime,
});
export type CadReviewLearning = typeof CadReviewLearning.Type;
/** Oldest learnings beyond this count are dropped per project. */
export const CAD_REVIEW_LEARNINGS_LIMIT = 50;
export const CadReviewLearningRemoveInput = Schema.Struct({
  projectId: ProjectId,
  learningId: Id,
  commandId: CommandId,
});
export const CadReviewLearningRemoveCommand = Schema.Struct({
  ...CadReviewLearningRemoveInput.fields,
  type: Schema.Literal("project.cad.review-learning.remove"),
});
export const CadReviewLearningAdded = Schema.Struct({
  projectId: ProjectId,
  learning: CadReviewLearning,
});
export const CadReviewLearningRemoved = Schema.Struct({
  projectId: ProjectId,
  learningId: Id,
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
  reason: Schema.optionalKey(CadReviewReason),
  commandId: CommandId,
  payloadHash: CadHash,
});
export class CadCommentError extends Schema.TaggedErrorClass<CadCommentError>()("CadCommentError", {
  reason: Schema.String,
  details: Schema.optionalKey(Schema.String),
  currentComment: Schema.optionalKey(CadComment),
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
