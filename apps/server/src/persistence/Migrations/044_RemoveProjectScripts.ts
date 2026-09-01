import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (columns.some((column) => column.name === "scripts_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      DROP COLUMN scripts_json
    `;
  }
});
