import * as NodeCrypto from "node:crypto";
import {
  CadFindPartsInput,
  CadViewError,
  CadFindPartsEntry,
  CadFindPartsResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { presentCadBounds, worldCadBounds, type CadCheckGeometry } from "./CadChecks.ts";
import { indexCadSnapshot } from "./CadViewState.ts";

const decodeInput = Schema.decodeUnknownEffect(CadFindPartsInput);
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(CadFindPartsEntry));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(CadFindPartsResult));
// The field and ancestor caps keep even one maximally JSON-escaped entry below this budget.
const MAX_RESULT_BYTES = 64 * 1024;
const encodeFingerprint = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))),
);
const invalid = () => new CadViewError({ reason: "invalid-operation" });
const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";

/** Search immutable manifest order. Only the page window (at most `limit` matches) reads part
 * bounds, through the same per-activation loader as cad_checks. Cursors identify a page of the same
 * normalized query and revision; they grant no additional authority over the pinned snapshot.
 */
export const findCadParts = Effect.fn("findCadParts")(function* (
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  bounds: CadCheckGeometry["bounds"],
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
    if (!Number.isSafeInteger(offset) || offset >= snapshot.nodes.length) return yield* invalid();
  }
  const index = indexCadSnapshot(snapshot),
    visible = index.visible(state),
    parts = new Map(snapshot.parts.map((part) => [part.geometryKey, part]));
  // Page candidates in manifest order. Placed parts carry the geometry key their bounds come from.
  const candidates: {
    entry: CadFindPartsEntry;
    node: CadSnapshotManifest["nodes"][number];
    geometryKey: string | null;
  }[] = [];
  // Reserve the envelope using upper bounds for both the match count and cursor offset.
  let resultBytes = Buffer.byteLength(
    encodeResult({
      rootId: snapshot.rootId,
      snapshotId: snapshot.snapshotId,
      revision: state.revision,
      entries: [],
      totalMatches: snapshot.nodes.length,
      nextCursor: `${prefix}${snapshot.nodes.length}`,
    }),
  );
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
    if (ordinal < offset || candidates.length === limit) continue;
    let textTruncated = false;
    const text = (value: string) => {
      if (value.length > 256) textTruncated = true;
      return value.slice(0, 256);
    };
    const assemblyPath: { occurrenceId: string; name: string }[] = [];
    let parentId = node.parentId,
      ancestorCount = 0,
      // Like cad_checks, anything under a suppressed assembly counts as suppressed.
      suppressed = node.suppressed;
    // Stored manifests have validated parent links. Bound the walk even for malformed callers.
    while (parentId !== null) {
      const parent = index.nodes.get(parentId);
      if (!parent || ancestorCount++ >= snapshot.nodes.length) return yield* invalid();
      if (assemblyPath.length < 16)
        assemblyPath.push({ occurrenceId: parent.id, name: text(parent.name) });
      suppressed ||= parent.suppressed;
      parentId = parent.parentId;
    }
    assemblyPath.reverse();
    const entry: CadFindPartsEntry = {
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
      massKg: metadata?.massKg ?? null,
      bounds: null,
      assemblyPath,
      omittedAncestorCount: Math.max(0, ancestorCount - 16),
      textTruncated,
    };
    candidates.push({
      entry,
      node,
      geometryKey: node.kind === "part" && !suppressed ? node.sourcePartKey : null,
    });
  }
  if (offset > 0 && offset >= totalMatches) return yield* invalid();
  const local = yield* bounds(
    new Set(candidates.flatMap(({ geometryKey }) => (geometryKey === null ? [] : [geometryKey]))),
  );
  const entries: CadFindPartsEntry[] = [];
  for (const { entry: candidate, node, geometryKey } of candidates) {
    const world =
      geometryKey === null ? null : worldCadBounds(node.transform, local.get(geometryKey));
    const entry = { ...candidate, bounds: world && presentCadBounds(world) };
    const entryBytes = Buffer.byteLength(encodeEntry(entry)) + (entries.length > 0 ? 1 : 0);
    if (resultBytes + entryBytes > MAX_RESULT_BYTES) {
      if (entries.length === 0) return yield* invalid();
      // Leave this entry and every later match for the next page.
      break;
    }
    entries.push(entry);
    resultBytes += entryBytes;
  }
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
