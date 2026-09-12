import { readCadComments, projectCadCommentEvent } from "./CadCommentPersistence.ts";
import {
  CadSessionIndex,
  CadCaptureRecord,
  CadUserView,
  CadUserViewIndex,
  CadViewState,
  type OrchestrationEvent,
  type ThreadId,
  type TurnId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../persistence/Errors.ts";

const SessionRow = Schema.Struct({
  ...CadSessionIndex.fields,
  view: Schema.NullOr(Schema.fromJsonString(CadViewState)),
});
const encodeView = Schema.encodeSync(Schema.fromJsonString(CadViewState));
const encodeCamera = Schema.encodeSync(Schema.fromJsonString(CadViewState.fields.camera));
const encodeCapture = Schema.encodeSync(Schema.fromJsonString(CadCaptureRecord));
const decodeSessionIndexes = Schema.decodeUnknownEffect(Schema.Array(CadSessionIndex));
const decodeUserIndexes = Schema.decodeUnknownEffect(Schema.Array(CadUserViewIndex));
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow));
const decodeUserViews = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: CadUserView.fields.threadId,
      view: Schema.fromJsonString(CadUserView.fields.view),
    }),
  ),
);
const decodeCaptures = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      record: Schema.fromJsonString(CadCaptureRecord),
      view: Schema.fromJsonString(CadViewState),
    }),
  ),
);

export const readLatestCadCapture = Effect.fn("readLatestCadCapture")(
  function* (threadId: ThreadId, turnId: TurnId) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT record_json AS record, view_json AS view FROM projection_cad_captures
      WHERE thread_id=${threadId} AND turn_id=${turnId} ORDER BY sequence DESC LIMIT 1`;
    const captures = yield* decodeCaptures(rows).pipe(
      Effect.mapError(toPersistenceDecodeError("CAD capture")),
    );
    return captures[0] ?? null;
  },
  Effect.catchTag("SqlError", (error) =>
    Effect.fail(toPersistenceSqlError("CadSessionPersistence.capture")(error)),
  ),
);

/** Called exclusively by the existing transactional projection pipeline. */
export const projectCadSessionEvent = Effect.fn("projectCadSessionEvent")(
  function* (event: OrchestrationEvent) {
    const sql = yield* SqlClient.SqlClient;
    yield* projectCadCommentEvent(event);
    switch (event.type) {
      case "thread.created": {
        const threadId = event.payload.threadId;
        // A recreated thread is a new owner even when it reuses the durable ID.
        // Clear every CAD projection that could otherwise expose the prior
        // incarnation's view or authorize one of its captures.
        yield* sql`DELETE FROM projection_cad_captures WHERE thread_id=${threadId}`;
        yield* sql`DELETE FROM projection_cad_sessions WHERE thread_id=${threadId}`;
        yield* sql`DELETE FROM projection_cad_user_views WHERE thread_id=${threadId}`;
        return;
      }
      case "thread.cad-capture-recorded": {
        const record = event.payload;
        const camera = encodeCamera({ kind: "pose", pose: record.cameraPose, fit: null });
        yield* sql`INSERT INTO projection_cad_captures(capture_id, thread_id, turn_id, sequence, record_json, view_json)
          SELECT ${record.capture.captureId}, ${record.threadId}, ${record.turnId}, ${event.sequence}, ${encodeCapture(record)}, json_set(view_json, '$.camera', json(${camera}))
          FROM projection_cad_sessions WHERE context_id=${record.contextId} AND revision=${record.capture.revision}
          ON CONFLICT(capture_id) DO NOTHING`;
        return;
      }
      case "thread.cad-context-ensured": {
        const session = event.payload.session;
        yield* sql`INSERT INTO projection_cad_sessions(context_id, thread_id, child_key, revision, view_json)
        VALUES (${session.contextId}, ${session.threadId}, ${session.childKey}, NULL, NULL)
        ON CONFLICT(context_id) DO NOTHING`;
        return;
      }
      case "thread.cad-view-set": {
        const { contextId, view } = event.payload;
        yield* sql`UPDATE projection_cad_sessions SET revision=${view.revision}, view_json=${encodeView(view)} WHERE context_id=${contextId}`;
        return;
      }
      case "thread.cad-user-view-set": {
        const { threadId, view } = event.payload;
        yield* sql`INSERT INTO projection_cad_user_views(thread_id,revision,view_json) VALUES(${threadId},${view.revision},${encodeView(view)})
        ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision, view_json=excluded.view_json`;
        return;
      }
    }
  },
  Effect.mapError(toPersistenceSqlError("CadSessionPersistence.project")),
);

export const readCadSessionIndexes = Effect.fn("readCadSessionIndexes")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions =
      yield* sql`SELECT context_id AS "contextId", thread_id AS "threadId", child_key AS "childKey", revision FROM projection_cad_sessions`;
    const users =
      yield* sql`SELECT thread_id AS "threadId", revision FROM projection_cad_user_views`;
    return {
      ...(yield* readCadComments().pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(toPersistenceDecodeError("CAD comments")(error)),
        ),
      )),
      cadSessions: yield* decodeSessionIndexes(sessions).pipe(
        Effect.mapError(toPersistenceDecodeError("CAD session index")),
      ),
      cadUserViews: yield* decodeUserIndexes(users).pipe(
        Effect.mapError(toPersistenceDecodeError("CAD user view index")),
      ),
    };
  },
  Effect.catchTag("SqlError", (error) =>
    Effect.fail(toPersistenceSqlError("CadSessionPersistence.index")(error)),
  ),
);

export const readCadSession = Effect.fn("readCadSession")(
  function* (contextId: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT context_id AS "contextId", thread_id AS "threadId", child_key AS "childKey", revision, view_json AS "view" FROM projection_cad_sessions WHERE context_id=${contextId}`;
    const decoded = yield* decodeSessions(rows).pipe(
      Effect.mapError(toPersistenceDecodeError("CAD session")),
    );
    return decoded[0] ?? null;
  },
  Effect.catchTag("SqlError", (error) =>
    Effect.fail(toPersistenceSqlError("CadSessionPersistence.read")(error)),
  ),
);

export const findCadSession = Effect.fn("findCadSession")(
  function* (threadId: ThreadId, childKey: string | null) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT context_id AS "contextId", thread_id AS "threadId", child_key AS "childKey", revision, view_json AS "view" FROM projection_cad_sessions WHERE thread_id=${threadId} AND child_key IS ${childKey}`;
    const decoded = yield* decodeSessions(rows).pipe(
      Effect.mapError(toPersistenceDecodeError("CAD session binding")),
    );
    return decoded[0] ?? null;
  },
  Effect.catchTag("SqlError", (error) =>
    Effect.fail(toPersistenceSqlError("CadSessionPersistence.find")(error)),
  ),
);

export const readCadUserView = Effect.fn("readCadUserView")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT thread_id AS "threadId", view_json AS "view" FROM projection_cad_user_views WHERE thread_id=${threadId}`;
    const decoded = yield* decodeUserViews(rows).pipe(
      Effect.mapError(toPersistenceDecodeError("CAD user view")),
    );
    return decoded[0] ?? null;
  },
  Effect.catchTag("SqlError", (error) =>
    Effect.fail(toPersistenceSqlError("CadSessionPersistence.userView")(error)),
  ),
);
