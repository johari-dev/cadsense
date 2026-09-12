import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Run after projection recovery; live activations also protect evidence not yet committed. */
export const pruneCadCommentEvidence = Effect.fn("pruneCadCommentEvidence")(function* (
  root: string,
  active: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* fs.exists(root))) return;
  const rows = yield* sql`SELECT json_extract(target.value,'$.inspectionId') AS id
    FROM projection_cad_comments c
    JOIN projection_threads t ON t.thread_id=c.thread_id AND t.deleted_at IS NULL
    JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL,
    json_each(c.record_json,'$.targets') target
    WHERE json_extract(target.value,'$.kind')='point'`;
  const retained = new Set(rows.map((r) => r.id));
  for (const directory of yield* fs.readDirectory(root)) {
    if (!/^[a-f0-9]{64}$/.test(directory)) continue;
    for (const file of yield* fs.readDirectory(path.join(root, directory))) {
      const match = /^([a-f0-9-]{36})\.(png|json)$/.exec(file);
      if (match && !active.has(match[1]!) && !retained.has(match[1]!))
        yield* fs.remove(path.join(root, directory, file), { force: true });
    }
  }
});
