import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const CadDiagnosticSeverity = Schema.Literals(["info", "warning", "error"]);
export const CadDiagnosticThresholds = Schema.Struct({
  triangles: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000_000 })),
  decodedBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 ** 4 })),
  drawCalls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
});
export const CadModelDiagnosticsInput = Schema.Struct({
  expectedRevision: Count,
  snapshotId: CadSnapshotId,
  minimumSeverity: Schema.optionalKey(CadDiagnosticSeverity),
  thresholds: Schema.optionalKey(
    Schema.Struct({
      triangles: Schema.optionalKey(CadDiagnosticThresholds.fields.triangles),
      decodedBytes: Schema.optionalKey(CadDiagnosticThresholds.fields.decodedBytes),
      drawCalls: Schema.optionalKey(CadDiagnosticThresholds.fields.drawCalls),
    }),
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CadModelDiagnosticsInput = typeof CadModelDiagnosticsInput.Type;
export const CadDiagnosticComplexity = Schema.Struct({
  triangles: Count,
  decodedBytes: Count,
  drawCalls: Count,
  nodeCount: Count,
});
export const CadModelDiagnostic = Schema.Struct({
  code: Schema.Literals([
    "unsupported-component",
    "suppressed-component",
    "missing-part-reference",
    "inconsistent-geometry-requirement",
    "expected-unloaded-geometry",
    "missing-required-geometry",
    "metadata-unavailable",
    "invalid-asset-association",
    "complexity-unavailable",
    "expensive-geometry",
  ]),
  severity: CadDiagnosticSeverity,
  classification: Schema.Literals(["expected-state", "coverage-gap", "manifest-defect", "cost"]),
  message: Schema.String,
  geometryKey: Schema.NullOr(CadHash),
  sourcePartId: Schema.NullOr(Schema.String),
  sourceMicroversionId: Schema.NullOr(Schema.String),
  occurrenceIds: Schema.Array(CadHash).check(Schema.isMaxLength(20)),
  occurrenceCount: Count,
  occurrenceIdsTruncated: Schema.Boolean,
  evidence: Schema.Struct({
    source: Schema.Literal("stored-manifest"),
    nodeKind: Schema.NullOr(Schema.Literals(["assembly", "part-studio", "part", "unsupported"])),
    suppressed: Schema.NullOr(Schema.Boolean),
    geometryRequired: Schema.NullOr(Schema.Boolean),
    assetDescriptorPresent: Schema.Boolean,
    metadataPresent: Schema.NullOr(Schema.Boolean),
    complexityState: Schema.Literals(["present", "missing", "invalid", "no-asset-descriptor"]),
    storedComplexity: Schema.NullOr(CadDiagnosticComplexity),
    unsuppressedPartOccurrences: Count,
    potentialTriangles: Schema.NullOr(Count),
    potentialDrawCalls: Schema.NullOr(Count),
    thresholdsExceeded: Schema.Array(
      Schema.Literals([
        "geometry-triangles",
        "geometry-decoded-bytes",
        "geometry-draw-calls",
        "potential-triangles",
        "potential-draw-calls",
      ]),
    ),
  }),
});
export type CadModelDiagnostic = typeof CadModelDiagnostic.Type;
export const CadModelDiagnosticsResult = Schema.Struct({
  snapshotId: CadSnapshotId,
  rootId: CadHash,
  revision: Count,
  microversionId: Schema.String,
  filters: Schema.Struct({
    minimumSeverity: CadDiagnosticSeverity,
    thresholds: CadDiagnosticThresholds,
  }),
  coverage: Schema.Struct({
    scope: Schema.Literal("stored-manifest"),
    complete: Schema.Literal(true),
    nodesScanned: Count,
    sourcePartsScanned: Count,
    assetDescriptorsScanned: Count,
    assetIntegrity: Schema.Struct({
      status: Schema.Literal("not-checked"),
      assetsChecked: Schema.Literal(0),
    }),
    workloadBasis: Schema.Literal("all-unsuppressed-part-occurrences"),
    visibilityApplied: Schema.Literal(false),
    limitations: Schema.Array(Schema.String),
  }),
  summary: Schema.Struct({
    occurrences: Schema.Struct({
      total: Count,
      parts: Count,
      suppressed: Count,
      unsupported: Count,
      unsuppressedParts: Count,
    }),
    sourceParts: Schema.Struct({
      total: Count,
      geometryRequired: Count,
      expectedUnloaded: Count,
      missingMetadata: Count,
      missingRequiredAssets: Count,
    }),
    assets: Schema.Struct({
      descriptors: Count,
      distinctHashes: Count,
      invalidAssociations: Count,
    }),
    geometryComplexity: Schema.Struct({
      basis: Schema.Literal("required-source-geometry-key"),
      knownGeometryCount: Count,
      unknownGeometryCount: Count,
      trianglesKnownSubtotal: Schema.NullOr(Count),
      decodedBytesKnownSubtotal: Schema.NullOr(Count),
      drawCallsKnownSubtotal: Schema.NullOr(Count),
      complete: Schema.Boolean,
    }),
    potentialAssembledWorkload: Schema.Struct({
      knownOccurrenceCount: Count,
      unknownOccurrenceCount: Count,
      trianglesKnownSubtotal: Schema.NullOr(Count),
      drawCallsKnownSubtotal: Schema.NullOr(Count),
      complete: Schema.Boolean,
    }),
  }),
  counts: Schema.Struct({
    allFindings: Count,
    matchingFindings: Count,
    returnedFindings: Count,
    offset: Count,
    bySeverity: Schema.Struct({ info: Count, warning: Count, error: Count }),
  }),
  findings: Schema.Array(CadModelDiagnostic).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CadModelDiagnosticsResult = typeof CadModelDiagnosticsResult.Type;
