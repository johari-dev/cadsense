import {
  CAD_MEMORY_MAX_BYTES,
  CAD_MEMORY_MAX_ENTRIES,
  CAD_MEMORY_MAX_NEW_PER_MESSAGE,
  CadMemoryInput,
  CadProjectMemory,
  CadViewError,
  MessageId,
  type CadSnapshotManifest,
  type ProjectId,
  type ThreadId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const invalid = () => new CadViewError({ reason: "invalid-operation" });
const conflict = () => new CadViewError({ reason: "revision-conflict" });
const encodeEntries = Schema.encodeSync(Schema.fromJsonString(CadProjectMemory.fields.entries));
const decodeInput = Schema.decodeUnknownEffect(CadMemoryInput);
const decodeMemory = Schema.decodeUnknownEffect(CadProjectMemory);
const decodeSources = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: MessageId, text: Schema.String })),
);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      revision: CadProjectMemory.fields.revision,
      entries: Schema.fromJsonString(CadProjectMemory.fields.entries),
    }),
  ),
);

export const readCadProjectMemory = Effect.fn("readCadProjectMemory")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT revision, entries_json AS entries FROM cad_project_memory WHERE project_id=${projectId}`;
  const decoded = yield* decodeRows(rows);
  return decoded[0] ?? { revision: 0, entries: [] };
});

/** Only current snapshot references leave the store. User intent outlives its geometry binding. */
export function cadMemoryBrief(
  memory: CadProjectMemory,
  roots: readonly { rootId: string; snapshotId: string }[],
) {
  return {
    revision: memory.revision,
    entries: memory.entries.map((entry) => {
      const current =
        entry.target !== null &&
        roots.some(
          (root) =>
            root.rootId === entry.target?.rootId && root.snapshotId === entry.target.snapshotId,
        );
      return {
        ...entry,
        target: current ? entry.target : null,
        targetStatus:
          entry.target === null
            ? ("none" as const)
            : current
              ? ("current" as const)
              : ("stale" as const),
      };
    }),
  };
}

/** The calling thread owns provenance; the model cannot supply another thread or invent source text. */
export const updateCadProjectMemory = Effect.fn("updateCadProjectMemory")(function* (
  projectId: ProjectId,
  threadId: ThreadId,
  rawInput: unknown,
  snapshot: CadSnapshotManifest | null,
) {
  const input = yield* decodeInput(rawInput).pipe(Effect.mapError(invalid));
  if (input.quote.trim().length === 0) return yield* invalid();
  const target = input.change.type === "remember" ? input.change.target : null;
  const targetNode = target
    ? snapshot?.nodes.find((node) => node.id === target.occurrenceId)
    : undefined;
  if (
    target &&
    (!snapshot ||
      snapshot.projectId !== projectId ||
      target.rootId !== snapshot.rootId ||
      target.snapshotId !== snapshot.snapshotId ||
      !targetNode)
  )
    return yield* invalid();
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Acquire the write lock before reading the shared revision, including the first write.
      yield* sql`INSERT INTO cad_project_memory(project_id, revision, entries_json)
      VALUES(${projectId}, 0, '[]') ON CONFLICT(project_id) DO NOTHING`;
      const memory = yield* readCadProjectMemory(projectId);
      if (memory.revision !== input.expectedRevision) return yield* conflict();
      const rows = yield* sql`SELECT m.message_id AS id, m.text FROM projection_thread_messages m
      JOIN projection_threads t ON t.thread_id=m.thread_id
      JOIN projection_projects p ON p.project_id=t.project_id
      WHERE m.thread_id=${threadId} AND t.project_id=${projectId} AND m.role='user'
        AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1`;
      const sources = yield* decodeSources(rows);
      const source = sources[0];
      if (!source || !source.text.includes(input.quote))
        return yield* new CadViewError({ reason: "memory-source-invalid" });
      const entries = memory.entries.filter((entry) => entry.key !== input.key);
      if (input.change.type === "remember") {
        // Identical excerpts under different keys do not consume additional slots.
        if (entries.some((entry) => entry.quote === input.quote)) return yield* invalid();
        if (
          !memory.entries.some((entry) => entry.key === input.key) &&
          memory.entries.filter((entry) => entry.sourceMessageId === source.id).length >=
            CAD_MEMORY_MAX_NEW_PER_MESSAGE
        )
          return yield* new CadViewError({ reason: "memory-write-limit" });
        entries.push({
          key: input.key,
          kind: input.change.kind,
          quote: input.quote,
          sourceThreadId: threadId,
          sourceMessageId: source.id,
          target,
          targetName: targetNode?.name ?? null,
        });
      }
      entries.sort((a, b) => a.key.localeCompare(b.key));
      if (entries.length > CAD_MEMORY_MAX_ENTRIES)
        return yield* new CadViewError({ reason: "memory-full" });
      const encoded = encodeEntries(entries);
      if (new TextEncoder().encode(encoded).byteLength > CAD_MEMORY_MAX_BYTES)
        return yield* new CadViewError({ reason: "memory-full" });
      if (encoded === encodeEntries(memory.entries)) return memory;
      const next = { revision: memory.revision + 1, entries };
      yield* decodeMemory(next).pipe(Effect.mapError(invalid));
      yield* sql`UPDATE cad_project_memory SET revision=${next.revision}, entries_json=${encoded}
      WHERE project_id=${projectId} AND revision=${input.expectedRevision}`;
      return next;
    }),
  );
});
