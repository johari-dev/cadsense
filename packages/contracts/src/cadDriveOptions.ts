import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";

/** Stock drive families cad_drive_options searches. Belts and chains name their pitch. */
export const CAD_DRIVE_FAMILIES = [
  "gear-20dp",
  "gear-32dp",
  "htd-5mm",
  "gt2-3mm",
  "rt25",
  "chain-25",
  "chain-35",
] as const;
export const CadDriveFamily = Schema.Literals(CAD_DRIVE_FAMILIES);
export type CadDriveFamily = typeof CadDriveFamily.Type;

/** FRC motors with known free speeds, named as ReCalc names them. */
export const CAD_DRIVE_MOTORS = [
  "Kraken X60",
  "Kraken X60 (FOC)",
  "Kraken X44",
  "Kraken X44 (FOC)",
  "NEO Vortex",
  "NEO 2.0",
  "NEO",
  "NEO 550",
  "Falcon 500",
  "Falcon 500 (FOC)",
  "Minion",
  "Thrifty Pulsar",
  "CIM",
  "MiniCIM",
  "775pro",
  "BAG",
] as const;
export const CadDriveMotor = Schema.Literals(CAD_DRIVE_MOTORS);
export type CadDriveMotor = typeof CadDriveMotor.Type;

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMaxLength(256));

/**
 * What the output should do. A reduction above 1 slows the output; below 1 speeds it up. Speeds
 * are converted to a reduction from the motor's free speed.
 */
export const CadDriveTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reduction"), reduction: Positive }),
  Schema.Struct({ kind: Schema.Literal("output-rpm"), rpm: Positive }),
  Schema.Struct({ kind: Schema.Literal("surface-speed"), feetPerSecond: Positive }),
]);
export type CadDriveTarget = typeof CadDriveTarget.Type;

export const CadDriveOptionsInput = Schema.Struct({
  expectedRevision: Count,
  target: CadDriveTarget,
  /** The motor, or the shaft that carries the first wheel. */
  driverOccurrenceId: Schema.optionalKey(CadHash),
  /** The shaft or roller that carries the last wheel. */
  drivenOccurrenceId: Schema.optionalKey(CadHash),
  /** Fixed center distance between the driver and driven axes, when they are not both in the CAD. */
  centerInches: Schema.optionalKey(Positive),
  /** Free-speed source for speed targets; read from the driver part's name when left out. */
  motor: Schema.optionalKey(CadDriveMotor),
  /** Surface-speed targets: defaults to the driven part's diameter in the CAD. */
  rollerDiameterInches: Schema.optionalKey(Positive),
  families: Schema.optionalKey(Schema.Array(CadDriveFamily).check(Schema.isMinLength(1))),
  /** Bore the first wheel must have, such as a motor's shaft: "SplineXS", "Falcon", "8mm", "1/2\" Hex". */
  driverBore: Schema.optionalKey(Text),
  maxStages: Schema.optionalKey(Schema.Literals([1, 2])),
  /** How far the overall reduction may miss the target, in percent. Default 3. */
  tolerancePercent: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
});
export type CadDriveOptionsInput = typeof CadDriveOptionsInput.Type;

const CadDrivePart = Schema.Struct({
  vendor: Text,
  sku: Schema.NullOr(Text),
  bore: Schema.NullOr(Text),
  url: Text,
});
const CadDriveWheel = Schema.Struct({
  teeth: Count,
  /** Every bore the catalog sells this wheel in. */
  bores: Schema.Array(Text),
  /** Up to three listings, the requested or most common bore first. */
  parts: Schema.Array(CadDrivePart),
});
export const CadDriveStage = Schema.Struct({
  family: CadDriveFamily,
  driver: CadDriveWheel,
  driven: CadDriveWheel,
  reduction: Positive,
  /** Center distance to model between this stage's axes; null for a belt or chain with no center yet. */
  centerInches: Schema.NullOr(Schema.Finite),
  /** The belt (teeth) or chain (links) at that center; null for gears, or when no center is known. */
  loop: Schema.NullOr(
    Schema.Struct({
      teeth: Count,
      widthsMm: Schema.Array(Schema.Finite),
      parts: Schema.Array(CadDrivePart),
    }),
  ),
  /** The same stage in ReCalc's calculator. */
  recalcUrl: Text,
});
export type CadDriveStage = typeof CadDriveStage.Type;
const Meters3 = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]);
export const CadDriveOption = Schema.Struct({
  reduction: Positive,
  errorPercent: Schema.Finite,
  stages: Schema.Array(CadDriveStage),
  /** With a fixed center: whether the stages fit it as cad_checks judges belt length and gear spacing. */
  fits: Schema.NullOr(Schema.Boolean),
  /** Single stage with a fixed center: the stage's center minus the fixed one. */
  centerErrorInches: Schema.NullOr(Schema.Finite),
  /**
   * Two stages with both axes in the CAD: where the jackshaft axis can go, in world meters (Z up),
   * one point on each side of the line between the axes, level with the driver part's middle.
   */
  jackshaftPositions: Schema.NullOr(Schema.Array(Meters3)),
  outputRpm: Schema.NullOr(Schema.Finite),
  surfaceFeetPerSecond: Schema.NullOr(Schema.Finite),
});
export type CadDriveOption = typeof CadDriveOption.Type;
const CadDriveAxis = Schema.Struct({
  occurrenceId: CadHash,
  name: Text,
  center: Meters3,
  axis: Meters3,
  diameterInches: Schema.Finite,
});
export const CadDriveOptionsResult = Schema.Struct({
  revision: Count,
  snapshotId: CadSnapshotId,
  reduction: Positive,
  motor: Schema.NullOr(Schema.Struct({ name: CadDriveMotor, freeRpm: Positive })),
  centerInches: Schema.NullOr(Schema.Finite),
  driver: Schema.NullOr(CadDriveAxis),
  driven: Schema.NullOr(CadDriveAxis),
  options: Schema.Array(CadDriveOption),
  notes: Schema.Array(Schema.String),
  recalcUrl: Text,
  catalog: Text,
});
export type CadDriveOptionsResult = typeof CadDriveOptionsResult.Type;
