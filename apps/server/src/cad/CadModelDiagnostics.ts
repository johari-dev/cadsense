import {
  CadModelDiagnosticsInput,
  CadViewError,
  type CadDiagnosticComplexity,
  type CadDiagnosticSeverity,
  type CadModelDiagnostic,
  type CadModelDiagnosticsResult,
  type CadSnapshotManifest,
  type CadSnapshotNode,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownEffect(CadModelDiagnosticsInput);
const invalid = () => new CadViewError({ reason: "invalid-operation" });
export const CAD_DIAGNOSTIC_THRESHOLDS = {
  triangles: 1_000_000,
  decodedBytes: 128 * 1024 ** 2,
  drawCalls: 128,
} as const;
const severityOrder = { info: 0, warning: 1, error: 2 };
type Complexity = typeof CadDiagnosticComplexity.Type;
type References = { ids: string[]; count: number; unsuppressedParts: number };
const emptyReferences = (): References => ({ ids: [], count: 0, unsuppressedParts: 0 });
const sum = (a: number | null, b: number): number | null =>
  a !== null && Number.isSafeInteger(a + b) ? a + b : null;
const product = (a: number, b: number): number | null =>
  Number.isSafeInteger(a * b) ? a * b : null;
const complexityValid = (value: Complexity | undefined): value is Complexity =>
  value !== undefined &&
  Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);

/** This scan never reads asset files. Descriptor consistency and stored costs are its only evidence. */
export const readCadModelDiagnostics = Effect.fn("readCadModelDiagnostics")(function* (
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  rawInput: unknown,
): Effect.fn.Return<CadModelDiagnosticsResult, CadViewError> {
  const input = yield* decode(rawInput).pipe(Effect.mapError(invalid));
  if (
    input.expectedRevision !== state.revision ||
    input.snapshotId !== snapshot.snapshotId ||
    state.snapshotId !== snapshot.snapshotId ||
    state.rootId !== snapshot.rootId
  )
    return yield* new CadViewError({ reason: "revision-conflict" });
  const thresholds = { ...CAD_DIAGNOSTIC_THRESHOLDS, ...input.thresholds };
  const minimumSeverity = input.minimumSeverity ?? "info";
  const prefix = `${snapshot.snapshotId}:${state.revision}:${minimumSeverity}:${thresholds.triangles}:${thresholds.decodedBytes}:${thresholds.drawCalls}:`;
  const suffix = input.cursor?.slice(prefix.length);
  if (
    input.cursor !== undefined &&
    (!input.cursor.startsWith(prefix) || !suffix || !/^(0|[1-9][0-9]*)$/.test(suffix))
  )
    return yield* invalid();
  const offset = suffix === undefined ? 0 : Number(suffix);
  if (!Number.isSafeInteger(offset)) return yield* invalid();
  const limit = input.limit ?? 50;
  const parts = new Map(snapshot.parts.map((part) => [part.geometryKey, part]));
  const assets = new Map(snapshot.assets.map((asset) => [asset.geometryKey, asset]));
  const references = new Map<string, References>();
  const occurrences = {
    total: snapshot.nodes.length,
    parts: 0,
    suppressed: 0,
    unsupported: 0,
    unsuppressedParts: 0,
  };
  const workload = {
    knownOccurrenceCount: 0,
    unknownOccurrenceCount: 0,
    trianglesKnownSubtotal: 0 as number | null,
    drawCallsKnownSubtotal: 0 as number | null,
    complete: false,
  };
  for (const node of snapshot.nodes) {
    if (node.kind === "part") occurrences.parts++;
    if (node.suppressed) occurrences.suppressed++;
    if (node.kind === "unsupported") occurrences.unsupported++;
    if (node.sourcePartKey !== null) {
      const refs = references.get(node.sourcePartKey) ?? emptyReferences();
      refs.count++;
      if (refs.ids.length < 20) refs.ids.push(node.id);
      if (node.kind === "part" && !node.suppressed) refs.unsuppressedParts++;
      references.set(node.sourcePartKey, refs);
    }
    if (node.kind === "part" && !node.suppressed) {
      occurrences.unsuppressedParts++;
      const part = node.sourcePartKey === null ? undefined : parts.get(node.sourcePartKey);
      const complexity = part?.geometryRequired
        ? assets.get(part.geometryKey)?.complexity
        : undefined;
      if (complexityValid(complexity)) {
        workload.knownOccurrenceCount++;
        workload.trianglesKnownSubtotal = sum(
          workload.trianglesKnownSubtotal,
          complexity.triangles,
        );
        workload.drawCallsKnownSubtotal = sum(
          workload.drawCallsKnownSubtotal,
          complexity.drawCalls,
        );
      } else workload.unknownOccurrenceCount++;
    }
  }
  workload.complete =
    workload.unknownOccurrenceCount === 0 &&
    workload.trianglesKnownSubtotal !== null &&
    workload.drawCallsKnownSubtotal !== null;
  const findings: CadModelDiagnostic[] = [];
  const counts = {
    allFindings: 0,
    matchingFindings: 0,
    returnedFindings: 0,
    offset,
    bySeverity: { info: 0, warning: 0, error: 0 },
  };
  const emit = (
    code: CadModelDiagnostic["code"],
    severity: typeof CadDiagnosticSeverity.Type,
    classification: CadModelDiagnostic["classification"],
    message: string,
    geometryKey: string | null,
    node?: CadSnapshotNode,
  ) => {
    counts.allFindings++;
    counts.bySeverity[severity]++;
    if (severityOrder[severity] < severityOrder[minimumSeverity]) return;
    const index = counts.matchingFindings++;
    if (index < offset || findings.length >= limit) return;
    const part = geometryKey === null ? undefined : parts.get(geometryKey);
    const asset = geometryKey === null ? undefined : assets.get(geometryKey);
    const refs =
      geometryKey === null ? emptyReferences() : (references.get(geometryKey) ?? emptyReferences());
    const storedComplexity = complexityValid(asset?.complexity) ? asset.complexity : null;
    const thresholdsExceeded: CadModelDiagnostic["evidence"]["thresholdsExceeded"][number][] = [];
    if (storedComplexity) {
      if (storedComplexity.triangles >= thresholds.triangles)
        thresholdsExceeded.push("geometry-triangles");
      if (storedComplexity.decodedBytes >= thresholds.decodedBytes)
        thresholdsExceeded.push("geometry-decoded-bytes");
      if (storedComplexity.drawCalls >= thresholds.drawCalls)
        thresholdsExceeded.push("geometry-draw-calls");
      if (storedComplexity.triangles * refs.unsuppressedParts >= thresholds.triangles)
        thresholdsExceeded.push("potential-triangles");
      if (storedComplexity.drawCalls * refs.unsuppressedParts >= thresholds.drawCalls)
        thresholdsExceeded.push("potential-draw-calls");
    }
    const occurrenceIds = node ? [node.id] : refs.ids;
    const occurrenceCount = node ? 1 : refs.count;
    findings.push({
      code,
      severity,
      classification,
      message,
      geometryKey,
      sourcePartId: part?.source.partId ?? null,
      sourceMicroversionId: part?.source.documentMicroversion ?? null,
      occurrenceIds,
      occurrenceCount,
      occurrenceIdsTruncated: occurrenceIds.length < occurrenceCount,
      evidence: {
        source: "stored-manifest",
        nodeKind: node?.kind ?? null,
        suppressed: node?.suppressed ?? null,
        geometryRequired: part?.geometryRequired ?? null,
        assetDescriptorPresent: asset !== undefined,
        metadataPresent: part ? part.metadata !== null : null,
        complexityState:
          asset === undefined
            ? "no-asset-descriptor"
            : asset.complexity === undefined
              ? "missing"
              : storedComplexity === null
                ? "invalid"
                : "present",
        storedComplexity,
        unsuppressedPartOccurrences: refs.unsuppressedParts,
        potentialTriangles: storedComplexity
          ? product(storedComplexity.triangles, refs.unsuppressedParts)
          : null,
        potentialDrawCalls: storedComplexity
          ? product(storedComplexity.drawCalls, refs.unsuppressedParts)
          : null,
        thresholdsExceeded,
      },
    });
  };
  for (const node of snapshot.nodes) {
    const part = node.sourcePartKey === null ? undefined : parts.get(node.sourcePartKey);
    if (node.kind === "unsupported")
      emit(
        "unsupported-component",
        node.suppressed ? "info" : "warning",
        node.suppressed ? "expected-state" : "coverage-gap",
        node.suppressed
          ? "This component is marked unsupported and suppressed. Its omission from the loaded scene is expected."
          : "This component is marked unsupported in the snapshot. No supported part geometry is represented for it.",
        node.sourcePartKey,
        node,
      );
    else if (node.suppressed)
      emit(
        "suppressed-component",
        "info",
        "expected-state",
        "This occurrence is suppressed. Omission from the loaded scene is expected.",
        node.sourcePartKey,
        node,
      );
    if (
      (node.sourcePartKey !== null && !part) ||
      (node.kind === "part" && !node.suppressed && node.sourcePartKey === null)
    )
      emit(
        "missing-part-reference",
        "error",
        "manifest-defect",
        "The occurrence has no matching source-part association in the manifest.",
        node.sourcePartKey,
        node,
      );
    if (node.kind === "part" && !node.suppressed && part && !part.geometryRequired)
      emit(
        "inconsistent-geometry-requirement",
        "error",
        "manifest-defect",
        "An unsuppressed part references source geometry that is marked not required.",
        node.sourcePartKey,
        node,
      );
  }
  const sourceParts = {
    total: snapshot.parts.length,
    geometryRequired: 0,
    expectedUnloaded: 0,
    missingMetadata: 0,
    missingRequiredAssets: 0,
  };
  const geometryComplexity = {
    basis: "required-source-geometry-key" as const,
    knownGeometryCount: 0,
    unknownGeometryCount: 0,
    trianglesKnownSubtotal: 0 as number | null,
    decodedBytesKnownSubtotal: 0 as number | null,
    drawCallsKnownSubtotal: 0 as number | null,
    complete: false,
  };
  for (const part of snapshot.parts) {
    const asset = assets.get(part.geometryKey);
    const refs = references.get(part.geometryKey) ?? emptyReferences();
    if (part.geometryRequired) {
      sourceParts.geometryRequired++;
      if (complexityValid(asset?.complexity)) {
        geometryComplexity.knownGeometryCount++;
        geometryComplexity.trianglesKnownSubtotal = sum(
          geometryComplexity.trianglesKnownSubtotal,
          asset.complexity.triangles,
        );
        geometryComplexity.decodedBytesKnownSubtotal = sum(
          geometryComplexity.decodedBytesKnownSubtotal,
          asset.complexity.decodedBytes,
        );
        geometryComplexity.drawCallsKnownSubtotal = sum(
          geometryComplexity.drawCallsKnownSubtotal,
          asset.complexity.drawCalls,
        );
      } else geometryComplexity.unknownGeometryCount++;
      if (!asset) {
        sourceParts.missingRequiredAssets++;
        emit(
          "missing-required-geometry",
          "error",
          "manifest-defect",
          "Required source geometry has no asset descriptor. This is a missing manifest association, not a disk-file check.",
          part.geometryKey,
        );
      }
    } else if (!asset && refs.unsuppressedParts === 0) {
      sourceParts.expectedUnloaded++;
      emit(
        "expected-unloaded-geometry",
        "info",
        "expected-state",
        "This source part is not required for loading and has no asset descriptor. Unloaded geometry is expected.",
        part.geometryKey,
      );
    }
    if (part.metadata === null) {
      sourceParts.missingMetadata++;
      emit(
        "metadata-unavailable",
        part.geometryRequired ? "error" : "info",
        part.geometryRequired ? "manifest-defect" : "coverage-gap",
        "No part metadata is stored. Material, appearance, and other part properties remain unknown.",
        part.geometryKey,
      );
    }
  }
  geometryComplexity.complete =
    geometryComplexity.unknownGeometryCount === 0 &&
    geometryComplexity.trianglesKnownSubtotal !== null &&
    geometryComplexity.decodedBytesKnownSubtotal !== null &&
    geometryComplexity.drawCallsKnownSubtotal !== null;
  let invalidAssociations = 0;
  for (const asset of snapshot.assets) {
    const part = parts.get(asset.geometryKey);
    if (!part?.geometryRequired) {
      invalidAssociations++;
      emit(
        "invalid-asset-association",
        "error",
        "manifest-defect",
        "The asset descriptor does not belong to source geometry marked required.",
        asset.geometryKey,
      );
    }
    if (!complexityValid(asset.complexity)) {
      emit(
        "complexity-unavailable",
        asset.complexity === undefined ? "info" : "warning",
        "coverage-gap",
        "Stored mesh complexity is missing or cannot be represented as safe nonnegative integer counts. Geometry cost remains unknown.",
        asset.geometryKey,
      );
      continue;
    }
    const refs = references.get(asset.geometryKey) ?? emptyReferences();
    const cost = asset.complexity;
    if (
      cost.triangles >= thresholds.triangles ||
      cost.decodedBytes >= thresholds.decodedBytes ||
      cost.drawCalls >= thresholds.drawCalls ||
      cost.triangles * refs.unsuppressedParts >= thresholds.triangles ||
      cost.drawCalls * refs.unsuppressedParts >= thresholds.drawCalls
    )
      emit(
        "expensive-geometry",
        "warning",
        "cost",
        "Stored mesh counts meet a cost threshold for this geometry or its potential assembled instances. This is a loading-cost observation, not an engineering defect.",
        asset.geometryKey,
      );
  }
  if (offset > counts.matchingFindings) return yield* invalid();
  counts.returnedFindings = findings.length;
  return {
    snapshotId: snapshot.snapshotId,
    rootId: snapshot.rootId,
    revision: state.revision,
    microversionId: snapshot.root.microversionId,
    filters: { minimumSeverity, thresholds },
    coverage: {
      scope: "stored-manifest",
      complete: true,
      nodesScanned: snapshot.nodes.length,
      sourcePartsScanned: snapshot.parts.length,
      assetDescriptorsScanned: snapshot.assets.length,
      assetIntegrity: { status: "not-checked", assetsChecked: 0 },
      workloadBasis: "all-unsuppressed-part-occurrences",
      visibilityApplied: false,
      limitations: [
        "This diagnostic scan reads no files or GLB bytes. Asset descriptors do not prove files exist or that their bytes and hashes match.",
        "Complexity comes from stored metadata. Geometry totals count each required source geometry key once; different keys can share identical asset bytes. Decoded bytes are not a process-memory measurement.",
        "Potential assembled workload counts all unsuppressed part occurrences, including hidden or isolated-away parts. It is not the current rendered workload.",
        "Known subtotals exclude unknown complexity. Null subtotals exceed the safe integer range. Potential counts are null when complexity is unknown or the multiplication exceeds that range.",
        "Occurrence links include at most the first 20 matching IDs per finding; occurrenceCount and occurrenceIdsTruncated describe that coverage.",
        "Normal completed snapshots validate required metadata and asset associations before activation. This scan cannot diagnose a snapshot that cannot be loaded.",
      ],
    },
    summary: {
      occurrences,
      sourceParts,
      assets: {
        descriptors: snapshot.assets.length,
        distinctHashes: new Set(snapshot.assets.map((asset) => asset.sha256)).size,
        invalidAssociations,
      },
      geometryComplexity,
      potentialAssembledWorkload: workload,
    },
    counts,
    findings,
    nextCursor:
      offset + findings.length < counts.matchingFindings
        ? `${prefix}${offset + findings.length}`
        : null,
  };
});
