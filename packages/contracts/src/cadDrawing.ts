import * as Schema from "effect/Schema";
import { CadHash, CadSnapshotId } from "./cad.ts";

const Text = Schema.String.check(Schema.isMaxLength(256));

/** Opens shop drawings for parts, or for every part under an assembly the shop draws. */
export const CadPartDrawingInput = Schema.Struct({
  snapshotId: CadSnapshotId,
  occurrenceIds: Schema.Array(CadHash).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  title: Schema.optionalKey(Text),
});
export type CadPartDrawingInput = typeof CadPartDrawingInput.Type;

export const CadPartDrawingSheet = Schema.Struct({ name: Text, qty: Schema.Int, material: Text });

/** The chat card for drawings the agent opened. The web builds the sheets from the snapshot. */
export const CadPartDrawingCard = Schema.Struct({
  snapshotId: CadSnapshotId,
  occurrenceIds: Schema.Array(CadHash),
  title: Text,
  sheets: Schema.Array(CadPartDrawingSheet),
  /** Part instances in an assembly selection that were not drawn, by where they go instead. */
  skipped: Schema.optionalKey(Schema.Struct({ cnc: Schema.Int, print: Schema.Int })),
});
export type CadPartDrawingCard = typeof CadPartDrawingCard.Type;
export const CAD_PART_DRAWING_ACTIVITY = "cad.drawing.opened";

/** Opens router CAM for plates, or for every plate under an assembly; same input as drawings. */
export const CadPlateCamInput = CadPartDrawingInput;
/** The chat card for plates the agent opened in CAM; `sheets` lists the plates. */
export const CAD_PLATE_CAM_ACTIVITY = "cad.cam.opened";
