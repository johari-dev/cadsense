import * as NodeCrypto from "node:crypto";
import {
  CadFindPartsInput,
  CadViewError,
  type CadFindPartsEntry,
  type CadFindPartsResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import { indexCadSnapshot } from "@cadsense/shared/cadScene";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeInput = Schema.decodeUnknownEffect(CadFindPartsInput);
const encodeFingerprint = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))),
);
const invalid = () => new CadViewError({ reason: "invalid-operation" });
const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";

/** Search immutable manifest order without geometry reads. Cursors identify a page of the same
 * normalized query and revision; they grant no additional authority over the pinned snapshot.
 */
export const findCadParts = Effect.fn("findCadParts")(function* (
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  rawInput: unknown,
): Effect.fn.Return<CadFindPartsResult, CadViewError> {
  const input = yield* decodeInput(rawInput).pipe(Effect.mapError(invalid));
  if (
    input.snapshotId !== state.snapshotId ||
    input.expectedRevision !== state.revision ||
    snapshot.snapshotId !== state.snapshotId ||
    snapshot.rootId !== state.rootId
  )
    return yield* new CadViewError({ reason: "revision-conflict" });
  const name = normalize(input.nameQuery),
    materialName = normalize(input.materialName),
    bodyType = normalize(input.bodyType),
    kind = input.kind ?? "part",
    visibility = input.visibility ?? "all",
    limit = input.limit ?? 25;
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      encodeFingerprint([
        snapshot.rootId,
        snapshot.snapshotId,
        state.revision,
        name,
        input.sourcePartKey ?? null,
        materialName,
        bodyType,
        kind,
        visibility,
        limit,
      ]),
    )
    .digest("hex");
  const prefix = `v1:${fingerprint}:`;
  let offset = 0;
  if (input.cursor !== undefined) {
    const suffix = input.cursor.slice(prefix.length);
    if (!input.cursor.startsWith(prefix) || !/^[1-9][0-9]*$/.test(suffix)) return yield* invalid();
    offset = Number(suffix);
    if (!Number.isSafeInteger(offset) || offset % limit !== 0 || offset >= snapshot.nodes.length)
      return yield* invalid();
  }
  const index = indexCadSnapshot(snapshot),
    visible = index.visible(state),
    parts = new Map(snapshot.parts.map((part) => [part.geometryKey, part]));
  const entries: CadFindPartsEntry[] = [];
  let totalMatches = 0;
  for (const node of snapshot.nodes) {
    const part = node.sourcePartKey === null ? undefined : parts.get(node.sourcePartKey),
      metadata = part?.metadata;
    const isVisible = visible.get(node.id) ?? false;
    if (
      (kind !== "all" && node.kind !== kind) ||
      (name && !node.name.toLowerCase().includes(name)) ||
      (input.sourcePartKey !== undefined && node.sourcePartKey !== input.sourcePartKey) ||
      (bodyType && metadata?.bodyType.toLowerCase() !== bodyType) ||
      (materialName && !metadata?.material?.displayName?.toLowerCase().includes(materialName)) ||
      (visibility !== "all" && isVisible !== (visibility === "visible"))
    )
      continue;
    const ordinal = totalMatches++;
    if (ordinal < offset || entries.length === limit) continue;
    let textTruncated = false;
    const text = (value: string) => {
      if (value.length > 256) textTruncated = true;
      return value.slice(0, 256);
    };
    const assemblyPath: { occurrenceId: string; name: string }[] = [];
    let parentId = node.parentId,
      ancestorCount = 0;
    // Stored manifests have validated parent links. Bound the walk even for malformed callers.
    while (parentId !== null) {
      const parent = index.nodes.get(parentId);
      if (!parent || ancestorCount++ >= snapshot.nodes.length) return yield* invalid();
      if (assemblyPath.length < 16)
        assemblyPath.push({ occurrenceId: parent.id, name: text(parent.name) });
      parentId = parent.parentId;
    }
    assemblyPath.reverse();
    entries.push({
      occurrenceId: node.id,
      parentOccurrenceId: node.parentId,
      name: text(node.name),
      kind: node.kind,
      instanceId: node.instanceId === null ? null : text(node.instanceId),
      visible: isVisible,
      suppressed: node.suppressed,
      sourcePartKey: node.sourcePartKey,
      source: part
        ? {
            documentId: part.source.documentId,
            documentMicroversion: part.source.documentMicroversion,
            elementId: part.source.elementId,
            partId: text(part.source.partId),
            configuration: text(part.source.configuration),
          }
        : null,
      metadataAvailable: metadata != null,
      bodyType: metadata ? text(metadata.bodyType) : null,
      material: {
        status: metadata?.material ? "available" : "unavailable",
        name:
          metadata?.material?.displayName === undefined
            ? null
            : text(metadata.material.displayName),
      },
      assemblyPath,
      omittedAncestorCount: Math.max(0, ancestorCount - 16),
      textTruncated,
    });
  }
  if (offset > 0 && offset >= totalMatches) return yield* invalid();
  return {
    rootId: snapshot.rootId,
    snapshotId: snapshot.snapshotId,
    revision: state.revision,
    entries,
    totalMatches,
    nextCursor:
      offset + entries.length < totalMatches ? `${prefix}${offset + entries.length}` : null,
  };
});
