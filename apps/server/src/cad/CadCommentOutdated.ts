import type { CadComment, CadCommentOutdatedReason } from "@cadsense/contracts";
import { cadOccurrenceKey, diffCadManifests, type CadDiffManifest } from "./CadDiff.ts";

const SEVERITY: Record<CadCommentOutdatedReason, number> = {
  removed: 3,
  "geometry-changed": 2,
  moved: 1,
};

/**
 * Decides which comments a newer snapshot of the same root invalidated, using cad_diff's rules so
 * the two agree. Build one check per (comment snapshot, current snapshot) pair and call it for
 * every comment on that pair; it returns the most severe change across a comment's targets, or
 * null when every targeted instance is unchanged.
 */
export const cadCommentOutdatedCheck = (from: CadDiffManifest, to: CadDiffManifest) => {
  const changes = new Map(
    diffCadManifests(from, to).entries.map((entry) => [
      cadOccurrenceKey(entry.occurrencePath),
      entry,
    ]),
  );
  const before = new Map(from.nodes.map((node) => [node.id, node]));
  const after = new Map(to.nodes.map((node) => [cadOccurrenceKey(node.occurrencePath), node]));
  const withGeometry = new Set(to.assets.map((asset) => asset.geometryKey));
  const targetReason = (occurrenceId: string): CadCommentOutdatedReason | null => {
    const path = before.get(occurrenceId)?.occurrencePath;
    if (!path) return "removed";
    const current = after.get(cadOccurrenceKey(path));
    if (
      !current ||
      current.suppressed ||
      current.sourcePartKey === null ||
      !withGeometry.has(current.sourcePartKey)
    )
      return "removed";
    const changed = (prefix: readonly string[]) =>
      changes.get(cadOccurrenceKey(prefix))?.changes ?? [];
    if (changed(path).includes("geometry-changed")) return "geometry-changed";
    // cad_diff reports a moved subassembly once, relative to its parent, so a target is moved
    // when it or any ancestor (an occurrence path prefix) moved.
    const lineage = Array.from({ length: path.length + 1 }, (_, length) => path.slice(0, length));
    return lineage.some((prefix) => changed(prefix).includes("moved")) ? "moved" : null;
  };
  return (comment: Pick<CadComment, "targets">) =>
    comment.targets.reduce<CadCommentOutdatedReason | null>((worst, target) => {
      const reason = targetReason(target.occurrenceId);
      return reason && (!worst || SEVERITY[reason] > SEVERITY[worst]) ? reason : worst;
    }, null);
};
