import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  OnshapeWorkspaceId,
  type CadSnapshotDraft,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CadGeometryError, normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { applyOnshapeOpacity } from "./OnshapeGeometryAppearance.ts";
import { batchOnshapeGeometry } from "./OnshapeGeometryBatching.ts";
import { CadSnapshotStore } from "../cad/CadSnapshotStore.ts";
import { CadProgressReporter } from "../cad/CadOperationProgress.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import {
  OnshapeConnections,
  type OnshapeReadRequest,
  type OnshapeJsonMethod,
} from "./OnshapeConnections.ts";
import { readOnshapeExportGeometry } from "./OnshapeExportGeometry.ts";
import { readOnshapeThreeMf } from "./OnshapeThreeMf.ts";
import {
  completeSnapshotManifest,
  snapshotPartStudioKey,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
} from "./OnshapeSnapshotManifest.ts";
import { acquireSnapshotMetadata, onshapeDefinitionQuery } from "./OnshapeSnapshotMetadata.ts";
import { OnshapeRecentElements } from "./OnshapeRecentElements.ts";
import { OnshapeSyncState } from "./OnshapeSyncState.ts";

export const ONSHAPE_BULK_TESSELLATION_PROFILE =
  "onshape-3mf-coarse-meters-z-up-opacity-composite-source-v4";
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

const decodeElements = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({ id: Schema.String, elementType: Schema.String, microversionId: Id }),
  ).check(Schema.isMaxLength(10_000)),
);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
/**
 * A revision for each Part Studio that changes whenever its parts can change. A studio's own
 * element microversion already changes with its features, part properties, Feature Studio
 * code, and studios it derives from; nothing else changes it, including assembly edits
 * (measured November 2026). Element kinds not measured, such as Variable Studios and imported
 * files, count toward every studio.
 */
const studioRevisions = (response: unknown) =>
  Option.map(decodeElements(response), (elements) => {
    const measured = new Set(["PARTSTUDIO", "FEATURESTUDIO", "ASSEMBLY", "BILLOFMATERIALS"]);
    const shared = sha256(
      elements
        .filter((element) => !measured.has(element.elementType))
        .map((element) => `${element.id}:${element.microversionId}`)
        .sort()
        .join(","),
    );
    return Object.fromEntries(
      elements
        .filter((element) => element.elementType === "PARTSTUDIO")
        .map((element) => [element.id, sha256(`${element.microversionId}:${shared}`)]),
    );
  });
type DraftPart = CadSnapshotDraft["parts"][number];
type PartMetadata = NonNullable<DraftPart["metadata"]>;
const sourcePartKey = (part: DraftPart) =>
  JSON.stringify([
    part.source.elementId,
    part.source.fullConfiguration || part.source.configuration || "default",
    part.source.partId,
  ]);
/**
 * Geometry and metadata of the previous snapshot's parts whose sources did not change,
 * under this draft's geometry keys. Linked parts keep their keys. Root-document parts match
 * by studio, configuration, and part ID when their studio revision is unchanged.
 */
const carryForward = (
  previous: CadSnapshotManifest,
  draft: CadSnapshotDraft,
  current: Readonly<Record<string, string>>,
  earlier: Readonly<Record<string, string>>,
) => {
  const assets = new Map(previous.assets.map((asset) => [asset.geometryKey, asset]));
  const byKey = new Map<string, { asset: CadGeometryAsset; metadata: PartMetadata }>();
  const bySource = new Map<string, { asset: CadGeometryAsset; metadata: PartMetadata }>();
  for (const part of previous.parts) {
    const asset = assets.get(part.geometryKey);
    if (!asset?.complexity || !part.metadata) continue;
    const entry = { asset, metadata: part.metadata };
    byKey.set(part.geometryKey, entry);
    if (part.source.documentId === previous.root.documentId)
      bySource.set(sourcePartKey(part), entry);
  }
  const carried = new Map<string, { asset: CadGeometryAsset; metadata: PartMetadata }>();
  for (const part of draft.parts) {
    if (!part.geometryRequired) continue;
    const studio = part.source.elementId;
    const entry =
      part.source.documentId !== draft.root.documentId
        ? byKey.get(part.geometryKey)
        : current[studio] !== undefined && current[studio] === earlier[studio]
          ? bySource.get(sourcePartKey(part))
          : undefined;
    if (entry)
      carried.set(part.geometryKey, {
        asset: { ...entry.asset, geometryKey: part.geometryKey },
        metadata: entry.metadata,
      });
  }
  return carried;
};
/** Opacity and composite handling are baked into an asset, so both must match to reuse it. */
const sameLook = (a: DraftPart["metadata"] | undefined, b: DraftPart["metadata"] | undefined) =>
  a?.bodyType === b?.bodyType && NodeUtil.isDeepStrictEqual(a?.appearance, b?.appearance);
const MAX_BATCH_PARTS = 64;
const MAX_BATCH_QUERY = 6000;
const sourceQuery = (draft: CadSnapshotDraft, part: DraftPart) => {
  const query = new URLSearchParams({
    configuration: part.source.fullConfiguration || part.source.configuration || "default",
    angleTolerance: "0.1",
    chordTolerance: "0.0005",
    rollbackBarIndex: "-1",
    outputSeparateFaceNodes: "false",
    outputFaceAppearances: "true",
  });
  if (part.source.documentId !== draft.root.documentId)
    query.set("linkDocumentId", draft.root.documentId);
  return query;
};
/**
 * Source-geometry requests for parts: one per Part Studio, split to bound URL size and
 * response memory. Each batch is one request unless the response omits a part.
 */
export const sourceGeometryBatches = (draft: CadSnapshotDraft, parts: readonly DraftPart[]) => {
  const studios = new Map<string, DraftPart[]>();
  for (const part of parts) {
    const key = snapshotPartStudioKey(part.source);
    studios.set(key, [...(studios.get(key) ?? []), part]);
  }
  const batches: DraftPart[][] = [];
  for (const members of studios.values()) {
    let batch: DraftPart[] = [];
    let length = sourceQuery(draft, members[0]!).toString().length;
    const base = length;
    for (const part of members) {
      const added = encodeURIComponent(part.source.partId).length + 8;
      if (
        batch.length === MAX_BATCH_PARTS ||
        (batch.length > 0 && length + added > MAX_BATCH_QUERY)
      ) {
        batches.push(batch);
        batch = [];
        length = base;
      }
      batch.push(part);
      length += added;
    }
    batches.push(batch);
  }
  return batches;
};

/** One export job per root, with bounded polling and durable resume on the next explicit sync. */
export const makeBulkAcquisition = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const state = yield* OnshapeSyncState;
  const store = yield* CadSnapshotStore;
  const recent = yield* OnshapeRecentElements;
  /** Geometry for one batch of parts from one Part Studio, pinned to each part's revision. */
  const fetchSourceGeometry = Effect.fn(function* (
    source: OnshapeProjectSource,
    draft: CadSnapshotDraft,
    batch: readonly DraftPart[],
  ) {
    const first = batch[0]!.source;
    const linked = first.documentId !== draft.root.documentId;
    // Never publish an incomplete scene: a linked part must be pinned to a version.
    if (linked && !first.documentVersion)
      return yield* new OnshapeExportError({ reason: "invalid-response" });
    const revision = `${linked ? "v" : "m"}/${linked ? first.documentVersion : first.documentMicroversion}`;
    const geometry = new Map<string, Uint8Array>();
    if (batch.length > 1) {
      const query = sourceQuery(draft, batch[0]!);
      for (const part of batch) query.append("partId", part.source.partId);
      const response = yield* connections
        .readBinary({
          connectionId: source.connectionId,
          host: first.host,
          path: `${ONSHAPE_API_BASE_PATH}/partstudios/d/${first.documentId}/${revision}/e/${first.elementId}/gltf`,
          query: query.toString(),
          beforeRequest: store.checkReserve(),
          beforeChunk: (bytes) => store.checkReserve(bytes),
        })
        .pipe(
          Effect.catchTag("OnshapeResponseError", (error) =>
            error.reason === "too-large" || error.reason === "timeout"
              ? Effect.void
              : Effect.fail(error),
          ),
        );
      if (response) {
        const bytes = yield* normalizeCadGeometry(response.bytes);
        // Synchronous studio exports identify source part IDs, not assembly paths.
        const studio = yield* Effect.try({
          try: () =>
            readOnshapeExportGeometry(
              { ...draft, root: { ...draft.root, kind: "part-studio" }, parts: [...batch] },
              bytes,
              true,
            ),
          catch: geometryFailure,
        });
        for (const part of batch)
          if (studio.has(part.geometryKey))
            geometry.set(
              part.geometryKey,
              yield* Effect.try({
                try: () => studio.extract(part.geometryKey),
                catch: geometryFailure,
              }),
            );
      }
    }
    // A failed or partial batch falls back only for its unresolved parts.
    for (const part of batch) {
      if (geometry.has(part.geometryKey)) continue;
      const response = yield* connections.readBinary({
        connectionId: source.connectionId,
        host: part.source.host,
        path: `${ONSHAPE_API_BASE_PATH}/parts/d/${part.source.documentId}/${revision}/e/${part.source.elementId}/partid/${encodeURIComponent(part.source.partId)}/gltf`,
        query: sourceQuery(draft, part).toString(),
        beforeRequest: store.checkReserve(),
        beforeChunk: (bytes) => store.checkReserve(bytes),
      });
      geometry.set(part.geometryKey, yield* normalizeCadGeometry(response.bytes));
    }
    return geometry;
  });
  /** Stores one part's geometry as a two-sided asset with its authored opacity. */
  const storeAsset = Effect.fn(function* (part: DraftPart, extracted: Uint8Array) {
    const batched = yield* Effect.try({
      try: () =>
        applyOnshapeOpacity(
          batchOnshapeGeometry(extracted, { doubleSided: true }),
          part.metadata?.appearance,
        ),
      catch: geometryFailure,
    });
    const bytes = yield* normalizeCadGeometry(batched);
    const complexity = yield* Effect.try({
      try: () => measureCadGeometry(bytes),
      catch: geometryFailure,
    });
    return { ...(yield* store.putAsset(bytes)), geometryKey: part.geometryKey, complexity };
  });
  /** `definition` is the root assembly definition the caller already read at this revision. */
  return Effect.fn("OnshapeBulkAcquisition.acquire")(function* (
    context: CadSnapshotContext,
    source: OnshapeProjectSource,
    definition?: unknown,
  ) {
    const { root } = context;
    const progress = yield* CadProgressReporter;
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
    const read = Effect.fn(function* (
      request: Omit<OnshapeReadRequest, "connectionId" | "host"> & OnshapeJsonMethod,
    ) {
      yield* store.checkReserve();
      return yield* connections.readJson({
        ...request,
        connectionId: source.connectionId,
        host: source.host,
      });
    });
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
        // The last published snapshot of this root. A changed revision may reuse its geometry
        // and metadata, so it stays on disk until a newer checkpoint replaces it.
        const last = checkpoint?.phase === "complete" ? checkpoint : null;
        // Studio revisions at this revision, recorded with every later checkpoint.
        let studios = checkpoint?.revisionKey === revisionKey ? checkpoint.studios : undefined;
        // Stored assets that stand in for unchanged sources, keyed by this draft's geometry keys.
        let reusable = new Map<string, CadGeometryAsset>();
        if (checkpoint?.revisionKey !== revisionKey) {
          if (checkpoint !== null && checkpoint.phase !== "complete") yield* entry.clear();
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
        const complete = Effect.fn(function* (draft: CadSnapshotDraft, assets: CadGeometryAsset[]) {
          yield* progress.step("saving");
          const partOrder = new Map(draft.parts.map((part, index) => [part.geometryKey, index]));
          assets.sort((a, b) => partOrder.get(a.geometryKey)! - partOrder.get(b.geometryKey)!);
          const manifest: CadSnapshotManifest = yield* completeSnapshotManifest(draft, assets);
          yield* store.publish(manifest);
          yield* entry.write({
            phase: "complete",
            revisionKey,
            snapshotId: manifest.snapshotId,
            ...(studios === undefined ? {} : { studios }),
          });
          return manifest;
        });
        if (checkpoint === null) {
          yield* progress.step("reading");
          const response =
            definition ??
            (yield* read({
              path: `${ONSHAPE_API_BASE_PATH}/${root.kind === "assembly" ? "assemblies" : "parts"}/d/${root.documentId}/m/${root.microversionId}/e/${root.elementId}`,
              query: onshapeDefinitionQuery(root.kind, root.configuration).toString(),
            }));
          let draft = yield* root.kind === "assembly"
            ? parseAssemblySnapshotDraft(context, response)
            : parsePartStudioSnapshotDraft(context, response);
          const budget = yield* Effect.try({
            try: () => createCadSceneBudget(draft.nodes),
            catch: geometryFailure,
          });
          const required = draft.parts.filter((part) => part.geometryRequired);
          // Linked parts keep their geometry keys across workspace edits and projects.
          reusable = new Map(
            (yield* store.findGeometry(required.map((part) => part.geometryKey)))
              .filter((asset) => asset.complexity !== undefined)
              .map((asset) => [asset.geometryKey, asset]),
          );
          let carried = new Map<string, { asset: CadGeometryAsset; metadata: PartMetadata }>();
          if (root.kind === "assembly") {
            // Root-document keys change with every edit, so unchanged studios are found by
            // their revisions instead.
            if (
              required.some(
                (part) =>
                  part.source.documentId === root.documentId && !reusable.has(part.geometryKey),
              )
            ) {
              // With nothing to compare, revisions are only recorded, so the list discovery
              // read moments ago can stand in. A studio changed since has a new revision, so
              // the next sync cannot match it. Comparing needs this revision's own list.
              const discovered =
                last?.studios === undefined
                  ? Option.flatMap(yield* recent.take(source), studioRevisions)
                  : Option.none();
              studios = Option.isSome(discovered)
                ? discovered.value
                : Option.getOrUndefined(
                    studioRevisions(
                      yield* read({
                        path: `${ONSHAPE_API_BASE_PATH}/documents/d/${root.documentId}/m/${root.microversionId}/elements`,
                        query: "withThumbnails=false",
                      }).pipe(Effect.catchTag("OnshapeResponseError", () => Effect.succeed(null))),
                    ),
                  );
            }
            const previous =
              last === null
                ? Option.none()
                : yield* store.load(last.snapshotId).pipe(Effect.option);
            if (
              Option.isSome(previous) &&
              previous.value.projectId === context.projectId &&
              previous.value.rootId === context.rootId &&
              previous.value.root.tessellationProfile === root.tessellationProfile
            )
              carried = carryForward(previous.value, draft, studios ?? {}, last?.studios ?? {});
            // Metadata lives with each part's source: a studio revision changes with part
            // properties too, and linked versions never change. Read the BOM only when some
            // part's source changed.
            draft =
              required.length > 0 && required.every((part) => carried.has(part.geometryKey))
                ? {
                    ...draft,
                    parts: draft.parts.map((part) => {
                      const metadata = carried.get(part.geometryKey)?.metadata;
                      return metadata ? { ...part, metadata } : part;
                    }),
                  }
                : yield* acquireSnapshotMetadata(
                    draft,
                    (path, query = "") => read({ path, query }),
                    response,
                  );
            const parts = new Map(draft.parts.map((part) => [part.geometryKey, part]));
            for (const [key, { asset, metadata }] of carried)
              if (!reusable.has(key) && sameLook(metadata, parts.get(key)?.metadata))
                reusable.set(key, asset);
          }
          const missing = draft.parts.filter(
            (part) => part.geometryRequired && !reusable.has(part.geometryKey),
          );
          const batches = sourceGeometryBatches(draft, missing);
          // An export costs a submission, a status poll, the download, and for a workspace a
          // revision check, plus fallbacks. Fetch missing sources directly when that costs no more.
          if (batches.length <= (root.originalRevision.kind === "w" ? 4 : 3)) {
            const assets: CadGeometryAsset[] = [];
            for (const part of draft.parts) {
              const asset = reusable.get(part.geometryKey);
              if (!part.geometryRequired || !asset) continue;
              yield* Effect.try({
                try: () => budget.add(asset, asset.complexity!),
                catch: geometryFailure,
              });
              assets.push(asset);
            }
            for (const batch of batches) {
              yield* progress.step("downloading", { done: assets.length, total: required.length });
              const geometry = yield* fetchSourceGeometry(source, draft, batch);
              for (const part of batch) {
                const asset = yield* storeAsset(part, geometry.get(part.geometryKey)!);
                yield* Effect.try({
                  try: () => budget.add(asset, asset.complexity),
                  catch: geometryFailure,
                });
                assets.push(asset);
              }
            }
            return yield* complete(draft, assets);
          }
          yield* progress.step("exporting");
          const translation = yield* read({
            method: "POST",
            query: "",
            path: `${ONSHAPE_API_BASE_PATH}/${root.kind === "assembly" ? "assemblies" : "partstudios"}/d/${root.documentId}/${root.originalRevision.kind}/${root.originalRevision.id}/e/${root.elementId}/translations`,
            body: {
              storeInDocument: false,
              notifyUser: false,
              grouping: true,
              formatName: "3MF",
              resolution: "coarse",
              unit: "METER",
              allowFaultyParts: true,
              configuration: root.configuration,
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
                ...(studios === undefined ? {} : { studios }),
              }),
            ),
            // Finish the bounded submission and save its job ID even if the caller cancels.
            Effect.uninterruptible,
          );
          checkpoint = {
            phase: "exporting",
            revisionKey,
            draft,
            translationId: translation.id,
            ...(studios === undefined ? {} : { studios }),
          };
          initialStatus = translation;
        }
        if (checkpoint.phase === "exporting") {
          // A resumed export reports here; a new one already did before submitting it.
          yield* progress.step("exporting");
          let exported: { readonly externalId: string; readonly documentId: string } | null = null;
          let status = initialStatus;
          for (let attempt = 0; attempt < ONSHAPE_TRANSLATION_MAX_POLLS; attempt++) {
            if (status === undefined || status.requestState === "ACTIVE") {
              // Check a resumed job immediately; give a new translation time to finish before polling.
              if (status !== undefined || attempt > 0)
                yield* Effect.sleep(`${Math.min(20 * 2 ** attempt, 30)} seconds`);
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
          // Workspace BOM and definition reads cannot replace this: a workspace BOM reports no
          // microversion, and a definition costs the same single request.
          if (
            root.originalRevision.kind === "w" &&
            (yield* pin()).microversion !== root.microversionId
          ) {
            yield* entry.clear();
            return yield* new OnshapeExportError({ reason: "revision-changed" });
          }
          yield* progress.step("downloading", { done: 0 });
          // Report each further MiB, not each chunk.
          let reportedBytes = 0;
          const downloaded = yield* connections.readBinary({
            bulkExport: true,
            connectionId: source.connectionId,
            host: root.host,
            path: `${ONSHAPE_API_BASE_PATH}/documents/d/${exported.documentId}/externaldata/${exported.externalId}`,
            query: "",
            beforeRequest: store.checkReserve(),
            beforeChunk: (bytes) =>
              store.checkReserve(bytes).pipe(
                Effect.andThen(
                  bytes - reportedBytes < 1024 ** 2
                    ? Effect.void
                    : Effect.suspend(() => {
                        reportedBytes = bytes;
                        return progress.step("downloading", { done: bytes });
                      }),
                ),
              ),
          });
          checkpoint = yield* entry.saveDownload(
            checkpoint.draft,
            revisionKey,
            downloaded.bytes,
            studios,
          );
        }
        const bytes = yield* entry.readDownload(checkpoint);
        const geometry = yield* Effect.try({
          // Keep uniquely identified archive geometry. Only ambiguous, omitted, or
          // composite sources need the pinned Part Studio fallback below.
          try: () => readOnshapeThreeMf(checkpoint.draft, bytes, undefined, true),
          catch: geometryFailure,
        });
        // 3MF exports paint composite faces that inherit a constituent body color with a
        // fixed near-white, so composites always use source part geometry instead.
        const fromArchive = (part: DraftPart) =>
          geometry.has(part.geometryKey) && part.metadata?.bodyType !== "composite";
        const draft = checkpoint.draft;
        const budget = yield* Effect.try({
          try: () => createCadSceneBudget(draft.nodes),
          catch: geometryFailure,
        });
        // Geometry keys pin the source revision, so a stored asset is the same geometry.
        // A resumed export has no pre-export reuse, so it looks stored assets up again.
        const cached = new Map([
          ...(yield* store.findGeometry(
            draft.parts
              .filter((part) => part.geometryRequired && !fromArchive(part))
              .map((part) => part.geometryKey),
          ))
            .filter((asset) => asset.complexity !== undefined)
            .map((asset) => [asset.geometryKey, asset] as const),
          ...reusable,
        ]);
        const required = draft.parts.filter((part) => part.geometryRequired).length;
        const assets: CadGeometryAsset[] = [];
        const add = (asset: CadGeometryAsset) =>
          Effect.try({
            try: () => {
              budget.add(asset, asset.complexity!);
              assets.push(asset);
            },
            catch: geometryFailure,
          });
        const missing: DraftPart[] = [];
        for (const part of draft.parts) {
          if (!part.geometryRequired) continue;
          yield* progress.step("building", { done: assets.length, total: required });
          if (fromArchive(part)) {
            const extracted = yield* Effect.try({
              try: () => geometry.extract(part.geometryKey),
              catch: geometryFailure,
            });
            yield* add(yield* storeAsset(part, extracted));
            continue;
          }
          const reused = cached.get(part.geometryKey);
          if (reused) yield* add(reused);
          else missing.push(part);
        }
        // Bulk exports can omit bodies. Fetch only absent source geometry, one batch in memory
        // at a time, pinned to its inspected revision; never publish an incomplete scene.
        for (const batch of sourceGeometryBatches(draft, missing)) {
          yield* progress.step("building", { done: assets.length, total: required });
          const fetched = yield* fetchSourceGeometry(source, draft, batch);
          for (const part of batch)
            yield* add(yield* storeAsset(part, fetched.get(part.geometryKey)!));
        }
        return yield* complete(draft, assets);
      }),
    );
  });
});
