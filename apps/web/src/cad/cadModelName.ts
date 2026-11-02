import type { CadProjectState } from "@cadsense/contracts";

/**
 * The synced model's Onshape name, named the way the CAD panel's scene picker names it.
 * Null when the project has no synced model or several.
 */
export function singleCadModelName(cad: CadProjectState | undefined): string | null {
  const current = cad?.roots.filter((root) => root.current) ?? [];
  const only = current.length === 1 ? current[0] : undefined;
  if (!only) return null;
  return (
    cad?.catalog?.roots.find((entry) => entry.elementId === only.elementId)?.name ??
    (only.kind === "assembly" ? "Assembly" : "Part Studio")
  );
}
