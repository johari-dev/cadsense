import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_cad_captures (
    capture_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    view_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX projection_cad_captures_turn ON projection_cad_captures(thread_id, turn_id, sequence DESC)`;
});
