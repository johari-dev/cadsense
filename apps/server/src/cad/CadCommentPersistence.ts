import {
  CAD_REVIEW_LEARNINGS_LIMIT,
  CadComment,
  CadCommentOutdated,
  CadCommentProposal,
  CadCommentReceipt,
  CadCommentReviewed,
  CadReviewLearning,
  type OrchestrationEvent,
  type ProjectId,
  type ThreadId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeComments = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(CadComment)));
const decodeReceipts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(CadCommentReceipt)),
);
const decodeReviews = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(CadCommentReviewed)),
);
const decodeLearnings = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(CadReviewLearning)),
);
const encodeComment = Schema.encodeEffect(Schema.fromJsonString(CadComment));
const encodeLearning = Schema.encodeEffect(Schema.fromJsonString(CadReviewLearning));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(CadCommentReceipt));
const encodeReview = Schema.encodeEffect(Schema.fromJsonString(CadCommentReviewed));
const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(CadCommentProposal));
const encodeOutdated = Schema.encodeEffect(Schema.fromJsonString(CadCommentOutdated));
export const readThreadCadComments = Effect.fn("readThreadCadComments")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT record_json AS record FROM projection_cad_comments WHERE thread_id=${threadId} ORDER BY sequence, comment_id`;
  return yield* decodeComments(rows.map((r) => r.record));
});
/** Oldest first, matching the order agents see them in the review guidance. */
export const readProjectCadReviewLearnings = Effect.fn("readProjectCadReviewLearnings")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT record_json AS record FROM projection_cad_review_learnings WHERE project_id=${projectId} ORDER BY sequence, learning_id`;
  return yield* decodeLearnings(rows.map((r) => r.record));
});
export const readCadComments = Effect.fn("readCadComments")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const comments =
    yield* sql`SELECT record_json AS record FROM projection_cad_comments ORDER BY sequence, comment_id`;
  const receipts = yield* sql`SELECT record_json AS record FROM projection_cad_comment_receipts`;
  const reviews = yield* sql`SELECT record_json AS record FROM projection_cad_comment_reviews`;
  const learnings =
    yield* sql`SELECT record_json AS record FROM projection_cad_review_learnings ORDER BY sequence, learning_id`;
  return {
    cadComments: yield* decodeComments(comments.map((r) => r.record)),
    cadCommentReceipts: yield* decodeReceipts(receipts.map((r) => r.record)),
    cadCommentReviews: yield* decodeReviews(reviews.map((r) => r.record)),
    cadReviewLearnings: yield* decodeLearnings(learnings.map((r) => r.record)),
  };
});

export const projectCadCommentEvent = Effect.fn("projectCadCommentEvent")(function* (
  event: OrchestrationEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "thread.created") {
    const id = event.payload.threadId;
    yield* sql`DELETE FROM projection_cad_comments WHERE thread_id=${id}`;
    yield* sql`DELETE FROM projection_cad_comment_receipts WHERE thread_id=${id}`;
    yield* sql`DELETE FROM projection_cad_comment_reviews WHERE json_extract(record_json,'$.threadId')=${id}`;
  } else if (event.type === "thread.cad-comments-committed") {
    for (const comment of event.payload.comments)
      yield* sql`INSERT INTO projection_cad_comments(comment_id, thread_id, snapshot_id, sequence, record_json) VALUES(${comment.id},${comment.threadId},${comment.snapshotId},${event.sequence},${yield* encodeComment(comment)}) ON CONFLICT(comment_id) DO NOTHING`;
    for (const receipt of event.payload.receipts)
      yield* sql`INSERT INTO projection_cad_comment_receipts(thread_id, publication_key, record_json) VALUES(${receipt.threadId},${receipt.key},${yield* encodeReceipt(receipt)}) ON CONFLICT(thread_id, publication_key) DO NOTHING`;
    for (const { commentId, proposal } of event.payload.proposals)
      yield* sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.proposal',json(${yield* encodeProposal(proposal)})) WHERE comment_id=${commentId} AND thread_id=${event.payload.threadId}`;
  } else if (event.type === "thread.cad-comment-reviewed") {
    const p = event.payload;
    // The latest review owns the reason: a reopen or reason-less review clears the previous one.
    // The user's judgment also supersedes any agent proposal.
    yield* p.reason === undefined
      ? sql`UPDATE projection_cad_comments SET record_json=json_remove(json_set(record_json,'$.state',${p.state},'$.version',${p.version},'$.proposal',NULL),'$.reviewReason') WHERE comment_id=${p.commentId} AND thread_id=${p.threadId}`
      : sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.state',${p.state},'$.version',${p.version},'$.reviewReason',${p.reason},'$.proposal',NULL) WHERE comment_id=${p.commentId} AND thread_id=${p.threadId}`;
    yield* sql`INSERT INTO projection_cad_comment_reviews(command_id,record_json) VALUES(${p.commandId},${yield* encodeReview(p)}) ON CONFLICT(command_id) DO NOTHING`;
  } else if (event.type === "thread.cad-comments-outdated") {
    for (const { commentId, outdated } of event.payload.entries)
      yield* outdated === null
        ? sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.outdated',NULL) WHERE comment_id=${commentId} AND thread_id=${event.payload.threadId}`
        : sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.outdated',json(${yield* encodeOutdated(outdated)})) WHERE comment_id=${commentId} AND thread_id=${event.payload.threadId}`;
  } else if (event.type === "project.cad-review-learning-added") {
    const { projectId, learning } = event.payload;
    yield* sql`INSERT INTO projection_cad_review_learnings(learning_id, project_id, sequence, record_json) VALUES(${learning.id},${projectId},${event.sequence},${yield* encodeLearning(learning)}) ON CONFLICT(learning_id) DO NOTHING`;
    yield* sql`DELETE FROM projection_cad_review_learnings WHERE project_id=${projectId} AND learning_id NOT IN (SELECT learning_id FROM projection_cad_review_learnings WHERE project_id=${projectId} ORDER BY sequence DESC, learning_id DESC LIMIT ${CAD_REVIEW_LEARNINGS_LIMIT})`;
  } else if (event.type === "project.cad-review-learning-removed") {
    yield* sql`DELETE FROM projection_cad_review_learnings WHERE learning_id=${event.payload.learningId} AND project_id=${event.payload.projectId}`;
  }
});
