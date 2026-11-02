import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The CAD file a folder project reviews. See localCad/LocalCad.md. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN local_cad_source_json TEXT
  `;
});
