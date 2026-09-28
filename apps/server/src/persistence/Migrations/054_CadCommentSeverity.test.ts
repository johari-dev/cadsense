import { assert, it } from "@effect/vitest";
import { ThreadId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readThreadCadComments } from "../../cad/CadCommentPersistence.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const threadId = ThreadId.make("thread");
const legacyRecord = {
  id: "legacy",
  threadId,
  rootId: "1".repeat(64),
  snapshotId: "00000000-0000-4000-8000-000000000002",
  modelKey: "2".repeat(64),
  modelDescriptor: "model",
  title: "Check this fastener",
  body: "The inspected attachment appears empty.",
  targets: [
    {
      kind: "part",
      label: "Intake",
      occurrenceId: "3".repeat(64),
      preciseLocationLimitation: "The precise hole could not be verified.",
    },
  ],
  link: null,
  state: "open",
  version: 0,
  number: 1,
  createdAt: "2026-09-05T00:00:00.000Z",
  turnId: "turn",
};

it.layer(NodeSqliteClient.layerMemory())("CAD comment severity migration", (it) => {
  it.effect("gives pre-existing comments null labels and keeps labels that already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const insert = (id: string, record: object) =>
        sql`INSERT INTO projection_cad_comments(comment_id, thread_id, snapshot_id, sequence, record_json) VALUES(${id},${threadId},${legacyRecord.snapshotId},1,${JSON.stringify(record)})`;
      yield* insert("legacy", legacyRecord);
      yield* insert("rated", {
        ...legacyRecord,
        id: "rated",
        number: 2,
        severity: "blocker",
        category: "interference",
      });
      yield* runMigrations({ toMigrationInclusive: 54 });
      const types = yield* sql<{ readonly severity: string; readonly category: string }>`
        SELECT json_type(record_json,'$.severity') AS severity, json_type(record_json,'$.category') AS category
        FROM projection_cad_comments ORDER BY comment_id`;
      assert.deepEqual(types, [
        { severity: "null", category: "null" },
        { severity: "text", category: "text" },
      ]);
      const comments = yield* readThreadCadComments(threadId);
      assert.deepEqual(
        comments.map((c) => [c.id, c.severity, c.category]),
        [
          ["legacy", null, null],
          ["rated", "blocker", "interference"],
        ],
      );
    }),
  );
});
