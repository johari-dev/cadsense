import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const codexSolSelection = JSON.stringify({
  instanceId: "codex",
  model: "gpt-5.6-sol",
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = ${codexSolSelection}
    WHERE json_extract(default_model_selection_json, '$.instanceId') = 'claudeAgent'
      AND json_extract(default_model_selection_json, '$.model') = 'claude-fable-5'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection',
      json(${codexSolSelection})
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_extract(payload_json, '$.defaultModelSelection.instanceId') = 'claudeAgent'
      AND json_extract(payload_json, '$.defaultModelSelection.model') = 'claude-fable-5'
  `;
});
