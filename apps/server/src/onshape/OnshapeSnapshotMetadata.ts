import {
  CadPartMetadata,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeNetworkError,
  OnshapeResponseError,
  OnshapeWorkspaceId,
  type CadPartStudioSource,
  type CadSnapshotDraft,
  type CadSnapshotRoot,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as NodeUtil from "node:util";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import {
  OnshapeAssemblyPart,
  enrichSnapshotMetadata,
  snapshotGeometryKey,
  snapshotPartStudioGroups,
  snapshotPartStudioKey,
} from "./OnshapeSnapshotManifest.ts";

const decodeMicroversion = Schema.decodeUnknownEffect(
  Schema.Struct({ microversion: OnshapeWorkspaceId }),
);
const decodeMetadataProof = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ microversionId: Schema.optionalKey(OnshapeWorkspaceId) })),
);
const decodeDocumentMetadata = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const isResponseError = Schema.is(OnshapeResponseError);
const isNetworkError = Schema.is(OnshapeNetworkError);
const decodeAssemblyParts = Schema.decodeUnknownOption(
  Schema.Struct({ parts: Schema.Array(OnshapeAssemblyPart).check(Schema.isMaxLength(100_000)) }),
);
const Bom = Schema.Struct({
  bomSource: Schema.Struct({
    document: Schema.Struct({ id: OnshapeDocumentId }),
    element: Schema.Struct({ id: OnshapeElementId, configuration: Schema.String }),
    documentMicroversion: Schema.Struct({ id: OnshapeWorkspaceId }),
  }),
  rows: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100_000)),
});
const BomRow = Schema.Struct({
  itemSource: Schema.Struct({
    documentId: OnshapeDocumentId,
    elementId: OnshapeElementId,
    wvmType: Schema.Literals(["m", "v"]),
    wvmId: OnshapeWorkspaceId,
    configuration: Schema.String,
    fullConfiguration: Schema.optionalKey(Schema.String),
    distinctConfigurations: Schema.optionalKey(Schema.Array(Schema.String)),
    partId: Schema.optionalKey(Schema.String),
    partIdentity: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  headerIdToValue: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeBom = Schema.decodeUnknownOption(Bom);
const decodeRow = Schema.decodeUnknownOption(BomRow);
const decodePartMetadata = Schema.decodeUnknownOption(CadPartMetadata);

// Onshape abbreviates configurations by omitting default-valued parameters.
// Accept an abbreviation only if it identifies one source in this pinned assembly.
const configurationEntries = (configuration: string) => {
  const entries = new URLSearchParams(
    configuration === "default" ? "" : configuration.replaceAll(";", "&"),
  );
  entries.sort();
  return entries;
};
const metadataReference = (
  documentId: string,
  kind: string,
  revision: string,
  elementId: string,
  partId: string,
) => JSON.stringify([documentId, kind, revision, elementId, partId]);

function withBomMetadata(draft: CadSnapshotDraft, definition: unknown, response: unknown) {
  const assembly = decodeAssemblyParts(definition);
  const bom = decodeBom(response);
  if (Option.isNone(assembly) || Option.isNone(bom)) return draft;
  const root = bom.value.bomSource;
  if (
    root.document.id !== draft.root.documentId ||
    root.element.id !== draft.root.elementId ||
    root.documentMicroversion.id !== draft.root.microversionId ||
    configurationEntries(root.element.configuration).toString() !==
      configurationEntries(draft.root.configuration).toString()
  )
    return draft;

  const bodyTypes = new Map(
    assembly.value.parts.map((part) => [
      snapshotGeometryKey({
        ...part,
        host: draft.root.host,
        documentVersion: part.documentVersion ?? null,
        configuration: part.configuration ?? part.fullConfiguration ?? "default",
        fullConfiguration: part.fullConfiguration ?? part.configuration ?? "default",
        tessellationProfile: draft.root.tessellationProfile,
      }),
      part.bodyType,
    ]),
  );
  const byReference = new Map<string, (typeof draft.parts)[number][]>();
  for (const part of draft.parts) {
    const source = part.source;
    for (const [kind, revision] of [
      ["m", source.documentMicroversion],
      ["v", source.documentVersion],
    ] as const) {
      if (revision === null) continue;
      const key = metadataReference(
        source.documentId,
        kind,
        revision,
        source.elementId,
        source.partId,
      );
      const parts = byReference.get(key) ?? [];
      parts.push(part);
      byReference.set(key, parts);
    }
  }
  const candidates = new Map<string, CadPartMetadata>();
  const conflicting = new Set<string>();
  for (const value of bom.value.rows) {
    const decoded = decodeRow(value);
    if (Option.isNone(decoded)) continue;
    const { itemSource: ref, headerIdToValue: props } = decoded.value;
    if (!ref.partId) continue;
    const parts =
      byReference.get(
        metadataReference(ref.documentId, ref.wvmType, ref.wvmId, ref.elementId, ref.partId),
      ) ?? [];
    // BOMs collapse metadata-equivalent configurations. Only their explicit
    // distinctConfigurations prove that a non-default configuration belongs to a row.
    const configurations = new Set(
      [ref.fullConfiguration ?? ref.configuration, ...(ref.distinctConfigurations ?? [])].map(
        (value) => configurationEntries(value).toString(),
      ),
    );
    const full = (part: (typeof parts)[number]) =>
      configurationEntries(part.source.fullConfiguration || part.source.configuration || "default");
    const exact = parts.filter((part) => configurations.has(full(part).toString()));
    const config = configurationEntries(ref.configuration);
    const abbreviated =
      ref.fullConfiguration === undefined
        ? parts.filter((part) =>
            [...config].every(
              ([key, value]) =>
                full(part).getAll(key).length === 1 && full(part).get(key) === value,
            ),
          )
        : [];
    const matches = exact.length > 0 ? exact : abbreviated.length === 1 ? abbreviated : [];
    for (const part of matches) {
      const metadata = decodePartMetadata({
        name: props["57f3fb8efa3416c06701d60d"],
        bodyType: bodyTypes.get(part.geometryKey),
        isHidden: null,
        isMesh: null,
        partIdentity: ref.partIdentity ?? null,
        configurationId: null,
        appearance: props["57f3fb8efa3416c06701d60c"],
        material: props["57f3fb8efa3416c06701d615"] ?? null,
      });
      if (Option.isNone(metadata)) {
        conflicting.add(part.geometryKey);
        continue;
      }
      const previous = candidates.get(part.geometryKey);
      if (previous && !NodeUtil.isDeepStrictEqual(previous, metadata.value))
        conflicting.add(part.geometryKey);
      candidates.set(part.geometryKey, metadata.value);
    }
  }
  return {
    ...draft,
    parts: draft.parts.map((part) => {
      const metadata = candidates.get(part.geometryKey);
      if (!part.geometryRequired || !metadata || conflicting.has(part.geometryKey)) return part;
      return { ...part, metadata };
    }),
  };
}
export class OnshapeSnapshotAcquisitionError extends Schema.TaggedErrorClass<OnshapeSnapshotAcquisitionError>()(
  "OnshapeSnapshotAcquisitionError",
  {
    reason: Schema.Literals(["invalid-response", "missing-linked-version", "identity-unavailable"]),
  },
) {}

export const onshapePartStudioRequest = Effect.fn(function* (
  root: CadSnapshotRoot,
  part: CadPartStudioSource,
  scope: "element" | "document" = "element",
) {
  const linked = part.documentId !== root.documentId;
  if (linked && part.documentVersion === null)
    return yield* new OnshapeSnapshotAcquisitionError({ reason: "missing-linked-version" });
  const query = new URLSearchParams({
    configuration: part.fullConfiguration || part.configuration || "default",
  });
  if (linked) query.set("linkDocumentId", root.documentId);
  return {
    path: `${ONSHAPE_API_BASE_PATH}/parts/d/${part.documentId}/${linked ? "v" : "m"}/${linked ? part.documentVersion : part.documentMicroversion}${scope === "element" ? `/e/${part.elementId}` : ""}`,
    query,
  };
});

/** Read expanded BOM appearance once; fetch studio metadata only for unresolved sources. */
export const acquireSnapshotMetadata = <E, R>(
  input: CadSnapshotDraft,
  read: (path: string, query?: string) => Effect.Effect<unknown, E, R>,
  definition?: unknown,
) =>
  Effect.gen(function* () {
    const { root } = input;
    let draft = input;
    const allStudios = snapshotPartStudioGroups(draft);
    for (const studio of allStudios) yield* onshapePartStudioRequest(root, studio.source);
    if (definition !== undefined && allStudios.length > 1) {
      const query = new URLSearchParams({
        configuration: root.configuration,
        indented: "true",
        multiLevel: "true",
        generateIfAbsent: "true",
        includeExcluded: "true",
        ignoreSubassemblyBomBehavior: "true",
        includeItemMicroversions: "true",
        onlyVisibleColumns: "false",
      });
      for (const id of [
        "57f3fb8efa3416c06701d60d",
        "57f3fb8efa3416c06701d60c",
        "57f3fb8efa3416c06701d615",
      ])
        query.append("bomColumnIds", id);
      const response = yield* read(
        `${ONSHAPE_API_BASE_PATH}/assemblies/d/${root.documentId}/m/${root.microversionId}/e/${root.elementId}/bom`,
        query.toString(),
      ).pipe(
        Effect.catchIf(
          (error) => isResponseError(error) || isNetworkError(error),
          () => Effect.succeed(null),
        ),
      );
      draft = withBomMetadata(draft, definition, response);
    }
    const groups = [];
    const verifiedVersions = new Map<string, string>();
    const unresolved = new Set(
      draft.parts
        .filter((part) => part.geometryRequired && !part.metadata)
        .map((part) => snapshotPartStudioKey(part.source)),
    );
    const studios = allStudios.filter((group) => unresolved.has(group.key));
    const documentKey = (source: CadPartStudioSource) =>
      JSON.stringify([source.documentId, source.documentMicroversion, source.documentVersion]);
    const isDefault = (source: CadPartStudioSource) =>
      (source.fullConfiguration || source.configuration || "default") === "default";
    const documentCounts = new Map<string, number>();
    const documents = new Map<string, readonly Record<string, unknown>[] | null>();
    for (const group of studios) {
      if (!isDefault(group.source)) continue;
      const key = documentKey(group.source);
      documentCounts.set(key, (documentCounts.get(key) ?? 0) + 1);
    }
    for (const group of studios) {
      const key = documentKey(group.source);
      // The document endpoint does not preserve explicit configuration IDs.
      const batch = isDefault(group.source) && (documentCounts.get(key) ?? 0) > 1;
      const request = yield* onshapePartStudioRequest(
        root,
        group.source,
        batch ? "document" : "element",
      );
      request.query.set("withThumbnails", "false");
      request.query.set("includePropertyDefaults", "false");
      let response: unknown;
      if (batch) {
        let rows = documents.get(key);
        if (rows === undefined) {
          const documentResponse = yield* read(request.path, request.query.toString()).pipe(
            Effect.catchIf(
              (error) =>
                isResponseError(error) &&
                (error.reason === "too-large" || error.reason === "timeout"),
              () => Effect.succeed(null),
            ),
          );
          rows =
            documentResponse === null
              ? null
              : yield* decodeDocumentMetadata(documentResponse).pipe(
                  Effect.catchTag("SchemaError", () =>
                    Effect.fail(
                      new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" }),
                    ),
                  ),
                );
          documents.set(key, rows);
        }
        // A large unrelated studio must not make a previously importable assembly fail.
        response =
          rows === null
            ? yield* read(
                (yield* onshapePartStudioRequest(root, group.source)).path,
                request.query.toString(),
              )
            : rows.filter((row) => row.elementId === group.source.elementId);
      } else response = yield* read(request.path, request.query.toString());
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
    return yield* enrichSnapshotMetadata(draft, groups);
  });
