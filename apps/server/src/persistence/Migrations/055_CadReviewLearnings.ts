import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_cad_review_learnings(learning_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX cad_review_learnings_project ON projection_cad_review_learnings(project_id,sequence,learning_id)`;
});
