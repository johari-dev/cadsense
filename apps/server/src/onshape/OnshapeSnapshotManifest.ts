import * as NodeCrypto from "node:crypto";
import {
  CadPartAppearance,
  CadPartMaterial,
  CadPartSource,
  CadPartStudioSource,
  CadSnapshotContext,
  CadSnapshotDraft,
  CadSnapshotManifest,
  CadGeometryAsset,
  CadTransform,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeWorkspaceId,
  type CadSnapshotNode,
  type CadSnapshotPart,
  type CadPartMetadata,
  type CadSnapshotRoot,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Id = Text.check(Schema.isNonEmpty());
const Reference = {
  documentId: OnshapeDocumentId,
  documentMicroversion: OnshapeWorkspaceId,
  documentVersion: Schema.optionalKey(Schema.NullOr(OnshapeWorkspaceId)),
  elementId: OnshapeElementId,
  configuration: Schema.optionalKey(Text),
  fullConfiguration: Schema.optionalKey(Text),
};
const Instance = Schema.Struct({
  id: Id,
  name: Text,
  type: Schema.Literals(["Assembly", "Part", "Feature", "Unknown"]),
  suppressed: Schema.Boolean,
  documentId: Schema.optionalKey(OnshapeDocumentId),
  documentMicroversion: Schema.optionalKey(OnshapeWorkspaceId),
  documentVersion: Schema.optionalKey(Schema.NullOr(OnshapeWorkspaceId)),
  elementId: Schema.optionalKey(OnshapeElementId),
  configuration: Schema.optionalKey(Text),
  fullConfiguration: Schema.optionalKey(Text),
  partId: Schema.optionalKey(Text),
});
const Assembly = Schema.Struct({
  ...Reference,
  instances: Schema.Array(Instance).check(Schema.isMaxLength(100_000)),
});
const Occurrence = Schema.Struct({
  path: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  transform: CadTransform,
  hidden: Schema.Boolean,
});
const Definition = Schema.Struct({
  rootAssembly: Schema.Struct({
    ...Assembly.fields,
    occurrences: Schema.Array(Occurrence).check(Schema.isMaxLength(100_000)),
  }),
  subAssemblies: Schema.Array(Assembly).check(Schema.isMaxLength(10_000)),
  parts: Schema.Array(Schema.Struct({ ...Reference, partId: Text })).check(
    Schema.isMaxLength(100_000),
  ),
});
const Metadata = Schema.Array(
  Schema.Struct({
    partId: Id,
    name: Text,
    bodyType: Text,
    elementId: Schema.optionalKey(OnshapeElementId),
    microversionId: Schema.optionalKey(OnshapeWorkspaceId),
    isHidden: Schema.optionalKey(Schema.Boolean),
    isMesh: Schema.optionalKey(Schema.Boolean),
    partIdentity: Schema.optionalKey(Schema.NullOr(Text)),
    configurationId: Schema.optionalKey(Schema.NullOr(Text)),
    appearance: Schema.optionalKey(Schema.NullOr(CadPartAppearance)),
    material: Schema.optionalKey(Schema.NullOr(CadPartMaterial)),
  }),
).check(Schema.isMaxLength(100_000));
const decodeContext = Schema.decodeUnknownEffect(CadSnapshotContext);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const decodeDraft = Schema.decodeUnknownEffect(CadSnapshotDraft);
const decodeComplete = Schema.decodeUnknownEffect(CadSnapshotManifest);
const decodeAssets = Schema.decodeUnknownEffect(Schema.Array(CadGeometryAsset));
const decodeSource = Schema.decodeUnknownEffect(CadPartSource);
const decodeStudio = Schema.decodeUnknownEffect(CadPartStudioSource);

export class OnshapeSnapshotManifestError extends Schema.TaggedErrorClass<OnshapeSnapshotManifestError>()(
  "OnshapeSnapshotManifestError",
  {
    reason: Schema.Literals([
      "invalid-response",
      "invalid-topology",
      "missing-reference",
      "incomplete-assets",
    ]),
  },
) {}
const invalid = (reason: OnshapeSnapshotManifestError["reason"]) =>
  new OnshapeSnapshotManifestError({ reason });
const schemaFailure = () => invalid("invalid-response");
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const snapshotRootId = (root: CadSnapshotRoot) =>
  hash([
    root.host,
    root.documentId,
    root.originalRevision.kind,
    root.originalRevision.id,
    root.elementId,
    root.configuration,
  ]);
const nodeId = (rootId: string, path: readonly string[]) => hash([rootId, path]);
export const snapshotPartStudioKey = (source: CadPartStudioSource) =>
  hash([
    source.host,
    source.documentId,
    source.documentMicroversion,
    source.documentVersion,
    source.elementId,
    source.configuration,
    source.fullConfiguration,
  ]);
export const snapshotGeometryKey = (source: CadPartSource) =>
  hash([
    source.host,
    source.documentId,
    source.documentMicroversion,
    source.elementId,
    source.fullConfiguration || source.configuration || "default",
    source.partId,
    source.tessellationProfile,
  ]);
const partReferenceKey = (source: CadPartSource) =>
  hash([snapshotPartStudioKey(source), source.partId]);

const normalizedReference = (
  host: string,
  reference: typeof Assembly.Type | typeof Instance.Type | (typeof Definition.Type.parts)[number],
) => ({
  host,
  documentId: reference.documentId,
  documentMicroversion: reference.documentMicroversion,
  documentVersion: reference.documentVersion ?? null,
  elementId: reference.elementId,
  configuration: reference.configuration ?? reference.fullConfiguration,
  fullConfiguration: reference.fullConfiguration ?? reference.configuration,
});
const validateContext = Effect.fn("validateSnapshotContext")(function* (input: CadSnapshotContext) {
  const context = yield* decodeContext(input).pipe(Effect.mapError(schemaFailure));
  if (snapshotRootId(context.root) !== context.rootId) return yield* invalid("invalid-response");
  return context;
});
const rootNode = (context: CadSnapshotContext): CadSnapshotNode => ({
  id: nodeId(context.rootId, []),
  parentId: null,
  occurrencePath: [],
  instanceId: null,
  name: context.root.kind === "assembly" ? "Assembly" : "Part Studio",
  kind: context.root.kind,
  suppressed: false,
  defaultVisible: true,
  transform: IDENTITY,
  sourcePartKey: null,
});
function validAffine(transform: readonly number[]) {
  if (transform[12] !== 0 || transform[13] !== 0 || transform[14] !== 0 || transform[15] !== 1)
    return false;
  const determinant =
    transform[0]! * (transform[5]! * transform[10]! - transform[6]! * transform[9]!) -
    transform[1]! * (transform[4]! * transform[10]! - transform[6]! * transform[8]!) +
    transform[2]! * (transform[4]! * transform[9]! - transform[5]! * transform[8]!);
  return Number.isFinite(determinant) && Math.abs(determinant) > 1e-12;
}

/** Converts evaluated definitions to root-qualified occurrences; matrices are already absolute. */
export const parseAssemblySnapshotDraft = Effect.fn("parseAssemblySnapshotDraft")(function* (
  input: CadSnapshotContext,
  response: unknown,
) {
  const context = yield* validateContext(input);
  if (context.root.kind !== "assembly") return yield* invalid("invalid-response");
  const definition = yield* decodeDefinition(response).pipe(Effect.mapError(schemaFailure));
  if (
    definition.rootAssembly.documentId !== context.root.documentId ||
    definition.rootAssembly.documentMicroversion !== context.root.microversionId ||
    definition.rootAssembly.elementId !== context.root.elementId
  )
    return yield* invalid("missing-reference");
  const assemblies = new Map<string, typeof Assembly.Type>();
  const dependencies = new Map<string, CadPartStudioSource>();
  for (const assembly of [definition.rootAssembly, ...definition.subAssemblies]) {
    const source = yield* decodeStudio(normalizedReference(context.root.host, assembly)).pipe(
      Effect.mapError(schemaFailure),
    );
    const key = snapshotPartStudioKey(source);
    if (assemblies.has(key)) return yield* invalid("invalid-topology");
    const ids = new Set(assembly.instances.map((instance) => instance.id));
    if (ids.size !== assembly.instances.length) return yield* invalid("invalid-topology");
    assemblies.set(key, assembly);
    dependencies.set(key, source);
  }
  const declaredParts = new Map<string, CadPartSource>();
  for (const reference of definition.parts) {
    const studioReference = yield* decodeStudio(
      normalizedReference(context.root.host, reference),
    ).pipe(Effect.mapError(schemaFailure));
    dependencies.set(snapshotPartStudioKey(studioReference), studioReference);
    // Evaluated suppression can leave a configured source with an empty part ID.
    if (reference.partId === "") continue;
    const source = yield* decodeSource({
      ...normalizedReference(context.root.host, reference),
      partId: reference.partId,
      tessellationProfile: context.root.tessellationProfile,
    }).pipe(Effect.mapError(schemaFailure));
    const key = partReferenceKey(source);
    if (declaredParts.has(key)) return yield* invalid("invalid-topology");
    declaredParts.set(key, source);
    const { partId: _partId, tessellationProfile: _profile, ...studio } = source;
    dependencies.set(snapshotPartStudioKey(studio), studio);
  }
  const occurrences = new Map<string, typeof Occurrence.Type>();
  for (const occurrence of definition.rootAssembly.occurrences) {
    const key = nodeId(context.rootId, occurrence.path);
    if (occurrences.has(key) || !validAffine(occurrence.transform))
      return yield* invalid("invalid-topology");
    occurrences.set(key, occurrence);
  }
  const nodes: CadSnapshotNode[] = [rootNode(context)];
  const parts = new Map<string, CadSnapshotPart>();
  const visited = new Set<string>();
  const stack = [
    {
      assembly: definition.rootAssembly as typeof Assembly.Type,
      path: [] as string[],
      parentId: nodes[0]!.id,
      suppressed: false,
      visible: true,
      ancestors: new Set<string>(),
    },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const instance of frame.assembly.instances) {
      const path = [...frame.path, instance.id];
      if (path.length > 128 || nodes.length >= 100_000) return yield* invalid("invalid-topology");
      const pathKey = nodeId(context.rootId, path);
      const occurrence = occurrences.get(pathKey);
      const suppressed = frame.suppressed || instance.suppressed;
      if (!suppressed && !occurrence) return yield* invalid("missing-reference");
      if (occurrence) visited.add(pathKey);
      const id = nodeId(context.rootId, path);
      const visible = !suppressed && frame.visible && !(occurrence?.hidden ?? false);
      let sourcePartKey: string | null = null;
      if (instance.type === "Part") {
        const sourceOption = yield* decodeSource({
          ...normalizedReference(context.root.host, instance),
          partId: instance.partId,
          tessellationProfile: context.root.tessellationProfile,
        }).pipe(Effect.option);
        if (sourceOption._tag === "None") {
          if (!suppressed) return yield* invalid("missing-reference");
        } else {
          const source = sourceOption.value;
          const { partId: _partId, tessellationProfile: _profile, ...studio } = source;
          dependencies.set(snapshotPartStudioKey(studio), studio);
          sourcePartKey = snapshotGeometryKey(source);
          if (!suppressed && !declaredParts.has(partReferenceKey(source)))
            return yield* invalid("missing-reference");
          const previous = parts.get(sourcePartKey);
          parts.set(sourcePartKey, {
            geometryKey: sourcePartKey,
            source: previous?.geometryRequired ? previous.source : source,
            geometryRequired: !suppressed || (previous?.geometryRequired ?? false),
            metadata: null,
          });
        }
      } else if (instance.type !== "Assembly" && !suppressed) {
        return yield* invalid("missing-reference");
      }
      nodes.push({
        id,
        parentId: frame.parentId,
        occurrencePath: path,
        instanceId: instance.id,
        name: instance.name,
        kind:
          instance.type === "Assembly"
            ? "assembly"
            : instance.type === "Part"
              ? "part"
              : "unsupported",
        suppressed,
        defaultVisible: visible,
        transform: occurrence?.transform ?? IDENTITY,
        sourcePartKey,
      });
      if (instance.type === "Assembly") {
        const ref = yield* decodeStudio(normalizedReference(context.root.host, instance)).pipe(
          Effect.option,
        );
        const key = ref._tag === "Some" ? snapshotPartStudioKey(ref.value) : null;
        const child = key === null ? undefined : assemblies.get(key);
        if (!child || key === null) {
          if (!suppressed) return yield* invalid("missing-reference");
          continue;
        }
        if (frame.ancestors.has(key)) return yield* invalid("invalid-topology");
        stack.push({
          assembly: child,
          path,
          parentId: id,
          suppressed,
          visible,
          ancestors: new Set([...frame.ancestors, key]),
        });
      }
    }
  }
  if (visited.size !== occurrences.size) return yield* invalid("invalid-topology");
  return yield* decodeDraft({
    schemaVersion: 1,
    ...context,
    nodes,
    parts: [...parts.values()],
    dependencies: [...dependencies.values()],
  }).pipe(Effect.mapError(schemaFailure));
});

export function snapshotPartStudioGroups(draft: CadSnapshotDraft) {
  const groups = new Map<string, { key: string; source: CadPartStudioSource }>();
  for (const part of draft.parts) {
    if (!part.geometryRequired) continue;
    const key = snapshotPartStudioKey(part.source);
    if (!groups.has(key)) {
      const {
        host,
        documentId,
        documentMicroversion,
        documentVersion,
        elementId,
        configuration,
        fullConfiguration,
      } = part.source;
      groups.set(key, {
        key,
        source: {
          host,
          documentId,
          documentMicroversion,
          documentVersion,
          elementId,
          configuration,
          fullConfiguration,
        },
      });
    }
  }
  return [...groups.values()];
}
const metadataValue = (part: (typeof Metadata.Type)[number]): CadPartMetadata => ({
  name: part.name,
  bodyType: part.bodyType,
  isHidden: part.isHidden ?? false,
  isMesh: part.isMesh ?? false,
  partIdentity: part.partIdentity ?? null,
  configurationId: part.configurationId ?? null,
  appearance: part.appearance ?? null,
  material: part.material ?? null,
});

export const enrichSnapshotMetadata = Effect.fn("enrichSnapshotMetadata")(function* (
  input: CadSnapshotDraft,
  groups: readonly { source: CadPartStudioSource; response: unknown }[],
) {
  const draft = yield* decodeDraft(input).pipe(Effect.mapError(schemaFailure));
  const metadata = new Map<string, Map<string, CadPartMetadata>>();
  for (const group of groups) {
    const source = yield* decodeStudio(group.source).pipe(Effect.mapError(schemaFailure));
    const key = snapshotPartStudioKey(source);
    if (metadata.has(key)) return yield* invalid("invalid-response");
    const rows = yield* decodeMetadata(group.response).pipe(Effect.mapError(schemaFailure));
    const byPart = new Map<string, CadPartMetadata>();
    for (const row of rows) {
      if (
        byPart.has(row.partId) ||
        (row.elementId !== undefined && row.elementId !== source.elementId) ||
        (row.microversionId !== undefined && row.microversionId !== source.documentMicroversion)
      )
        return yield* invalid("missing-reference");
      byPart.set(row.partId, metadataValue(row));
    }
    metadata.set(key, byPart);
  }
  const parts: CadSnapshotPart[] = [];
  for (const part of draft.parts) {
    const value =
      metadata.get(snapshotPartStudioKey(part.source))?.get(part.source.partId) ?? part.metadata;
    if (part.geometryRequired && !value) return yield* invalid("missing-reference");
    parts.push({ ...part, metadata: value });
  }
  return { ...draft, parts };
});

export const parsePartStudioSnapshotDraft = Effect.fn("parsePartStudioSnapshotDraft")(function* (
  input: CadSnapshotContext,
  response: unknown,
) {
  const context = yield* validateContext(input);
  if (context.root.kind !== "part-studio") return yield* invalid("invalid-response");
  const rows = yield* decodeMetadata(response).pipe(Effect.mapError(schemaFailure));
  const nodes: CadSnapshotNode[] = [rootNode(context)];
  const parts: CadSnapshotPart[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      ids.has(row.partId) ||
      (row.elementId !== undefined && row.elementId !== context.root.elementId) ||
      (row.microversionId !== undefined && row.microversionId !== context.root.microversionId)
    )
      return yield* invalid("missing-reference");
    ids.add(row.partId);
    const source: CadPartSource = {
      host: context.root.host,
      documentId: context.root.documentId,
      documentMicroversion: context.root.microversionId,
      documentVersion:
        context.root.originalRevision.kind === "v" ? context.root.originalRevision.id : null,
      elementId: context.root.elementId,
      configuration: context.root.configuration,
      fullConfiguration: context.root.configuration,
      partId: row.partId,
      tessellationProfile: context.root.tessellationProfile,
    };
    const geometryKey = snapshotGeometryKey(source);
    parts.push({ geometryKey, source, geometryRequired: true, metadata: metadataValue(row) });
    nodes.push({
      id: nodeId(context.rootId, [row.partId]),
      parentId: nodes[0]!.id,
      occurrencePath: [row.partId],
      instanceId: null,
      name: row.name,
      kind: "part",
      suppressed: false,
      defaultVisible: !(row.isHidden ?? false),
      transform: IDENTITY,
      sourcePartKey: geometryKey,
    });
  }
  const dependency: CadPartStudioSource = {
    host: context.root.host,
    documentId: context.root.documentId,
    documentMicroversion: context.root.microversionId,
    documentVersion:
      context.root.originalRevision.kind === "v" ? context.root.originalRevision.id : null,
    elementId: context.root.elementId,
    configuration: context.root.configuration,
    fullConfiguration: context.root.configuration,
  };
  return yield* decodeDraft({
    schemaVersion: 1,
    ...context,
    nodes,
    parts,
    dependencies: [dependency],
  }).pipe(Effect.mapError(schemaFailure));
});

/** Structural completion only; the store must separately verify asset bytes against descriptors. */
export const completeSnapshotManifest = Effect.fn("completeSnapshotManifest")(function* (
  input: CadSnapshotDraft,
  inputAssets: readonly CadGeometryAsset[],
) {
  const draft = yield* decodeDraft(input).pipe(Effect.mapError(schemaFailure));
  const assets = yield* decodeAssets(inputAssets).pipe(Effect.mapError(schemaFailure));
  yield* validateContext(draft);
  const partByKey = new Map(draft.parts.map((part) => [part.geometryKey, part]));
  const dependencyKeys = new Set(draft.dependencies.map(snapshotPartStudioKey));
  if (dependencyKeys.size !== draft.dependencies.length) return yield* invalid("invalid-topology");
  const keys = new Set<string>();
  for (const asset of assets) {
    if (
      keys.has(asset.geometryKey) ||
      asset.relativePath !== `${asset.sha256}.glb` ||
      partByKey.get(asset.geometryKey)?.geometryRequired !== true
    )
      return yield* invalid("incomplete-assets");
    keys.add(asset.geometryKey);
  }
  for (const part of draft.parts) {
    if (
      part.geometryKey !== snapshotGeometryKey(part.source) ||
      !dependencyKeys.has(snapshotPartStudioKey(part.source)) ||
      (part.geometryRequired && (!part.metadata || !keys.has(part.geometryKey)))
    )
      return yield* invalid("incomplete-assets");
  }
  const ids = new Set<string>();
  const nodeById = new Map(draft.nodes.map((node) => [node.id, node]));
  const partKeys = new Set(draft.parts.map((part) => part.geometryKey));
  if (partKeys.size !== draft.parts.length || draft.nodes.length === 0)
    return yield* invalid("invalid-topology");
  for (const node of draft.nodes) {
    if (
      ids.has(node.id) ||
      node.id !== nodeId(draft.rootId, node.occurrencePath) ||
      !validAffine(node.transform) ||
      (node.sourcePartKey !== null && !partKeys.has(node.sourcePartKey))
    )
      return yield* invalid("invalid-topology");
    ids.add(node.id);
  }
  for (const node of draft.nodes) {
    if (
      node.occurrencePath.length === 0
        ? node.parentId !== null
        : node.parentId !== nodeId(draft.rootId, node.occurrencePath.slice(0, -1)) ||
          !ids.has(node.parentId)
    )
      return yield* invalid("invalid-topology");
    if (node.suppressed && node.defaultVisible) return yield* invalid("invalid-topology");
    if (
      !node.suppressed &&
      node.kind === "part" &&
      (node.sourcePartKey === null || partByKey.get(node.sourcePartKey)?.geometryRequired !== true)
    )
      return yield* invalid("incomplete-assets");
    if (
      node.occurrencePath.length === 0 &&
      (node.kind !== draft.root.kind || node.sourcePartKey !== null || node.suppressed)
    )
      return yield* invalid("invalid-topology");
    if (node.parentId !== null) {
      const parent = nodeById.get(node.parentId);
      if (
        !parent ||
        (parent.kind !== "assembly" && parent.kind !== "part-studio") ||
        (parent.suppressed && !node.suppressed) ||
        (!parent.defaultVisible && node.defaultVisible)
      )
        return yield* invalid("invalid-topology");
    }
  }
  return yield* decodeComplete({ ...draft, assets }).pipe(Effect.mapError(schemaFailure));
});
