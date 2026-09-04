import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN onshape_source_json TEXT
  `;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN onshape_source_key TEXT
  `;
  yield* sql`
    CREATE UNIQUE INDEX projection_projects_active_onshape_source
    ON projection_projects (onshape_source_key)
    WHERE deleted_at IS NULL AND onshape_source_key IS NOT NULL
  `;
});
