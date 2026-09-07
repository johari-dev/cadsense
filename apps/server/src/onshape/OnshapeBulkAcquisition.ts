import * as NodeCrypto from "node:crypto";
import {
  OnshapeWorkspaceId,
  type CadGeometryAsset,
  type CadSnapshotContext,
  type CadSnapshotManifest,
  type OnshapeProjectSource,
} from "@cadsense/contracts";
import {
  CadSceneBudgetError,
  createCadSceneBudget,
  measureCadGeometry,
} from "@cadsense/shared/cadSceneBudget";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CadGeometryError, normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { batchOnshapeGeometry } from "./OnshapeGeometryBatching.ts";
import { CadSnapshotStore } from "../cad/CadSnapshotStore.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import {
  OnshapeConnections,
  type OnshapeReadRequest,
  type OnshapeJsonMethod,
} from "./OnshapeConnections.ts";
import { normalizeOnshapeExport } from "./OnshapeExportBundle.ts";
import { readOnshapeExportGeometry } from "./OnshapeExportGeometry.ts";
import {
  completeSnapshotManifest,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
  withAssemblyExportMetadata,
} from "./OnshapeSnapshotManifest.ts";
import { OnshapeSyncState } from "./OnshapeSyncState.ts";

export const ONSHAPE_BULK_TESSELLATION_PROFILE = "onshape-bulk-gltf-medium-meters-z-up-v1";
export const ONSHAPE_TRANSLATION_MAX_POLLS = 24;
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/));
const Translation = Schema.Struct({
  id: Id,
  requestState: Schema.Literals(["ACTIVE", "DONE", "FAILED", "CANCELLED"]),
  resultExternalDataIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Id))),
  resultDocumentId: Schema.optionalKey(Schema.NullOr(Id)),
});
const decodeTranslation = Schema.decodeUnknownEffect(Translation);
const decodePin = Schema.decodeUnknownEffect(Schema.Struct({ microversion: OnshapeWorkspaceId }));

export class OnshapeExportError extends Schema.TaggedErrorClass<OnshapeExportError>()(
  "OnshapeExportError",
  {
    reason: Schema.Literals([
      "invalid-response",
      "translation-failed",
      "translation-pending",
      "revision-changed",
    ]),
  },
) {}
const invalid = () => new OnshapeExportError({ reason: "invalid-response" });
const isGeometryError = Schema.is(CadGeometryError);
const geometryFailure = (error: unknown) =>
  isGeometryError(error)
    ? error
    : new CadGeometryError({
        reason: error instanceof CadSceneBudgetError ? error.reason : "invalid-geometry",
      });

/** One export job per root, with bounded polling and durable resume on the next explicit sync. */
export const makeBulkAcquisition = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const state = yield* OnshapeSyncState;
  const store = yield* CadSnapshotStore;
  return Effect.fn("OnshapeBulkAcquisition.acquire")(function* (
    context: CadSnapshotContext,
    source: OnshapeProjectSource,
  ) {
    const { root } = context;
    const cacheKey = NodeCrypto.createHash("sha256")
      .update(context.projectId)
      .update("\0")
      .update(context.rootId)
      .digest("hex");
    const revisionKey = NodeCrypto.createHash("sha256")
      .update(cacheKey)
      .update(root.microversionId)
      .update(root.tessellationProfile)
      .digest("hex");
    const read = (request: Omit<OnshapeReadRequest, "connectionId" | "host"> & OnshapeJsonMethod) =>
      store.checkReserve().pipe(
        Effect.andThen(
          connections.readJson({
            ...request,
            connectionId: source.connectionId,
            host: source.host,
          }),
        ),
      );
    const pin = () =>
      read({
        path: `${ONSHAPE_API_BASE_PATH}/documents/d/${root.documentId}/${root.originalRevision.kind}/${root.originalRevision.id}/currentmicroversion`,
        query: "",
      }).pipe(
        Effect.flatMap(decodePin),
        Effect.mapError((error) => (error._tag === "SchemaError" ? invalid() : error)),
      );
    return yield* state.withEntry(cacheKey, (entry) =>
      Effect.gen(function* () {
        let checkpoint = yield* entry.read();
        let initialStatus: typeof Translation.Type | undefined;
        if (checkpoint?.revisionKey !== revisionKey) {
          if (checkpoint !== null) yield* entry.clear();
          checkpoint = null;
        }
        if (checkpoint?.phase === "complete") {
          const previous = yield* store.load(checkpoint.snapshotId).pipe(Effect.option);
          if (
            previous._tag === "Some" &&
            previous.value.projectId === context.projectId &&
            previous.value.rootId === context.rootId &&
            previous.value.root.microversionId === root.microversionId &&
            previous.value.root.tessellationProfile === root.tessellationProfile
          )
            return previous.value;
          yield* entry.clear();
          checkpoint = null;
        }
        if (checkpoint === null) {
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
          const response = yield* read({
            path: `${ONSHAPE_API_BASE_PATH}/${root.kind === "assembly" ? "assemblies" : "parts"}/d/${root.documentId}/m/${root.microversionId}/e/${root.elementId}`,
            query: query.toString(),
          });
          const draft = yield* root.kind === "assembly"
            ? parseAssemblySnapshotDraft(context, response).pipe(
                Effect.flatMap((draft) => withAssemblyExportMetadata(draft, response)),
              )
            : parsePartStudioSnapshotDraft(context, response);
          yield* Effect.try({
            try: () => createCadSceneBudget(draft.nodes),
            catch: geometryFailure,
          });
          if (!draft.parts.some((part) => part.geometryRequired)) {
            const manifest = yield* completeSnapshotManifest(draft, []);
            yield* store.publish(manifest);
            yield* entry.write({ phase: "complete", revisionKey, snapshotId: manifest.snapshotId });
            return manifest;
          }
          const translation = yield* read({
            method: "POST",
            query: "",
            path: `${ONSHAPE_API_BASE_PATH}/${root.kind === "assembly" ? "assemblies" : "partstudios"}/d/${root.documentId}/${root.originalRevision.kind}/${root.originalRevision.id}/e/${root.elementId}/export/gltf`,
            body: {
              storeInDocument: false,
              notifyUser: false,
              grouping: true,
              excludeHiddenEntities: false,
              isYAxisUp: false,
              includeExportIds: true,
              meshParams: { resolution: "MEDIUM", unit: "METER" },
              advancedParams: { configuration: root.configuration },
              correlationId: revisionKey,
            },
          }).pipe(
            Effect.flatMap(decodeTranslation),
            Effect.mapError((error) => (error._tag === "SchemaError" ? invalid() : error)),
            Effect.tap((translation) =>
              entry.write({
                phase: "exporting",
                revisionKey,
                draft,
                translationId: translation.id,
              }),
            ),
            // Finish the bounded submission and save its job ID even if the caller cancels.
            Effect.uninterruptible,
          );
          checkpoint = { phase: "exporting", revisionKey, draft, translationId: translation.id };
          initialStatus = translation;
        }
        if (checkpoint.phase === "exporting") {
          let exported: { readonly externalId: string; readonly documentId: string } | null = null;
          let status = initialStatus;
          for (let attempt = 0; attempt < ONSHAPE_TRANSLATION_MAX_POLLS; attempt++) {
            if (status === undefined || status.requestState === "ACTIVE") {
              // Check a resumed job immediately; give a new translation time to finish before polling.
              if (status !== undefined || attempt > 0)
                yield* Effect.sleep(`${Math.min(5 * 2 ** attempt, 30)} seconds`);
              status = yield* read({
                path: `${ONSHAPE_API_BASE_PATH}/translations/${checkpoint.translationId}`,
                query: "",
              }).pipe(
                Effect.flatMap(decodeTranslation),
                Effect.mapError((error) => (error._tag === "SchemaError" ? invalid() : error)),
              );
            }
            if (status.id !== checkpoint.translationId) return yield* invalid();
            if (status.requestState === "FAILED" || status.requestState === "CANCELLED") {
              yield* entry.clear();
              return yield* new OnshapeExportError({ reason: "translation-failed" });
            }
            if (status.requestState === "DONE") {
              if (
                status.resultExternalDataIds?.length !== 1 ||
                (status.resultDocumentId && status.resultDocumentId !== root.documentId)
              )
                return yield* invalid();
              exported = {
                externalId: status.resultExternalDataIds[0]!,
                documentId: root.documentId,
              };
              break;
            }
          }
          if (exported === null)
            return yield* new OnshapeExportError({ reason: "translation-pending" });
          // Async export only accepts w/v. A workspace must still match the immutable definition.
          if (
            root.originalRevision.kind === "w" &&
            (yield* pin()).microversion !== root.microversionId
          ) {
            yield* entry.clear();
            return yield* new OnshapeExportError({ reason: "revision-changed" });
          }
          const downloaded = yield* connections.readBinary({
            bulkExport: true,
            connectionId: source.connectionId,
            host: root.host,
            path: `${ONSHAPE_API_BASE_PATH}/documents/d/${exported.documentId}/externaldata/${exported.externalId}`,
            query: "",
            beforeRequest: store.checkReserve(),
            beforeChunk: (bytes) => store.checkReserve(bytes),
          });
          checkpoint = yield* entry.saveDownload(checkpoint.draft, revisionKey, downloaded.bytes);
        }
        const bytes = yield* entry.readDownload(checkpoint);
        const normalized = yield* normalizeOnshapeExport(bytes);
        const geometry = yield* Effect.try({
          try: () => readOnshapeExportGeometry(checkpoint.draft, normalized, true),
          catch: geometryFailure,
        });
        const draft = checkpoint.draft;
        const budget = yield* Effect.try({
          try: () => createCadSceneBudget(draft.nodes),
          catch: geometryFailure,
        });
        const assets: CadGeometryAsset[] = [];
        for (const part of draft.parts) {
          if (!part.geometryRequired) continue;
          const extracted = geometry.has(part.geometryKey)
            ? yield* Effect.try({
                try: () => geometry.extract(part.geometryKey),
                catch: geometryFailure,
              })
            : yield* Effect.gen(function* () {
                // Bulk exports can omit bodies. Fetch only absent source geometry,
                // pinned to its inspected revision; never publish an incomplete scene.
                const linked = part.source.documentId !== draft.root.documentId;
                if (linked && !part.source.documentVersion)
                  return yield* new OnshapeExportError({ reason: "invalid-response" });
                const query = new URLSearchParams({
                  configuration:
                    part.source.fullConfiguration || part.source.configuration || "default",
                  angleTolerance: "0.1",
                  chordTolerance: "0.0005",
                  rollbackBarIndex: "-1",
                  outputSeparateFaceNodes: "false",
                  outputFaceAppearances: "true",
                });
                if (linked) query.set("linkDocumentId", draft.root.documentId);
                const response = yield* connections.readBinary({
                  connectionId: source.connectionId,
                  host: part.source.host,
                  path: `${ONSHAPE_API_BASE_PATH}/parts/d/${part.source.documentId}/${linked ? "v" : "m"}/${linked ? part.source.documentVersion : part.source.documentMicroversion}/e/${part.source.elementId}/partid/${encodeURIComponent(part.source.partId)}/gltf`,
                  query: query.toString(),
                  beforeRequest: store.checkReserve(),
                  beforeChunk: (bytes) => store.checkReserve(bytes),
                });
                return yield* normalizeCadGeometry(response.bytes);
              });
          const batched = yield* Effect.try({
            try: () => batchOnshapeGeometry(extracted),
            catch: geometryFailure,
          });
          const bytes = yield* normalizeCadGeometry(batched);
          const complexity = yield* Effect.try({
            try: () => measureCadGeometry(bytes),
            catch: geometryFailure,
          });
          const asset = {
            ...(yield* store.putAsset(bytes)),
            geometryKey: part.geometryKey,
            complexity,
          };
          yield* Effect.try({ try: () => budget.add(asset, complexity), catch: geometryFailure });
          assets.push(asset);
        }
        const manifest: CadSnapshotManifest = yield* completeSnapshotManifest(draft, assets);
        yield* store.publish(manifest);
        yield* entry.write({ phase: "complete", revisionKey, snapshotId: manifest.snapshotId });
        return manifest;
      }),
    );
  });
});
