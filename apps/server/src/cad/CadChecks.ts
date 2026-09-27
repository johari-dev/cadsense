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
import Module from "manifold-3d";
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
          explanation: explanations["overlapping-bounds"],
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
    const findings = pairs.flatMap(
      ({ a, b }): Extract<CadCheckFinding, { check: "mesh-interference" }>[] => {
        const solidA = localSolid(a.occurrence.geometryKey);
        const solidB = localSolid(b.occurrence.geometryKey);
        if (!solidA || !solidB) return [];
        const placedA = place(a.occurrence, solidA);
        const placedB = place(b.occurrence, solidB);
        const common = placedA.intersect(placedB);
        owned.push(common);
        const intersectionVolume = common.volume();
        if (intersectionVolume <= CAD_CHECK_LIMITS.overlapVolume) return [];
        return [
          {
            check: "mesh-interference",
            occurrences: pair(a.occurrence, b.occurrence),
            intersectionVolume,
            intersectionFraction: Math.min(
              1,
              intersectionVolume / Math.min(placedA.volume(), placedB.volume()),
            ),
            withinSubassembly: within(a.occurrence.occurrenceId, b.occurrence.occurrenceId),
            explanation: explanations["mesh-interference"],
          },
        ];
      },
    );
    findings.sort(
      (a, b) =>
        Number(a.withinSubassembly) - Number(b.withinSubassembly) ||
        b.intersectionVolume - a.intersectionVolume ||
        byPair(a, b),
    );
    return { findings, meshUnknown };
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
  solids?: CadCheckSolids,
) => {
  const occurrences = partOccurrences(manifest);
  const boxes = occurrences.flatMap((occurrence): WorldBox[] => {
    const local = bounds.get(occurrence.geometryKey);
    if (!local) return [];
    const world = transformBounds(occurrence.transform, local);
    return isFiniteBounds(world) ? [{ ...world, occurrence }] : [];
  });
  const broad =
    checks.has("overlapping-bounds") || checks.has("mesh-interference")
      ? overlappingBoxes(boxes, pairBudget)
      : { pairs: [], pairsEvaluated: 0, budgetExhausted: false };
  const interference = checks.has("mesh-interference")
    ? meshInterference(manifest, occurrences, broad.pairs, solids)
    : { findings: [], meshUnknown: 0 };
  const findings: CadCheckFinding[] = [
    ...interference.findings,
    ...(checks.has("overlapping-bounds") ? overlappingBounds(broad.pairs) : []),
    ...(checks.has("coincident-instances") ? coincidentInstances(occurrences) : []),
    ...(checks.has("degenerate-geometry") ? degenerateGeometry(occurrences, bounds) : []),
  ];
  return {
    findings,
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
  const solids = selected.has("mesh-interference")
    ? { meshes: yield* geometry.meshes(keys), kernel: yield* loadCadSolidKernel }
    : undefined;
  const { findings, summary } = runCadChecks(
    manifest,
    bounds,
    selected,
    CAD_CHECK_LIMITS.pairBudget,
    solids,
  );
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
