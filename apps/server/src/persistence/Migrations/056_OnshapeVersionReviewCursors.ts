import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Newest Onshape version each auto-review project has already seen, so a restart
// never reviews the same version twice and the first check only records a baseline.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE onshape_version_review_cursors (
      project_id TEXT PRIMARY KEY NOT NULL,
      version_id TEXT NOT NULL,
      version_created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
});
