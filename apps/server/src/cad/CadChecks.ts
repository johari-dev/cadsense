import {
  CAD_CHECK_NAMES,
  CadChecksInput,
  CadViewError,
  type CadCheckFinding,
  type CadCheckName,
  type CadChecksResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MAX_PART_EXPORT_BYTES } from "./CadGeometry.ts";
import { decodeCadToolInput } from "./CadViewState.ts";

/** Thresholds in meters (volume in cubic meters). Findings below them are treated as numerical noise. */
export const CAD_CHECK_LIMITS = {
  // Candidate pair evaluations per call after the sort-and-sweep broad phase.
  pairBudget: 250_000,
  // One cubic millimeter of bounding-box overlap.
  overlapVolume: 1e-9,
  // Max per-element transform difference for two placements to count as the same.
  coincidence: 1e-6,
  // Smallest bounding-box dimension that still counts as a solid.
  degenerate: 1e-7,
  pageSize: 50,
} as const;

type Vector3 = readonly [number, number, number];
/** Row-major 4x4 affine transform, the same layout Onshape uses for occurrence transforms. */
type Matrix = readonly number[];
export interface CadBounds {
  readonly min: Vector3;
  readonly max: Vector3;
}
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: Matrix, b: Matrix): Matrix =>
  Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    return (
      a[row * 4]! * b[column]! +
      a[row * 4 + 1]! * b[4 + column]! +
      a[row * 4 + 2]! * b[8 + column]! +
      a[row * 4 + 3]! * b[12 + column]!
    );
  });
const applyPoint = (m: Matrix, [x, y, z]: Vector3): Vector3 => [
  m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
  m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
  m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
];
/** Transforms the eight corners of a box; the result is the axis-aligned box around them. */
const transformBounds = (m: Matrix, bounds: CadBounds): CadBounds => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = applyPoint(m, [
      corner & 1 ? bounds.max[0] : bounds.min[0],
      corner & 2 ? bounds.max[1] : bounds.min[1],
      corner & 4 ? bounds.max[2] : bounds.min[2],
    ]);
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
};
const isFiniteBounds = (bounds: CadBounds) =>
  [...bounds.min, ...bounds.max].every((value) => Number.isFinite(value));
const size = (bounds: CadBounds): Vector3 => [
  bounds.max[0] - bounds.min[0],
  bounds.max[1] - bounds.min[1],
  bounds.max[2] - bounds.min[2],
];
const volume = ([x, y, z]: Vector3) => x * y * z;

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Numbers = Schema.Array(Schema.Number);
const GltfDocument = Schema.Struct({
  scene: Schema.optionalKey(nonnegative),
  scenes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ nodes: Schema.optionalKey(Schema.Array(nonnegative)) })),
  ),
  nodes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mesh: Schema.optionalKey(nonnegative),
        children: Schema.optionalKey(Schema.Array(nonnegative)),
        matrix: Schema.optionalKey(Numbers),
        translation: Schema.optionalKey(Numbers),
        rotation: Schema.optionalKey(Numbers),
        scale: Schema.optionalKey(Numbers),
      }),
    ),
  ),
  meshes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        primitives: Schema.Array(
          Schema.Struct({ attributes: Schema.Record(Schema.String, nonnegative) }),
        ),
      }),
    ),
  ),
  accessors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        min: Schema.optionalKey(Numbers),
        max: Schema.optionalKey(Numbers),
        normalized: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
const decodeGltf = Schema.decodeUnknownOption(Schema.fromJsonString(GltfDocument));
const vector3 = (values: readonly number[] | undefined): Vector3 | null =>
  values?.length === 3 && values.every(Number.isFinite)
    ? [values[0]!, values[1]!, values[2]!]
    : null;
/** glTF stores matrices column-major and TRS as translation * rotation * scale. */
const gltfNodeMatrix = (
  node: NonNullable<typeof GltfDocument.Type.nodes>[number],
): Matrix | null => {
  if (node.matrix !== undefined) {
    if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) return null;
    const m = node.matrix;
    return Array.from({ length: 16 }, (_, index) => m[(index % 4) * 4 + Math.floor(index / 4)]!);
  }
  const t = vector3(node.translation ?? [0, 0, 0]);
  const s = vector3(node.scale ?? [1, 1, 1]);
  const q = node.rotation ?? [0, 0, 0, 1];
  if (!t || !s || q.length !== 4 || !q.every(Number.isFinite)) return null;
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y - z * w) * s[1],
    2 * (x * z + y * w) * s[2],
    t[0],
    2 * (x * y + z * w) * s[0],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z - x * w) * s[2],
    t[1],
    2 * (x * z - y * w) * s[0],
    2 * (y * z + x * w) * s[1],
    (1 - 2 * (x * x + y * y)) * s[2],
    t[2],
    0,
    0,
    0,
    1,
  ];
};

/** Reads a normalized GLB's default scene bounds from POSITION accessor min/max without decoding vertices.
 * Returns null when the file cannot establish bounds, which callers report as unknown rather than empty. */
export const readCadGeometryBounds = (glb: Uint8Array): CadBounds | null => {
  if (glb.byteLength < 20 || glb.byteLength > MAX_PART_EXPORT_BYTES) return null;
  const header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(16, true) !== 0x4e4f534a)
    return null;
  const jsonEnd = 20 + header.getUint32(12, true);
  if (jsonEnd > glb.byteLength) return null;
  const document = decodeGltf(new TextDecoder().decode(glb.subarray(20, jsonEnd)));
  if (document._tag === "None") return null;
  const { nodes = [], meshes = [], accessors = [] } = document.value;
  const roots = document.value.scenes?.[document.value.scene ?? 0]?.nodes;
  if (!roots) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const visited = new Set<number>();
  const pending = roots.map((index) => ({ index, parent: IDENTITY }));
  while (pending.length > 0) {
    const { index, parent } = pending.pop()!;
    const node = nodes[index];
    if (!node || visited.has(index)) return null;
    visited.add(index);
    const local = gltfNodeMatrix(node);
    if (!local) return null;
    const world = multiply(parent, local);
    for (const child of node.children ?? []) pending.push({ index: child, parent: world });
    if (node.mesh === undefined) continue;
    const mesh = meshes[node.mesh];
    if (!mesh) return null;
    for (const primitive of mesh.primitives) {
      const position = primitive.attributes.POSITION;
      if (position === undefined) continue;
      const accessor = accessors[position];
      const localMin = vector3(accessor?.min);
      const localMax = vector3(accessor?.max);
      if (!accessor || accessor.normalized || !localMin || !localMax) return null;
      const box = transformBounds(world, { min: localMin, max: localMax });
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], box.min[axis]);
        max[axis] = Math.max(max[axis], box.max[axis]);
      }
    }
  }
  const bounds = { min, max };
  return isFiniteBounds(bounds) ? bounds : null;
};

/** Loads part bounds once per stored asset. Missing, oversized, or unreadable geometry maps to null. */
export const loadCadBounds = Effect.fn("loadCadBounds")(function* <E>(
  manifest: CadSnapshotManifest,
  readAsset: (sha256: string) => Effect.Effect<Uint8Array, E>,
  cache: Map<string, CadBounds | null>,
  geometryKeys: ReadonlySet<string>,
) {
  const assets = new Map(manifest.assets.map((asset) => [asset.geometryKey, asset]));
  const result = new Map<string, CadBounds | null>();
  for (const key of geometryKeys) {
    const asset = assets.get(key);
    if (!asset || asset.byteLength > MAX_PART_EXPORT_BYTES) {
      result.set(key, null);
      continue;
    }
    let bounds = cache.get(asset.sha256);
    if (bounds === undefined) {
      bounds = readCadGeometryBounds(yield* readAsset(asset.sha256));
      cache.set(asset.sha256, bounds);
    }
    result.set(key, bounds);
  }
  return result;
});

interface PartOccurrence {
  readonly occurrenceId: string;
  readonly name: string;
  readonly geometryKey: string;
  readonly transform: Matrix;
}
interface WorldBox extends CadBounds {
  readonly occurrence: PartOccurrence;
}
const ref = ({ occurrenceId, name }: PartOccurrence) => ({ occurrenceId, name });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: PartOccurrence, b: PartOccurrence) => compare(a.occurrenceId, b.occurrenceId);
const byPair = (a: CadCheckFinding, b: CadCheckFinding) =>
  compare(a.occurrences[0]!.occurrenceId, b.occurrences[0]!.occurrenceId) ||
  compare(a.occurrences[1]?.occurrenceId ?? "", b.occurrences[1]?.occurrenceId ?? "");
const pair = (a: PartOccurrence, b: PartOccurrence) => [a, b].sort(byId).map(ref);
const explanations = {
  "overlapping-bounds":
    "World-space bounding boxes overlap. Boxes overlap for many valid designs (fasteners in holes, parts in pockets), so this is an interference lead, not proof; verify the surfaces visually before commenting.",
  "coincident-instances":
    "Two instances of the same part share a placement, which usually means a duplicate insertion. It does not prove which instance is redundant.",
  "degenerate-geometry":
    "The part's bounds are unavailable or nearly flat on one axis. Surface bodies and sheets can be intentional; unavailable bounds mean the geometry could not be measured, not that it is empty.",
} satisfies Record<CadCheckName, string>;

/** Unsuppressed part occurrences at their original placement (explosion ignored). */
const partOccurrences = (manifest: CadSnapshotManifest): PartOccurrence[] => {
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]));
  const suppressed = new Map<string, boolean>();
  const isSuppressed = (id: string): boolean => {
    const known = suppressed.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id);
    const result =
      !node || node.suppressed || (node.parentId !== null && isSuppressed(node.parentId));
    suppressed.set(id, result);
    return result;
  };
  return manifest.nodes.flatMap((node) =>
    node.kind === "part" && node.sourcePartKey !== null && !isSuppressed(node.id)
      ? [
          {
            occurrenceId: node.id,
            name: node.name,
            geometryKey: node.sourcePartKey,
            transform: node.transform,
          },
        ]
      : [],
  );
};

/** Sort and sweep on X, then exact box tests on the survivors until the pair budget runs out. */
const overlappingBounds = (boxes: readonly WorldBox[], budget: number) => {
  const sorted = [...boxes].sort((a, b) => a.min[0] - b.min[0] || byId(a.occurrence, b.occurrence));
  const findings: Extract<CadCheckFinding, { check: "overlapping-bounds" }>[] = [];
  let pairsEvaluated = 0;
  let budgetExhausted = false;
  sweep: for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.min[0] > a.max[0]) break;
      if (pairsEvaluated >= budget) {
        budgetExhausted = true;
        break sweep;
      }
      pairsEvaluated++;
      const overlap: CadBounds = {
        min: [
          Math.max(a.min[0], b.min[0]),
          Math.max(a.min[1], b.min[1]),
          Math.max(a.min[2], b.min[2]),
        ],
        max: [
          Math.min(a.max[0], b.max[0]),
          Math.min(a.max[1], b.max[1]),
          Math.min(a.max[2], b.max[2]),
        ],
      };
      const overlapSize = size(overlap);
      if (overlapSize.some((value) => value <= 0)) continue;
      const overlapVolume = volume(overlapSize);
      if (overlapVolume <= CAD_CHECK_LIMITS.overlapVolume) continue;
      const sizeA = size(a);
      const sizeB = size(b);
      const smaller = Math.min(volume(sizeA), volume(sizeB));
      findings.push({
        check: "overlapping-bounds",
        occurrences: pair(a.occurrence, b.occurrence),
        overlapSize,
        overlapVolume,
        overlapFraction: smaller > 0 ? Math.min(1, overlapVolume / smaller) : 1,
        contained: ([0, 1, 2] as const).every(
          (axis) => overlapSize[axis] === Math.min(sizeA[axis], sizeB[axis]),
        ),
        explanation: explanations["overlapping-bounds"],
      });
    }
  }
  findings.sort((a, b) => b.overlapVolume - a.overlapVolume || byPair(a, b));
  return { findings, pairsEvaluated, budgetExhausted };
};

/** Same source part, near-identical transform. Sorted by X translation so each group is a short sweep. */
const coincidentInstances = (occurrences: readonly PartOccurrence[]) => {
  const groups = new Map<string, PartOccurrence[]>();
  for (const occurrence of occurrences)
    groups.set(occurrence.geometryKey, [...(groups.get(occurrence.geometryKey) ?? []), occurrence]);
  const findings: Extract<CadCheckFinding, { check: "coincident-instances" }>[] = [];
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => a.transform[3]! - b.transform[3]! || byId(a, b));
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (b.transform[3]! - a.transform[3]! > CAD_CHECK_LIMITS.coincidence) break;
        const maxDeviation = Math.max(
          ...a.transform.map((value, index) => Math.abs(value - b.transform[index]!)),
        );
        if (maxDeviation > CAD_CHECK_LIMITS.coincidence) continue;
        findings.push({
          check: "coincident-instances",
          occurrences: pair(a, b),
          maxDeviation,
          explanation: explanations["coincident-instances"],
        });
      }
  }
  return findings.sort(byPair);
};

const degenerateGeometry = (
  occurrences: readonly PartOccurrence[],
  bounds: ReadonlyMap<string, CadBounds | null>,
) =>
  [...occurrences]
    .sort(byId)
    .flatMap((occurrence): Extract<CadCheckFinding, { check: "degenerate-geometry" }>[] => {
      const local = bounds.get(occurrence.geometryKey) ?? null;
      const dimensions = local ? size(local) : null;
      if (dimensions && Math.min(...dimensions) >= CAD_CHECK_LIMITS.degenerate) return [];
      return [
        {
          check: "degenerate-geometry",
          occurrences: [ref(occurrence)],
          size: dimensions,
          explanation: explanations["degenerate-geometry"],
        },
      ];
    });

/** Pure, deterministic pass over one snapshot. Same inputs always yield the same ordered findings. */
export const runCadChecks = (
  manifest: CadSnapshotManifest,
  bounds: ReadonlyMap<string, CadBounds | null>,
  checks: ReadonlySet<CadCheckName>,
  pairBudget: number = CAD_CHECK_LIMITS.pairBudget,
) => {
  const occurrences = partOccurrences(manifest);
  const boxes = occurrences.flatMap((occurrence): WorldBox[] => {
    const local = bounds.get(occurrence.geometryKey);
    if (!local) return [];
    const world = transformBounds(occurrence.transform, local);
    return isFiniteBounds(world) ? [{ ...world, occurrence }] : [];
  });
  const overlap = checks.has("overlapping-bounds")
    ? overlappingBounds(boxes, pairBudget)
    : { findings: [], pairsEvaluated: 0, budgetExhausted: false };
  const findings: CadCheckFinding[] = [
    ...overlap.findings,
    ...(checks.has("coincident-instances") ? coincidentInstances(occurrences) : []),
    ...(checks.has("degenerate-geometry") ? degenerateGeometry(occurrences, bounds) : []),
  ];
  return {
    findings,
    summary: {
      totalFindings: findings.length,
      partOccurrences: occurrences.length,
      boundsUnknown: occurrences.length - boxes.length,
      pairsEvaluated: overlap.pairsEvaluated,
      pairBudget,
      budgetExhausted: overlap.budgetExhausted,
    },
  };
};

const invalid = (details: string) => new CadViewError({ reason: "invalid-operation", details });
/** Tool entry point. Cursors are bound to the snapshot and the selected checks, like cad_hierarchy. */
export const readCadChecks = Effect.fn("readCadChecks")(function* (
  manifest: CadSnapshotManifest,
  state: CadViewState,
  loadBounds: (
    geometryKeys: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyMap<string, CadBounds | null>, CadViewError>,
  rawInput: unknown,
): Effect.fn.Return<CadChecksResult, CadViewError> {
  const input = yield* decodeCadToolInput(CadChecksInput, rawInput);
  if (input.expectedRevision !== state.revision)
    return yield* new CadViewError({ reason: "revision-conflict" });
  const selected = new Set(input.checks ?? CAD_CHECK_NAMES);
  const checks = CAD_CHECK_NAMES.filter((name) => selected.has(name));
  const prefix = `${state.snapshotId}:${checks.join("+")}:`;
  const suffix = input.cursor?.slice(prefix.length);
  if (
    input.cursor !== undefined &&
    (!input.cursor.startsWith(prefix) || !suffix || !/^(0|[1-9][0-9]*)$/.test(suffix))
  )
    return yield* invalid(
      "cursor does not belong to this snapshot and check selection. Start again without a cursor.",
    );
  const offset = suffix === undefined ? 0 : Number(suffix);
  const needsBounds = selected.has("overlapping-bounds") || selected.has("degenerate-geometry");
  const bounds = needsBounds
    ? yield* loadBounds(
        new Set(partOccurrences(manifest).map((occurrence) => occurrence.geometryKey)),
      )
    : new Map<string, CadBounds | null>();
  const { findings, summary } = runCadChecks(manifest, bounds, selected);
  if (!Number.isSafeInteger(offset) || offset > findings.length)
    return yield* invalid("cursor is past the end of the findings. Start again without a cursor.");
  const end = Math.min(offset + (input.limit ?? CAD_CHECK_LIMITS.pageSize), findings.length);
  return {
    revision: state.revision,
    snapshotId: state.snapshotId,
    checks,
    findings: findings.slice(offset, end),
    nextCursor: end < findings.length ? `${prefix}${end}` : null,
    summary,
  };
});
