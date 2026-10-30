import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CadFeatureScriptPreviewInput,
  CadFeatureScriptPreviewStep,
  CadFeatureScriptPreviewResult,
  FEATURESCRIPT_PREVIEW_STATUSES,
  FEATURESCRIPT_PREVIEW_VIEWS,
  FeatureScriptChanges,
  FeatureScriptFailure,
} from "./cadTools.ts";

const WorkspacePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const MAX_SOURCE_LENGTH = 1024 * 1024;

const Vector3 = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]);

/**
 * A point picked in the panel, made into a mate connector before the features run. Parameters find
 * it as `qCreatedBy(makeId("Picked") + "<id>", EntityType.BODY)`.
 */
export const FeatureScriptPickedConnector = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,40}$/)),
  /** Meters, Z up. */
  origin: Vector3,
  /** Its Z axis, out of the picked face. */
  zAxis: Vector3,
});
export type FeatureScriptPickedConnector = typeof FeatureScriptPickedConnector.Type;

/** Input id to FeatureScript expression. A list input is one expression. */
const Expressions = Schema.Record(
  Schema.String.check(Schema.isMaxLength(256)),
  Schema.String.check(Schema.isMaxLength(64 * 1024)),
);

/**
 * The feature dialog's state for its "Editing Logic Function", which Onshape keeps in the feature's
 * definition and the panel keeps between runs: each run returns it, and the next sends it back.
 */
export const FeatureScriptEditingState = Schema.Struct({
  /** The inputs the person set, as the run sent them. */
  parameters: Expressions,
  /** Inputs the editing logic set and the person hasn't changed since, as expressions. */
  edited: Expressions,
});
export type FeatureScriptEditingState = typeof FeatureScriptEditingState.Type;

/**
 * A dragged manipulator: its key, the `Manipulator` a run returned (its `expression`), and the new
 * values of the fields the drag moved, as expressions (`{ offset: "20 * millimeter" }`).
 */
export const FeatureScriptManipulatorChange = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(256)),
  manipulator: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  changes: Expressions,
});
export type FeatureScriptManipulatorChange = typeof FeatureScriptManipulatorChange.Type;

/** A manipulator the previewed feature added (`addManipulators`), for drawing and dragging it. */
export const FeatureScriptManipulator = Schema.Struct({
  key: Schema.String,
  /** Its `ManipulatorType` member: `LINEAR_1D`, `LINEAR_3D`, `ANGULAR`, `FLIP`, ... */
  type: Schema.String,
  /** The `Manipulator` as an expression, to send back with a change; null if it has none. */
  expression: Schema.NullOr(Schema.String),
  /** Its fields (`base`, `direction`, `offset`, `angle`, `flipped`, ...) in meters and radians. */
  fields: Schema.Record(Schema.String, Schema.Json),
});
export type FeatureScriptManipulator = typeof FeatureScriptManipulator.Type;

/**
 * The file panel's preview of a `.fs` file. The panel sends the editor's text, so a run never races
 * the save that follows a keystroke. Inputs, `before` (read from disk) and the STEP base work as in
 * `cad_featurescript_preview`.
 */
export const FeatureScriptPanelPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: WorkspacePath,
  source: Schema.String.check(Schema.isMaxLength(MAX_SOURCE_LENGTH)),
  feature: CadFeatureScriptPreviewInput.fields.feature,
  parameters: CadFeatureScriptPreviewInput.fields.parameters,
  before: CadFeatureScriptPreviewInput.fields.before,
  base: Schema.optionalKey(WorkspacePath),
  connectors: Schema.optionalKey(
    Schema.Array(FeatureScriptPickedConnector).check(Schema.isMaxLength(200)),
  ),
  /**
   * The state the last run returned; absent or null when the dialog opens. The feature runs as
   * Onshape's dialog runs it: its editing logic runs when an input changed since that run.
   */
  editing: Schema.optionalKey(Schema.NullOr(FeatureScriptEditingState)),
  /**
   * Inputs the person set since that run, even to the same text: setting one again after the
   * editing logic overrode it takes it back.
   */
  touched: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(500)),
  ),
  /**
   * A manipulator was dragged: the feature's "Manipulator Change Function" runs on the context
   * before it, then the feature runs with the inputs it set, which the result's `parameters` holds.
   */
  manipulatorChange: Schema.optionalKey(FeatureScriptManipulatorChange),
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

const dialogInputFields = {
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(FEATURESCRIPT_INPUT_KINDS),
  /** The value the feature ran with, as a person would type it: `5.5 mm`, `30 deg`, `true`. */
  value: Schema.String,
  /** Enum members as FeatureScript expressions, such as `BoundingType.BLIND`. */
  options: Schema.Array(Schema.String),
  /** False when an `if` around the input is false, so Onshape's dialog would hide it. */
  visible: Schema.Boolean,
  /**
   * The feature's status blames this input (`regenError(message, ["waypoints"])`, a warning's
   * associated parameters), so Onshape outlines it.
   */
  faulty: Schema.Boolean,
  group: Schema.NullOr(Schema.String),
  /** Source of a query's "Filter" annotation, e.g. `EntityType.FACE && GeometryType.PLANE`. */
  filter: Schema.NullOr(Schema.String),
  maxPicks: Schema.NullOr(Schema.Int),
};
/** An input inside a list item. Lists don't nest. */
export const FeatureScriptDialogItemInput = Schema.Struct(dialogInputFields);
export type FeatureScriptDialogItemInput = typeof FeatureScriptDialogItemInput.Type;

/** One row of the feature dialog, read from the feature's precondition. */
export const FeatureScriptDialogInput = Schema.Struct({
  ...dialogInputFields,
  /** A list's "Item name", such as `Waypoint`. */
  itemName: Schema.NullOr(Schema.String),
  /** A list's items as they ran: each item's inputs with its values. */
  items: Schema.Array(Schema.Array(FeatureScriptDialogItemInput)),
});
export type FeatureScriptDialogInput = typeof FeatureScriptDialogInput.Type;

/**
 * What a feature that worked but reported INFO or WARNING says (`reportFeatureInfo`,
 * `reportFeatureWarning`): its custom message, or else its `ErrorStringEnum` member.
 */
export const FeatureScriptNotice = Schema.Struct({
  status: Schema.Literals(["INFO", "WARNING"]),
  message: Schema.String,
});
export type FeatureScriptNotice = typeof FeatureScriptNotice.Type;

export const FeatureScriptPanelPreview = Schema.Struct({
  status: Schema.Literals(FEATURESCRIPT_PREVIEW_STATUSES),
  failure: Schema.NullOr(FeatureScriptFailure),
  /**
   * The previewed feature's INFO or WARNING message, or else the first earlier feature's (named
   * by its type). Null when no feature reported one. A failure outranks it.
   */
  notice: Schema.NullOr(FeatureScriptNotice),
  /**
   * The previewed feature's own status, which its dialog's rows take (`status` is the worst of
   * every step); null when it didn't run.
   */
  featureStatus: Schema.NullOr(Schema.Literals(["OK", "INFO", "WARNING", "ERROR"])),
  /** Every feature the file defines; empty when it didn't load. */
  features: Schema.Array(Schema.Struct({ name: Schema.String, typeName: Schema.String })),
  /** The previewed feature's constant, and its dialog. */
  feature: Schema.NullOr(Schema.String),
  inputs: Schema.Array(FeatureScriptDialogInput),
  changes: Schema.NullOr(FeatureScriptChanges),
  solids: CadFeatureScriptPreviewResult.fields.solids,
  elapsedMs: Schema.Number,
  /**
   * Entities the previewed feature marked as errors (`setErrorEntities`, a `regenError`'s
   * entities) that the after model draws in its third material: faces, edges, vertices, and
   * bodies (a wire by its edges). A failed feature's rollback keeps them; one with nothing to draw
   * isn't counted.
   */
  errorEntities: Schema.Int,
  /** The state to send with the next run, or null when the feature has no editing logic. */
  editing: Schema.NullOr(FeatureScriptEditingState),
  /** Manipulators the previewed feature added. */
  manipulators: Schema.Array(FeatureScriptManipulator),
  /**
   * After a manipulator change, the inputs as its change function set them, for the panel to keep
   * as the person's. Null otherwise, and when the change function failed.
   */
  parameters: Schema.NullOr(Expressions),
  /**
   * GLB attachments (meters, Z up) of the model after the feature, with its faces in the second
   * material and its error entities in the third, and before it. Either is null when it has no bodies; the whole is null when neither
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
  /** Features the agent ran first, so opening the file in the panel runs the same thing. */
  before: Schema.Array(CadFeatureScriptPreviewStep).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
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
