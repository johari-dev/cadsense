import {
  CadComment,
  CadCommentReceipt,
  CadCommentReviewed,
  type OrchestrationEvent,
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
const encodeComment = Schema.encodeEffect(Schema.fromJsonString(CadComment));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(CadCommentReceipt));
const encodeReview = Schema.encodeEffect(Schema.fromJsonString(CadCommentReviewed));
export const readCadComments = Effect.fn("readCadComments")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const comments =
    yield* sql`SELECT record_json AS record FROM projection_cad_comments ORDER BY sequence, comment_id`;
  const receipts = yield* sql`SELECT record_json AS record FROM projection_cad_comment_receipts`;
  const reviews = yield* sql`SELECT record_json AS record FROM projection_cad_comment_reviews`;
  return {
    cadComments: yield* decodeComments(comments.map((r) => r.record)),
    cadCommentReceipts: yield* decodeReceipts(receipts.map((r) => r.record)),
    cadCommentReviews: yield* decodeReviews(reviews.map((r) => r.record)),
  };
});

export const projectCadCommentEvent = Effect.fn("projectCadCommentEvent")(function* (
  event: OrchestrationEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "thread.cad-comments-committed") {
    for (const comment of event.payload.comments)
      yield* sql`INSERT INTO projection_cad_comments(comment_id, thread_id, snapshot_id, sequence, record_json) VALUES(${comment.id},${comment.threadId},${comment.snapshotId},${event.sequence},${yield* encodeComment(comment)}) ON CONFLICT(comment_id) DO NOTHING`;
    for (const receipt of event.payload.receipts)
      yield* sql`INSERT INTO projection_cad_comment_receipts(thread_id, publication_key, record_json) VALUES(${receipt.threadId},${receipt.key},${yield* encodeReceipt(receipt)}) ON CONFLICT(thread_id, publication_key) DO NOTHING`;
  } else if (event.type === "thread.cad-comment-reviewed") {
    const p = event.payload;
    yield* sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.state',${p.state},'$.version',${p.version}) WHERE comment_id=${p.commentId} AND thread_id=${p.threadId}`;
    yield* sql`INSERT INTO projection_cad_comment_reviews(command_id,record_json) VALUES(${p.commandId},${yield* encodeReview(p)}) ON CONFLICT(command_id) DO NOTHING`;
  }
});
