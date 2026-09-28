import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
// Comments published before severity and category existed carry explicit nulls, so every stored
// record has the same shape and the labels display nothing for them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.severity',NULL) WHERE json_type(record_json,'$.severity') IS NULL`;
  yield* sql`UPDATE projection_cad_comments SET record_json=json_set(record_json,'$.category',NULL) WHERE json_type(record_json,'$.category') IS NULL`;
});
