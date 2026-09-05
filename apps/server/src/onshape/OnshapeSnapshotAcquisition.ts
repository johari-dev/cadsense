import {
  OnshapeWorkspaceId,
  type CadGeometryAsset,
  type CadPartStudioSource,
  type CadSnapshotManifest,
  type CadSnapshotRoot,
  type OnshapeConnectionError,
  type OnshapeElementId,
  type OnshapeProjectSource,
  type ProjectId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CadSnapshotStore, type CadSnapshotStoreError } from "../cad/CadSnapshotStore.ts";
import { normalizeCadGeometry, type CadGeometryError } from "../cad/CadGeometry.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import { OnshapeConnections } from "./OnshapeConnections.ts";
import {
  completeSnapshotManifest,
  enrichSnapshotMetadata,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
  snapshotPartStudioGroups,
  snapshotRootId,
  type OnshapeSnapshotManifestError,
} from "./OnshapeSnapshotManifest.ts";

// Fixed source-part coordinates: meters and radians, without separate face nodes.
// Onshape v17 parts/{...}/gltf defines these synchronous export parameters.
export const ONSHAPE_TESSELLATION_PROFILE = "onshape-gltf-chord-0.0005-angle-0.1-v1";
const decodeMicroversion = Schema.decodeUnknownEffect(
  Schema.Struct({ microversion: OnshapeWorkspaceId }),
);
const decodeMetadataProof = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ microversionId: Schema.optionalKey(OnshapeWorkspaceId) })),
);
export class OnshapeSnapshotAcquisitionError extends Schema.TaggedErrorClass<OnshapeSnapshotAcquisitionError>()(
  "OnshapeSnapshotAcquisitionError",
  {
    reason: Schema.Literals([
      "invalid-response",
      "missing-linked-version",
      "invalid-previous-snapshot",
      "identity-unavailable",
    ]),
  },
) {}
export interface OnshapeSnapshotAcquisitionInput {
  readonly projectId: ProjectId;
  readonly source: OnshapeProjectSource;
  readonly root: {
    readonly elementId: OnshapeElementId;
    readonly kind: CadSnapshotRoot["kind"];
    readonly configuration: string;
  };
  readonly previousSnapshotId?: string;
}
type AcquisitionError =
  | OnshapeConnectionError
  | OnshapeSnapshotManifestError
  | CadSnapshotStoreError
  | CadGeometryError
  | OnshapeSnapshotAcquisitionError;
export class OnshapeSnapshotAcquisition extends Context.Service<
  OnshapeSnapshotAcquisition,
  {
    readonly acquire: (
      input: OnshapeSnapshotAcquisitionInput,
    ) => Effect.Effect<CadSnapshotManifest, AcquisitionError>;
  }
>()("@cadsense/server/onshape/OnshapeSnapshotAcquisition") {}

/** Private acquisition only. The caller must admit an explicit user operation before invoking it. */
export const make = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const store = yield* CadSnapshotStore;
  const crypto = yield* Crypto.Crypto;
  const run = Effect.fn("OnshapeSnapshotAcquisition.acquire")(function* (
    input: OnshapeSnapshotAcquisitionInput,
  ) {
    const { source } = input;
    const read = Effect.fn(function* (path: string, query = "") {
      yield* store.checkReserve();
      return yield* connections.readJson({
        connectionId: source.connectionId,
        host: source.host,
        path,
        query,
      });
    });
    const microversionId =
      source.workspaceType === "m"
        ? source.workspaceId
        : (yield* read(
            `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/${source.workspaceType}/${source.workspaceId}/currentmicroversion`,
          ).pipe(
            Effect.flatMap(decodeMicroversion),
            Effect.catchTag("SchemaError", () =>
              Effect.fail(new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" })),
            ),
          )).microversion;
    const root: CadSnapshotRoot = {
      host: source.host,
      documentId: source.documentId,
      elementId: input.root.elementId,
      kind: input.root.kind,
      configuration: input.root.configuration || "default",
      originalRevision: { kind: source.workspaceType, id: source.workspaceId },
      microversionId,
      tessellationProfile: ONSHAPE_TESSELLATION_PROFILE,
    };
    const context = {
      root,
      rootId: snapshotRootId(root),
      projectId: input.projectId,
      snapshotId: yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () => new OnshapeSnapshotAcquisitionError({ reason: "identity-unavailable" }),
        ),
      ),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const previous =
      input.previousSnapshotId === undefined ? null : yield* store.load(input.previousSnapshotId);
    if (
      previous !== null &&
      (previous.projectId !== input.projectId || previous.rootId !== context.rootId)
    ) {
      return yield* new OnshapeSnapshotAcquisitionError({ reason: "invalid-previous-snapshot" });
    }
    const previousAssets = new Map(previous?.assets.map((asset) => [asset.geometryKey, asset]));
    const base = `${ONSHAPE_API_BASE_PATH}/${root.kind === "assembly" ? "assemblies" : "parts"}/d/${root.documentId}/m/${microversionId}/e/${root.elementId}`;
    const query = new URLSearchParams({ configuration: root.configuration });
    if (root.kind === "assembly") {
      query.set("includeNonSolids", "true");
      query.set("excludeSuppressed", "false");
      query.set("includeMateFeatures", "false");
      query.set("includeMateConnectors", "false");
    } else {
      query.set("withThumbnails", "false");
      query.set("includePropertyDefaults", "false");
    }
    const response = yield* read(base, query.toString());
    let draft = yield* root.kind === "assembly"
      ? parseAssemblySnapshotDraft(context, response)
      : parsePartStudioSnapshotDraft(context, response);
    const studioRequest = Effect.fn(function* (part: CadPartStudioSource) {
      const linked = part.documentId !== root.documentId;
      if (linked && part.documentVersion === null)
        return yield* new OnshapeSnapshotAcquisitionError({ reason: "missing-linked-version" });
      const query = new URLSearchParams({
        configuration: part.fullConfiguration || part.configuration || "default",
      });
      if (linked) query.set("linkDocumentId", root.documentId);
      return {
        path: `${ONSHAPE_API_BASE_PATH}/parts/d/${part.documentId}/${linked ? "v" : "m"}/${linked ? part.documentVersion : part.documentMicroversion}/e/${part.elementId}`,
        query,
      };
    });
    if (root.kind === "assembly") {
      const groups = [];
      const verifiedVersions = new Map<string, string>();
      for (const group of snapshotPartStudioGroups(draft)) {
        const request = yield* studioRequest(group.source);
        request.query.set("withThumbnails", "false");
        request.query.set("includePropertyDefaults", "false");
        const response = yield* read(request.path, request.query.toString());
        if (group.source.documentId !== root.documentId) {
          const proof = yield* decodeMetadataProof(response).pipe(
            Effect.mapError(
              () => new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" }),
            ),
          );
          if (proof.length === 0 || proof.some((row) => row.microversionId === undefined)) {
            const key = `${group.source.documentId}/${group.source.documentVersion}`;
            let resolved = verifiedVersions.get(key);
            if (resolved === undefined) {
              resolved = (yield* read(
                `${ONSHAPE_API_BASE_PATH}/documents/d/${group.source.documentId}/v/${group.source.documentVersion}/currentmicroversion`,
              ).pipe(
                Effect.flatMap(decodeMicroversion),
                Effect.catchTag("SchemaError", () =>
                  Effect.fail(new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" })),
                ),
              )).microversion;
              verifiedVersions.set(key, resolved);
            }
            if (resolved !== group.source.documentMicroversion)
              return yield* new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" });
          }
        }
        groups.push({ source: group.source, response });
      }
      draft = yield* enrichSnapshotMetadata(draft, groups);
    }
    const assets: CadGeometryAsset[] = [];
    for (const part of draft.parts) {
      if (!part.geometryRequired) continue;
      const cached = previousAssets.get(part.geometryKey);
      if (cached !== undefined) {
        assets.push(cached);
        continue;
      }
      const request = yield* studioRequest(part.source);
      request.query.set("angleTolerance", "0.1");
      request.query.set("chordTolerance", "0.0005");
      request.query.set("rollbackBarIndex", "-1");
      request.query.set("outputSeparateFaceNodes", "false");
      request.query.set("outputFaceAppearances", "true");
      const downloaded = yield* connections.readBinary({
        connectionId: source.connectionId,
        host: source.host,
        path: `${request.path}/partid/${encodeURIComponent(part.source.partId)}/gltf`,
        query: request.query.toString(),
        beforeRequest: store.checkReserve(),
        beforeChunk: (receivedBytes) => store.checkReserve(receivedBytes),
      });
      const bytes = yield* normalizeCadGeometry(downloaded.bytes);
      assets.push({ geometryKey: part.geometryKey, ...(yield* store.putAsset(bytes)) });
    }
    const manifest = yield* completeSnapshotManifest(draft, assets);
    yield* store.publish(manifest);
    return manifest;
  });
  return OnshapeSnapshotAcquisition.of({ acquire: (input) => store.withAcquisition(run(input)) });
});
export const layer = Layer.effect(OnshapeSnapshotAcquisition, make);
