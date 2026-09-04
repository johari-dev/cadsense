import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const EMPTY_CATALOG_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE onshape_connection_catalog_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      updated_at TEXT NOT NULL
    ) STRICT
  `;
  yield* sql`
    INSERT INTO onshape_connection_catalog_state (singleton, updated_at)
    SELECT 1, COALESCE(MAX(updated_at), ${EMPTY_CATALOG_UPDATED_AT})
    FROM onshape_connections
  `;
});
