import { addBodies, type GeometryState } from "./Model.ts";
import { ShapeSet, subShapes, type Oc, type Shape } from "./occt.ts";

/**
 * STEP in and out. The model is in meters; STEP files carry their own units (Onshape exports use the
 * document's units), and the reader converts them to meters.
 */

let fileCounter = 0;

/** Solids and loose faces (sheet bodies) from a STEP file, in meters. */
export function readStep(oc: Oc, bytes: Uint8Array): { solids: Shape[]; sheets: Shape[] } {
  const path = `/import-${fileCounter++}.step`;
  oc.FS.writeFile(path, bytes);
  try {
    oc.Interface_Static.SetCVal("xstep.cascade.unit", "M");
    const reader = new oc.STEPControl_Reader();
    const status = String(reader.ReadFile(path));
    if (!status.endsWith("RetDone")) throw new Error(`The STEP file couldn't be read (${status}).`);
    reader.TransferRoots(new oc.Message_ProgressRange());
    const shape = reader.OneShape();
    const solids = subShapes(oc, shape, "SOLID");
    // Faces outside any solid are surfaces; each shell of them becomes a sheet body.
    const inSolids = new ShapeSet<true>(oc);
    for (const solid of solids)
      for (const face of subShapes(oc, solid, "FACE")) inSolids.set(face, true);
    const sheets = subShapes(oc, shape, "SHELL").filter(
      (shell) => !subShapes(oc, shell, "FACE").some((face) => inSolids.has(face)),
    );
    return { solids, sheets };
  } finally {
    oc.FS.unlink(path);
  }
}

/** Adds a STEP file's bodies to the context as pre-existing geometry created by `createdBy`. */
export function importStep(
  oc: Oc,
  state: GeometryState,
  bytes: Uint8Array,
  createdBy: readonly string[],
): GeometryState {
  const { solids, sheets } = readStep(oc, bytes);
  return addBodies(oc, state, [
    ...solids.map((shape) => ({ shape, bodyType: "SOLID" as const, createdBy })),
    ...sheets.map((shape) => ({ shape, bodyType: "SHEET" as const, createdBy })),
  ]).state;
}

/** Writes shapes (in meters) to a STEP file in millimeters. */
export function writeStep(oc: Oc, shapes: readonly Shape[]): Uint8Array {
  const toMillimeters = new oc.gp_Trsf();
  toMillimeters.SetScaleFactor(1000);
  const path = `/export-${fileCounter++}.step`;
  oc.Interface_Static.SetCVal("xstep.cascade.unit", "MM");
  oc.Interface_Static.SetCVal("write.step.unit", "MM");
  const writer = new oc.STEPControl_Writer();
  for (const shape of shapes)
    writer.Transfer(
      new oc.BRepBuilderAPI_Transform(shape, toMillimeters, true, false).Shape(),
      oc.STEPControl_StepModelType.STEPControl_AsIs,
      true,
      new oc.Message_ProgressRange(),
    );
  writer.Write(path);
  try {
    return oc.FS.readFile(path);
  } finally {
    oc.FS.unlink(path);
  }
}
