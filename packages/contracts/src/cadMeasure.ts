import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";

export const CadMeasurePoint = Schema.Tuple([
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
]);
export const CadMeasurePointInput = Schema.Union([
  Schema.Struct({ space: Schema.Literal("world"), point: CadMeasurePoint }),
  Schema.Struct({
    space: Schema.Literal("part"),
    occurrenceId: CadHash,
    point: CadMeasurePoint,
  }),
]);
export type CadMeasurePointInput = typeof CadMeasurePointInput.Type;
const request = {
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snapshotId: CadSnapshotId,
};
export const CadMeasureInput = Schema.Union([
  Schema.Struct({
    ...request,
    mode: Schema.Literal("point-distance"),
    from: CadMeasurePointInput,
    to: CadMeasurePointInput,
  }),
  Schema.Struct({
    ...request,
    mode: Schema.Literal("surface-clearance"),
    fromOccurrenceId: CadHash,
    toOccurrenceId: CadHash,
  }),
]);
export type CadMeasureInput = typeof CadMeasureInput.Type;
export const CadMeasureGeometryProvenance = Schema.Struct({
  occurrenceId: CadHash,
  geometryKey: Schema.NullOr(CadHash),
  assetSha256: Schema.NullOr(CadHash),
  tessellationProfile: Schema.NullOr(Schema.String),
});
const result = {
  snapshotId: CadSnapshotId,
  revision: Schema.Int,
  rootId: CadHash,
  microversionId: Schema.String,
  mode: Schema.Literals(["point-distance", "surface-clearance"]),
  units: Schema.Literal("meters"),
  coordinateConvention: Schema.Literal("assembled-world-z-up"),
  placement: Schema.Literal("original-assembled"),
  geometry: Schema.Array(CadMeasureGeometryProvenance),
  pointInputs: Schema.NullOr(Schema.Tuple([CadMeasurePointInput, CadMeasurePointInput])),
  accuracy: Schema.Struct({
    source: Schema.Literals(["caller-specified-points", "tessellated-triangle-surfaces"]),
    numericMethod: Schema.Literal("float64"),
    certifiedErrorBoundMeters: Schema.Null,
    limitations: Schema.Array(Schema.String),
  }),
};
export const CadMeasureResult = Schema.Union([
  Schema.Struct({
    ...result,
    status: Schema.Literal("measured"),
    distanceMeters: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    closestPoints: Schema.Tuple([CadMeasurePoint, CadMeasurePoint]),
  }),
  Schema.Struct({
    ...result,
    status: Schema.Literal("unknown"),
    distanceMeters: Schema.Null,
    closestPoints: Schema.Null,
    reason: Schema.Literals([
      "missing-occurrence",
      "missing-geometry",
      "invalid-geometry",
      "unsupported-geometry",
      "empty-geometry",
      "budget-exceeded",
      "numeric-failure",
    ]),
  }),
]);
export type CadMeasureResult = typeof CadMeasureResult.Type;
