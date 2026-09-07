import { assert, it } from "@effect/vitest";
import { MessageId, ThreadTurnAdmission } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("CAD lifecycle migration", (it) => {
  it.effect("backfills only unresolved legacy starts for correlated startup cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
    ) VALUES ('thread', 'project', 'Thread', '{"instanceId":"codex","model":"gpt-5.6"}',
      'full-access', 'default', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', 0, 0, 0)`;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,state,requested_at)
      VALUES ('thread','native-old','old','completed','2026-09-05T00:00:00.000Z'),
      ('thread',NULL,'pending','pending','2026-09-05T00:01:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 50 });
      const rows = yield* sql<{
        turn_admission_json: string;
      }>`SELECT turn_admission_json FROM projection_threads`;
      const state = yield* Schema.decodeEffect(Schema.fromJsonString(ThreadTurnAdmission))(
        rows[0]?.turn_admission_json ?? "null",
      );
      assert.deepStrictEqual(state, {
        pending: [
          {
            messageId: MessageId.make("pending"),
            requestedAt: "2026-09-05T00:01:00.000Z",
            turnId: null,
          },
        ],
        completedTurnIds: [],
      });
    }),
  );
});
