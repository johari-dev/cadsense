import type {
  CadComment,
  CadCommentOutdatedReason,
  CadSnapshotManifest,
  CadSnapshotNode,
} from "@cadsense/contracts";

// Manifest transforms are exact copies of Onshape occurrence matrices, so equal placements compare equal.
const TRANSFORM_TOLERANCE = 1e-9;
const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);
const sameTransform = (a: readonly number[], b: readonly number[]) =>
  a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= TRANSFORM_TOLERANCE);
type Geometry = Pick<CadSnapshotManifest, "nodes" | "assets">;
const geometryHash = (manifest: Geometry, node: CadSnapshotNode) =>
  manifest.assets.find((asset) => asset.geometryKey === node.sourcePartKey)?.sha256 ?? null;

/** Compares one target's occurrence between the comment's snapshot and a later one of the same root. */
const targetOutdatedReason = (
  occurrenceId: string,
  from: Geometry,
  to: Geometry,
): CadCommentOutdatedReason | null => {
  const before = from.nodes.find((node) => node.id === occurrenceId);
  if (!before) return "removed";
  // Occurrence paths identify the same instance across snapshots, including repeated instances.
  const after = to.nodes.find(
    (node) => node.kind === "part" && samePath(node.occurrencePath, before.occurrencePath),
  );
  if (!after || after.suppressed || after.sourcePartKey === null) return "removed";
  // Asset hashes identify geometry; geometry keys also change with untouched document microversions.
  const geometry = geometryHash(to, after);
  if (geometry === null) return "removed";
  if (geometry !== geometryHash(from, before)) return "geometry-changed";
  return sameTransform(before.transform, after.transform) ? null : "moved";
};

const SEVERITY: Record<CadCommentOutdatedReason, number> = {
  removed: 3,
  "geometry-changed": 2,
  moved: 1,
};

/**
 * Whether a newer snapshot invalidated a comment: the most severe change across its targets, or
 * null when every targeted instance still exists with the same geometry and placement.
 */
export const cadCommentOutdatedReason = (
  comment: Pick<CadComment, "targets">,
  from: Geometry,
  to: Geometry,
): CadCommentOutdatedReason | null =>
  comment.targets.reduce<CadCommentOutdatedReason | null>((worst, target) => {
    const reason = targetOutdatedReason(target.occurrenceId, from, to);
    return reason && (!worst || SEVERITY[reason] > SEVERITY[worst]) ? reason : worst;
  }, null);
