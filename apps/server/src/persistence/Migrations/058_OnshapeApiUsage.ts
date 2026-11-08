import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Each connection's Onshape API calls in `api_calls_year`, and its plan's yearly limit. A count
 * from an earlier year reads as zero; the next counted call restarts it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE onshape_connections ADD COLUMN api_calls_year INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE onshape_connections ADD COLUMN api_calls_used INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE onshape_connections ADD COLUMN api_call_limit INTEGER NOT NULL DEFAULT 2500`;
});
