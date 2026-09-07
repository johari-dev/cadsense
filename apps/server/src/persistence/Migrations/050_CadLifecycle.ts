import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN cad_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN turn_admission_json TEXT`;
  // Capture the unresolved legacy request so startup can settle it before admission opens.
  yield* sql`
    UPDATE projection_threads SET turn_admission_json = (
      SELECT json_object('pending', json_array(json_object(
        'messageId', pending_message_id, 'requestedAt', requested_at, 'turnId', NULL
      )), 'completedTurnIds', json_array())
      FROM projection_turns WHERE projection_turns.thread_id = projection_threads.thread_id
        AND turn_id IS NULL AND pending_message_id IS NOT NULL AND state = 'pending'
      ORDER BY row_id DESC LIMIT 1
    )
  `;
});
