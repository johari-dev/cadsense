import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeServices } from "@effect/platform-node";
import { layerTest } from "../../server/src/config.ts";
import { make, diskSpaceLayer } from "../../server/src/cad/CadSnapshotStore.ts";
import {
  completeSnapshotManifest,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
  snapshotRootId,
} from "../../server/src/onshape/OnshapeSnapshotManifest.ts";

export const cadSmokeProjectId = "10000000-0000-4000-8000-000000000001";
export const cadSmokeThreads = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
];

// A small tetrahedron, generated here rather than downloaded from any CAD service.
function geometry(offset = 0) {
  const positions = new Float32Array([
    offset,
    0,
    0,
    offset + 0.04,
    0,
    0,
    offset,
    0.04,
    0,
    offset,
    0,
    0.04,
  ]);
  const indices = new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [
        {
          doubleSided: true,
          pbrMetallicRoughness: {
            baseColorFactor: [0.1, 0.5, 0.9, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteLength: positions.byteLength, target: 34962 },
        {
          buffer: 0,
          byteOffset: positions.byteLength,
          byteLength: indices.byteLength,
          target: 34963,
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: "VEC3",
          min: [offset, 0, 0],
          max: [offset + 0.04, 0.04, 0.04],
        },
        { bufferView: 1, componentType: 5123, count: 12, type: "SCALAR" },
      ],
    }),
  );
  const padded = Math.ceil(json.length / 4) * 4;
  const result = Buffer.alloc(28 + padded + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(32, 20, 20 + padded);
  json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded);
  result.writeUInt32LE(0x004e4942, 24 + padded);
  binary.copy(result, 28 + padded);
  return result;
}

/** Seeds only a newly initialized, stopped smoke-test backend. Never accepts an existing project. */
export async function seedCadSmokeFixture(baseDir) {
  const stateDir = NodePath.join(baseDir, "userdata");
  const database = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "state.sqlite"));
  try {
    if (database.prepare("SELECT COUNT(*) AS count FROM projection_projects").get().count !== 0)
      throw new Error("CAD smoke fixture requires an empty isolated database");
    const workspace = NodePath.join(baseDir, "fixture-workspace");
    await NodeFSP.mkdir(workspace, { recursive: true });
    const timestamp = "2026-09-06T00:00:00.000Z";
    const root = {
      host: "https://cad.onshape.com",
      documentId: "1".repeat(24),
      elementId: "2".repeat(24),
      kind: "assembly",
      originalRevision: { kind: "m", id: "3".repeat(24) },
      microversionId: "3".repeat(24),
      configuration: "default",
      tessellationProfile: "offline-smoke",
    };
    const ref = {
      documentId: root.documentId,
      documentMicroversion: root.microversionId,
      elementId: "4".repeat(24),
      configuration: "default",
      fullConfiguration: "default",
    };
    const transform = (x) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const manifests = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* make;
        const assembly = yield* parseAssemblySnapshotDraft(
          {
            snapshotId: NodeCrypto.randomUUID(),
            projectId: cadSmokeProjectId,
            createdAt: timestamp,
            root,
            rootId: snapshotRootId(root),
          },
          {
            rootAssembly: {
              ...ref,
              elementId: root.elementId,
              instances: [
                {
                  ...ref,
                  id: "nested",
                  name: "Nested assembly",
                  type: "Assembly",
                  suppressed: false,
                },
              ],
              occurrences: [
                { path: ["nested"], transform: transform(0), hidden: false },
                { path: ["nested", "A"], transform: transform(-0.04), hidden: false },
                { path: ["nested", "B"], transform: transform(0.04), hidden: false },
              ],
            },
            subAssemblies: [
              {
                ...ref,
                instances: ["A", "B"].map((id) => ({
                  ...ref,
                  id,
                  partId: "part",
                  name: `Component ${id}`,
                  type: "Part",
                  suppressed: false,
                })),
              },
            ],
            parts: [{ ...ref, partId: "part" }],
          },
        );
        const studioRoot = { ...root, kind: "part-studio", elementId: "5".repeat(24) };
        const studio = yield* parsePartStudioSnapshotDraft(
          {
            snapshotId: NodeCrypto.randomUUID(),
            projectId: cadSmokeProjectId,
            createdAt: timestamp,
            root: studioRoot,
            rootId: snapshotRootId(studioRoot),
          },
          [
            { partId: "body-a", name: "Studio body A", bodyType: "solid" },
            { partId: "body-b", name: "Studio body B", bodyType: "solid" },
          ],
        );
        const results = [];
        for (const draft of [assembly, studio]) {
          const assets = [];
          for (const [index, part] of draft.parts.entries()) {
            part.metadata ??= {
              name: "Component",
              bodyType: "solid",
              isHidden: false,
              isMesh: false,
              partIdentity: null,
              configurationId: null,
              appearance: null,
              material: null,
            };
            assets.push({
              ...(yield* store.putAsset(geometry(index * 0.06))),
              geometryKey: part.geometryKey,
            });
          }
          const manifest = yield* completeSnapshotManifest(draft, assets);
          yield* store.publish(manifest);
          results.push(manifest);
        }
        return results;
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
    const cad = {
      enabled: true,
      pendingPresentations: [],
      operation: null,
      lastOutcome: null,
      catalog: {
        refreshedAt: timestamp,
        microversionId: root.microversionId,
        sourceElement: null,
        roots: manifests.map((manifest, index) => ({
          elementId: manifest.root.elementId,
          kind: manifest.root.kind,
          name: index === 0 ? "Offline assembly" : "Offline multipart",
        })),
      },
      roots: manifests.map((manifest) => ({
        rootId: manifest.rootId,
        elementId: manifest.root.elementId,
        kind: manifest.root.kind,
        configuration: "default",
        current: {
          snapshotId: manifest.snapshotId,
          microversionId: root.microversionId,
          createdAt: timestamp,
          manifestBytes: Buffer.byteLength(JSON.stringify(manifest)),
          assetBytes: manifest.assets.reduce((total, asset) => total + asset.byteLength, 0),
        },
        rollback: null,
        lastOutcome: null,
      })),
    };
    const source = {
      connectionId: "30000000-0000-4000-8000-000000000001",
      host: root.host,
      documentId: root.documentId,
      workspaceType: "m",
      workspaceId: root.microversionId,
      elementId: root.elementId,
      configuration: "default",
      managedWorkspaceReady: true,
    };
    const model = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });
    database.exec("BEGIN");
    database
      .prepare(
        "INSERT INTO projection_projects (project_id,title,workspace_root,created_at,updated_at,default_model_selection_json,onshape_source_json,cad_json) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        cadSmokeProjectId,
        "Offline CAD smoke",
        workspace,
        timestamp,
        timestamp,
        model,
        JSON.stringify(source),
        JSON.stringify(cad),
      );
    const insertThread = database.prepare(
      "INSERT INTO projection_threads (thread_id,project_id,title,created_at,updated_at,model_selection_json) VALUES (?,?,?,?,?,?)",
    );
    for (const [index, threadId] of cadSmokeThreads.entries())
      insertThread.run(
        threadId,
        cadSmokeProjectId,
        `CAD smoke thread ${index + 1}`,
        timestamp,
        timestamp,
        model,
      );
    database.exec("COMMIT");
    return {
      projectId: cadSmokeProjectId,
      threads: cadSmokeThreads,
      roots: manifests.map((manifest) => manifest.rootId),
    };
  } finally {
    database.close();
  }
}
