import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_cad_sessions (
    context_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    child_key TEXT,
    revision INTEGER,
    view_json TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX projection_cad_primary ON projection_cad_sessions(thread_id) WHERE child_key IS NULL`;
  yield* sql`CREATE UNIQUE INDEX projection_cad_child ON projection_cad_sessions(thread_id, child_key) WHERE child_key IS NOT NULL`;
  yield* sql`CREATE TABLE projection_cad_user_views (
    thread_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    view_json TEXT NOT NULL
  )`;
});
