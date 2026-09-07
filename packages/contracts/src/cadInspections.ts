import * as Schema from "effect/Schema";
import { ThreadId, TurnId } from "./baseSchemas.ts";
import { CadHash, CadSnapshotId } from "./cad.ts";
import { CadCameraPose } from "./cadView.ts";

export const CAD_INSPECTION_MAX_ENTRIES = 24;
export const CAD_INSPECTION_MAX_BYTES = 24_000;
export const CAD_INSPECTION_MAX_NEW_PER_TURN = 3;
const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
);
const Subjects = Schema.Array(CadHash).check(Schema.isMinLength(1), Schema.isMaxLength(8));
const Finding = {
  key: Key,
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  finding: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(800)),
  kind: Schema.Literals(["observation", "hypothesis"]),
  occurrenceIds: Subjects,
  captureId: CadSnapshotId,
};
export const CadInspectionEntry = Schema.Struct({
  ...Finding,
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  sourceThreadId: ThreadId,
  savedTurnId: TurnId,
  imagePath: Schema.String,
  cameraPose: CadCameraPose,
});
export type CadInspectionEntry = typeof CadInspectionEntry.Type;
export const CadInspectionMemory = Schema.Struct({
  revision: Revision,
  entries: Schema.Array(CadInspectionEntry).check(Schema.isMaxLength(CAD_INSPECTION_MAX_ENTRIES)),
});
export type CadInspectionMemory = typeof CadInspectionMemory.Type;
export const CadInspectionQuery = Schema.Struct({
  key: Schema.optionalKey(Key),
  query: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))),
  occurrenceIds: Schema.optionalKey(Subjects),
});
export type CadInspectionQuery = typeof CadInspectionQuery.Type;
export const CadInspectionInput = Schema.Struct({
  operation: Schema.Union([
    Schema.Struct({ type: Schema.Literal("recall"), ...CadInspectionQuery.fields }),
    Schema.Struct({ type: Schema.Literal("remember"), expectedRevision: Revision, ...Finding }),
    Schema.Struct({ type: Schema.Literal("forget"), expectedRevision: Revision, key: Key }),
  ]),
});
export const CadInspectionRecall = Schema.Struct({
  revision: Revision,
  totalMatches: Schema.Int,
  entries: Schema.Array(CadInspectionEntry),
});
export type CadInspectionRecall = typeof CadInspectionRecall.Type;
export const CadInspectionIndex = Schema.Struct({
  revision: Revision,
  entries: Schema.Array(
    Schema.Struct({
      key: Key,
      question: Finding.question,
      kind: Finding.kind,
      rootId: CadHash,
      snapshotId: CadSnapshotId,
    }),
  ),
});
