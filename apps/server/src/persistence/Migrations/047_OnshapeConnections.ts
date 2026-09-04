import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE onshape_connections (
      connection_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      host TEXT NOT NULL,
      credential_revision TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE onshape_credential_blobs (
      connection_id TEXT NOT NULL,
      credential_revision TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'cleanup_pending')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, credential_revision)
    ) STRICT
  `;
  yield* sql`
    CREATE UNIQUE INDEX onshape_credential_blobs_active
    ON onshape_credential_blobs (connection_id)
    WHERE state = 'active'
  `;
  yield* sql`
    CREATE INDEX onshape_credential_blobs_cleanup_pending
    ON onshape_credential_blobs (created_at)
    WHERE state = 'cleanup_pending'
  `;
});
