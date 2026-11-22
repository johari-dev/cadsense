import { ThreadId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const model = '{"instanceId":"codex","model":"gpt-5.6"}';

// Seeds projection rows directly: two live projects, one empty project, one
// deleted project, an active thread, two archived threads and a deleted
// archived thread. Comment summaries only read state/severity/outdated.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at, deleted_at)
    VALUES ('p-live', 'Live', '/live', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
      ('p-archived', 'Archived only', '/archived', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL),
      ('p-empty', 'Empty', '/empty', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', NULL),
      ('p-deleted', 'Deleted', '/deleted', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-05T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, latest_turn_id,
      created_at, updated_at, archived_at, deleted_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
    ) VALUES
      ('t-active', 'p-live', 'Active', ${model}, 'full-access', 'default', 'turn-active',
        '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NULL, NULL, 0, 0, 0),
      ('t-archived-old', 'p-archived', 'Archived old', ${model}, 'full-access', 'default', 'turn-archived',
        '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL, 0, 0, 0),
      ('t-archived-new', 'p-archived', 'Archived new', ${model}, 'full-access', 'default', NULL,
        '2026-02-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL, 0, 0, 0),
      ('t-deleted', 'p-live', 'Deleted', ${model}, 'full-access', 'default', NULL,
        '2026-02-04T00:00:00.000Z', '2026-02-04T00:00:00.000Z', '2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z', 0, 0, 0)`;
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at)
    VALUES ('t-active', 'turn-active', 'completed', '2026-02-01T00:01:00.000Z', '2026-02-01T00:02:00.000Z'),
      ('t-archived-old', 'turn-archived', 'completed', '2026-02-02T00:01:00.000Z', '2026-02-02T00:02:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, runtime_mode, updated_at)
    VALUES ('t-active', 'ready', 'codex', 'full-access', '2026-02-01T00:03:00.000Z'),
      ('t-archived-old', 'stopped', 'codex', 'full-access', '2026-02-02T00:03:00.000Z'),
      ('t-deleted', 'stopped', 'codex', 'full-access', '2026-02-04T00:03:00.000Z')`;
  yield* sql`INSERT INTO projection_cad_comments (comment_id, thread_id, snapshot_id, sequence, record_json)
    VALUES ('c1', 't-active', 's', 1, '{"state":"open","severity":"blocker"}'),
      ('c2', 't-active', 's', 2, '{"state":"open","severity":"concern"}'),
      ('c3', 't-archived-old', 's', 3, '{"state":"open","severity":"concern","outdated":{}}'),
      ('c4', 't-archived-old', 's', 4, '{"state":"resolved","severity":"blocker"}'),
      ('c5', 't-deleted', 's', 5, '{"state":"open","severity":"blocker"}')`;
});

it.layer(layer)("ProjectionSnapshotQuery shell snapshots", (it) => {
  it.effect("scope threads and projects, and carry open cad comments in both scopes", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionSnapshotQuery;

      const active = yield* query.getShellSnapshot();
      assert.deepStrictEqual(
        active.projects.map((project) => project.id),
        ["p-live", "p-archived", "p-empty"],
      );
      assert.deepStrictEqual(
        active.threads.map((thread) => thread.id),
        ["t-active"],
      );
      const activeThread = active.threads[0]!;
      assert.deepStrictEqual(activeThread.cadComments, { open: 2, blockers: 1, outdated: 0 });
      assert.equal(activeThread.latestTurn?.turnId, "turn-active");
      assert.equal(activeThread.session?.status, "ready");

      const archived = yield* query.getArchivedShellSnapshot();
      // Only projects that own an archived thread, newest archive first.
      assert.deepStrictEqual(
        archived.projects.map((project) => project.id),
        ["p-archived"],
      );
      assert.deepStrictEqual(
        archived.threads.map((thread) => thread.id),
        ["t-archived-new", "t-archived-old"],
      );
      const [newest, oldest] = archived.threads;
      assert.equal(newest!.cadComments, null);
      assert.equal(newest!.latestTurn, null);
      assert.equal(newest!.session, null);
      assert.deepStrictEqual(oldest!.cadComments, { open: 1, blockers: 0, outdated: 1 });
      assert.equal(oldest!.latestTurn?.turnId, "turn-archived");
      assert.equal(oldest!.session?.status, "stopped");

      // The single-thread lookup builds the same shell as the active snapshot.
      const byId = yield* query.getThreadShellById(ThreadId.make("t-active"));
      assert.deepStrictEqual(Option.getOrNull(byId), activeThread);
      assert.isTrue(
        Option.isNone(yield* query.getThreadShellById(ThreadId.make("t-archived-old"))),
      );
    }),
  );
});
