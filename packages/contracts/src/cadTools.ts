import {
  CadCommentsListInput,
  CadCommentLocateInput,
  CadCommentInspectInput,
  CadCommentsPublishToolInput,
} from "./cadComments.ts";
import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId, CadSnapshotNode } from "./cad.ts";
import { CadCameraPose, CadUpdateViewInput, CadViewState } from "./cadView.ts";
import { IsoDateTime } from "./baseSchemas.ts";
import { OnshapeWorkspaceId } from "./onshape.ts";

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

/** Both snapshot IDs default: target to the selected root's current snapshot, base to the newest earlier retained one. */
export const CadDiffInput = Schema.Struct({
  baseSnapshotId: Schema.optionalKey(CadSnapshotId),
  targetSnapshotId: Schema.optionalKey(CadSnapshotId),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type CadDiffInput = typeof CadDiffInput.Type;
export const CadDiffChange = Schema.Literals([
  "moved",
  "geometry-changed",
  "renamed",
  "suppression-changed",
  "visibility-changed",
]);
export type CadDiffChange = typeof CadDiffChange.Type;
/** One occurrence path matched across both snapshots. Added and removed entries carry no changes. */
export const CadDiffEntry = Schema.Struct({
  status: Schema.Literals(["added", "removed", "modified"]),
  occurrencePath: CadSnapshotNode.fields.occurrencePath,
  name: Schema.String,
  previousName: Schema.NullOr(Schema.String),
  kind: CadSnapshotNode.fields.kind,
  baseOccurrenceId: Schema.NullOr(CadHash),
  targetOccurrenceId: Schema.NullOr(CadHash),
  changes: Schema.Array(CadDiffChange),
});
export type CadDiffEntry = typeof CadDiffEntry.Type;
export const CadDiffCounts = Schema.Struct({
  added: Schema.Int,
  removed: Schema.Int,
  modified: Schema.Int,
  moved: Schema.Int,
  geometryChanged: Schema.Int,
  renamed: Schema.Int,
  suppressionChanged: Schema.Int,
  visibilityChanged: Schema.Int,
  unchanged: Schema.Int,
});
export type CadDiffCounts = typeof CadDiffCounts.Type;
export const CadDiffSnapshot = Schema.Struct({
  snapshotId: CadSnapshotId,
  createdAt: IsoDateTime,
  microversionId: OnshapeWorkspaceId,
});
export type CadDiffSnapshot = typeof CadDiffSnapshot.Type;
/** Retention keeps the root's current and rollback snapshots and any this chat's comments inspected. */
export const CadRetainedSnapshot = Schema.Struct({
  ...CadDiffSnapshot.fields,
  retainedBy: Schema.Array(Schema.Literals(["current", "rollback", "comments"])),
  commentNumbers: Schema.Array(Schema.Int),
});
export type CadRetainedSnapshot = typeof CadRetainedSnapshot.Type;
export const CadDiffResult = Schema.Struct({
  rootId: CadHash,
  base: CadDiffSnapshot,
  target: CadDiffSnapshot,
  baseSelection: Schema.String,
  counts: CadDiffCounts,
  entries: Schema.Array(CadDiffEntry),
  nextCursor: Schema.NullOr(Schema.String),
  retainedSnapshots: Schema.Array(CadRetainedSnapshot),
});
export type CadDiffResult = typeof CadDiffResult.Type;

/** Live tool feedback includes the rendered pose; historical capture records keep their own pose. */
export const CadCaptureToolResult = Schema.Struct({
  ...CadCaptureResult.fields,
  cameraPose: CadCameraPose,
});

/** Provider adapters share this closed set. Remote CAD operations are deliberately absent. */
export const CAD_TOOL_INPUTS = {
  cad_comments_list: CadCommentsListInput,
  cad_comment_locate: CadCommentLocateInput,
  cad_comment_inspect: CadCommentInspectInput,
  cad_comments_publish: CadCommentsPublishToolInput,
  cad_context: Schema.Struct({}),
  cad_hierarchy: CadHierarchyInput,
  cad_diff: CadDiffInput,
  cad_update_view: CadUpdateViewInput,
  cad_capture: CadCaptureInput,
} as const;
