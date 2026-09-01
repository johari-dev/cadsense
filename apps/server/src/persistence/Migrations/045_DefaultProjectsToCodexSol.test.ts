import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_DefaultProjectsToCodexSol", (it) => {
  it.effect("replaces the retired Fable project default without changing thread models", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at
        ) VALUES (
          'project-fable',
          'Fable project',
          '/tmp/fable',
          '{"instanceId":"claudeAgent","model":"claude-fable-5"}',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          'event-project-fable',
          'project',
          'project-fable',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-fable',
          NULL,
          'correlation-project-fable',
          'user',
          '{"projectId":"project-fable","title":"Fable project","workspaceRoot":"/tmp/fable","defaultModelSelection":{"instanceId":"claudeAgent","model":"claude-fable-5"},"createdAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const [project] = yield* sql<{
        readonly instanceId: string;
        readonly model: string;
      }>`
        SELECT
          json_extract(default_model_selection_json, '$.instanceId') AS "instanceId",
          json_extract(default_model_selection_json, '$.model') AS model
        FROM projection_projects
        WHERE project_id = 'project-fable'
      `;
      const [event] = yield* sql<{
        readonly instanceId: string;
        readonly model: string;
      }>`
        SELECT
          json_extract(payload_json, '$.defaultModelSelection.instanceId') AS "instanceId",
          json_extract(payload_json, '$.defaultModelSelection.model') AS model
        FROM orchestration_events
        WHERE event_id = 'event-project-fable'
      `;

      assert.deepStrictEqual(project, {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      });
      assert.deepStrictEqual(event, {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      });
    }),
  );
});
