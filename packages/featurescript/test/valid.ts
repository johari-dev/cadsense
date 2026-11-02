import type { PartStudioRun } from "../src/Runtime.ts";

/** True when every body a run left passes OpenCascade's validity check (BRepCheck_Analyzer). */
export function allValid(run: PartStudioRun): boolean {
  const oc = run.oc;
  if (!oc || !run.geometry) return true;
  return [...run.geometry.entities.values()].every(
    (entity) => entity.type !== "BODY" || new oc.BRepCheck_Analyzer(entity.shape).IsValid(),
  );
}
