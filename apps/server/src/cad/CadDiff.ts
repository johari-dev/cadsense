import {
  type CadComment,
  type CadDiffInput,
  CadViewError,
  type CadDiffChange,
  type CadDiffCounts,
  type CadDiffEntry,
  type CadDiffSnapshot,
  type CadRetainedSnapshot,
  type CadSnapshotManifest,
  type CadSnapshotMetadata,
  type CadSnapshotNode,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";

/** Placement differences below this (meters for translation, unitless for rotation) are import noise. */
export const CAD_DIFF_MOVE_EPSILON = 1e-6;
export interface CadDiff {
  readonly counts: CadDiffCounts;
  readonly entries: readonly CadDiffEntry[];
}

const pathKey = (node: CadSnapshotNode) => JSON.stringify(node.occurrencePath);
// Row-major affine 4x4 with the last row fixed to [0,0,0,1]; null when the linear part is singular.
const invertAffine = (m: readonly number[]) => {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const r = [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ] as const;
  return [
    r[0],
    r[1],
    r[2],
    -(r[0] * tx + r[1] * ty + r[2] * tz),
    r[3],
    r[4],
    r[5],
    -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6],
    r[7],
    r[8],
    -(r[6] * tx + r[7] * ty + r[8] * tz),
    0,
    0,
    0,
    1,
  ];
};
const multiply = (a: readonly number[], b: readonly number[]) =>
  Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[row * 4 + k]! * b[k * 4 + column]!;
    return sum;
  });
/**
 * Manifest transforms are absolute, so moving a subassembly moves every descendant. Comparing each
 * occurrence relative to its parent reports only the placement that was edited.
 */
const relativeTransform = (node: CadSnapshotNode, nodes: ReadonlyMap<string, CadSnapshotNode>) => {
  const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
  if (!parent) return node.transform;
  const inverse = invertAffine(parent.transform);
  return inverse ? multiply(inverse, node.transform) : node.transform;
};
const moved = (a: readonly number[], b: readonly number[]) =>
  a.some((value, index) => Math.abs(value - b[index]!) > CAD_DIFF_MOVE_EPSILON);
/**
 * A part studio edit changes the geometry key of every part in that studio. Identical exported
 * bytes prove the tessellated shape is unchanged; keys without geometry (suppressed) compare by key.
 */
const geometryChanged = (
  baseKey: string | null,
  targetKey: string | null,
  baseAssets: ReadonlyMap<string, string>,
  targetAssets: ReadonlyMap<string, string>,
) => {
  if (baseKey === targetKey) return false;
  if (baseKey === null || targetKey === null) return true;
  const baseSha = baseAssets.get(baseKey);
  const targetSha = targetAssets.get(targetKey);
  return baseSha === undefined || targetSha === undefined || baseSha !== targetSha;
};
const shaByGeometryKey = (manifest: CadSnapshotManifest) =>
  new Map(manifest.assets.map((asset) => [asset.geometryKey, asset.sha256]));
const order = { added: 0, removed: 1, modified: 2 } as const;
const compareEntries = (a: CadDiffEntry, b: CadDiffEntry) =>
  order[a.status] - order[b.status] ||
  a.occurrencePath.length - b.occurrencePath.length ||
  (JSON.stringify(a.occurrencePath) < JSON.stringify(b.occurrencePath) ? -1 : 1);

/** Occurrences match by occurrence path, which survives reimport; node IDs are root-qualified hashes of it. */
export const diffCadManifests = (
  base: CadSnapshotManifest,
  target: CadSnapshotManifest,
): CadDiff => {
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const targetNodes = new Map(target.nodes.map((node) => [node.id, node]));
  const baseByPath = new Map(base.nodes.map((node) => [pathKey(node), node]));
  const baseAssets = shaByGeometryKey(base);
  const targetAssets = shaByGeometryKey(target);
  const counts = {
    added: 0,
    removed: 0,
    modified: 0,
    moved: 0,
    geometryChanged: 0,
    renamed: 0,
    suppressionChanged: 0,
    visibilityChanged: 0,
    unchanged: 0,
  };
  const entries: CadDiffEntry[] = [];
  const seen = new Set<string>();
  for (const node of target.nodes) {
    const key = pathKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = baseByPath.get(key);
    if (!previous) {
      counts.added++;
      entries.push({
        status: "added",
        occurrencePath: node.occurrencePath,
        name: node.name,
        previousName: null,
        kind: node.kind,
        baseOccurrenceId: null,
        targetOccurrenceId: node.id,
        changes: [],
      });
      continue;
    }
    const changes: CadDiffChange[] = [];
    if (moved(relativeTransform(previous, baseNodes), relativeTransform(node, targetNodes)))
      changes.push("moved");
    if (geometryChanged(previous.sourcePartKey, node.sourcePartKey, baseAssets, targetAssets))
      changes.push("geometry-changed");
    if (previous.name !== node.name) changes.push("renamed");
    if (previous.suppressed !== node.suppressed) changes.push("suppression-changed");
    if (previous.defaultVisible !== node.defaultVisible) changes.push("visibility-changed");
    if (changes.length === 0) {
      counts.unchanged++;
      continue;
    }
    counts.modified++;
    for (const change of changes)
      switch (change) {
        case "moved":
          counts.moved++;
          break;
        case "geometry-changed":
          counts.geometryChanged++;
          break;
        case "renamed":
          counts.renamed++;
          break;
        case "suppression-changed":
          counts.suppressionChanged++;
          break;
        case "visibility-changed":
          counts.visibilityChanged++;
          break;
      }
    entries.push({
      status: "modified",
      occurrencePath: node.occurrencePath,
      name: node.name,
      previousName: previous.name === node.name ? null : previous.name,
      kind: node.kind,
      baseOccurrenceId: previous.id,
      targetOccurrenceId: node.id,
      changes,
    });
  }
  for (const [key, node] of baseByPath)
    if (!seen.has(key)) {
      counts.removed++;
      entries.push({
        status: "removed",
        occurrencePath: node.occurrencePath,
        name: node.name,
        previousName: null,
        kind: node.kind,
        baseOccurrenceId: node.id,
        targetOccurrenceId: null,
        changes: [],
      });
    }
  entries.sort(compareEntries);
  return { counts, entries };
};

export const cadDiffSnapshot = (manifest: CadSnapshotManifest): CadDiffSnapshot => ({
  snapshotId: manifest.snapshotId,
  createdAt: manifest.createdAt,
  microversionId: manifest.root.microversionId,
});

export interface CadDiffCandidate {
  readonly retainedBy: CadRetainedSnapshot["retainedBy"][number][];
  readonly commentNumbers: number[];
  /** Known from the root lineage; comment-only snapshots need their manifest header loaded. */
  readonly header: CadDiffSnapshot | null;
}
/** Retention protects a root's current and rollback snapshots and every snapshot this chat's comments reference. */
export const retainedCadCandidates = (
  lineage:
    | { current: CadSnapshotMetadata | null; rollback: CadSnapshotMetadata | null }
    | undefined,
  comments: readonly CadComment[],
  rootId: string,
) => {
  const candidates = new Map<string, CadDiffCandidate>();
  const candidate = (snapshotId: string, header: CadDiffSnapshot | null = null) => {
    const entry = candidates.get(snapshotId) ?? { retainedBy: [], commentNumbers: [], header };
    candidates.set(snapshotId, entry);
    return entry;
  };
  for (const role of ["current", "rollback"] as const) {
    const metadata = lineage?.[role];
    if (metadata)
      candidate(metadata.snapshotId, {
        snapshotId: metadata.snapshotId,
        createdAt: metadata.createdAt,
        microversionId: metadata.microversionId,
      }).retainedBy.push(role);
  }
  for (const comment of comments) {
    if (comment.rootId !== rootId) continue;
    const entry = candidate(comment.snapshotId);
    if (!entry.retainedBy.includes("comments")) entry.retainedBy.push("comments");
    entry.commentNumbers.push(comment.number);
  }
  for (const entry of candidates.values()) entry.commentNumbers.sort((a, b) => a - b);
  return candidates;
};

const describeRetained = (snapshot: CadRetainedSnapshot) =>
  [
    snapshot.retainedBy.join(", "),
    ...(snapshot.commentNumbers.length > 0
      ? [
          `inspected by comment${snapshot.commentNumbers.length === 1 ? "" : "s"} #${snapshot.commentNumbers.join(", #")}`,
        ]
      : []),
  ].join("; ");
/** The newest retained snapshot created before the target, so the diff covers exactly the work since the last review. */
export const chooseCadDiffBase = (
  retained: readonly CadRetainedSnapshot[],
  target: CadDiffSnapshot,
) => {
  const targetTime = Date.parse(target.createdAt);
  const earlier = retained
    .filter(
      (snapshot) =>
        snapshot.snapshotId !== target.snapshotId && Date.parse(snapshot.createdAt) < targetTime,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const chosen = earlier[0];
  if (!chosen) return null;
  return {
    snapshot: chosen,
    reason: `Default base: the most recent retained snapshot created before the target (${describeRetained(chosen)}).`,
  };
};

/** Cursors are bound to the snapshot pair; a different pair or an invalid offset is rejected. */
export const pageCadDiff = Effect.fn("pageCadDiff")(function* (
  diff: CadDiff,
  baseSnapshotId: string,
  targetSnapshotId: string,
  input: CadDiffInput,
): Effect.fn.Return<{ entries: readonly CadDiffEntry[]; nextCursor: string | null }, CadViewError> {
  const prefix = `${baseSnapshotId}:${targetSnapshotId}:`;
  const suffix = input.cursor?.slice(prefix.length);
  if (
    input.cursor !== undefined &&
    (!input.cursor.startsWith(prefix) || !suffix || !/^(0|[1-9][0-9]*)$/.test(suffix))
  )
    return yield* new CadViewError({
      reason: "invalid-operation",
      details: "cursor belongs to a different snapshot pair or is malformed. Omit it to restart.",
    });
  const offset = suffix === undefined ? 0 : Number(suffix);
  if (!Number.isSafeInteger(offset) || offset > diff.entries.length)
    return yield* new CadViewError({
      reason: "invalid-operation",
      details: "cursor offset is past the end of this diff. Omit it to restart.",
    });
  const end = Math.min(offset + (input.limit ?? 100), diff.entries.length);
  return {
    entries: diff.entries.slice(offset, end),
    nextCursor: end < diff.entries.length ? `${prefix}${end}` : null,
  };
});
