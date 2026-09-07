import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";

const Unit = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 }));
const Vector = Schema.Tuple([
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
  Schema.Number.check(Schema.isFinite()),
]);
const Occurrences = Schema.Array(CadHash).check(Schema.isMaxLength(256));
export const CadCameraPreset = Schema.Literals([
  "isometric",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
]);
export const CadCameraPose = Schema.Struct({
  position: Vector.annotate({
    description: "Camera eye/origin [x,y,z] in CAD world coordinates (meters, Z-up).",
  }),
  target: Vector.annotate({
    description: "World-space point [x,y,z] at the center of the image and the orbit pivot.",
  }),
  up: Vector.annotate({
    description:
      "Image up direction, usually [0,0,1]. Must be nonzero and not parallel to target-position; use [0,1,0] when looking along Z.",
  }),
  projection: Schema.Literals(["perspective", "orthographic"]).annotate({
    description: "Perspective for depth; orthographic for parallel projection without perspective.",
  }),
  zoom: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(100_000),
  ).annotate({
    description:
      "Absolute magnification: 1 is baseline, 2 doubles apparent size, 0.5 halves it. Multiply the current zoom to zoom relatively.",
  }),
}).check(
  Schema.makeFilter((pose) => {
    const direction = pose.target.map((value, index) => value - pose.position[index]!);
    const [x, y, z] = direction;
    const [ux, uy, uz] = pose.up;
    return Math.hypot(y! * uz - z! * uy, z! * ux - x! * uz, x! * uy - y! * ux) > 1e-12;
  }),
);
export const CadCamera = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("preset"), preset: CadCameraPreset, fit: Occurrences }),
  Schema.Struct({
    kind: Schema.Literal("pose"),
    pose: CadCameraPose,
    fit: Schema.NullOr(Occurrences),
  }),
]);
export const CadViewState = Schema.Struct({
  rootId: CadHash,
  snapshotId: CadSnapshotId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  camera: CadCamera,
  visibility: Schema.Record(CadHash, Schema.Boolean),
  isolatedOccurrenceIds: Occurrences,
  explosion: Unit,
});
export type CadViewState = typeof CadViewState.Type;
export const CadViewOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("select-root"), rootId: CadHash }),
  Schema.Struct({ type: Schema.Literal("camera-preset"), preset: CadCameraPreset }),
  Schema.Struct({ type: Schema.Literal("camera-pose"), pose: CadCameraPose }),
  Schema.Struct({ type: Schema.Literal("fit"), occurrenceIds: Occurrences }),
  Schema.Struct({ type: Schema.Literals(["show", "hide", "isolate"]), occurrenceIds: Occurrences }),
  Schema.Struct({ type: Schema.Literal("reset-visibility") }),
  Schema.Struct({ type: Schema.Literal("explode"), amount: Unit }),
]);
export type CadViewOperation = typeof CadViewOperation.Type;
export const CadUpdateViewInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operations: Schema.Array(CadViewOperation).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type CadUpdateViewInput = typeof CadUpdateViewInput.Type;
export class CadViewError extends Schema.TaggedErrorClass<CadViewError>()("CadViewError", {
  reason: Schema.Literals([
    "revision-conflict",
    "invalid-operation",
    "capability-unavailable",
    "memory-full",
    "memory-source-invalid",
    "memory-evidence-invalid",
    "memory-write-limit",
  ]),
}) {}
