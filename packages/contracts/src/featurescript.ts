import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CadFeatureScriptPreviewInput,
  CadFeatureScriptPreviewResult,
  FEATURESCRIPT_PREVIEW_STATUSES,
  FEATURESCRIPT_PREVIEW_VIEWS,
  FeatureScriptChanges,
  FeatureScriptFailure,
} from "./cadTools.ts";

const WorkspacePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const MAX_SOURCE_LENGTH = 1024 * 1024;

/**
 * The file panel's preview of a `.fs` file. The panel sends the editor's text, so a run never races
 * the save that follows a keystroke. Inputs and the STEP base work as in `cad_featurescript_preview`.
 */
export const FeatureScriptPanelPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: WorkspacePath,
  source: Schema.String.check(Schema.isMaxLength(MAX_SOURCE_LENGTH)),
  feature: CadFeatureScriptPreviewInput.fields.feature,
  parameters: CadFeatureScriptPreviewInput.fields.parameters,
  base: Schema.optionalKey(WorkspacePath),
});
export type FeatureScriptPanelPreviewInput = typeof FeatureScriptPanelPreviewInput.Type;

export const FEATURESCRIPT_INPUT_KINDS = [
  "length",
  "angle",
  "integer",
  "real",
  "anything",
  "boolean",
  "string",
  "query",
  "enum",
  "array",
  "other",
] as const;
export type FeatureScriptInputKind = (typeof FEATURESCRIPT_INPUT_KINDS)[number];

/** One row of the feature dialog, read from the feature's precondition. */
export const FeatureScriptDialogInput = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(FEATURESCRIPT_INPUT_KINDS),
  /** The value the feature ran with, as a person would type it: `5.5 mm`, `30 deg`, `true`. */
  value: Schema.String,
  /** Enum members as FeatureScript expressions, such as `BoundingType.BLIND`. */
  options: Schema.Array(Schema.String),
  /** False when an `if` around the input is false, so Onshape's dialog would hide it. */
  visible: Schema.Boolean,
  group: Schema.NullOr(Schema.String),
  /** Source of a query's "Filter" annotation, e.g. `EntityType.FACE && GeometryType.PLANE`. */
  filter: Schema.NullOr(Schema.String),
  maxPicks: Schema.NullOr(Schema.Int),
});
export type FeatureScriptDialogInput = typeof FeatureScriptDialogInput.Type;

export const FeatureScriptPanelPreview = Schema.Struct({
  status: Schema.Literals(FEATURESCRIPT_PREVIEW_STATUSES),
  failure: Schema.NullOr(FeatureScriptFailure),
  /** Every feature the file defines; empty when it didn't load. */
  features: Schema.Array(Schema.Struct({ name: Schema.String, typeName: Schema.String })),
  /** The previewed feature's constant, and its dialog. */
  feature: Schema.NullOr(Schema.String),
  inputs: Schema.Array(FeatureScriptDialogInput),
  changes: Schema.NullOr(FeatureScriptChanges),
  solids: CadFeatureScriptPreviewResult.fields.solids,
  elapsedMs: Schema.Number,
  /**
   * GLB attachments (meters, Z up) of the model after the feature, with its faces in the second
   * material, and before it. Either is null when it has no bodies; the whole is null when neither
   * has any or nothing ran.
   */
  model: Schema.NullOr(
    Schema.Struct({ after: Schema.NullOr(Schema.String), before: Schema.NullOr(Schema.String) }),
  ),
});
export type FeatureScriptPanelPreview = typeof FeatureScriptPanelPreview.Type;

/** Chat record of one `cad_featurescript_preview` call. Images are attachment ids. */
export const CadFeatureScriptPreviewCard = Schema.Struct({
  status: Schema.Literals(FEATURESCRIPT_PREVIEW_STATUSES),
  path: Schema.String,
  /** The previewed feature's `defineFeature` constant and "Feature Type Name", when it loaded. */
  feature: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  typeName: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(FeatureScriptFailure),
  changes: Schema.NullOr(FeatureScriptChanges),
  /** The inputs the agent set, as FeatureScript expressions. */
  parameters: Schema.Record(Schema.String, Schema.String),
  base: Schema.NullOr(Schema.String),
  images: Schema.Array(
    Schema.Struct({
      view: Schema.Literals(FEATURESCRIPT_PREVIEW_VIEWS),
      attachmentId: Schema.String,
    }),
  ),
});
export type CadFeatureScriptPreviewCard = typeof CadFeatureScriptPreviewCard.Type;
export const CAD_FEATURESCRIPT_PREVIEWED_ACTIVITY = "cad.featurescript.previewed";
