import * as Schema from "effect/Schema";
import { CadHash, CadPartSource, CadSnapshotId, CadSnapshotNode } from "./cad.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMaxLength(256));
export const CadFindPartsInput = Schema.Struct({
  snapshotId: CadSnapshotId,
  expectedRevision: Count,
  nameQuery: Schema.optionalKey(Text),
  sourcePartKey: Schema.optionalKey(CadHash),
  materialName: Schema.optionalKey(Text),
  bodyType: Schema.optionalKey(Text),
  kind: Schema.optionalKey(
    Schema.Literals(["all", "part", "assembly", "part-studio", "unsupported"]),
  ),
  visibility: Schema.optionalKey(Schema.Literals(["all", "visible", "hidden"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
});
export type CadFindPartsInput = typeof CadFindPartsInput.Type;
export const CadFindPartsEntry = Schema.Struct({
  occurrenceId: CadHash,
  parentOccurrenceId: Schema.NullOr(CadHash),
  name: Text,
  kind: CadSnapshotNode.fields.kind,
  instanceId: Schema.NullOr(Text),
  visible: Schema.Boolean,
  suppressed: Schema.Boolean,
  sourcePartKey: Schema.NullOr(CadHash),
  source: Schema.NullOr(
    Schema.Struct({
      documentId: CadPartSource.fields.documentId,
      documentMicroversion: CadPartSource.fields.documentMicroversion,
      elementId: CadPartSource.fields.elementId,
      partId: Text,
      configuration: Text,
    }),
  ),
  metadataAvailable: Schema.Boolean,
  bodyType: Schema.NullOr(Text),
  material: Schema.Struct({
    status: Schema.Literals(["available", "unavailable"]),
    name: Schema.NullOr(Text),
  }),
  assemblyPath: Schema.Array(Schema.Struct({ occurrenceId: CadHash, name: Text })).check(
    Schema.isMaxLength(16),
  ),
  omittedAncestorCount: Count,
  textTruncated: Schema.Boolean,
});
export type CadFindPartsEntry = typeof CadFindPartsEntry.Type;
export const CadFindPartsResult = Schema.Struct({
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  revision: Count,
  entries: Schema.Array(CadFindPartsEntry).check(Schema.isMaxLength(50)),
  totalMatches: Count,
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(160))),
});
export type CadFindPartsResult = typeof CadFindPartsResult.Type;
