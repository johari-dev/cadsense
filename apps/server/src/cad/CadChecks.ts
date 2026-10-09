// @effect-diagnostics nodeBuiltinImport:off
// Draft keys are digests computed at this trusted server boundary.
import * as NodeCrypto from "node:crypto";
import {
  CAD_CHECK_NAMES,
  CadCheckDraft,
  CadCheckFinding,
  CadChecksInput,
  CadChecksResult,
  CadViewError,
  type CadCheckName,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import Module from "manifold-3d";
import {
  analyzeCadDrivetrain,
  beltEndPlacement,
  type CadDrivetrainPart,
  type CadOverlap,
  countedList,
  distinctPhrases,
  FASTENER,
  fitCadAxis,
  GAME_PIECE,
  joinAnd,
  partLabel,
  partList,
  partName,
  partPhrase,
  recognizeDrivetrainParts,
  rotatingCollisions,
  upperFirst,
} from "./CadDrivetrain.ts";
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
  // Triangles per part mesh; larger meshes are reported as unknown instead of intersected.
  meshTriangles: 500_000,
  pageSize: 50,
  // Serialized page budget, well under Claude's MCP output limit so a page is never spilled to a file.
  pageBytes: 32 * 1024,
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
/** A part occurrence's world box: its local asset bounds under the row-major occurrence transform.
 * Null when the local bounds are unknown or the placed box is not finite. */
export const worldCadBounds = (
  transform: Matrix,
  local: CadBounds | null | undefined,
): CadBounds | null => {
  if (!local) return null;
  const world = transformBounds(transform, local);
  return isFiniteBounds(world) ? world : null;
};

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
          Schema.Struct({
            attributes: Schema.Record(Schema.String, nonnegative),
            indices: Schema.optionalKey(nonnegative),
            mode: Schema.optionalKey(nonnegative),
          }),
        ),
      }),
    ),
  ),
  accessors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        bufferView: Schema.optionalKey(nonnegative),
        byteOffset: Schema.optionalKey(nonnegative),
        componentType: Schema.optionalKey(nonnegative),
        count: Schema.optionalKey(nonnegative),
        type: Schema.optionalKey(Schema.String),
        min: Schema.optionalKey(Numbers),
        max: Schema.optionalKey(Numbers),
        normalized: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  bufferViews: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        buffer: Schema.optionalKey(nonnegative),
        byteOffset: Schema.optionalKey(nonnegative),
        byteLength: nonnegative,
        byteStride: Schema.optionalKey(nonnegative),
      }),
    ),
  ),
});
type GltfDocument = typeof GltfDocument.Type;
type GltfMesh = NonNullable<GltfDocument["meshes"]>[number];
const decodeGltf = Schema.decodeUnknownOption(Schema.fromJsonString(GltfDocument));
const vector3 = (values: readonly number[] | undefined): Vector3 | null =>
  values?.length === 3 && values.every(Number.isFinite)
    ? [values[0]!, values[1]!, values[2]!]
    : null;
/** glTF stores matrices column-major and TRS as translation * rotation * scale. */
const gltfNodeMatrix = (node: NonNullable<GltfDocument["nodes"]>[number]): Matrix | null => {
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

/** Splits a GLB into its decoded JSON document and optional binary chunk; null for anything else. */
const parseGlb = (glb: Uint8Array): { document: GltfDocument; bin: Uint8Array | null } | null => {
  if (glb.byteLength < 20 || glb.byteLength > MAX_PART_EXPORT_BYTES) return null;
  const header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(16, true) !== 0x4e4f534a)
    return null;
  const jsonEnd = 20 + header.getUint32(12, true);
  if (jsonEnd > glb.byteLength) return null;
  const document = decodeGltf(new TextDecoder().decode(glb.subarray(20, jsonEnd)));
  if (document._tag === "None") return null;
  const binStart = jsonEnd + 8;
  if (binStart > glb.byteLength || header.getUint32(jsonEnd + 4, true) !== 0x004e4942)
    return { document: document.value, bin: null };
  const binEnd = binStart + header.getUint32(jsonEnd, true);
  if (binEnd > glb.byteLength) return null;
  return { document: document.value, bin: glb.subarray(binStart, binEnd) };
};

/** Every mesh instance in the default scene with its composed node transform.
 * Null for missing references, cycles, or invalid transforms. */
const sceneMeshes = (document: GltfDocument): { world: Matrix; mesh: GltfMesh }[] | null => {
  const { nodes = [], meshes = [] } = document;
  const roots = document.scenes?.[document.scene ?? 0]?.nodes;
  if (!roots) return null;
  const instances: { world: Matrix; mesh: GltfMesh }[] = [];
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
    instances.push({ world, mesh });
  }
  return instances;
};

/** Reads a normalized GLB's default scene bounds from POSITION accessor min/max without decoding vertices.
 * Returns null when the file cannot establish bounds, which callers report as unknown rather than empty. */
export const readCadGeometryBounds = (glb: Uint8Array): CadBounds | null => {
  const parsed = parseGlb(glb);
  if (!parsed) return null;
  const { accessors = [] } = parsed.document;
  const instances = sceneMeshes(parsed.document);
  if (!instances) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { world, mesh } of instances) {
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

export interface CadTriangleMesh {
  /** Part-space vertices in meters, xyz interleaved, with the GLB's own node transforms applied. */
  readonly positions: Float64Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
}
const INDEX_BYTES: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4 };

/** Decodes every triangle in a GLB's default scene. Returns null for anything it would have to guess
 * at (non-triangle primitives, non-float positions, out-of-range indices or byte ranges), so callers
 * report the part as unknown instead of intersecting a misread mesh. */
export const readCadTriangleMesh = (glb: Uint8Array): CadTriangleMesh | null => {
  const parsed = parseGlb(glb);
  if (!parsed?.bin) return null;
  const { document, bin } = parsed;
  const instances = sceneMeshes(document);
  if (!instances) return null;
  const { accessors = [], bufferViews = [] } = document;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  // An accessor's first byte and stride inside the binary chunk, or null when any element falls outside it.
  const locate = (index: number, elementBytes: number) => {
    const accessor = accessors[index];
    const view = accessor?.bufferView === undefined ? undefined : bufferViews[accessor.bufferView];
    if (!accessor || accessor.count === undefined || !view || (view.buffer ?? 0) !== 0) return null;
    const stride = view.byteStride ?? elementBytes;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const viewEnd = (view.byteOffset ?? 0) + view.byteLength;
    const end = start + Math.max(0, accessor.count - 1) * stride + elementBytes;
    if (stride < elementBytes || end > viewEnd || viewEnd > bin.byteLength) return null;
    return { count: accessor.count, start, stride };
  };
  const positions: number[] = [];
  const indices: number[] = [];
  for (const { world, mesh } of instances)
    for (const primitive of mesh.primitives) {
      const positionIndex = primitive.attributes.POSITION;
      const accessor = positionIndex === undefined ? undefined : accessors[positionIndex];
      if ((primitive.mode ?? 4) !== 4 || positionIndex === undefined || !accessor) return null;
      if (accessor.componentType !== 5126 || accessor.type !== "VEC3" || accessor.normalized)
        return null;
      const position = locate(positionIndex, 12);
      if (!position) return null;
      const base = positions.length / 3;
      for (let i = 0; i < position.count; i++) {
        const at = position.start + i * position.stride;
        positions.push(
          ...applyPoint(world, [
            data.getFloat32(at, true),
            data.getFloat32(at + 4, true),
            data.getFloat32(at + 8, true),
          ]),
        );
      }
      if (primitive.indices === undefined) {
        if (position.count % 3 !== 0) return null;
        for (let i = 0; i < position.count; i++) indices.push(base + i);
      } else {
        const indexAccessor = accessors[primitive.indices];
        const bytes = INDEX_BYTES[indexAccessor?.componentType ?? 0];
        const range =
          bytes && indexAccessor?.type === "SCALAR" ? locate(primitive.indices, bytes) : null;
        if (!bytes || !range || range.count % 3 !== 0) return null;
        for (let i = 0; i < range.count; i++) {
          const at = range.start + i * range.stride;
          const vertex =
            bytes === 1
              ? data.getUint8(at)
              : bytes === 2
                ? data.getUint16(at, true)
                : data.getUint32(at, true);
          if (vertex >= position.count) return null;
          indices.push(base + vertex);
        }
      }
      if (indices.length / 3 > CAD_CHECK_LIMITS.meshTriangles) return null;
    }
  if (indices.length === 0) return null;
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
};

/** Reads each asset's triangles once per call. Missing, oversized, or unreadable geometry maps to null. */
export const loadCadMeshes = Effect.fn("loadCadMeshes")(function* <E>(
  manifest: CadSnapshotManifest,
  readAsset: (sha256: string) => Effect.Effect<Uint8Array, E>,
  geometryKeys: ReadonlySet<string>,
) {
  const assets = new Map(manifest.assets.map((asset) => [asset.geometryKey, asset]));
  const bySha = new Map<string, CadTriangleMesh | null>();
  const result = new Map<string, CadTriangleMesh | null>();
  for (const key of geometryKeys) {
    const asset = assets.get(key);
    if (!asset || asset.byteLength > MAX_PART_EXPORT_BYTES) {
      result.set(key, null);
      continue;
    }
    let mesh = bySha.get(asset.sha256);
    if (mesh === undefined) {
      mesh = readCadTriangleMesh(yield* readAsset(asset.sha256));
      bySha.set(asset.sha256, mesh);
    }
    result.set(key, mesh);
  }
  return result;
});

type CadSolidKernel = Awaited<ReturnType<typeof Module>>;
type CadSolid = InstanceType<CadSolidKernel["Manifold"]>;
let solidKernel: Promise<CadSolidKernel> | undefined;
/** The manifold-3d WASM module, instantiated once per process on first use. */
export const loadCadSolidKernel = Effect.promise(
  () =>
    (solidKernel ??= Module().then((kernel) => {
      kernel.setup();
      return kernel;
    })),
);
export interface CadCheckSolids {
  readonly meshes: ReadonlyMap<string, CadTriangleMesh | null>;
  readonly kernel: CadSolidKernel;
}

export interface PartOccurrence {
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
/**
 * When an agent may decline a cad_checks draft, in the words every agent-facing text uses. A plan
 * to change a part later does not excuse a defect drawn now; see "Drafts, reminders, and the
 * backstop" in CadChecks.md.
 */
export const CAD_DRAFT_DECLINE_RULE =
  "Decline a draft (declinedDrafts:[{publicationKey,explanation}]) only when the user said that part is a placeholder or not modeled yet, the user asked for no CAD comments, one of your published comments already covers it, you asked the user about that part in this reply, or you inspected the parts and the draft is wrong for this model; say which in the explanation. A plan to rework, move, or merge parts later is not a reason, and neither is calling the design a work in progress.";
/** What each check does and does not prove. Pages state these once instead of on every finding. */
export const CAD_CHECK_EXPLANATIONS = {
  drivetrain:
    "Reads gears, pulleys, belts, chains, shafts, bearings, gearboxes, motors, and rollers from vendor part names, fits each part's rotation axis from its mesh, and traces power from every motor. problem: true means the drive will not work as modeled (gears at the wrong center distance, a belt or chain with no pulley or sprocket at an end, a shaft with no bearing, rollers no motor reaches). Each one is a finding for a CAD comment. problem: false findings are traced facts such as ratios and power paths. Parts without vendor names are not recognized, so a part missing from a trace is unrecognized, not absent.",
  "mesh-interference":
    "The two solids share this volume in their original placements. Intended fits touch at zero volume, so this is usually a modeling error or a real collision: a duplicate part, a gear or shaft in the wrong spot, a plate through a tube. Parts modeled undeformed on purpose (a compressed game piece, press fits, threads) also appear. Pairs inside one subassembly are listed last because they are usually the kit author's modeling choice.",
  "overlapping-bounds":
    "World-space bounding boxes overlap. Boxes overlap for many valid designs (fasteners in holes, parts in pockets), so this is an interference lead, not proof; verify the surfaces visually before commenting.",
  "coincident-instances":
    "Two instances of the same part share a placement, which usually means a duplicate insertion. It does not prove which instance is redundant.",
  "degenerate-geometry":
    "The part's bounds are unavailable or nearly flat on one axis. Surface bodies and sheets can be intentional; unavailable bounds mean the geometry could not be measured, not that it is empty.",
} satisfies Record<CadCheckName, string>;

/** Unsuppressed part occurrences at their original placement (explosion ignored). */
export const partOccurrences = (manifest: CadSnapshotManifest): PartOccurrence[] => {
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

interface BoxPair {
  readonly a: WorldBox;
  readonly b: WorldBox;
  readonly overlapSize: Vector3;
  readonly overlapVolume: number;
}
/** Sort and sweep on X, then exact box tests on the survivors until the pair budget runs out.
 * The broad phase for both overlap checks. */
const overlappingBoxes = (boxes: readonly WorldBox[], budget: number) => {
  const sorted = [...boxes].sort((a, b) => a.min[0] - b.min[0] || byId(a.occurrence, b.occurrence));
  const pairs: BoxPair[] = [];
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
      pairs.push({ a, b, overlapSize, overlapVolume });
    }
  }
  return { pairs, pairsEvaluated, budgetExhausted };
};

const overlappingBounds = (pairs: readonly BoxPair[]) =>
  pairs
    .map(
      ({
        a,
        b,
        overlapSize,
        overlapVolume,
      }): Extract<CadCheckFinding, { check: "overlapping-bounds" }> => {
        const sizeA = size(a);
        const sizeB = size(b);
        const smaller = Math.min(volume(sizeA), volume(sizeB));
        return {
          check: "overlapping-bounds",
          occurrences: pair(a.occurrence, b.occurrence),
          overlapSize,
          overlapVolume,
          overlapFraction: smaller > 0 ? Math.min(1, overlapVolume / smaller) : 1,
          contained: ([0, 1, 2] as const).every(
            (axis) => overlapSize[axis] === Math.min(sizeA[axis], sizeB[axis]),
          ),
        };
      },
    )
    .sort((a, b) => b.overlapVolume - a.overlapVolume || byPair(a, b));

/** Onshape's row-major occurrence transform as the column-major array manifold-3d expects. */
const columnMajor = (m: Matrix) =>
  Array.from(
    { length: 16 },
    (_, index) => m[(index % 4) * 4 + Math.floor(index / 4)]!,
  ) as Parameters<CadSolid["transform"]>[0];

/** True when the nearest assembly containing both occurrences is below the root. */
const sharesSubassembly = (manifest: CadSnapshotManifest) => {
  const parents = new Map(manifest.nodes.map((node) => [node.id, node.parentId]));
  const ancestors = (id: string) => {
    const chain: string[] = [];
    for (let parent = parents.get(id); parent; parent = parents.get(parent)) chain.push(parent);
    return chain;
  };
  return (a: string, b: string) => {
    const aboveB = new Set(ancestors(b));
    const common = ancestors(a).find((id) => aboveB.has(id));
    return common !== undefined && (parents.get(common) ?? null) !== null;
  };
};

const cubicInches = (cubicMeters: number) =>
  `${Number((cubicMeters / 1.6387064e-5).toPrecision(2))} in³`;

/**
 * Ranks an exact overlap and says what it usually means, so an agent can triage a long list
 * without decoding volumes: cross-subassembly duplicates and collisions first, then overlaps inside
 * one subassembly, then a squeezed game piece, then fastener threads. Ranking only orders the
 * list; every overlap stays in it.
 */
export const readOverlap = (
  smaller: string,
  larger: string,
  volume: number,
  fraction: number,
  withinSubassembly: boolean,
): { rank: number; reading: string } => {
  const amount = `${cubicInches(volume)} (${Math.round(fraction * 100)}% of ${smaller})`;
  if (GAME_PIECE.test(smaller) || GAME_PIECE.test(larger))
    return {
      rank: 2,
      reading: `${smaller} and ${larger} share ${amount}. Game pieces are modeled undeformed, so this is usually an intended squeeze; mention it only if that part should not touch the piece.`,
    };
  if (FASTENER.test(smaller) || FASTENER.test(larger))
    return {
      rank: 3,
      reading: `${smaller} and ${larger} share ${amount}. Fastener threads and nuts are often modeled overlapping, so this is usually not a problem.`,
    };
  const duplicate = `${smaller} sits almost entirely inside ${larger} (${amount}): a duplicate or stale copy, or a second part modeled in the same place. Remove or move one.`;
  if (withinSubassembly)
    return {
      rank: 1,
      reading:
        fraction >= 0.9
          ? duplicate
          : `${smaller} and ${larger} share ${amount} inside one subassembly. Vendor kits sometimes overlap like this, but parts the team placed should not; check how they are mated.`,
    };
  if (fraction >= 0.9) return { rank: 0, reading: duplicate };
  return {
    rank: 0,
    reading: `${smaller} runs into ${larger}, sharing ${amount}: a real collision or a part in the wrong place. Explain or fix it.`,
  };
};

/** Exact intersection of every broad-phase pair whose parts both form closed solids.
 * Solids are built once per asset and placed per occurrence; every WASM object is freed before returning. */
const meshInterference = (
  manifest: CadSnapshotManifest,
  occurrences: readonly PartOccurrence[],
  pairs: readonly BoxPair[],
  solids: CadCheckSolids | undefined,
) => {
  const owned: CadSolid[] = [];
  try {
    const local = new Map<string, CadSolid | null>();
    const localSolid = (geometryKey: string) => {
      const known = local.get(geometryKey);
      if (known !== undefined) return known;
      const mesh = solids?.meshes.get(geometryKey);
      let solid: CadSolid | null = null;
      if (solids && mesh)
        try {
          const input = new solids.kernel.Mesh({
            numProp: 3,
            vertProperties: Float32Array.from(mesh.positions),
            triVerts: mesh.indices,
          });
          input.merge();
          solid = new solids.kernel.Manifold(input);
          owned.push(solid);
        } catch {
          // manifold-3d throws for meshes that are not closed, consistently oriented solids.
          solid = null;
        }
      local.set(geometryKey, solid);
      return solid;
    };
    const meshUnknown = occurrences.filter(
      (occurrence) => !localSolid(occurrence.geometryKey),
    ).length;
    const placed = new Map<string, CadSolid>();
    const place = (occurrence: PartOccurrence, solid: CadSolid) => {
      let result = placed.get(occurrence.occurrenceId);
      if (!result) {
        result = solid.transform(columnMajor(occurrence.transform));
        owned.push(result);
        placed.set(occurrence.occurrenceId, result);
      }
      return result;
    };
    const within = sharesSubassembly(manifest);
    const ranked = pairs.flatMap(
      ({
        a,
        b,
      }): { rank: number; finding: Extract<CadCheckFinding, { check: "mesh-interference" }> }[] => {
        const solidA = localSolid(a.occurrence.geometryKey);
        const solidB = localSolid(b.occurrence.geometryKey);
        if (!solidA || !solidB) return [];
        const placedA = place(a.occurrence, solidA);
        const placedB = place(b.occurrence, solidB);
        const common = placedA.intersect(placedB);
        owned.push(common);
        const intersectionVolume = common.volume();
        if (intersectionVolume <= CAD_CHECK_LIMITS.overlapVolume) return [];
        const [smaller, larger] =
          placedA.volume() <= placedB.volume()
            ? [a.occurrence, b.occurrence]
            : [b.occurrence, a.occurrence];
        const intersectionFraction = Math.min(
          1,
          intersectionVolume / Math.min(placedA.volume(), placedB.volume()),
        );
        const withinSubassembly = within(a.occurrence.occurrenceId, b.occurrence.occurrenceId);
        const { rank, reading } = readOverlap(
          smaller.name,
          larger.name,
          intersectionVolume,
          intersectionFraction,
          withinSubassembly,
        );
        return [
          {
            rank,
            finding: {
              check: "mesh-interference",
              occurrences: pair(a.occurrence, b.occurrence),
              intersectionVolume,
              intersectionFraction,
              withinSubassembly,
              reading,
            },
          },
        ];
      },
    );
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.finding.intersectionVolume - a.finding.intersectionVolume ||
        byPair(a.finding, b.finding),
    );
    return { findings: ranked.map(({ finding }) => finding), meshUnknown };
  } finally {
    for (const solid of owned) solid.delete();
  }
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
        },
      ];
    });

/**
 * Where a check-placed comment marker goes: a surface point in the part's own coordinates, the
 * world direction to look at it from, the parts an inspection should show, and a description of the
 * spot for the agent to confirm against the inspection image.
 */
export interface CadCheckPlacement {
  readonly occurrenceId: string;
  readonly point: Vector3;
  readonly normal: Vector3;
  readonly isolate: readonly string[];
  readonly expected: string;
}

/** Inverse of a row-major affine transform. */
const inverseAffine = (m: Matrix): Matrix => {
  const [a, b, c, d, e, f, g, h, i] = [
    m[0]!,
    m[1]!,
    m[2]!,
    m[4]!,
    m[5]!,
    m[6]!,
    m[8]!,
    m[9]!,
    m[10]!,
  ];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const t = [m[3]!, m[7]!, m[11]!];
  return [
    r[0]!,
    r[1]!,
    r[2]!,
    -(r[0]! * t[0]! + r[1]! * t[1]! + r[2]! * t[2]!),
    r[3]!,
    r[4]!,
    r[5]!,
    -(r[3]! * t[0]! + r[4]! * t[1]! + r[5]! * t[2]!),
    r[6]!,
    r[7]!,
    r[8]!,
    -(r[6]! * t[0]! + r[7]! * t[1]! + r[8]! * t[2]!),
    0,
    0,
    0,
    1,
  ];
};

/**
 * The point where the subject's surface enters the other part, nearest the middle of their overlap:
 * a vertex of the exact intersection shared by triangles from both parts' surfaces, moved
 * SEAM_OFFSET out into the open corner between them (the bisector of both outward normals), so the
 * marker is not buried in either solid. The view direction is that bisector. Null when the meshes
 * are not closed solids or do not overlap.
 */
const seamPoint = (
  kernel: CadSolidKernel,
  subject: { mesh: CadTriangleMesh; transform: Matrix },
  other: { mesh: CadTriangleMesh; transform: Matrix },
): { point: Vector3; normal: Vector3 } | null => {
  const owned: CadSolid[] = [];
  const keep = (solid: CadSolid) => {
    owned.push(solid);
    return solid;
  };
  try {
    const place = ({ mesh, transform }: typeof subject) => {
      const input = new kernel.Mesh({
        numProp: 3,
        vertProperties: Float32Array.from(mesh.positions),
        triVerts: mesh.indices,
      });
      input.merge();
      const local = keep(new kernel.Manifold(input));
      return keep(keep(local.transform(columnMajor(transform))).asOriginal());
    };
    const a = place(subject);
    const b = place(other);
    const common = keep(a.intersect(b));
    if (common.volume() <= CAD_CHECK_LIMITS.overlapVolume) return null;
    const out = common.getMesh();
    const vertices = out.vertProperties.length / out.numProp;
    const at = (v: number): Vector3 => [
      out.vertProperties[v * out.numProp]!,
      out.vertProperties[v * out.numProp + 1]!,
      out.vertProperties[v * out.numProp + 2]!,
    ];
    // Vertices can repeat at boundaries between the two inputs' triangles; merge them by position.
    const keyOf = (v: number) =>
      at(v)
        .map((value) => Math.round(value * 1e7))
        .join(",");
    const canonical = new Map<string, number>();
    const merged = Array.from({ length: vertices }, (_, v) => {
      const key = keyOf(v);
      if (!canonical.has(key)) canonical.set(key, v);
      return canonical.get(key)!;
    });
    const sides = new Uint8Array(vertices);
    // Outward normals summed per vertex: index 0 for the subject's surface, 1 for the other part's.
    const normals = [
      new Map<number, [number, number, number]>(),
      new Map<number, [number, number, number]>(),
    ];
    const subjectId = a.originalID();
    for (let run = 0; run < out.runOriginalID.length; run++) {
      const bit = out.runOriginalID[run] === subjectId ? 1 : 2;
      for (let t = out.runIndex[run]!; t < out.runIndex[run + 1]!; t += 3) {
        const corners = [out.triVerts[t]!, out.triVerts[t + 1]!, out.triVerts[t + 2]!];
        for (const corner of corners) sides[merged[corner]!]! |= bit;
        const sums = normals[bit - 1]!;
        const [p, q, r] = corners.map(at) as [Vector3, Vector3, Vector3];
        const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        const n: [number, number, number] = [
          u[1]! * w[2]! - u[2]! * w[1]!,
          u[2]! * w[0]! - u[0]! * w[2]!,
          u[0]! * w[1]! - u[1]! * w[0]!,
        ];
        for (const corner of corners) {
          const key = merged[corner]!;
          const sum = sums.get(key) ?? [0, 0, 0];
          sums.set(key, [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]]);
        }
      }
    }
    const middle: [number, number, number] = [0, 0, 0];
    for (let v = 0; v < vertices; v++) {
      const [x, y, z] = at(v);
      middle[0] += x / vertices;
      middle[1] += y / vertices;
      middle[2] += z / vertices;
    }
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let v = 0; v < vertices; v++) {
      if (merged[v] !== v || sides[v] !== 3) continue;
      const [x, y, z] = at(v);
      const distance = Math.hypot(x - middle[0], y - middle[1], z - middle[2]);
      if (distance < bestDistance) {
        best = v;
        bestDistance = distance;
      }
    }
    if (best === null) return null;
    const seam = at(best);
    const unit = (v: readonly number[]) => {
      const length = Math.hypot(...v);
      return length > 0 ? v.map((value) => value / length) : [0, 0, 0];
    };
    // Out of both solids: the bisector of the two outward normals points into the open corner.
    const outward = unit(
      [0, 1, 2].map(
        (axis) =>
          unit(normals[0]!.get(best) ?? [0, 0, 0])[axis]! +
          unit(normals[1]!.get(best) ?? [0, 0, 0])[axis]!,
      ),
    );
    const direction =
      Math.hypot(...outward) > 0 ? outward : unit(seam.map((v, i) => v - middle[i]!));
    // A point exactly on both surfaces reads as hidden behind them, so sit just outside the seam.
    const world: Vector3 = [
      seam[0] + direction[0]! * SEAM_OFFSET,
      seam[1] + direction[1]! * SEAM_OFFSET,
      seam[2] + direction[2]! * SEAM_OFFSET,
    ];
    return {
      point: applyPoint(inverseAffine(subject.transform), world),
      normal: [direction[0]!, direction[1]!, direction[2]!],
    };
  } catch {
    // manifold-3d throws for meshes that are not closed, consistently oriented solids.
    return null;
  } finally {
    for (const solid of owned) solid.delete();
  }
};

/** How far a seam marker sits off the surfaces it joins, in meters. */
const SEAM_OFFSET = 0.0003;
const plainName = (name: string) => name.replace(/\s*<\d+>$/, "");

/**
 * Placements for the drivetrain findings whose spot the geometry proves: a spinning part running
 * into another part and two gears set so close they overlap (the seam of the overlap), and a belt or
 * chain with a bare end (that end of the loop).
 */
const drivetrainPlacements = (
  findings: readonly CadCheckFinding[],
  occurrences: readonly PartOccurrence[],
  parts: readonly CadDrivetrainPart[],
  overlaps: readonly CadOverlap[],
  solids: CadCheckSolids,
) => {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const recognized = new Map(parts.map((part) => [part.occurrenceId, part]));
  const overlapping = new Set(
    overlaps.map((overlap) =>
      overlap.occurrences
        .map((side) => side.occurrenceId)
        .sort()
        .join("|"),
    ),
  );
  const solidOf = (occurrenceId: string) => {
    const occurrence = byId.get(occurrenceId);
    const mesh = occurrence ? solids.meshes.get(occurrence.geometryKey) : null;
    return occurrence && mesh ? { mesh, transform: occurrence.transform } : null;
  };
  const placements = new Map<CadCheckFinding, CadCheckPlacement>();
  for (const finding of findings) {
    if (finding.check !== "drivetrain" || !finding.problem) continue;
    const [first, second] = finding.occurrences;
    if (
      (finding.kind === "collision" || finding.kind === "gear-mesh") &&
      first &&
      second &&
      overlapping.has([first.occurrenceId, second.occurrenceId].sort().join("|"))
    ) {
      const subject = solidOf(first.occurrenceId);
      const other = solidOf(second.occurrenceId);
      const seam = subject && other ? seamPoint(solids.kernel, subject, other) : null;
      if (seam)
        placements.set(finding, {
          occurrenceId: first.occurrenceId,
          ...seam,
          isolate: [first.occurrenceId, second.occurrenceId],
          expected: `where ${plainName(first.name)} meets ${plainName(second.name)}`,
        });
    }
    if (finding.kind === "loop" && first) {
      const belt = recognized.get(first.occurrenceId);
      const occurrence = byId.get(first.occurrenceId);
      const mesh = occurrence ? solids.meshes.get(occurrence.geometryKey) : null;
      const end =
        belt && occurrence && mesh
          ? beltEndPlacement(belt, mesh, occurrence.transform, parts)
          : null;
      if (end)
        placements.set(finding, {
          occurrenceId: first.occurrenceId,
          ...end,
          isolate: finding.occurrences.map((occurrence) => occurrence.occurrenceId),
          expected: `at the end of ${plainName(first.name)} that has no pulley`,
        });
    }
  }
  return placements;
};

/** Pure, deterministic pass over one snapshot. Same inputs always yield the same ordered findings. */
export const runCadChecks = (
  manifest: CadSnapshotManifest,
  bounds: ReadonlyMap<string, CadBounds | null>,
  checks: ReadonlySet<CadCheckName>,
  pairBudget: number = CAD_CHECK_LIMITS.pairBudget,
  solids?: CadCheckSolids,
) => {
  const occurrences = partOccurrences(manifest);
  const boxes = occurrences.flatMap((occurrence): WorldBox[] => {
    const world = worldCadBounds(occurrence.transform, bounds.get(occurrence.geometryKey));
    return world ? [{ ...world, occurrence }] : [];
  });
  const broad =
    checks.has("overlapping-bounds") || checks.has("mesh-interference")
      ? overlappingBoxes(boxes, pairBudget)
      : { pairs: [], pairsEvaluated: 0, budgetExhausted: false };
  const interference = checks.has("mesh-interference")
    ? meshInterference(manifest, occurrences, broad.pairs, solids)
    : { findings: [], meshUnknown: 0 };
  const parts =
    checks.has("drivetrain") && solids ? recognizeDrivetrainParts(occurrences, solids.meshes) : [];
  const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const recognized = new Map(parts.map((part) => [part.occurrenceId, part]));
  // Exact overlaps, with each side's axis, for the collision check and its placements.
  const overlaps: CadOverlap[] = interference.findings.flatMap((finding) => {
    const sides = finding.occurrences.map((side) => {
      const occurrence = byId.get(side.occurrenceId);
      const mesh = occurrence ? solids?.meshes.get(occurrence.geometryKey) : null;
      return {
        ...side,
        fit:
          recognized.get(side.occurrenceId)?.fit ??
          (occurrence && mesh ? fitCadAxis(mesh, occurrence.transform) : null),
      };
    });
    const [a, b] = sides;
    return a && b
      ? [
          {
            occurrences: [a, b],
            volume: finding.intersectionVolume,
            withinSubassembly: finding.withinSubassembly,
          },
        ]
      : [];
  });
  // Each drivetrain finding's student wording stays beside it, like its placement: the agent sees
  // the summary, and only a draft publishes the comment.
  const comments = new Map<CadCheckFinding, string>();
  const drivetrain =
    checks.has("drivetrain") && solids
      ? [...analyzeCadDrivetrain(parts), ...rotatingCollisions(parts, overlaps)]
          // Problems first; the sort is stable, so each group keeps occurrence order.
          .sort((a, b) => Number(b.problem) - Number(a.problem))
          .map(({ comment, ...finding }) => {
            const converted: CadCheckFinding = { check: "drivetrain", ...finding };
            if (comment !== undefined) comments.set(converted, comment);
            return converted;
          })
      : [];
  const placements = solids
    ? drivetrainPlacements(drivetrain, occurrences, parts, overlaps, solids)
    : new Map<CadCheckFinding, CadCheckPlacement>();
  const findings: CadCheckFinding[] = [
    ...drivetrain,
    ...interference.findings,
    ...(checks.has("overlapping-bounds") ? overlappingBounds(broad.pairs) : []),
    ...(checks.has("coincident-instances") ? coincidentInstances(occurrences) : []),
    ...(checks.has("degenerate-geometry") ? degenerateGeometry(occurrences, bounds) : []),
  ];
  return {
    findings,
    placements,
    comments,
    summary: {
      totalFindings: findings.length,
      partOccurrences: occurrences.length,
      boundsUnknown: occurrences.length - boxes.length,
      meshUnknown: interference.meshUnknown,
      pairsEvaluated: broad.pairsEvaluated,
      pairBudget,
      budgetExhausted: broad.budgetExhausted,
    },
  };
};

const invalid = (details: string) => new CadViewError({ reason: "invalid-operation", details });
const encodeFindingJson = Schema.encodeSync(Schema.fromJsonString(CadCheckFinding));
const encodeResultJson = Schema.encodeSync(Schema.fromJsonString(CadChecksResult));
const encodeDraftJson = Schema.encodeSync(Schema.fromJsonString(CadCheckDraft));
const significant = (value: number) => Number(value.toPrecision(4));
const significant3 = ([x, y, z]: Vector3): Vector3 => [
  significant(x),
  significant(y),
  significant(z),
];
/** A world box as sent to the agent, rounded like findings. Null if rounding overflows a coordinate. */
export const presentCadBounds = (bounds: CadBounds) => {
  const presented = {
    min: significant3(bounds.min),
    max: significant3(bounds.max),
    size: significant3(size(bounds)),
  };
  return Object.values(presented).flat().every(Number.isFinite) ? presented : null;
};
/** A finding as sent to the agent: four significant digits, since float noise only costs tokens. */
const presentFinding = (finding: CadCheckFinding): CadCheckFinding => {
  switch (finding.check) {
    case "mesh-interference":
      return {
        ...finding,
        intersectionVolume: significant(finding.intersectionVolume),
        intersectionFraction: significant(finding.intersectionFraction),
      };
    case "overlapping-bounds":
      return {
        ...finding,
        overlapSize: significant3(finding.overlapSize),
        overlapVolume: significant(finding.overlapVolume),
        overlapFraction: significant(finding.overlapFraction),
      };
    case "coincident-instances":
      return { ...finding, maxDeviation: significant(finding.maxDeviation) };
    case "degenerate-geometry":
      return { ...finding, size: finding.size && significant3(finding.size) };
    case "drivetrain":
      return finding;
  }
};
type DraftedKind = Exclude<
  Extract<CadCheckFinding, { check: "drivetrain" }>["kind"],
  "power-path" | "loop-length"
>;
// Each draft's body ends with a next step: a backstop comment is published as drafted, and a defect
// without one tells the student what is wrong but not what to do.
const DRAFT_LABELS = {
  "gear-mesh": {
    title: "Gears are at the wrong spacing",
    severity: "blocker",
    category: "interference",
  },
  loop: {
    title: "Belt or chain does not fit its pulleys",
    severity: "blocker",
    category: "assembly",
  },
  "shaft-support": { title: "Shaft has no bearing", severity: "blocker", category: "structure" },
  "stacked-shafts": { title: "Two shafts on one axis", severity: "concern", category: "assembly" },
  unpowered: { title: "Motor does not reach the rollers", severity: "blocker", category: "other" },
  collision: {
    title: "A spinning part runs into another part",
    severity: "blocker",
    category: "interference",
  },
  "motor-mount": {
    title: "Motor is not held by its plate",
    severity: "blocker",
    category: "assembly",
  },
} satisfies Record<DraftedKind, Pick<CadCheckDraft, "title" | "severity" | "category">>;
type MergedKind = "shaft-support" | "stacked-shafts" | "collision";
type DrivetrainFinding = Extract<CadCheckFinding, { check: "drivetrain" }>;
/**
 * Findings that state one problem across several parts share a key and become one comment with
 * several targets: every shaft without a bearing, every doubled shaft, and every spinning part
 * that runs into the same other part.
 */
const mergeKey = (finding: DrivetrainFinding) =>
  finding.kind === "shaft-support" || finding.kind === "stacked-shafts"
    ? finding.kind
    : finding.kind === "collision"
      ? `collision:${finding.occurrences[1]?.occurrenceId}`
      : null;
/**
 * A draft's key names the defect: its kind and parts on this snapshot. Every call that drafts the
 * defect on the snapshot gives it the same key, whichever other checks ran, and a new snapshot
 * gives new keys, so a later review in the chat never reuses a key published for another comment.
 */
const draftKey = (kind: string, snapshotId: string, targets: CadCheckDraft["targets"]) => {
  const parts = targets.flatMap((target) => (target.kind === "part" ? [target.occurrenceId] : []));
  const digest = NodeCrypto.createHash("sha256")
    .update([snapshotId, kind, ...parts.toSorted()].join("|"))
    .digest("hex");
  return `check-${kind}-${digest.slice(0, 6)}`;
};
const WHOLE_PART = "The problem is where this part sits, not one spot on it.";
/**
 * Draft bodies stop short of the 4000 characters a comment allows, so the note the backstop
 * appends (`BACKSTOP_NOTE`) always fits.
 */
const DRAFT_BODY_LIMIT = 3950;
/** A draft body: the problem, trimmed if it must be, then its whole next step. */
const withStep = (problem: string, step: string) =>
  `${problem.slice(0, DRAFT_BODY_LIMIT - step.length - 1)} ${step}`;
/**
 * The body of a merged draft, worded once for all its findings in the names a student would use.
 * A merged kind's findings only name parts, so the wording needs nothing else from them.
 */
const mergedBody = (kind: MergedKind, findings: readonly DrivetrainFinding[]) => {
  const several = findings.length > 1;
  switch (kind) {
    case "shaft-support": {
      // Each finding names its shaft first, then the parts on it.
      const shafts = countedList(
        findings.map(({ occurrences: [shaft, ...carried] }) =>
          carried.length > 0
            ? `${partPhrase(shaft!.name)} (which carries ${partList(carried.map((part) => part.name))})`
            : partPhrase(shaft!.name),
        ),
      );
      return several
        ? withStep(
            `${upperFirst(shafts)} have no bearings, so nothing holds them in line.`,
            "Add a bearing where each shaft passes through a plate.",
          )
        : withStep(
            `${upperFirst(shafts)} has no bearing, so nothing holds it in line.`,
            "Add a bearing where it passes through a plate.",
          );
    }
    case "stacked-shafts": {
      // Shafts modeled inside one another are one place: three copies of one shaft make three
      // pairs but one place. Places that read the same are counted (one on each roller).
      const parent = new Map<string, string>();
      const find = (id: string): string => {
        const up = parent.get(id) ?? id;
        return up === id ? id : find(up);
      };
      const names = new Map<string, string>();
      for (const { occurrences } of findings) {
        const [a, b] = occurrences;
        names.set(a!.occurrenceId, a!.name).set(b!.occurrenceId, b!.name);
        const [rootA, rootB] = [find(a!.occurrenceId), find(b!.occurrenceId)];
        if (rootA !== rootB) parent.set(rootA, rootB);
      }
      const groups = new Map<string, string[]>();
      for (const [id, name] of names) groups.set(find(id), [...(groups.get(find(id)) ?? []), name]);
      const places = new Map<string, number>();
      for (const group of groups.values()) {
        const inside =
          group.length === 2 ? "one modeled inside the other" : "modeled inside one another";
        const sentence = group.every((name) => partName(name) === partName(group[0]!))
          ? `${group.length === 2 ? "Two" : group.length} copies of ${partPhrase(group[0]!)} sit on the same axis, ${inside}`
          : `${upperFirst(joinAnd(distinctPhrases(group)))} sit on the same axis, ${inside}`;
        places.set(sentence, (places.get(sentence) ?? 0) + 1);
      }
      const most = Math.max(...[...groups.values()].map((group) => group.length));
      const step = `keep the shaft the parts are designed for and remove the ${most > 2 ? "others" : "other"}.`;
      return withStep(
        [...places]
          .map(([sentence, count]) => `${sentence}${count > 1 ? `, in ${count} places` : ""}.`)
          .join(" "),
        groups.size > 1 ? `In each place, ${step}` : upperFirst(step),
      );
    }
    case "collision": {
      const subjects = findings.map((finding) => finding.occurrences[0]!.name);
      const other = findings[0]!.occurrences[1]!.name;
      return withStep(
        `${upperFirst(partList(subjects))} ${several ? "run" : "runs"} into ${partPhrase(other)}, so ${several ? "they" : "it"} can't turn as drawn.`,
        "Move a part or cut clearance, then check the gap through a full turn.",
      );
    }
  }
};
type DraftPart = { readonly occurrenceId: string; readonly name: string };
/**
 * The body of a duplicate draft: a pair of parts in one place, or a stack of copies of one part.
 * Only occurrences of one part are called copies; the overlap alone proves where they sit.
 */
const duplicateBody = (parts: readonly DraftPart[]) => {
  const names = parts.map((part) => part.name);
  if (parts.length > 2)
    return `${parts.length} copies of ${partPhrase(names[0]!)} sit in the same place and overlap almost completely, so all but one are likely stale copies. Keep one and remove the others.`;
  if (partName(names[0]!) === partName(names[1]!))
    return `Two copies of ${partPhrase(names[0]!)} sit in the same place, one almost entirely inside the other, so one is likely a stale copy. Keep one and remove the other.`;
  const [a, b] = distinctPhrases(names);
  return withStep(
    `${upperFirst(a!)} and ${b!} sit in the same place, one almost entirely inside the other. One is likely a duplicate or stale copy, or a part in the wrong place.`,
    "Remove or move one.",
  );
};

/**
 * Publishable drafts for the defects the checks prove outright: drivetrain problems and near-total
 * duplicates. Partial collisions are left to the agent, because exact overlaps there mix real
 * problems (a gear through a tube) with tessellation noise (a bearing pressed into its plate).
 * Smaller models found these defects but rarely spent the effort to publish them; a draft makes
 * the right action one call. A duplicate whose parts a drivetrain draft already names is skipped.
 * Bodies are written for the student, since a draft may be published as offered: a drivetrain
 * finding brings its own `comments` entry, and merged and duplicate drafts are worded here.
 */
export const draftCadComments = (
  findings: readonly CadCheckFinding[],
  snapshotId: CadCheckDraft["inspectedSnapshotId"],
  placements: ReadonlyMap<CadCheckFinding, CadCheckPlacement> = new Map(),
  comments: ReadonlyMap<CadCheckFinding, string> = new Map(),
): CadCheckDraft[] => {
  const names = new Map<string, string>();
  const target = (occurrence: DraftPart) => {
    names.set(occurrence.occurrenceId, occurrence.name);
    return {
      kind: "part" as const,
      label: occurrence.name.replace(/\s*<\d+>$/, "").slice(0, 120),
      occurrenceId: occurrence.occurrenceId,
      preciseLocationLimitation: WHOLE_PART,
    };
  };
  const partOf = (occurrence: DraftPart): DraftPart => ({
    occurrenceId: occurrence.occurrenceId,
    name: occurrence.name,
  });
  const drafts: CadCheckDraft[] = [];
  const merged = new Map<
    string,
    { kind: MergedKind; draft: CadCheckDraft; findings: DrivetrainFinding[] }
  >();
  const named = new Set<string>();
  for (const finding of findings) {
    // A length mismatch is a finding, not a draft: its fix depends on parts the check cannot see.
    if (
      finding.check !== "drivetrain" ||
      !finding.problem ||
      finding.kind === "power-path" ||
      finding.kind === "loop-length"
    )
      continue;
    for (const occurrence of finding.occurrences) named.add(occurrence.occurrenceId);
    // A bearing draft is about the shaft; the parts it carries are named in the text. Targeting
    // them too would let an unrelated comment on a carried gear count as covering this draft.
    const subjects =
      finding.kind === "shaft-support" ? finding.occurrences.slice(0, 1) : finding.occurrences;
    const targets = subjects.slice(0, 20).map(target);
    const placement = placements.get(finding);
    const key = mergeKey(finding);
    const prior = key === null ? undefined : merged.get(key);
    if (prior) {
      const known = new Set(
        prior.draft.targets.flatMap((t) => (t.kind === "part" ? [t.occurrenceId] : [])),
      );
      prior.findings.push(finding);
      prior.draft = {
        ...prior.draft,
        targets: [
          ...prior.draft.targets,
          ...targets.filter((t) => !known.has(t.occurrenceId)),
        ].slice(0, 20),
        ...(placement || prior.draft.placements
          ? {
              placements: [
                ...(prior.draft.placements ?? []),
                ...(placement ? [placement] : []),
              ].slice(0, 20),
            }
          : {}),
      };
      continue;
    }
    const draft: CadCheckDraft = {
      kind: "new",
      // A merged draft's key and body are set below, once all its parts are known.
      publicationKey: draftKey(finding.kind, snapshotId, targets),
      inspectedSnapshotId: snapshotId,
      ...DRAFT_LABELS[finding.kind],
      body: (comments.get(finding) ?? finding.summary).slice(0, DRAFT_BODY_LIMIT),
      targets,
      ...(placement ? { placements: [placement] } : {}),
    };
    if (
      finding.kind === "shaft-support" ||
      finding.kind === "stacked-shafts" ||
      finding.kind === "collision"
    )
      merged.set(key!, { kind: finding.kind, draft, findings: [finding] });
    else drafts.push(draft);
  }
  // A merged draft is worded once, after every instance. A collision's title names its parts.
  for (const { kind, draft, findings: group } of merged.values()) {
    const subjects = group.map((finding) => partLabel(finding.occurrences[0]!.name));
    const other = group[0]!.occurrences[1]?.name;
    const title =
      kind === "collision" && other
        ? upperFirst(
            `${countedList(subjects)} ${subjects.length > 1 ? "run" : "runs"} into ${partLabel(other)}`,
          ).slice(0, 160)
        : draft.title;
    drafts.push({
      ...draft,
      title,
      publicationKey: draftKey(kind, snapshotId, draft.targets),
      body: mergedBody(kind, group),
    });
  }
  // Copies of one part form stacks: one draft per stack, not one per pair. Same-named parts that
  // overlap are grouped, and a group becomes one stack only when every two of its parts overlap;
  // otherwise, and for parts of different names (a spacer inside two bearings, two parts inside one
  // plate), each overlapping pair is its own draft.
  const pairs: { a: DraftPart; b: DraftPart }[] = [];
  const overlapping = new Set<string>();
  for (const finding of findings) {
    if (
      finding.check !== "mesh-interference" ||
      finding.withinSubassembly ||
      finding.intersectionFraction < 0.9 ||
      finding.occurrences.every((occurrence) => named.has(occurrence.occurrenceId)) ||
      readOverlap(finding.occurrences[0]!.name, finding.occurrences[1]?.name ?? "", 0, 1, false)
        .rank !== 0
    )
      continue;
    const [a, b] = [partOf(finding.occurrences[0]!), partOf(finding.occurrences[1]!)];
    pairs.push({ a, b });
    overlapping
      .add(`${a.occurrenceId} ${b.occurrenceId}`)
      .add(`${b.occurrenceId} ${a.occurrenceId}`);
  }
  const baseName = (part: DraftPart) => partName(part.name);
  const groupOf = new Map<string, string>();
  const root = (id: string): string => {
    const up = groupOf.get(id) ?? id;
    return up === id ? id : root(up);
  };
  for (const { a, b } of pairs)
    if (baseName(a) === baseName(b)) groupOf.set(root(a.occurrenceId), root(b.occurrenceId));
  const groups = new Map<string, Map<string, DraftPart>>();
  for (const { a, b } of pairs)
    if (baseName(a) === baseName(b)) {
      const group = groups.get(root(a.occurrenceId)) ?? new Map();
      groups.set(root(a.occurrenceId), group.set(a.occurrenceId, a).set(b.occurrenceId, b));
    }
  const isStack = (group: Map<string, DraftPart>) => {
    const ids = [...group.keys()];
    return ids.every((x, i) => ids.slice(i + 1).every((y) => overlapping.has(`${x} ${y}`)));
  };
  // Each stacked part's group, so only pairs inside one stack are left out below.
  const stacked = new Map<string, string>();
  const duplicateDraft = (parts: readonly DraftPart[]) => {
    const targets = parts.slice(0, 20).map(target);
    drafts.push({
      kind: "new",
      publicationKey: draftKey("duplicate", snapshotId, targets),
      inspectedSnapshotId: snapshotId,
      title: "Duplicate part",
      body: duplicateBody(parts),
      severity: "concern",
      category: "assembly",
      targets,
    });
  };
  for (const group of groups.values())
    if (group.size > 2 && isStack(group)) {
      duplicateDraft([...group.values()]);
      for (const id of group.keys()) stacked.set(id, root(id));
    }
  for (const { a, b } of pairs)
    if (
      stacked.get(a.occurrenceId) === undefined ||
      stacked.get(a.occurrenceId) !== stacked.get(b.occurrenceId)
    )
      duplicateDraft([a, b]);
  // Where two targets of one draft read the same, as three copies of one rounded hex shaft do,
  // their labels keep the instance number (`<2>`).
  return drafts.map((draft) => {
    const labels = draft.targets.map((target) => target.label);
    return labels.every((label, index) => labels.indexOf(label) === index)
      ? draft
      : {
          ...draft,
          targets: draft.targets.map((target) =>
            target.kind === "part" && labels.filter((label) => label === target.label).length > 1
              ? { ...target, label: (names.get(target.occurrenceId) ?? target.label).slice(0, 120) }
              : target,
          ),
        };
  });
};

/** Exact interference replaces bounding-box leads unless the agent asks for them. */
export const CAD_DEFAULT_CHECKS: readonly CadCheckName[] = CAD_CHECK_NAMES.filter(
  (name) => name !== "overlapping-bounds",
);
/** Per-asset geometry readers, keyed by geometry key. */
export interface CadCheckGeometry {
  readonly bounds: (
    geometryKeys: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyMap<string, CadBounds | null>, CadViewError>;
  readonly meshes: (
    geometryKeys: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyMap<string, CadTriangleMesh | null>, CadViewError>;
}
/** Tool entry point. Cursors are bound to the snapshot and the selected checks, like cad_hierarchy. */
export const readCadChecks = Effect.fn("readCadChecks")(function* (
  manifest: CadSnapshotManifest,
  state: CadViewState,
  geometry: CadCheckGeometry,
  rawInput: unknown,
): Effect.fn.Return<CadChecksResult, CadViewError> {
  const input = yield* decodeCadToolInput(CadChecksInput, rawInput);
  if (input.expectedRevision !== state.revision)
    return yield* new CadViewError({ reason: "revision-conflict" });
  const selected = new Set(input.checks ?? CAD_DEFAULT_CHECKS);
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
  const keys = new Set(partOccurrences(manifest).map((occurrence) => occurrence.geometryKey));
  const needsBounds =
    selected.has("mesh-interference") ||
    selected.has("overlapping-bounds") ||
    selected.has("degenerate-geometry");
  const bounds = needsBounds ? yield* geometry.bounds(keys) : new Map<string, CadBounds | null>();
  const solids =
    selected.has("mesh-interference") || selected.has("drivetrain")
      ? { meshes: yield* geometry.meshes(keys), kernel: yield* loadCadSolidKernel }
      : undefined;
  const { findings, summary, placements, comments } = runCadChecks(
    manifest,
    bounds,
    selected,
    CAD_CHECK_LIMITS.pairBudget,
    solids,
  );
  if (!Number.isSafeInteger(offset) || offset > findings.length)
    return yield* invalid("cursor is past the end of the findings. Start again without a cursor.");
  const explanations = Object.fromEntries(
    checks.map((check) => [check, CAD_CHECK_EXPLANATIONS[check]]),
  );
  const limit = input.limit ?? CAD_CHECK_LIMITS.pageSize;
  const bytes = (value: CadCheckFinding | CadChecksResult) =>
    new TextEncoder().encode("check" in value ? encodeFindingJson(value) : encodeResultJson(value))
      .byteLength;
  // Drafts get at most half the page, in the order they are drafted (drivetrain problems first),
  // so a model with dozens of duplicates still fits; the findings list every problem regardless.
  const drafts: CadCheckDraft[] = [];
  let draftBytes = 0;
  for (const draft of offset === 0
    ? draftCadComments(findings, state.snapshotId, placements, comments)
    : []) {
    draftBytes += new TextEncoder().encode(encodeDraftJson(draft)).byteLength + 1;
    if (draftBytes > CAD_CHECK_LIMITS.pageBytes / 2) break;
    drafts.push(draft);
  }
  const withDrafts = drafts.length > 0 ? { drafts } : {};
  // Reserve room for the longest cursor this page could carry, then add findings until the budget runs out.
  let used = bytes({
    revision: state.revision,
    snapshotId: state.snapshotId,
    checks,
    explanations,
    findings: [],
    ...withDrafts,
    nextCursor: `${prefix}${findings.length}`,
    summary,
  });
  const page: CadCheckFinding[] = [];
  let end = offset;
  while (end < findings.length && page.length < limit) {
    const finding = presentFinding(findings[end]!);
    const cost = bytes(finding) + (page.length > 0 ? 1 : 0);
    if (page.length > 0 && used + cost > CAD_CHECK_LIMITS.pageBytes) break;
    page.push(finding);
    used += cost;
    end++;
  }
  return {
    revision: state.revision,
    snapshotId: state.snapshotId,
    checks,
    explanations,
    findings: page,
    ...withDrafts,
    nextCursor: end < findings.length ? `${prefix}${end}` : null,
    summary,
  };
});
