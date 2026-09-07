import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CadHash, CadRootKind, CadSnapshotId } from "./cad.ts";
import { OnshapeElementId, OnshapeWorkspaceId } from "./onshape.ts";

export const CadOperationId = CadSnapshotId;
export const CadOperationKind = Schema.Literals(["discover", "sync", "cleanup"]);
export const CadRootIdentity = Schema.Struct({
  rootId: CadHash,
  elementId: OnshapeElementId,
  kind: CadRootKind,
  configuration: Schema.String.check(Schema.isMaxLength(4096)),
});
export type CadRootIdentity = typeof CadRootIdentity.Type;
export const CadCatalog = Schema.Struct({
  refreshedAt: IsoDateTime,
  microversionId: OnshapeWorkspaceId,
  roots: Schema.Array(
    Schema.Struct({
      elementId: OnshapeElementId,
      name: Schema.String.check(Schema.isMaxLength(4096)),
      kind: CadRootKind,
    }),
  ).check(Schema.isMaxLength(10_000)),
  sourceElement: Schema.NullOr(
    Schema.Struct({
      elementId: OnshapeElementId,
      status: Schema.Literals(["available", "missing", "unsupported"]),
    }),
  ),
});
export type CadCatalog = typeof CadCatalog.Type;
export const CadSnapshotMetadata = Schema.Struct({
  snapshotId: CadSnapshotId,
  microversionId: OnshapeWorkspaceId,
  createdAt: IsoDateTime,
  manifestBytes: NonNegativeInt,
  assetBytes: NonNegativeInt,
});
export type CadSnapshotMetadata = typeof CadSnapshotMetadata.Type;
export const CadOperationOutcome = Schema.Struct({
  operationId: CadOperationId,
  kind: CadOperationKind,
  status: Schema.Literals(["succeeded", "failed", "cancelled", "interrupted"]),
  completedAt: IsoDateTime,
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export const CadRootLineage = Schema.Struct({
  ...CadRootIdentity.fields,
  current: Schema.NullOr(CadSnapshotMetadata),
  rollback: Schema.NullOr(CadSnapshotMetadata),
  lastOutcome: Schema.NullOr(CadOperationOutcome),
});
export const CadOperation = Schema.Struct({
  operationId: CadOperationId,
  kind: CadOperationKind,
  root: Schema.NullOr(CadRootIdentity),
  startedAt: IsoDateTime,
});
export const CadProjectState = Schema.Struct({
  enabled: Schema.Boolean,
  catalog: Schema.NullOr(CadCatalog),
  roots: Schema.Array(CadRootLineage).check(Schema.isMaxLength(10_000)),
  operation: Schema.NullOr(CadOperation),
  lastOutcome: Schema.NullOr(CadOperationOutcome),
});
export type CadProjectState = typeof CadProjectState.Type;
export const initialCadProjectState = (): CadProjectState => ({
  enabled: true,
  catalog: null,
  roots: [],
  operation: null,
  lastOutcome: null,
});
export const CadOperationResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("discover"), catalog: CadCatalog }),
  Schema.Struct({ kind: Schema.Literal("sync"), snapshot: CadSnapshotMetadata }),
  Schema.Struct({ kind: Schema.Literal("cleanup") }),
]);
