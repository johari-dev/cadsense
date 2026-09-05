import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_OnshapeConnectionCatalogState", (it) => {
  it.effect("backfills the durable catalog revision from existing connections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO onshape_connections (
          connection_id, name, host, credential_revision, verified_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000001', 'Team CAD', 'https://cad.onshape.com',
          'revision', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z',
          '2026-09-04T00:00:02.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });
      const rows = yield* sql<{ readonly singleton: number; readonly updatedAt: string }>`
        SELECT singleton, updated_at AS "updatedAt"
        FROM onshape_connection_catalog_state
      `;

      assert.deepEqual(rows, [{ singleton: 1, updatedAt: "2026-09-04T00:00:02.000Z" }]);
    }),
  );
});
