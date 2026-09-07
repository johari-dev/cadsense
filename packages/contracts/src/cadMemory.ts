import * as Schema from "effect/Schema";
import { MessageId, ThreadId } from "./baseSchemas.ts";
import { CadHash, CadSnapshotId } from "./cad.ts";

export const CAD_MEMORY_MAX_ENTRIES = 20;
export const CAD_MEMORY_MAX_BYTES = 12_000;
const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const Quote = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400));
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
);
export const CadMemoryTarget = Schema.Struct({
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  occurrenceId: CadHash,
});
export const CadMemoryEntry = Schema.Struct({
  key: Key,
  kind: Schema.Literals(["constraint", "decision", "name"]),
  quote: Quote,
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  target: Schema.NullOr(CadMemoryTarget),
  targetName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
});
export const CadProjectMemory = Schema.Struct({
  revision: Revision,
  entries: Schema.Array(CadMemoryEntry).check(Schema.isMaxLength(CAD_MEMORY_MAX_ENTRIES)),
});
export type CadProjectMemory = typeof CadProjectMemory.Type;
export const CadMemoryInput = Schema.Struct({
  expectedRevision: Revision,
  key: Key,
  // Every mutation cites a real user message, including requests to forget a fact.
  quote: Quote,
  change: Schema.Union([
    Schema.Struct({ type: Schema.Literal("forget") }),
    Schema.Struct({
      type: Schema.Literal("remember"),
      kind: CadMemoryEntry.fields.kind,
      target: Schema.NullOr(CadMemoryTarget),
    }),
  ]),
});
export const CadMemoryBrief = Schema.Struct({
  revision: Revision,
  entries: Schema.Array(
    Schema.Struct({
      ...CadMemoryEntry.fields,
      targetStatus: Schema.Literals(["none", "current", "stale"]),
    }),
  ),
});
