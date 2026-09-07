import {
  CAD_INSPECTION_MAX_BYTES,
  CAD_INSPECTION_MAX_ENTRIES,
  CAD_INSPECTION_MAX_NEW_PER_TURN,
  CadCaptureRecord,
  CadInspectionInput,
  CadInspectionMemory,
  CadViewError,
  CadViewState,
  type CadInspectionQuery,
  type CadInspectionRecall,
  type CadSnapshotManifest,
  type ProjectId,
  type ThreadId,
  type TurnId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { indexCadSnapshot } from "./CadViewState.ts";

const decodeInput = Schema.decodeUnknownEffect(CadInspectionInput);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      revision: CadInspectionMemory.fields.revision,
      entries: Schema.fromJsonString(CadInspectionMemory.fields.entries),
    }),
  ),
);
const decodeEvidence = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      record: Schema.fromJsonString(CadCaptureRecord),
      view: Schema.fromJsonString(CadViewState),
    }),
  ),
);
const encodeEntries = Schema.encodeSync(Schema.fromJsonString(CadInspectionMemory.fields.entries));
const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const invalid = () => new CadViewError({ reason: "invalid-operation" });
type Root = { readonly rootId: string; readonly snapshotId: string };
const isCurrent = (entry: Root, roots: readonly Root[]) =>
  roots.some((root) => root.rootId === entry.rootId && root.snapshotId === entry.snapshotId);

export const readCadInspectionMemory = Effect.fn("readCadInspectionMemory")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT revision, entries_json AS entries FROM cad_inspection_memory WHERE project_id=${projectId}`;
  const decoded = yield* decodeRows(rows);
  return decoded[0] ?? { revision: 0, entries: [] };
});

/** Turn context advertises saved questions without injecting every visual interpretation. */
export function cadInspectionIndex(memory: CadInspectionMemory, roots: readonly Root[]) {
  return {
    revision: memory.revision,
    entries: memory.entries
      .filter((entry) => isCurrent(entry, roots))
      .map(({ key, question, kind, rootId, snapshotId }) => ({
        key,
        question,
        kind,
        rootId,
        snapshotId,
      })),
  };
}

/** Recall filters by question or component and returns at most three full findings. */
export function recallCadInspections(
  memory: CadInspectionMemory,
  root: Root,
  query: CadInspectionQuery,
): CadInspectionRecall {
  const terms = normalize(query.query ?? "")
    .split(/[\s/]+/)
    .filter(Boolean);
  const matches = memory.entries.filter((entry) => {
    if (!isCurrent(entry, [root]) || (query.key !== undefined && entry.key !== query.key))
      return false;
    if (query.occurrenceIds && !query.occurrenceIds.some((id) => entry.occurrenceIds.includes(id)))
      return false;
    const text = normalize(`${entry.key} ${entry.question} ${entry.finding}`);
    return terms.every((term) => text.includes(term));
  });
  // Newest records live at the end. Keep recall small and report the total for narrower follow-ups.
  return {
    revision: memory.revision,
    totalMatches: matches.length,
    entries: matches.slice(-3).toReversed(),
  };
}

/** Evidence is resolved from server-owned captures, never from model-authored image paths or snapshot IDs. */
export const useCadInspectionMemory = Effect.fn("useCadInspectionMemory")(function* (
  {
    projectId,
    threadId,
    contextId,
    turnId,
    snapshot,
    currentRoots,
  }: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly contextId: string;
    readonly turnId: TurnId | undefined;
    readonly snapshot: CadSnapshotManifest;
    readonly currentRoots: readonly Root[];
  },
  rawInput: unknown,
) {
  const { operation } = yield* decodeInput(rawInput).pipe(Effect.mapError(invalid));
  if (snapshot.projectId !== projectId || !isCurrent(snapshot, currentRoots))
    return yield* new CadViewError({ reason: "capability-unavailable" });
  if (operation.type === "recall") {
    return recallCadInspections(yield* readCadInspectionMemory(projectId), snapshot, operation);
  }
  if (turnId === undefined) return yield* new CadViewError({ reason: "capability-unavailable" });
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO cad_inspection_memory(project_id, revision, entries_json)
      VALUES(${projectId}, 0, '[]') ON CONFLICT(project_id) DO NOTHING`;
      const memory = yield* readCadInspectionMemory(projectId);
      if (memory.revision !== operation.expectedRevision)
        return yield* new CadViewError({ reason: "revision-conflict" });
      const current = memory.entries.filter((entry) => isCurrent(entry, currentRoots));
      const existing = current.find(
        (entry) => entry.rootId === snapshot.rootId && entry.key === operation.key,
      );
      if (operation.type === "forget" && !existing) return yield* invalid();
      const entries = current.filter((entry) => entry !== existing);
      if (operation.type === "remember") {
        if (!normalize(operation.question) || !normalize(operation.finding))
          return yield* invalid();
        const rows = yield* sql`SELECT c.record_json AS record, c.view_json AS view
        FROM projection_cad_captures c JOIN projection_threads t ON t.thread_id=c.thread_id
        JOIN projection_projects p ON p.project_id=t.project_id
        WHERE c.capture_id=${operation.captureId} AND c.thread_id=${threadId}
          AND t.project_id=${projectId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
        const evidence = (yield* decodeEvidence(rows))[0];
        if (
          !evidence ||
          evidence.record.contextId !== contextId ||
          evidence.record.capture.snapshotId !== snapshot.snapshotId ||
          evidence.record.capture.rootId !== snapshot.rootId ||
          evidence.view.snapshotId !== snapshot.snapshotId ||
          evidence.view.rootId !== snapshot.rootId
        )
          return yield* new CadViewError({ reason: "memory-evidence-invalid" });
        const visibility = indexCadSnapshot(snapshot).visible(evidence.view);
        const occurrenceIds = [...new Set(operation.occurrenceIds)].sort();
        if (!occurrenceIds.every((id) => visibility.get(id) === true))
          return yield* new CadViewError({ reason: "memory-evidence-invalid" });
        if (
          entries.some(
            (entry) =>
              entry.rootId === snapshot.rootId &&
              (normalize(entry.question) === normalize(operation.question) ||
                normalize(entry.finding) === normalize(operation.finding)),
          )
        )
          return yield* invalid();
        if (
          !existing &&
          current.filter(
            (entry) => entry.sourceThreadId === threadId && entry.savedTurnId === turnId,
          ).length >= CAD_INSPECTION_MAX_NEW_PER_TURN
        )
          return yield* new CadViewError({ reason: "memory-write-limit" });
        const next = {
          key: operation.key,
          question: operation.question.trim(),
          finding: operation.finding.trim(),
          kind: operation.kind,
          occurrenceIds,
          captureId: evidence.record.capture.captureId,
          rootId: snapshot.rootId,
          snapshotId: snapshot.snapshotId,
          sourceThreadId: threadId,
          savedTurnId: turnId,
          imagePath: evidence.record.capture.artifact.path,
          cameraPose: evidence.record.cameraPose,
        };
        if (
          existing &&
          existing.question === next.question &&
          existing.finding === next.finding &&
          existing.kind === next.kind &&
          existing.captureId === next.captureId &&
          existing.occurrenceIds.join(",") === next.occurrenceIds.join(",")
        )
          return recallCadInspections(memory, snapshot, { key: operation.key });
        entries.push(next);
      }
      if (entries.length > CAD_INSPECTION_MAX_ENTRIES)
        return yield* new CadViewError({ reason: "memory-full" });
      const encoded = encodeEntries(entries);
      if (new TextEncoder().encode(encoded).byteLength > CAD_INSPECTION_MAX_BYTES)
        return yield* new CadViewError({ reason: "memory-full" });
      if (encoded === encodeEntries(memory.entries))
        return recallCadInspections(memory, snapshot, { key: operation.key });
      const revision = memory.revision + 1;
      yield* sql`UPDATE cad_inspection_memory SET revision=${revision}, entries_json=${encoded}
      WHERE project_id=${projectId} AND revision=${memory.revision}`;
      return recallCadInspections({ revision, entries }, snapshot, { key: operation.key });
    }),
  );
});
