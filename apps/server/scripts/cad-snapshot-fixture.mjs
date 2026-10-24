// Seeds a stopped, freshly migrated dev home with one cached Onshape snapshot (a directory
// holding manifest.json and assets/<sha256>.glb) as a CAD project with one thread, so the full
// app runs offline against real geometry. Adapted from apps/desktop/scripts/cad-smoke-fixture.mjs.
// Run from apps/server:
//   node scripts/cad-snapshot-fixture.mjs <home dir> <snapshot dir> [project title] [model name]
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeServices } from "@effect/platform-node";
import { layerTest } from "../src/config.ts";
import { make, diskSpaceLayer } from "../src/cad/CadSnapshotStore.ts";

const [baseDir, snapshotArg, title = "Offline CAD snapshot", modelName] = process.argv.slice(2);
if (!baseDir || !snapshotArg)
  throw new Error("Usage: cad-snapshot-fixture.mjs <home dir> <snapshot dir> [project title]");
const snapshotDir = NodePath.resolve(snapshotArg);
const threadId = "20000000-0000-4000-8000-0000000d4a01";
const manifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(snapshotDir, "manifest.json"), "utf8"),
);
const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "state.sqlite"));
try {
  if (database.prepare("SELECT COUNT(*) AS count FROM projection_projects").get().count !== 0)
    throw new Error("The fixture needs an empty, migrated database");
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* make;
      for (const asset of manifest.assets) {
        const bytes = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(snapshotDir, "assets", asset.relativePath)),
        );
        const stored = yield* store.putAsset(bytes);
        if (stored.sha256 !== asset.sha256)
          throw new Error(`Asset hash changed for ${asset.relativePath}`);
      }
      yield* store.publish(manifest);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest(process.cwd(), baseDir).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(diskSpaceLayer),
        ),
      ),
    ),
  );
  const workspace = NodePath.join(baseDir, "fixture-workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  const timestamp = manifest.createdAt;
  const { root } = manifest;
  const cad = {
    enabled: true,
    pendingPresentations: [],
    operation: null,
    lastOutcome: null,
    catalog: {
      refreshedAt: timestamp,
      microversionId: root.microversionId,
      sourceElement: null,
      roots: [
        {
          elementId: root.elementId,
          kind: root.kind,
          name:
            modelName ?? manifest.nodes.find((node) => node.parentId === null)?.name ?? "Assembly",
        },
      ],
    },
    roots: [
      {
        rootId: manifest.rootId,
        elementId: root.elementId,
        kind: root.kind,
        configuration: root.configuration,
        current: {
          snapshotId: manifest.snapshotId,
          microversionId: root.microversionId,
          createdAt: timestamp,
          manifestBytes: Buffer.byteLength(JSON.stringify(manifest)),
          assetBytes: manifest.assets.reduce((total, asset) => total + asset.byteLength, 0),
        },
        rollback: null,
        lastOutcome: null,
      },
    ],
  };
  // A fake connection: the app never syncs this project, it only reads the cached snapshot.
  const source = {
    connectionId: "30000000-0000-4000-8000-0000000d4a01",
    host: root.host,
    documentId: root.documentId,
    workspaceType: root.originalRevision.kind,
    workspaceId: root.originalRevision.id,
    elementId: root.elementId,
    configuration: root.configuration,
    managedWorkspaceReady: true,
  };
  const model = JSON.stringify({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
  database.exec("BEGIN");
  database
    .prepare(
      "INSERT INTO projection_projects (project_id,title,workspace_root,created_at,updated_at,default_model_selection_json,onshape_source_json,cad_json) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      manifest.projectId,
      title,
      workspace,
      timestamp,
      timestamp,
      model,
      JSON.stringify(source),
      JSON.stringify(cad),
    );
  database
    .prepare(
      "INSERT INTO projection_threads (thread_id,project_id,title,created_at,updated_at,model_selection_json) VALUES (?,?,?,?,?,?)",
    )
    .run(threadId, manifest.projectId, "Shop drawings", timestamp, timestamp, model);
  database.exec("COMMIT");
  console.log(
    JSON.stringify({ projectId: manifest.projectId, threadId, snapshotId: manifest.snapshotId }),
  );
} finally {
  database.close();
}
