import * as Schema from "effect/Schema";
import {
  CadHash,
  CadPartSource,
  CadSnapshotId,
  CadSnapshotNode,
  CadPartMetadata,
  CadTransform,
} from "./cad.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMaxLength(512));
const Point = Schema.Tuple([
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
]);
export const CadPartInfoInput = Schema.Struct({
  snapshotId: CadSnapshotId,
  expectedRevision: Count,
  occurrenceId: CadHash,
  repeatedOccurrenceLimit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
});
export type CadPartInfoInput = typeof CadPartInfoInput.Type;
export const CadPartInfoResult = Schema.Struct({
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  revision: Count,
  occurrence: Schema.Struct({
    occurrenceId: CadHash,
    parentOccurrenceId: Schema.NullOr(CadHash),
    name: CadSnapshotNode.fields.name,
    kind: CadSnapshotNode.fields.kind,
    instanceId: CadSnapshotNode.fields.instanceId,
    occurrencePath: CadSnapshotNode.fields.occurrencePath,
    suppressed: Schema.Boolean,
    visible: Schema.Boolean,
  }),
  assembledTransform: Schema.Struct({
    matrix: CadTransform,
    storage: Schema.Literal("row-major"),
    from: Schema.Literal("source-node"),
    to: Schema.Literal("assembled-world"),
    translationUnits: Schema.Literal("meters"),
    upAxis: Schema.Literal("Z"),
  }),
  source: Schema.NullOr(Schema.Struct({ sourcePartKey: CadHash, ...CadPartSource.fields })),
  metadata: Schema.NullOr(
    Schema.Struct({
      name: CadPartMetadata.fields.name,
      bodyType: CadPartMetadata.fields.bodyType,
      isMesh: Schema.Boolean,
      isHidden: Schema.Boolean,
      partIdentity: CadPartMetadata.fields.partIdentity,
      configurationId: CadPartMetadata.fields.configurationId,
      appearance: CadPartMetadata.fields.appearance,
    }),
  ),
  material: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.Literal("not-in-snapshot"),
    }),
    Schema.Struct({
      status: Schema.Literal("available"),
      displayName: Schema.NullOr(Text),
      id: Schema.NullOr(Text),
      libraryName: Schema.NullOr(Text),
      libraryReference: Schema.NullOr(
        Schema.Struct({
          documentId: Schema.NullOr(Text),
          elementId: Schema.NullOr(Text),
          elementMicroversionId: Schema.NullOr(Text),
          versionId: Schema.NullOr(Text),
        }),
      ),
      properties: Schema.Array(
        Schema.Struct({
          name: Schema.NullOr(Text),
          displayName: Schema.NullOr(Text),
          units: Schema.NullOr(Text),
          value: Schema.NullOr(Text),
          category: Schema.NullOr(Text),
          description: Schema.NullOr(Text),
          type: Schema.NullOr(Text),
        }),
      ).check(Schema.isMaxLength(16)),
      propertyCount: Count,
      truncated: Schema.Boolean,
    }),
  ]),
  repeatedOccurrences: Schema.Struct({
    match: Schema.Literal("source-part-key"),
    occurrenceIds: Schema.Array(CadHash).check(Schema.isMaxLength(50)),
    total: Count,
    truncated: Schema.Boolean,
  }),
  geometry: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.Literals([
        "not-part",
        "not-cached",
        "asset-unavailable",
        "invalid-geometry",
        "unsupported-geometry",
        "too-large",
        "empty-geometry",
      ]),
    }),
    Schema.Struct({
      status: Schema.Literal("available"),
      units: Schema.Literal("meters"),
      coordinateFrame: Schema.Literal("assembled-world"),
      upAxis: Schema.Literal("Z"),
      approximation: Schema.Literal("tessellated-mesh"),
      boundsKind: Schema.Literal("axis-aligned"),
      min: Point,
      max: Point,
      dimensions: Point,
      triangleCount: Count,
      assetSha256: CadHash,
      tessellationProfile: Schema.String,
    }),
  ]),
});
export type CadPartInfoResult = typeof CadPartInfoResult.Type;
