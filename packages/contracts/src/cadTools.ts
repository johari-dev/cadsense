import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";
import { CadCameraPose, CadUpdateViewInput, CadViewState } from "./cadView.ts";
import { IsoDateTime } from "./baseSchemas.ts";

export const CadHierarchyInput = Schema.Struct({
  parentOccurrenceId: Schema.optionalKey(CadHash),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type CadHierarchyInput = typeof CadHierarchyInput.Type;
export const CadHierarchyEntry = Schema.Struct({
  occurrenceId: CadHash,
  parentOccurrenceId: Schema.NullOr(CadHash),
  name: Schema.String,
  kind: Schema.Literals(["assembly", "part-studio", "part", "unsupported"]),
  hasChildren: Schema.Boolean,
  visible: Schema.Boolean,
  suppressed: Schema.Boolean,
});
export const CadHierarchyResult = Schema.Struct({
  revision: Schema.Int,
  snapshotId: CadSnapshotId,
  entries: Schema.Array(CadHierarchyEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CadHierarchyResult = typeof CadHierarchyResult.Type;
export const CadContextResult = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.NullOr(CadViewState),
  roots: Schema.Array(
    Schema.Struct({
      rootId: CadHash,
      name: Schema.String,
      kind: Schema.Literals(["assembly", "part-studio"]),
    }),
  ),
});
export const CadCaptureInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const CadCaptureResult = Schema.Struct({
  captureId: Schema.String,
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  revision: Schema.Int,
  artifact: Schema.Struct({
    path: Schema.String,
    mimeType: Schema.Literal("image/png"),
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
    createdAt: IsoDateTime,
  }),
  summary: Schema.String,
});

/** Live tool feedback includes the rendered pose; historical capture records keep their own pose. */
export const CadCaptureToolResult = Schema.Struct({
  ...CadCaptureResult.fields,
  cameraPose: CadCameraPose,
});

/** Provider adapters share this closed set. Remote CAD operations are deliberately absent. */
export const CAD_TOOL_INPUTS = {
  cad_context: Schema.Struct({}),
  cad_hierarchy: CadHierarchyInput,
  cad_update_view: CadUpdateViewInput,
  cad_capture: CadCaptureInput,
} as const;
