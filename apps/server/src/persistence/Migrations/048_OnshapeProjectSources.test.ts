import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_OnshapeProjectSources", (it) => {
  it.effect("adds nullable source metadata and prevents duplicate active sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'local-project', 'Local project', '/tmp/local', NULL,
          '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.equal(columns.find((column) => column.name === "onshape_source_json")?.notnull, 0);
      assert.equal(columns.find((column) => column.name === "onshape_source_key")?.notnull, 0);

      yield* sql`
        UPDATE projection_projects
        SET onshape_source_json = '{}', onshape_source_key = 'same-source'
        WHERE project_id = 'local-project'
      `;
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          onshape_source_json, onshape_source_key, created_at, updated_at, deleted_at
        ) VALUES (
          'duplicate', 'Duplicate', '/tmp/duplicate', NULL,
          '{}', 'same-source', '2026-09-04T00:00:01.000Z', '2026-09-04T00:00:01.000Z', NULL
        )
      `);
      assert.strictEqual(duplicate._tag, "Failure");

      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-09-04T00:00:02.000Z'
        WHERE project_id = 'local-project'
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          onshape_source_json, onshape_source_key, created_at, updated_at, deleted_at
        ) VALUES (
          'replacement', 'Replacement', '/tmp/replacement', NULL,
          '{}', 'same-source', '2026-09-04T00:00:03.000Z', '2026-09-04T00:00:03.000Z', NULL
        )
      `;
    }),
  );
});
