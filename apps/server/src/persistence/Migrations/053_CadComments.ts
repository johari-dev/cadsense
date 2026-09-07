import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_cad_comments(comment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, sequence INTEGER NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX cad_comments_thread ON projection_cad_comments(thread_id,sequence,comment_id)`;
  yield* sql`CREATE TABLE projection_cad_comment_receipts(thread_id TEXT NOT NULL, publication_key TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(thread_id,publication_key))`;
  yield* sql`CREATE TABLE projection_cad_comment_reviews(command_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)`;
});
