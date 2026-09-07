import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE cad_inspection_memory (
    project_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    entries_json TEXT NOT NULL
  )`;
});
