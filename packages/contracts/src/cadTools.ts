import { CadFindPartsInput } from "./cadFindParts.ts";
import {
  CadCommentsListInput,
  CadCommentLocateInput,
  CadCommentInspectInput,
  CadCommentsPublishToolInput,
} from "./cadComments.ts";
import * as Schema from "effect/Schema";
import { CadMeasureInput } from "./cadMeasure.ts";
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
  // Parts only, when Onshape supplied them. Mass is per occurrence, not rolled up.
  material: Schema.optionalKey(Schema.String),
  massKg: Schema.optionalKey(Schema.Number),
});
export const CadHierarchyResult = Schema.Struct({
  revision: Schema.Int,
  snapshotId: CadSnapshotId,
  entries: Schema.Array(CadHierarchyEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CadHierarchyResult = typeof CadHierarchyResult.Type;
export const CAD_CHECK_NAMES = [
  "mesh-interference",
  "overlapping-bounds",
  "coincident-instances",
  "degenerate-geometry",
] as const;
export const CadCheckName = Schema.Literals(CAD_CHECK_NAMES);
export type CadCheckName = typeof CadCheckName.Type;
export const CadChecksInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checks: Schema.optionalKey(Schema.Array(CadCheckName).check(Schema.isMinLength(1))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CadChecksInput = typeof CadChecksInput.Type;
const CadCheckOccurrence = Schema.Struct({ occurrenceId: CadHash, name: Schema.String });
const Meters3 = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);
/** Deterministic leads for the agent to verify visually. Every number is in meters. */
export const CadCheckFinding = Schema.Union([
  Schema.Struct({
    check: Schema.Literal("mesh-interference"),
    occurrences: Schema.Array(CadCheckOccurrence),
    // Cubic meters of solid shared by both parts, from exact mesh booleans.
    intersectionVolume: Schema.Number,
    // Intersection volume divided by the smaller solid's volume.
    intersectionFraction: Schema.Number,
    // Both parts sit in one subassembly below the root, such as a vendor kit's own screw and nut.
    withinSubassembly: Schema.Boolean,
  }),
  Schema.Struct({
    check: Schema.Literal("overlapping-bounds"),
    occurrences: Schema.Array(CadCheckOccurrence),
    overlapSize: Meters3,
    overlapVolume: Schema.Number,
    // Overlap volume divided by the smaller box volume; 1 means one box lies inside the other.
    overlapFraction: Schema.Number,
    contained: Schema.Boolean,
  }),
  Schema.Struct({
    check: Schema.Literal("coincident-instances"),
    occurrences: Schema.Array(CadCheckOccurrence),
    maxDeviation: Schema.Number,
  }),
  Schema.Struct({
    check: Schema.Literal("degenerate-geometry"),
    occurrences: Schema.Array(CadCheckOccurrence),
    size: Schema.NullOr(Meters3),
  }),
]);
export type CadCheckFinding = typeof CadCheckFinding.Type;
export const CadChecksResult = Schema.Struct({
  revision: Schema.Int,
  snapshotId: CadSnapshotId,
  checks: Schema.Array(CadCheckName),
  // What each selected check does and does not prove, stated once per page rather than per finding.
  explanations: Schema.Record(Schema.String, Schema.String),
  findings: Schema.Array(CadCheckFinding),
  nextCursor: Schema.NullOr(Schema.String),
  summary: Schema.Struct({
    totalFindings: Schema.Int,
    partOccurrences: Schema.Int,
    boundsUnknown: Schema.Int,
    // Parts whose mesh is not a closed solid, so mesh-interference cannot clear or report them.
    meshUnknown: Schema.Int,
    pairsEvaluated: Schema.Int,
    pairBudget: Schema.Int,
    budgetExhausted: Schema.Boolean,
  }),
});
export type CadChecksResult = typeof CadChecksResult.Type;
export const CadContextResult = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.NullOr(CadViewState),
  /** The workspace design brief as it is on disk now, or null when the project has none. */
  designBrief: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
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

const WorkspaceFile = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
/** One feature to run: a workspace `.fs` file, which feature in it, and inputs as FeatureScript expressions. */
export const CadFeatureScriptPreviewStep = Schema.Struct({
  path: WorkspaceFile,
  feature: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  parameters: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMaxLength(4096)),
    ),
  ),
});
export const FEATURESCRIPT_PREVIEW_VIEWS = ["iso", "top", "front", "right"] as const;
/** Runs `before` features, then this one, locally on top of an optional workspace STEP `base`. */
export const CadFeatureScriptPreviewInput = Schema.Struct({
  ...CadFeatureScriptPreviewStep.fields,
  before: Schema.optionalKey(
    Schema.Array(CadFeatureScriptPreviewStep).check(Schema.isMaxLength(16)),
  ),
  base: Schema.optionalKey(WorkspaceFile),
  view: Schema.optionalKey(Schema.Literals(FEATURESCRIPT_PREVIEW_VIEWS)),
});
export type CadFeatureScriptPreviewInput = typeof CadFeatureScriptPreviewInput.Type;
export const CadFeatureScriptPreviewResult = Schema.Struct({
  /**
   * The worst feature status. INVALID: the script didn't load (syntax errors, a missing feature, a
   * bad parameter or base file). STOPPED: the preview timed out or its worker crashed.
   */
  status: Schema.Literals(["OK", "INFO", "WARNING", "ERROR", "INVALID", "STOPPED"]),
  /** Inputs, outcome and cause per feature, and the resulting solids, as plain text. */
  summary: Schema.String,
  features: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      feature: Schema.String,
      typeName: Schema.String,
      status: Schema.Literals(["OK", "INFO", "WARNING", "ERROR", "NOT_RUN"]),
      message: Schema.NullOr(Schema.String),
      cause: Schema.NullOr(Schema.String),
    }),
  ),
  solids: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      createdBy: Schema.String,
      volumeMm3: Schema.Number,
      faces: Schema.Int,
      edges: Schema.Int,
      vertices: Schema.Int,
    }),
  ),
  /** PNGs of every view, result.glb and report.json, when the features ran. */
  artifacts: Schema.NullOr(
    Schema.Struct({
      directory: Schema.String,
      image: Schema.String,
      view: Schema.Literals(FEATURESCRIPT_PREVIEW_VIEWS),
    }),
  ),
});
export type CadFeatureScriptPreviewResult = typeof CadFeatureScriptPreviewResult.Type;

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
  cad_checks: CadChecksInput,
  cad_diff: CadDiffInput,
  cad_measure: CadMeasureInput,
  cad_find_parts: CadFindPartsInput,
  cad_update_view: CadUpdateViewInput,
  cad_capture: CadCaptureInput,
  cad_featurescript_preview: CadFeatureScriptPreviewInput,
} as const;
