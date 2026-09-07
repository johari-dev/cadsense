import { CadViewError, ProjectId, ThreadId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readCadProjectMemory, updateCadProjectMemory } from "./CadProjectMemory.ts";

const projectId = ProjectId.make("memory-project");
const threadId = ThreadId.make("memory-thread");
const otherThread = ThreadId.make("other-thread");
const now = "2026-09-07T00:00:00Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, ProjectId.make("other-project")]) {
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,created_at,updated_at)
      VALUES(${id},'CAD','/tmp/test',${now},${now})`;
  }
  for (const id of [threadId, otherThread]) {
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
      VALUES(${id},${projectId},'CAD','{"instanceId":"codex","model":"test"}','full-access','default',${now},${now})`;
  }
});
const message = (id: string, text: string, thread = threadId, role = "user") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
    VALUES(${id},${thread},NULL,${role},${text},0,${now},${now})`;
  });
const remember = (key: string, quote: string, expectedRevision: number) => ({
  key,
  quote,
  expectedRevision,
  change: { type: "remember", kind: "constraint", target: null },
});
const isCadViewError = Schema.is(CadViewError);
const reason = (error: unknown) => (isCadViewError(error) ? error.reason : "unexpected");

it.effect(
  "shares verified facts across threads and replaces or forgets without accumulating history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* message("1", "The opening must accommodate gloves.");
      const input = remember("opening", "The opening must accommodate gloves.", 0);
      const first = yield* updateCadProjectMemory(projectId, threadId, input, null);
      assert.equal(first.entries[0]?.sourceMessageId, "1");
      assert.deepEqual(yield* readCadProjectMemory(projectId), first);
      const unchanged = yield* updateCadProjectMemory(
        projectId,
        threadId,
        { ...input, expectedRevision: 1 },
        null,
      );
      assert.equal(unchanged.revision, 1);
      yield* message("2", "The opening must accommodate insulated gloves.", otherThread);
      const corrected = yield* updateCadProjectMemory(
        projectId,
        otherThread,
        remember("opening", "The opening must accommodate insulated gloves.", 1),
        null,
      );
      assert.equal(corrected.entries.length, 1);
      assert.equal(corrected.entries[0]?.sourceThreadId, otherThread);
      yield* message("3", "Forget the opening constraint.", otherThread);
      const removed = yield* updateCadProjectMemory(
        projectId,
        otherThread,
        {
          key: "opening",
          expectedRevision: 2,
          quote: "Forget the opening constraint.",
          change: { type: "forget" },
        },
        null,
      );
      assert.deepEqual(removed, { revision: 3, entries: [] });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "rejects invented quotes, assistant text, old messages, and cross-project provenance",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* message("1", "Use a 10 mm opening.");
      yield* message("2", "Use a 20 mm opening.");
      yield* message("3", "The clearance is safe.", threadId, "assistant");
      yield* message("4", "Other thread fact.", otherThread);
      for (const quote of [
        "Invented fact.",
        "Use a 10 mm opening.",
        "The clearance is safe.",
        "Other thread fact.",
      ]) {
        const error = yield* updateCadProjectMemory(
          projectId,
          threadId,
          remember("opening", quote, 0),
          null,
        ).pipe(Effect.flip);
        assert.equal(reason(error), "memory-source-invalid");
      }
      const error = yield* updateCadProjectMemory(
        ProjectId.make("other-project"),
        threadId,
        remember("opening", "Use a 20 mm opening.", 0),
        null,
      ).pipe(Effect.flip);
      assert.equal(reason(error), "memory-source-invalid");
      assert.deepEqual(yield* readCadProjectMemory(projectId), { revision: 0, entries: [] });
      assert.deepEqual(yield* readCadProjectMemory(ProjectId.make("other-project")), {
        revision: 0,
        entries: [],
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("serializes competing writes and rejects stale revisions without losing the winner", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* message("1", "Keep the opening. Keep the bracket.");
    const outcomes = yield* Effect.all(
      [
        updateCadProjectMemory(
          projectId,
          threadId,
          remember("opening", "Keep the opening.", 0),
          null,
        ).pipe(Effect.result),
        updateCadProjectMemory(
          projectId,
          threadId,
          remember("bracket", "Keep the bracket.", 0),
          null,
        ).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
    const memory = yield* readCadProjectMemory(projectId);
    assert.equal(memory.entries.length, 1);
    assert.equal(memory.revision, 1);
    const error = yield* updateCadProjectMemory(
      projectId,
      threadId,
      remember("opening", "Keep the opening.", 0),
      null,
    ).pipe(Effect.flip);
    assert.equal(reason(error), "revision-conflict");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("enforces entry and UTF-8 byte budgets and rejects duplicate excerpts", () =>
  Effect.gen(function* () {
    yield* seed;
    const quotes = Array.from({ length: 21 }, (_, i) => `Constraint ${i}.`);
    yield* message("1", quotes.join(" "));
    for (const [i, quote] of quotes.slice(0, 20).entries())
      yield* updateCadProjectMemory(
        projectId,
        threadId,
        remember(`constraint-${i}`, quote, i),
        null,
      );
    assert.equal(
      reason(
        yield* updateCadProjectMemory(
          projectId,
          threadId,
          remember("extra", quotes[20]!, 20),
          null,
        ).pipe(Effect.flip),
      ),
      "memory-full",
    );
    assert.equal(
      reason(
        yield* updateCadProjectMemory(
          projectId,
          threadId,
          remember("duplicate", quotes[0]!, 20),
          null,
        ).pipe(Effect.flip),
      ),
      "invalid-operation",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM cad_project_memory`;
    const longQuotes = Array.from({ length: 20 }, (_, i) => `${i}${"界".repeat(390)}`);
    yield* message("2", longQuotes.join(" "));
    let revision = 0;
    for (const quote of longQuotes) {
      const result = yield* updateCadProjectMemory(
        projectId,
        threadId,
        remember(`constraint-${revision}`, quote, revision),
        null,
      ).pipe(Effect.result);
      if (result._tag === "Failure") {
        assert.equal(reason(result.failure), "memory-full");
        break;
      }
      revision++;
    }
    assert.isTrue(revision > 0 && revision < 20);
    assert.equal((yield* readCadProjectMemory(projectId)).revision, revision);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
