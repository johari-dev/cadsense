import * as Effect from "effect/Effect";
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
/** Why a newer current snapshot invalidated a comment's targets. */
export const CadCommentOutdatedReason = Schema.Literals(["removed", "moved", "geometry-changed"]);
export type CadCommentOutdatedReason = typeof CadCommentOutdatedReason.Type;
export const CadCommentOutdated = Schema.Struct({
  snapshotId: CadSnapshotId,
  reason: CadCommentOutdatedReason,
});
export type CadCommentOutdated = typeof CadCommentOutdated.Type;
/** An agent's evidence that a newer snapshot addressed the finding. Only the user resolves it. */
export const CadCommentProposal = Schema.Struct({
  snapshotId: CadSnapshotId,
  explanation: text(1000),
  turnId: TurnId,
  createdAt: IsoDateTime,
});
export type CadCommentProposal = typeof CadCommentProposal.Type;
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
  // Projection state beside review state. Records written before these fields decode as null.
  outdated: Schema.NullOr(CadCommentOutdated).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  proposal: Schema.NullOr(CadCommentProposal).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
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
  proposed: Schema.Array(
    Schema.Struct({
      publicationKey: Schema.String,
      commentId: CadComment.fields.id,
      number: CadComment.fields.number,
      title: CadComment.fields.title,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
  Schema.Struct({
    kind: Schema.Literal("propose-resolve"),
    publicationKey: Id,
    inspectedSnapshotId: CadSnapshotId,
    commentId: Id,
    explanation: text(1000),
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
export const CadCommentProposed = Schema.Struct({ commentId: Id, proposal: CadCommentProposal });
export type CadCommentProposed = typeof CadCommentProposed.Type;
const Proposals = Schema.Array(CadCommentProposed).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);
export const CadCommentsCommitCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.comments.commit"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedCatalogVersion: Schema.Int,
  comments: Schema.Array(CadComment),
  receipts: Schema.Array(CadCommentReceipt),
  proposals: Proposals,
});
/**
 * Internal command from the comments service after a snapshot becomes current for a root: each
 * open comment on that root with its recomputed reason, null when its targets are unchanged.
 */
export const CadCommentsOutdateCommand = Schema.Struct({
  type: Schema.Literal("thread.cad.comments.outdate"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotId: CadSnapshotId,
  entries: Schema.Array(
    Schema.Struct({ commentId: Id, reason: Schema.NullOr(CadCommentOutdatedReason) }),
  ),
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
  proposals: Proposals,
});
/** Only comments whose annotation changed are listed. */
export const CadCommentsOutdated = Schema.Struct({
  threadId: ThreadId,
  snapshotId: CadSnapshotId,
  entries: Schema.Array(
    Schema.Struct({ commentId: Id, outdated: Schema.NullOr(CadCommentOutdated) }),
  ),
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
