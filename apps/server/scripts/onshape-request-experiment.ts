// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off globalDate:off globalFetch:off preferSchemaOverJson:off
// Opt-in live experiment. Credentials remain in memory; artifacts contain responses, never headers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import {
  CadSnapshotManifest,
  OnshapeConnectionCreateInput,
  ProjectId,
  type CadGeometryAsset,
} from "@cadsense/contracts";
import { ServerSecretStore } from "../src/auth/ServerSecretStore.ts";
import { layerTest } from "../src/config.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as Store from "../src/cad/CadSnapshotStore.ts";
import * as Connections from "../src/onshape/OnshapeConnections.ts";
import * as Signer from "../src/onshape/OnshapeRequestSigner.ts";
import * as Transport from "../src/onshape/OnshapeTransport.ts";
import * as Acquisition from "../src/onshape/OnshapeSnapshotAcquisition.ts";
import * as SyncState from "../src/onshape/OnshapeSyncState.ts";
import * as SourceUrl from "../src/onshape/OnshapeSourceUrl.ts";
import { onshapePartStudioRequest } from "../src/onshape/OnshapeSnapshotMetadata.ts";
import {
  enrichSnapshotMetadata,
  snapshotGeometryKey,
  snapshotPartStudioGroups,
  snapshotPartStudioKey,
} from "../src/onshape/OnshapeSnapshotManifest.ts";
import { readOnshapeThreeMf } from "../src/onshape/OnshapeThreeMf.ts";
import { readOnshapeExportGeometry } from "../src/onshape/OnshapeExportGeometry.ts";
import { batchOnshapeGeometry } from "../src/onshape/OnshapeGeometryBatching.ts";
import { applyOnshapeOpacity } from "../src/onshape/OnshapeGeometryAppearance.ts";
import { normalizeCadGeometry } from "../src/cad/CadGeometry.ts";
import { normalizeOnshapeExport } from "../src/onshape/OnshapeExportBundle.ts";
import { measureCadGeometry } from "@cadsense/shared/cadSceneBudget";

const decodeConnectionInput = Schema.decodeUnknownEffect(OnshapeConnectionCreateInput);
const decodeRequestKey = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const decodeMetadataRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const sourceUrl = process.env.ONSHAPE_SOURCE_URL;
const offline = process.env.ONSHAPE_OFFLINE === "1";
const unchangedOnly = process.env.ONSHAPE_UNCHANGED_ONLY === "1";
const credentialFile = process.env.ONSHAPE_CREDENTIAL_FILE;
const output = process.env.ONSHAPE_EXPERIMENT_DIR;
if (!sourceUrl || (!credentialFile && !offline) || !output)
  throw new Error(
    "Set ONSHAPE_SOURCE_URL and ONSHAPE_EXPERIMENT_DIR. Live runs require ONSHAPE_CREDENTIAL_FILE.",
  );
const directory = NodePath.resolve(output);
await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
const credentials: unknown = offline
  ? { accessKeyId: "offline", secretKey: "offline" }
  : JSON.parse(await NodeFSP.readFile(credentialFile!, "utf8"));
const fields = Schema.decodeUnknownSync(
  Schema.Struct({ accessKeyId: Schema.String, secretKey: Schema.String }),
)(credentials);
const secretBytes = new Map<string, Uint8Array>();
const unused = () => Effect.die("Unexpected secret operation");
const secrets = ServerSecretStore.of({
  get: (name) => Effect.succeed(Option.fromUndefinedOr(secretBytes.get(name))),
  set: (name, value) =>
    Effect.sync(() => {
      secretBytes.set(name, value);
    }),
  create: (name, value) =>
    Effect.sync(() => {
      secretBytes.set(name, value);
    }),
  remove: (name) =>
    Effect.sync(() => {
      secretBytes.delete(name);
    }),
  getOrCreateRandom: unused,
});
type RequestRecord = {
  sequence: number;
  phase: string;
  method: string;
  path: string;
  query: string;
  body?: unknown;
  status?: number;
  bytes?: number;
  elapsedMs?: number;
  artifact?: string;
  execution?: "live" | "replay" | "injected";
};
const requests: RequestRecord[] = [];
const RecordedRequest = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  query: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  artifact: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.Unknown),
});
const replayRecords: Array<typeof RecordedRequest.Type & { directory: string }> = [];
for (const replayDirectory of process.env.ONSHAPE_REPLAY_READS_DIR?.split(NodePath.delimiter) ??
  []) {
  const records = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RecordedRequest)))(
    await NodeFSP.readFile(NodePath.join(replayDirectory, "requests.json"), "utf8"),
  );
  replayRecords.push(...records.map((record) => ({ ...record, directory: replayDirectory })));
}
const replayOffsets = new Map<string, number>();
const batchFailure = process.env.ONSHAPE_INJECT_BATCH_FAILURE;
if (batchFailure && (!offline || !["too-large", "timeout", "missing-part"].includes(batchFailure)))
  throw new Error("Batch fault injection requires offline mode and a supported fault.");
const baselinePath = process.env.ONSHAPE_BASELINE_MANIFEST;
const baseline = baselinePath
  ? Schema.decodeUnknownSync(Schema.fromJsonString(CadSnapshotManifest))(
      await NodeFSP.readFile(baselinePath, "utf8"),
    )
  : undefined;
if (batchFailure === "missing-part" && !baseline)
  throw new Error("Missing-part injection requires ONSHAPE_BASELINE_MANIFEST.");
const canonicalQuery = (query: string) => {
  const params = new URLSearchParams(query);
  params.sort();
  return params.toString();
};
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
// Correlation IDs are local checkpoint keys, not export options. A profile bump
// must still be replayable against the identical recorded export parameters.
const exportOptions = (body: unknown) =>
  isObject(body)
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "correlationId"))
    : body;
let phase = "setup";
const traceLayer = Layer.effect(
  Transport.OnshapeTransport,
  Effect.gen(function* () {
    const transport = yield* Transport.OnshapeTransport;
    return Transport.OnshapeTransport.of({
      execute: (request) =>
        Effect.gen(function* () {
          if (requests.length >= Number(process.env.ONSHAPE_REQUEST_BUDGET ?? 160))
            return yield* new Transport.OnshapeTransportFailure();
          const url = new URL(request.url);
          const record: RequestRecord = {
            sequence: requests.length + 1,
            phase,
            method: request.method,
            path: url.pathname,
            query: url.searchParams.toString(),
            ...(request.body ? { body: JSON.parse(request.body) } : {}),
          };
          requests.push(record);
          const start = performance.now();
          console.log(`[${phase}] ${record.sequence} ${record.method} ${record.path}`);
          const matching = replayRecords.filter(
            (old) =>
              old.method === request.method &&
              old.status === 200 &&
              old.path === record.path &&
              canonicalQuery(old.query) === canonicalQuery(record.query) &&
              (offline
                ? NodeUtil.isDeepStrictEqual(exportOptions(old.body), exportOptions(record.body))
                : request.method === "GET" &&
                  (/\/m\//.test(old.path) || /^\/api\/v17\/parts\/.*\/v\//.test(old.path))) &&
              (old.artifact || offline),
          );
          const replayKey = JSON.stringify([record.method, record.path, record.query, record.body]);
          const replayOffset = record.path.includes("/translations/")
            ? (replayOffsets.get(replayKey) ?? 0)
            : 0;
          const replay = matching[Math.min(replayOffset, matching.length - 1)];
          if (offline && !replay)
            return yield* Effect.die(`Missing recorded response: ${record.path}?${record.query}`);
          const batchGeometry =
            record.path.includes("/partstudios/") && record.path.endsWith("/gltf");
          const batchMetadata =
            /^\/api\/v17\/parts\/d\/[^/]+\/[mv]\/[^/]+$/.test(record.path) ||
            record.path.endsWith("/bom");
          const injectedError =
            (batchFailure === "too-large" || batchFailure === "timeout") &&
            (batchGeometry || batchMetadata)
              ? batchFailure
              : undefined;
          record.execution =
            injectedError || (batchFailure === "missing-part" && batchGeometry)
              ? "injected"
              : replay
                ? "replay"
                : "live";
          const execute = injectedError
            ? Effect.fail(new Transport.OnshapeTransportFailure({ reason: injectedError }))
            : replay
              ? Effect.promise(async (): Promise<Transport.OnshapeTransportResponse> => {
                  replayOffsets.set(replayKey, replayOffset + 1);
                  if (!replay.artifact) return { status: 200, retryAfter: null };
                  const bytes = await NodeFSP.readFile(
                    NodePath.join(replay.directory, replay.artifact),
                  );
                  if (batchFailure === "missing-part" && baseline && batchGeometry) {
                    const ids = new Set(url.searchParams.getAll("partId"));
                    const documentId = /\/d\/([^/]+)\//.exec(url.pathname)?.[1];
                    const elementId = /\/e\/([^/]+)\//.exec(url.pathname)?.[1];
                    const parts = baseline.parts.filter(
                      (part) =>
                        ids.has(part.source.partId) &&
                        part.source.documentId === documentId &&
                        part.source.elementId === elementId,
                    );
                    const geometry = readOnshapeExportGeometry(
                      { ...baseline, parts, root: { ...baseline.root, kind: "part-studio" } },
                      bytes,
                    );
                    return {
                      status: 200,
                      retryAfter: null,
                      bytes: geometry.extract(parts[0]!.geometryKey),
                      contentType: "model/gltf-binary",
                    };
                  }
                  return replay.artifact!.endsWith(".bin")
                    ? { status: 200, retryAfter: null, bytes, contentType: "model/gltf-binary" }
                    : { status: 200, retryAfter: null, body: JSON.parse(bytes.toString("utf8")) };
                })
              : transport.execute(request);
          return yield* execute.pipe(
            Effect.tap((response) =>
              Effect.promise(async () => {
                record.status = response.status;
                record.elapsedMs = Math.round(performance.now() - start);
                const bytes =
                  response.bytes ??
                  (response.body === undefined
                    ? undefined
                    : Buffer.from(JSON.stringify(response.body)));
                if (bytes) {
                  record.bytes = bytes.length;
                  record.artifact = `response-${String(record.sequence).padStart(3, "0")}.${response.bytes ? "bin" : "json"}`;
                  await NodeFSP.writeFile(NodePath.join(directory, record.artifact), bytes, {
                    mode: 0o600,
                  });
                }
                console.log(
                  `  HTTP ${response.status}, ${record.bytes ?? 0} bytes, ${record.elapsedMs}ms`,
                );
              }),
            ),
            Effect.ensuring(
              Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(directory, "requests.json"),
                  JSON.stringify(requests, null, 2),
                  { mode: 0o600 },
                ),
              ),
            ),
          );
        }),
    });
  }),
).pipe(Layer.provide(Transport.layer.pipe(Layer.provide(FetchHttpClient.layer))));

const program = Effect.gen(function* () {
  const connections = yield* Connections.make;
  const createInput = yield* decodeConnectionInput({
    ...fields,
    name: "Request experiment",
    host: new URL(sourceUrl).origin,
  });
  const connection = yield* connections.create(createInput);
  const source = yield* SourceUrl.parse({ url: sourceUrl, connection });
  if (!source.elementId) return yield* Effect.die("Source URL must include an element.");
  if (process.env.ONSHAPE_EXPERIMENT_MODE === "archive") {
    phase = "archive";
    const auth = { connectionId: connection.connectionId, host: source.host };
    const Translation = Schema.Struct({
      id: Schema.String,
      requestState: Schema.String,
      resultDocumentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      resultExternalDataIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    });
    const decodeTranslation = Schema.decodeUnknownEffect(Translation);
    let status = yield* connections
      .readJson({
        ...auth,
        path: `/api/v17/assemblies/d/${source.documentId}/${source.workspaceType}/${source.workspaceId}/e/${source.elementId}/translations`,
        query: "",
        method: "POST",
        body: {
          storeInDocument: false,
          notifyUser: false,
          grouping: true,
          formatName: "3MF",
          resolution: "coarse",
          unit: "METER",
          allowFaultyParts: true,
          configuration: source.configuration,
          includeExportIds: true,
          ...(process.env.ONSHAPE_EXPORT_COMPOSITE_IDS === "1"
            ? { exportCompositeConstituentsWithOriginalBodyIds: true }
            : {}),
        },
      })
      .pipe(Effect.flatMap(decodeTranslation));
    for (let attempt = 0; status.requestState === "ACTIVE" && attempt < 10; attempt++) {
      yield* Effect.sleep("10 seconds");
      status = yield* connections
        .readJson({ ...auth, path: `/api/v17/translations/${status.id}`, query: "" })
        .pipe(Effect.flatMap(decodeTranslation));
    }
    if (status.requestState !== "DONE" || status.resultExternalDataIds?.length !== 1)
      return yield* Effect.die("Archive experiment did not complete.");
    const download = yield* connections.readBinary({
      ...auth,
      path: `/api/v17/documents/d/${status.resultDocumentId ?? source.documentId}/externaldata/${status.resultExternalDataIds[0]}`,
      query: "",
      bulkExport: true,
    });
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, "model.3mf"), download.bytes, { mode: 0o600 }),
    );
    console.log(
      JSON.stringify({
        phase,
        requests: requests.filter((r) => r.phase === phase).length,
        bytes: download.bytes.length,
      }),
    );
    return;
  }
  if (baseline && process.env.ONSHAPE_EXPERIMENT_MODE) {
    const auth = { connectionId: connection.connectionId, host: source.host };
    if (process.env.ONSHAPE_EXPERIMENT_MODE === "metadata") {
      phase = "document-metadata";
      const batches = new Map<string, ReturnType<typeof snapshotPartStudioGroups>>();
      for (const group of snapshotPartStudioGroups(baseline)) {
        const request = yield* onshapePartStudioRequest(baseline.root, group.source);
        const documentPath = request.path.slice(0, request.path.lastIndexOf("/e/"));
        request.query.set("withThumbnails", "false");
        request.query.set("includePropertyDefaults", "false");
        const key = JSON.stringify([documentPath, request.query.toString()]);
        const batch = batches.get(key) ?? [];
        batch.push(group);
        batches.set(key, batch);
      }
      const report: Array<{
        requestPath: string;
        query: string;
        studios: number;
        returnedParts: number;
        exactMetadata: boolean;
        differences: Array<{ key: string; fields: string[] }>;
      }> = [];
      for (const [key, groups] of batches) {
        if (groups.length < 2) continue;
        const [requestPath, query] = yield* decodeRequestKey(key);
        const rows = yield* connections
          .readJson({ ...auth, path: requestPath, query })
          .pipe(Effect.flatMap(decodeMetadataRows));
        const enriched = yield* enrichSnapshotMetadata(
          baseline,
          groups.map((group) => ({
            source: group.source,
            response: rows.filter((row) => row.elementId === group.source.elementId),
          })),
        );
        const differences = enriched.parts.flatMap((part, i) =>
          NodeUtil.isDeepStrictEqual(part, baseline.parts[i])
            ? []
            : [
                {
                  key: part.geometryKey,
                  fields: Object.keys(part.metadata ?? {}).filter(
                    (key) =>
                      !NodeUtil.isDeepStrictEqual(
                        Reflect.get(part.metadata!, key),
                        Reflect.get(baseline.parts[i]!.metadata!, key),
                      ),
                  ),
                },
              ],
        );
        report.push({
          requestPath,
          query,
          studios: groups.length,
          returnedParts: rows.length,
          exactMetadata: differences.length === 0,
          differences,
        });
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "comparison.json"),
          JSON.stringify(report, null, 2),
        ),
      );
      console.log(
        "Document-wide metadata",
        report.map(({ studios, exactMetadata, differences }) => ({
          studios,
          exactMetadata,
          differences,
        })),
      );
      return;
    }
    if (process.env.ONSHAPE_EXPERIMENT_MODE === "geometry") {
      phase = "studio-reference-geometry";
      const gltfPath = process.env.ONSHAPE_BASELINE_GLTF;
      const missing = gltfPath
        ? yield* Effect.gen(function* () {
            const normalized = yield* Effect.promise(() => NodeFSP.readFile(gltfPath)).pipe(
              Effect.flatMap(normalizeOnshapeExport),
            );
            const geometry = readOnshapeExportGeometry(baseline, normalized, true);
            return baseline.parts.filter(
              (part) => part.geometryRequired && !geometry.has(part.geometryKey),
            );
          })
        : yield* Effect.gen(function* () {
            const archive = yield* Effect.promise(() =>
              NodeFSP.readFile(process.env.ONSHAPE_BASELINE_3MF!),
            );
            const geometry = readOnshapeThreeMf(
              baseline,
              archive,
              new Set(baseline.parts.map((part) => part.geometryKey)),
            );
            return baseline.parts.filter(
              (part) => part.geometryRequired && geometry.usesReference(part.geometryKey),
            );
          });
      const report: Array<{
        key: string;
        partId: string;
        name: string | undefined;
        baseline: CadGeometryAsset["complexity"];
        candidate: ReturnType<typeof measureCadGeometry>;
      }> = [];
      for (const group of snapshotPartStudioGroups({ ...baseline, parts: missing })) {
        const parts = missing.filter((part) => snapshotPartStudioKey(part.source) === group.key);
        const request = yield* onshapePartStudioRequest(baseline.root, group.source);
        request.query.set("angleTolerance", "0.1");
        request.query.set("chordTolerance", "0.0005");
        request.query.set("rollbackBarIndex", "-1");
        request.query.set("outputSeparateFaceNodes", "false");
        request.query.set("outputFaceAppearances", "true");
        for (const part of parts) request.query.append("partId", part.source.partId);
        const downloaded = yield* connections.readBinary({
          ...auth,
          path: request.path.replace("/parts/", "/partstudios/") + "/gltf",
          query: request.query.toString(),
        });
        const bytes = yield* normalizeCadGeometry(downloaded.bytes);
        const extracted = readOnshapeExportGeometry(
          { ...baseline, parts, root: { ...baseline.root, kind: "part-studio" } },
          bytes,
        );
        for (const part of parts) {
          const normalized = yield* normalizeCadGeometry(
            applyOnshapeOpacity(
              batchOnshapeGeometry(extracted.extract(part.geometryKey)),
              part.metadata?.appearance,
            ),
          );
          const complexity = measureCadGeometry(normalized);
          const original = baseline.assets.find((asset) => asset.geometryKey === part.geometryKey)!;
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(directory, `${part.geometryKey}.glb`), normalized),
          );
          report.push({
            key: part.geometryKey,
            partId: part.source.partId,
            name: part.metadata?.name,
            baseline: original.complexity,
            candidate: complexity,
          });
        }
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "comparison.json"),
          JSON.stringify(report, null, 2),
        ),
      );
      console.log("Reference geometry compared", report.length, "parts");
      return;
    }
    return yield* Effect.die("Unknown experiment mode");
  }
  if (process.env.ONSHAPE_PROBE_PATH) {
    phase = "probe";
    const base = {
      connectionId: connection.connectionId,
      host: source.host,
      path: process.env.ONSHAPE_PROBE_PATH,
      query: process.env.ONSHAPE_PROBE_QUERY ?? "",
    };
    const response = yield* process.env.ONSHAPE_PROBE_BINARY === "1"
      ? connections.readBinary({ ...base, bulkExport: true })
      : connections.readJson(
          process.env.ONSHAPE_PROBE_BODY
            ? { ...base, method: "POST", body: JSON.parse(process.env.ONSHAPE_PROBE_BODY) }
            : base,
        );
    console.log("Probe complete", typeof response);
    return;
  }
  const store = yield* Store.make.pipe(Effect.provide(Store.diskSpaceLayer));
  const syncState = yield* SyncState.make.pipe(
    Effect.provideService(Store.CadSnapshotStore, store),
  );
  const acquisition = yield* Acquisition.make.pipe(
    Effect.provideService(Connections.OnshapeConnections, connections),
    Effect.provideService(Store.CadSnapshotStore, store),
    Effect.provideService(SyncState.OnshapeSyncState, syncState),
  );
  const input: Acquisition.OnshapeSnapshotAcquisitionInput = {
    projectId: ProjectId.make("onshape-request-experiment"),
    source,
    root: { elementId: source.elementId, kind: "assembly", configuration: source.configuration },
  };
  const summaries: Array<{
    phase: string;
    requests: number;
    liveRequests: number;
    injectedRequests: number;
    elapsedMs: number;
    snapshotId: string;
    microversion: string;
    nodes: number;
    parts: number;
    assets: number;
    geometryBytes: number;
    complexity: Array<CadGeometryAsset["complexity"]>;
  }> = [];
  for (const name of unchangedOnly ? ["unchanged"] : ["cold", "unchanged"]) {
    phase = name;
    const before = requests.length;
    const start = performance.now();
    const manifest = yield* acquisition.acquire(input);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(directory, `${name}-manifest.json`),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600 },
      ),
    );
    if (baseline) {
      const migratedKeys = new Map(
        baseline.parts.map((part) => [
          part.geometryKey,
          snapshotGeometryKey({
            ...part.source,
            tessellationProfile: manifest.root.tessellationProfile,
          }),
        ]),
      );
      const expected: CadSnapshotManifest = {
        ...baseline,
        root: { ...baseline.root, tessellationProfile: manifest.root.tessellationProfile },
        parts: baseline.parts.map((part) => ({
          ...part,
          geometryKey: migratedKeys.get(part.geometryKey)!,
          source: { ...part.source, tessellationProfile: manifest.root.tessellationProfile },
        })),
        nodes: baseline.nodes.map((node) => ({
          ...node,
          sourcePartKey: node.sourcePartKey === null ? null : migratedKeys.get(node.sourcePartKey)!,
        })),
        assets: baseline.assets.map((asset) => ({
          ...asset,
          geometryKey: migratedKeys.get(asset.geometryKey)!,
        })),
      };
      const metadataNotFetched: Array<{ key: string; fields: string[] }> = [];
      const expectedParts = expected.parts.map((original, i) => {
        const candidate = manifest.parts[i];
        if (process.env.ONSHAPE_ALLOW_BULK_METADATA !== "1" || !candidate || !original.metadata)
          return original;
        if (!original.geometryRequired && candidate.metadata === null) {
          metadataNotFetched.push({
            key: original.geometryKey,
            fields: ["suppressed-part-metadata"],
          });
          return { ...original, metadata: null };
        }
        if (!candidate.metadata) return original;
        const metadata = { ...original.metadata };
        const fields = [];
        for (const field of ["isHidden", "isMesh", "partIdentity", "configurationId"] as const) {
          if (candidate.metadata[field] === null && metadata[field] !== null) {
            metadata[field] = null;
            fields.push(field);
          }
        }
        if (fields.length) metadataNotFetched.push({ key: original.geometryKey, fields });
        return { ...original, metadata };
      });
      const comparedFields = [
        "schemaVersion",
        "rootId",
        "projectId",
        "root",
        "nodes",
        "parts",
        "dependencies",
      ] as const;
      const normalizedNodes = (nodes: CadSnapshotManifest["nodes"]) =>
        nodes.map((node) => ({
          ...node,
          // JSON recordings serialize -0 as 0; these are the same affine transform.
          transform: node.transform.map((value) => (Object.is(value, -0) ? 0 : value)),
        }));
      const changedFields = comparedFields.filter(
        (field) =>
          !NodeUtil.isDeepStrictEqual(
            field === "nodes" ? normalizedNodes(manifest.nodes) : manifest[field],
            field === "parts"
              ? expectedParts
              : field === "nodes"
                ? normalizedNodes(expected.nodes)
                : expected[field],
          ),
      );
      const assetKeysMatch = NodeUtil.isDeepStrictEqual(
        manifest.assets.map((asset) => asset.geometryKey),
        expected.assets.map((asset) => asset.geometryKey),
      );
      const trianglesMatch = NodeUtil.isDeepStrictEqual(
        manifest.assets.map((asset) => asset.complexity?.triangles),
        baseline.assets.map((asset) => asset.complexity?.triangles),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, `${name}-comparison.json`),
          JSON.stringify(
            { comparedFields, changedFields, metadataNotFetched, assetKeysMatch, trianglesMatch },
            null,
            2,
          ),
          { mode: 0o600 },
        ),
      );
      if (
        changedFields.length ||
        !assetKeysMatch ||
        (!trianglesMatch && process.env.ONSHAPE_ALLOW_RETESSELLATION !== "1")
      )
        return yield* Effect.die(`Snapshot differs from baseline; see ${name}-comparison.json.`);
    }
    const summary = {
      phase,
      requests: requests.length - before,
      elapsedMs: Math.round(performance.now() - start),
      liveRequests: requests.slice(before).filter((request) => request.execution === "live").length,
      injectedRequests: requests.slice(before).filter((request) => request.execution === "injected")
        .length,
      snapshotId: manifest.snapshotId,
      microversion: manifest.root.microversionId,
      nodes: manifest.nodes.length,
      parts: manifest.parts.length,
      assets: manifest.assets.length,
      geometryBytes: manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0),
      complexity: manifest.assets.map((asset) => asset.complexity),
    };
    summaries.push(summary);
    console.log(JSON.stringify({ ...summary, complexity: undefined }));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(directory, "summary.json"),
        JSON.stringify(summaries, null, 2),
        {
          mode: 0o600,
        },
      ),
    );
  }
  if (unchangedOnly) {
    if (summaries[0]!.requests !== 1)
      return yield* Effect.die("Unchanged sync must use one request.");
    return;
  }
  const requestLimit = Number(process.env.ONSHAPE_ASSERT_MAX_REQUESTS ?? Infinity);
  if (summaries[0]!.requests > requestLimit)
    return yield* Effect.die(
      `Cold import used ${summaries[0]!.requests} requests; target ${requestLimit}.`,
    );
  if (summaries[1]!.requests !== 1 || summaries[0]!.snapshotId !== summaries[1]!.snapshotId)
    return yield* Effect.die("Unchanged sync must reuse the snapshot with one request.");
});

const run = offline
  ? Clock.clockWith((clock) =>
      program.pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: () => Effect.void,
        }),
      ),
    )
  : program;
await Effect.runPromise(
  run.pipe(
    Effect.provide(
      Layer.mergeAll(
        traceLayer,
        Signer.layer,
        SqlitePersistenceMemory,
        Layer.succeed(ServerSecretStore, secrets),
        layerTest(
          process.cwd(),
          process.env.ONSHAPE_STATE_DIR ?? NodePath.join(directory, "state"),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  ),
).finally(() => secretBytes.clear());
