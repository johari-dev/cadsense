import {
  type CadCheckFinding,
  CadSnapshotId,
  CadSnapshotManifest,
  ProjectId,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAD_CHECK_EXPLANATIONS,
  draftCadComments,
  readOverlap,
  CAD_CHECK_LIMITS,
  loadCadBounds,
  loadCadSolidKernel,
  readCadChecks,
  readCadGeometryBounds,
  readCadTriangleMesh,
  runCadChecks,
  type CadBounds,
  type CadTriangleMesh,
} from "./CadChecks.ts";
import { initialCadView } from "./CadViewState.ts";

const id = (value: number) => value.toString(16).padStart(64, "0");
const snapshotId = "00000000-0000-4000-8000-000000000001";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number, z: number) => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];
/** Quarter turn about Z followed by a translation, row-major like Onshape occurrence transforms. */
const rotateZ90 = (x: number, y: number, z: number) => [
  0,
  -1,
  0,
  x,
  1,
  0,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];
const box = (max: readonly [number, number, number]): CadBounds => ({ min: [0, 0, 0], max });
// Adding zero folds negative zero from rotations into plain zero for deep equality.
const rounded = (values: readonly number[]) => values.map((value) => Number(value.toFixed(9)) + 0);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** JSON-only GLB container; bounds reading never touches the binary chunk. */
const glb = (document: unknown) => {
  const json = new TextEncoder().encode(encodeJson(document));
  const length = Math.ceil(json.length / 4) * 4;
  const output = new Uint8Array(20 + length);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20);
  output.set(json, 20);
  return output;
};
type Point = readonly [number, number, number];
/** Outward-wound triangles of an axis-aligned box; vertex i has bit 0 = X max, bit 1 = Y max, bit 2 = Z max. */
const BOX_TRIANGLES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
const boxPrimitive = (min: Point, max: Point, faces = 12) => ({
  positions: Array.from({ length: 8 }, (_, i) => [
    i & 1 ? max[0] : min[0],
    i & 2 ? max[1] : min[1],
    i & 4 ? max[2] : min[2],
  ]).flat(),
  indices: BOX_TRIANGLES.slice(0, faces * 3),
});
interface Primitive {
  readonly positions: readonly number[];
  readonly indices?: readonly number[];
  readonly indexType?: 5121 | 5123 | 5125;
  readonly mode?: number;
}
/** GLB with a binary chunk: one mesh per primitive, each on its own root node unless `nodes` is given. */
const meshGlb = (primitives: readonly Primitive[], nodes?: readonly object[]) => {
  const chunks: Uint8Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let byteLength = 0;
  const push = (bytes: Uint8Array) => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength });
    chunks.push(bytes);
    byteLength += Math.ceil(bytes.byteLength / 4) * 4;
    return bufferViews.length - 1;
  };
  const meshes = primitives.map((primitive) => {
    const positions = new Float32Array(primitive.positions);
    const axis = (k: number) => primitive.positions.filter((_, i) => i % 3 === k);
    accessors.push({
      bufferView: push(new Uint8Array(positions.buffer)),
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min: [0, 1, 2].map((k) => Math.min(...axis(k))),
      max: [0, 1, 2].map((k) => Math.max(...axis(k))),
    });
    const attributes = { POSITION: accessors.length - 1 };
    if (!primitive.indices) return { primitives: [{ attributes, mode: primitive.mode }] };
    const type = primitive.indexType ?? 5125;
    const Array_ = type === 5121 ? Uint8Array : type === 5123 ? Uint16Array : Uint32Array;
    const indices = new Array_(primitive.indices);
    accessors.push({
      bufferView: push(new Uint8Array(indices.buffer)),
      componentType: type,
      count: indices.length,
      type: "SCALAR",
    });
    return { primitives: [{ attributes, indices: accessors.length - 1, mode: primitive.mode }] };
  });
  const json = new TextEncoder().encode(
    encodeJson({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: nodes ? [0] : primitives.map((_, i) => i) }],
      nodes: nodes ?? primitives.map((_, i) => ({ mesh: i })),
      meshes,
      accessors,
      bufferViews,
      buffers: [{ byteLength }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const output = new Uint8Array(20 + jsonLength + 8 + byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  view.setUint32(20 + jsonLength, byteLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  let offset = 28 + jsonLength;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += Math.ceil(chunk.byteLength / 4) * 4;
  }
  return output;
};
const solidBox = (min: Point, max: Point) => meshGlb([boxPrimitive(min, max)]);
/** Outward-wound closed cylinder along local Z, centered on the origin. */
const solidCylinder = (radius: number, length: number, segments = 32) => {
  const positions: number[] = [];
  for (const z of [-length / 2, length / 2])
    for (let i = 0; i < segments; i++) {
      const angle = (2 * Math.PI * i) / segments;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
  positions.push(0, 0, -length / 2, 0, 0, length / 2);
  const n = segments;
  const indices = Array.from({ length: n }, (_, i) => {
    const j = (i + 1) % n;
    return [i, j, n + j, i, n + j, n + i, 2 * n, j, i, 2 * n + 1, n + i, n + j];
  }).flat();
  return meshGlb([{ positions, indices }]);
};
interface Occurrence {
  readonly number: number;
  readonly name?: string;
  readonly part?: number;
  readonly parent?: number;
  readonly transform?: number[];
  readonly suppressed?: boolean;
  readonly kind?: "assembly" | "part";
}
const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const manifest = (occurrences: readonly Occurrence[], assetParts: readonly number[] = []) =>
  decodeManifest({
    schemaVersion: 1,
    snapshotId,
    rootId: id(1000),
    projectId: ProjectId.make("test"),
    createdAt: "2026-09-05T00:00:00Z",
    root: {
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      elementId: "b".repeat(24),
      kind: "assembly",
      originalRevision: { kind: "w", id: "c".repeat(24) },
      microversionId: "d".repeat(24),
      configuration: "default",
      tessellationProfile: "test",
    },
    nodes: occurrences.map((occurrence) => ({
      id: id(occurrence.number),
      parentId: occurrence.parent === undefined ? null : id(occurrence.parent),
      name: occurrence.name ?? `Occurrence ${occurrence.number}`,
      occurrencePath: [String(occurrence.number)],
      instanceId: String(occurrence.number),
      kind: occurrence.kind ?? (occurrence.part === undefined ? "assembly" : "part"),
      suppressed: occurrence.suppressed ?? false,
      defaultVisible: true,
      transform: occurrence.transform ?? identity,
      sourcePartKey: occurrence.part === undefined ? null : id(occurrence.part),
    })),
    parts: [...new Set(occurrences.flatMap((o) => (o.part === undefined ? [] : [o.part])))].map(
      (part) => ({
        geometryKey: id(part),
        source: {
          host: "https://cad.onshape.com",
          documentId: "a".repeat(24),
          documentMicroversion: "d".repeat(24),
          documentVersion: null,
          elementId: "e".repeat(24),
          configuration: "default",
          fullConfiguration: "default",
          partId: `P${part}`,
          tessellationProfile: "test",
        },
        geometryRequired: assetParts.includes(part),
        metadata: assetParts.includes(part)
          ? {
              name: `Part ${part}`,
              bodyType: "solid",
              isHidden: null,
              isMesh: null,
              partIdentity: null,
              configurationId: null,
              appearance: null,
              material: null,
            }
          : null,
      }),
    ),
    dependencies: [],
    assets: assetParts.map((part) => ({
      geometryKey: id(part),
      sha256: id(part + 500),
      byteLength: 1,
      format: "glb",
      relativePath: `${id(part + 500)}.glb`,
    })),
  });
const all = new Set(["overlapping-bounds", "coincident-instances", "degenerate-geometry"] as const);
const overlaps = (result: ReturnType<typeof runCadChecks>) =>
  result.findings.flatMap((finding) => (finding.check === "overlapping-bounds" ? [finding] : []));
const pairKey = (finding: { occurrences: readonly { occurrenceId: string }[] }) =>
  finding.occurrences.map((occurrence) => occurrence.occurrenceId).join("|");

describe("CAD geometry bounds", () => {
  it("composes glTF node matrices and TRS onto POSITION accessor bounds", () => {
    const bounds = readCadGeometryBounds(
      glb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          { translation: [0.1, 0, 0], children: [1, 2] },
          // Column-major matrix scaling by 2 on X.
          { mesh: 0, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
          // Quarter turn about Z maps the unit box onto negative X.
          { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
      }),
    );
    assert.isNotNull(bounds);
    assert.deepEqual(rounded(bounds!.min), [-0.9, 0, 0]);
    assert.deepEqual(rounded(bounds!.max), [2.1, 1, 1]);
  });
  it("returns unknown bounds for containers it cannot measure", () => {
    const document = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
    };
    assert.isNull(readCadGeometryBounds(new Uint8Array([1, 2, 3])));
    assert.isNull(readCadGeometryBounds(glb({ ...document, scenes: undefined })));
    assert.isNull(readCadGeometryBounds(glb({ ...document, accessors: [{ min: [0, 0, 0] }] })));
    assert.isNull(
      readCadGeometryBounds(
        glb({ ...document, accessors: [{ ...document.accessors[0], normalized: true }] }),
      ),
    );
    assert.isNull(readCadGeometryBounds(glb({ ...document, nodes: [{ mesh: 0, children: [0] }] })));
    assert.deepEqual(readCadGeometryBounds(glb(document)), box([1, 1, 1]));
  });
});

describe("CAD checks", () => {
  it("reports overlapping boxes with their overlap and skips boxes that only touch", () => {
    const result = runCadChecks(
      manifest([
        { number: 1, part: 10, name: "Plate" },
        { number: 2, part: 11, name: "Block", transform: translate(0.08, 0.005, 0) },
        { number: 3, part: 11, name: "Touching", transform: translate(0, 0, -0.05) },
        { number: 4, part: 11, name: "Apart", transform: translate(0.5, 0, 0) },
      ]),
      new Map([
        [id(10), box([0.1, 0.05, 0.01])],
        [id(11), box([0.05, 0.05, 0.05])],
      ]),
      all,
    );
    assert.deepEqual(result.summary, {
      totalFindings: 1,
      partOccurrences: 4,
      boundsUnknown: 0,
      meshUnknown: 0,
      pairsEvaluated: 2,
      pairBudget: CAD_CHECK_LIMITS.pairBudget,
      budgetExhausted: false,
    });
    const [finding] = overlaps(result);
    assert.deepEqual(finding!.occurrences, [
      { occurrenceId: id(1), name: "Plate" },
      { occurrenceId: id(2), name: "Block" },
    ]);
    assert.deepEqual(rounded(finding!.overlapSize), [0.02, 0.045, 0.01]);
    assert.closeTo(finding!.overlapVolume, 0.02 * 0.045 * 0.01, 1e-12);
    assert.closeTo(finding!.overlapFraction, (0.02 * 0.045 * 0.01) / (0.1 * 0.05 * 0.01), 1e-9);
    assert.isFalse(finding!.contained);
    assert.include(CAD_CHECK_EXPLANATIONS["overlapping-bounds"], "not proof");
  });
  it("flags a part nested inside another as contained and applies occurrence rotation", () => {
    // Rotated 90 degrees about Z at x=0.15, the bar occupies x in [0.05, 0.15] and y in [0, 0.5].
    // Without the rotation it would start at x=0.15 and miss the housing entirely.
    const result = runCadChecks(
      manifest([
        { number: 1, part: 10, name: "Housing" },
        { number: 2, part: 11, name: "Bearing", transform: translate(0.02, 0.02, 0.02) },
        { number: 3, part: 12, name: "Bar", transform: rotateZ90(0.15, 0, 0) },
      ]),
      new Map([
        [id(10), box([0.1, 0.1, 0.1])],
        [id(11), box([0.03, 0.03, 0.03])],
        [id(12), box([0.5, 0.1, 0.1])],
      ]),
      new Set(["overlapping-bounds"]),
    );
    const findings = overlaps(result);
    assert.deepEqual(
      findings.map((finding) => [pairKey(finding), finding.contained]),
      [
        [`${id(1)}|${id(3)}`, false],
        [`${id(1)}|${id(2)}`, true],
      ],
    );
    assert.equal(findings[1]!.overlapFraction, 1);
    assert.deepEqual(rounded(findings[0]!.overlapSize), [0.05, 0.1, 0.1]);
  });
  it("ignores suppressed occurrences and everything under a suppressed assembly", () => {
    const result = runCadChecks(
      manifest([
        { number: 1, part: 10, name: "Kept" },
        { number: 2, part: 10, name: "Suppressed", suppressed: true },
        { number: 3, name: "Suppressed subassembly", suppressed: true },
        { number: 4, part: 10, name: "Child of suppressed", parent: 3 },
      ]),
      new Map([[id(10), box([0.1, 0.1, 0.1])]]),
      all,
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.summary.partOccurrences, 1);
  });
  it("reports duplicate placements of one part but not moved instances or other parts", () => {
    const result = runCadChecks(
      manifest([
        { number: 1, part: 10, name: "Screw" },
        { number: 2, part: 10, name: "Screw", transform: translate(2e-7, 0, 0) },
        { number: 3, part: 10, name: "Screw", transform: translate(0.001, 0, 0) },
        { number: 4, part: 11, name: "Washer" },
      ]),
      new Map(),
      new Set(["coincident-instances"]),
    );
    assert.lengthOf(result.findings, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.check, "coincident-instances");
    assert.equal(pairKey(finding), `${id(1)}|${id(2)}`);
    if (finding.check === "coincident-instances") assert.closeTo(finding.maxDeviation, 2e-7, 1e-12);
    assert.equal(result.summary.boundsUnknown, 4);
  });
  it("reports flat parts with their size and unmeasured parts with null bounds", () => {
    const result = runCadChecks(
      manifest([
        { number: 1, part: 10, name: "Sheet" },
        { number: 2, part: 11, name: "Unknown" },
        { number: 3, part: 12, name: "Solid" },
      ]),
      new Map([
        [id(10), box([0.1, 0.1, 0])],
        [id(11), null],
        [id(12), box([0.1, 0.1, 0.1])],
      ]),
      new Set(["degenerate-geometry"]),
    );
    assert.deepEqual(
      result.findings.map((finding) => finding.check === "degenerate-geometry" && finding.size),
      [[0.1, 0.1, 0], null],
    );
    assert.equal(result.summary.boundsUnknown, 1);
  });
  it("matches brute force on random boxes and stops evaluating pairs at the budget", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const occurrences = Array.from({ length: 300 }, (_, index) => ({
      number: index + 1,
      part: 1000 + index,
      transform: translate(random(), random(), random()),
    }));
    const bounds = new Map(
      occurrences.map((occurrence) => [
        id(occurrence.part),
        box([random() * 0.2, random() * 0.2, random() * 0.2]),
      ]),
    );
    const world = occurrences.map((occurrence) => {
      const local = bounds.get(id(occurrence.part))!;
      const [x, y, z] = [
        occurrence.transform[3]!,
        occurrence.transform[7]!,
        occurrence.transform[11]!,
      ];
      return {
        id: id(occurrence.number),
        min: [x, y, z],
        max: [x + local.max[0], y + local.max[1], z + local.max[2]],
      };
    });
    const expected = new Set<string>();
    for (const a of world)
      for (const b of world) {
        if (a.id >= b.id) continue;
        const overlap = [0, 1, 2].map(
          (axis) => Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!),
        );
        if (overlap.every((value) => value > 0) && overlap[0]! * overlap[1]! * overlap[2]! > 1e-9)
          expected.add(`${a.id}|${b.id}`);
      }
    const full = runCadChecks(manifest(occurrences), bounds, new Set(["overlapping-bounds"]));
    assert.isAbove(expected.size, 50);
    assert.deepEqual(new Set(overlaps(full).map(pairKey)), expected);
    assert.isFalse(full.summary.budgetExhausted);
    assert.isBelow(full.summary.pairsEvaluated, (300 * 299) / 2);
    const budget = full.summary.pairsEvaluated - 1;
    const capped = runCadChecks(
      manifest(occurrences),
      bounds,
      new Set(["overlapping-bounds"]),
      budget,
    );
    assert.deepEqual(capped.summary, {
      ...full.summary,
      totalFindings: capped.findings.length,
      pairsEvaluated: budget,
      pairBudget: budget,
      budgetExhausted: true,
    });
    assert.isAtMost(capped.findings.length, full.findings.length);
    assert.deepEqual(
      runCadChecks(manifest(occurrences), bounds, new Set(["overlapping-bounds"]), budget),
      capped,
    );
  });
  it.effect("loads bounds once per asset and treats missing or oversized assets as unknown", () =>
    Effect.gen(function* () {
      const snapshot = manifest(
        [
          { number: 1, part: 10 },
          { number: 2, part: 11 },
          { number: 3, part: 12 },
        ],
        [10, 11],
      );
      const oversized = {
        ...snapshot,
        assets: snapshot.assets.map((asset) =>
          asset.geometryKey === id(11) ? { ...asset, byteLength: 129 * 1024 * 1024 } : asset,
        ),
      };
      const reads: string[] = [];
      const cache = new Map<string, CadBounds | null>();
      const readAsset = (sha256: string) =>
        Effect.sync(() => {
          reads.push(sha256);
          return glb({
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            accessors: [{ min: [0, 0, 0], max: [1, 2, 3] }],
          });
        });
      const keys = new Set([id(10), id(11), id(12)]);
      const first = yield* loadCadBounds(oversized, readAsset, cache, keys);
      assert.deepEqual(
        [...first.entries()],
        [
          [id(10), box([1, 2, 3])],
          [id(11), null],
          [id(12), null],
        ],
      );
      yield* loadCadBounds(oversized, readAsset, cache, keys);
      assert.deepEqual(reads, [id(510)]);
    }),
  );
});

describe("CAD triangle meshes", () => {
  it("composes node matrices and TRS onto indexed and unindexed triangles", () => {
    const mesh = readCadTriangleMesh(
      meshGlb(
        [boxPrimitive([0, 0, 0], [1, 1, 1])],
        [
          { translation: [0.1, 0, 0], children: [1, 2] },
          { mesh: 0, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
          { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        ],
      ),
    );
    assert.isNotNull(mesh);
    assert.equal(mesh!.indices.length, 72);
    const xs = [...mesh!.positions].filter((_, i) => i % 3 === 0);
    assert.deepEqual(rounded([Math.min(...xs), Math.max(...xs)]), [-0.9, 2.1]);
    const flat = boxPrimitive([0, 0, 0], [1, 1, 1]);
    const unindexed = readCadTriangleMesh(
      meshGlb([{ positions: flat.indices.flatMap((i) => flat.positions.slice(i * 3, i * 3 + 3)) }]),
    );
    assert.equal(unindexed!.indices.length, 36);
    for (const indexType of [5121, 5123, 5125] as const)
      assert.deepEqual(
        [...readCadTriangleMesh(meshGlb([{ ...flat, indexType }]))!.indices],
        flat.indices,
      );
  });
  it("returns null instead of misreading geometry it does not support", () => {
    const flat = boxPrimitive([0, 0, 0], [1, 1, 1]);
    assert.isNull(readCadTriangleMesh(new Uint8Array([1, 2, 3])));
    // JSON-only container: no binary chunk to read triangles from.
    assert.isNull(
      readCadTriangleMesh(
        glb({
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
        }),
      ),
    );
    // Lines are not triangles.
    assert.isNull(readCadTriangleMesh(meshGlb([{ ...flat, mode: 1 }])));
    // An index past the vertex count.
    assert.isNull(
      readCadTriangleMesh(meshGlb([{ ...flat, indices: [...flat.indices, 0, 1, 99] }])),
    );
  });
});

describe("mesh interference", () => {
  const checks = new Set(["mesh-interference"] as const);
  /** Runs one snapshot whose part N uses the GLB at index N - 10 of `assets`. */
  const run = (
    occurrences: readonly Occurrence[],
    assets: readonly Uint8Array[],
    selection: ReadonlySet<"mesh-interference" | "overlapping-bounds"> = checks,
  ) =>
    Effect.gen(function* () {
      const parts = assets.map((_, index) => index + 10);
      const snapshot = manifest(occurrences, parts);
      const bounds = new Map(parts.map((part, i) => [id(part), readCadGeometryBounds(assets[i]!)]));
      const meshes = new Map(parts.map((part, i) => [id(part), readCadTriangleMesh(assets[i]!)]));
      const kernel = yield* loadCadSolidKernel;
      return runCadChecks(snapshot, bounds, selection, undefined, { meshes, kernel });
    });
  const interference = (result: ReturnType<typeof runCadChecks>) =>
    result.findings.flatMap((finding) => (finding.check === "mesh-interference" ? [finding] : []));

  it.effect("reports the exact intersection volume and skips solids that only touch", () =>
    Effect.gen(function* () {
      const cube = solidBox([0, 0, 0], [0.1, 0.1, 0.1]);
      const result = yield* run(
        [
          { number: 1, part: 10 },
          { number: 2, part: 10, transform: translate(0.05, 0.05, 0.05) },
          { number: 3, part: 10, transform: translate(-0.1, 0, 0) },
        ],
        [cube],
      );
      const found = interference(result);
      assert.equal(found.length, 1);
      assert.equal(pairKey(found[0]!), `${id(1)}|${id(2)}`);
      // GLB vertices are float32, so 0.05 m carries about 1e-7 relative error.
      assert.closeTo(found[0]!.intersectionVolume, 0.05 ** 3, 1e-10);
      assert.closeTo(found[0]!.intersectionFraction, 0.125, 1e-6);
      assert.isFalse(found[0]!.withinSubassembly);
      assert.equal(result.summary.meshUnknown, 0);
    }),
  );
  it.effect("ignores a part sitting in the gap of another even though their boxes overlap", () =>
    Effect.gen(function* () {
      // Two separated lugs in one part, and a block between them with clearance on both sides.
      const lugs = meshGlb([
        boxPrimitive([0, 0, 0], [0.1, 0.1, 0.1]),
        boxPrimitive([0.3, 0, 0], [0.4, 0.1, 0.1]),
      ]);
      const block = solidBox([0.15, 0, 0], [0.25, 0.1, 0.1]);
      const occurrences = [
        { number: 1, part: 10 },
        { number: 2, part: 11 },
      ];
      assert.lengthOf(interference(yield* run(occurrences, [lugs, block])), 0);
      const both = yield* run(
        occurrences,
        [lugs, block],
        new Set(["mesh-interference", "overlapping-bounds"] as const),
      );
      assert.lengthOf(overlaps(both), 1);
      assert.lengthOf(interference(both), 0);
    }),
  );
  it.effect(
    "places solids with glTF node transforms, occurrence rotation, and repeated instances",
    () =>
      Effect.gen(function* () {
        // A 0.2 x 0.02 x 0.02 bar lifted 0.01 on Z by its glTF node.
        const bar = meshGlb(
          [boxPrimitive([0, 0, 0], [0.2, 0.02, 0.02])],
          [{ translation: [0, 0, 0.01], mesh: 0 }],
        );
        // Only the bar rotated a quarter turn about Z reaches this block, and only its upper half.
        const block = solidBox([-0.01, 0.05, 0], [0.01, 0.07, 0.02]);
        const result = yield* run(
          [
            { number: 1, part: 10, transform: rotateZ90(0, 0, 0) },
            { number: 2, part: 11 },
            { number: 3, part: 11, transform: translate(1, 0, 0) },
            { number: 4, part: 10, transform: rotateZ90(1, 0, 0) },
            { number: 5, part: 10, transform: translate(0, 0, 0) },
          ],
          [bar, block],
        );
        const found = interference(result);
        assert.deepEqual(found.map(pairKey).sort(), [`${id(1)}|${id(2)}`, `${id(3)}|${id(4)}`]);
        for (const finding of found) assert.closeTo(finding.intersectionVolume, 2e-6, 1e-12);
      }),
  );
  it.effect("counts open, unreadable, and suppressed parts without reporting them clear", () =>
    Effect.gen(function* () {
      const cube = solidBox([0, 0, 0], [0.1, 0.1, 0.1]);
      const open = meshGlb([boxPrimitive([0, 0, 0], [0.1, 0.1, 0.1], 10)]);
      const result = yield* run(
        [
          { number: 1, part: 10 },
          { number: 2, part: 11, transform: translate(0.05, 0, 0) },
          { number: 3, part: 12, transform: translate(0, 0.05, 0) },
          { number: 4, part: 10, transform: translate(0, 0, 0.05), suppressed: true },
        ],
        [cube, open, glb({ scenes: [{ nodes: [] }] })],
      );
      assert.lengthOf(interference(result), 0);
      // The open box and the unreadable part; the suppressed cube is not a candidate at all.
      assert.equal(result.summary.meshUnknown, 2);
    }),
  );
  it.effect("ranks cross-subassembly pairs before larger pairs inside one subassembly", () =>
    Effect.gen(function* () {
      const cube = solidBox([0, 0, 0], [0.1, 0.1, 0.1]);
      const result = yield* run(
        [
          { number: 100 },
          { number: 200, parent: 100 },
          { number: 300, parent: 200 },
          // Kit screw two levels down and kit body one level down: same subassembly 200.
          { number: 1, part: 10, parent: 300 },
          { number: 2, part: 10, parent: 200, transform: translate(0.01, 0, 0) },
          // A top-level part barely touching the kit screw.
          { number: 3, part: 10, parent: 100, transform: translate(0.099, 0, 0) },
        ],
        [cube],
      );
      const found = interference(result);
      assert.deepEqual(found.map(pairKey), [
        `${id(2)}|${id(3)}`,
        `${id(1)}|${id(3)}`,
        `${id(1)}|${id(2)}`,
      ]);
      assert.deepEqual(
        found.map((finding) => finding.withinSubassembly),
        [false, false, true],
      );
      assert.isAbove(found[2]!.intersectionVolume, found[0]!.intersectionVolume);
    }),
  );
});

describe("cad_checks tool", () => {
  const snapshot = manifest(
    [
      { number: 1, part: 10, name: "Plate" },
      { number: 2, part: 11, name: "Block", transform: translate(0.08, 0.005, 0) },
      { number: 3, part: 11, name: "Block copy", transform: translate(0.08, 0.005, 0) },
      { number: 4, part: 11, name: "Block", transform: translate(0.09, 0.005, 0) },
    ],
    [10, 11],
  );
  const state = { ...initialCadView(snapshot), revision: 3 };
  const bounds = new Map([
    [id(10), box([0.1, 0.05, 0.01])],
    [id(11), box([0.05, 0.05, 0.05])],
  ]);
  const meshes = new Map<string, CadTriangleMesh | null>([
    [id(10), readCadTriangleMesh(solidBox([0, 0, 0], [0.1, 0.05, 0.01]))],
    [id(11), readCadTriangleMesh(solidBox([0, 0, 0], [0.05, 0.05, 0.05]))],
  ]);
  const loads: ReadonlySet<string>[] = [];
  const loadBounds = (keys: ReadonlySet<string>) => {
    loads.push(keys);
    return Effect.succeed(bounds);
  };
  const loadMeshes = (keys: ReadonlySet<string>) => {
    loads.push(keys);
    return Effect.succeed(meshes);
  };
  const geometry = { bounds: loadBounds, meshes: loadMeshes };
  it.effect(
    "pages deterministic findings with cursors bound to the snapshot and check selection",
    () =>
      Effect.gen(function* () {
        const whole = yield* readCadChecks(snapshot, state, geometry, { expectedRevision: 3 });
        assert.equal(whole.snapshotId, snapshotId);
        // Exact interference replaces bounding-box leads by default; these boxes are their own solids.
        // The drivetrain check runs too but recognizes nothing in parts named Plate and Block.
        assert.deepEqual(whole.checks, [
          "drivetrain",
          "mesh-interference",
          "coincident-instances",
          "degenerate-geometry",
        ]);
        assert.deepEqual(
          whole.findings.map((finding) => finding.check),
          [...Array.from({ length: 6 }, () => "mesh-interference"), "coincident-instances"],
        );
        assert.isNull(whole.nextCursor);
        assert.equal(whole.summary.totalFindings, 7);
        const paged: (typeof whole.findings)[number][] = [];
        let cursor: string | undefined;
        do {
          const page = yield* readCadChecks(snapshot, state, geometry, {
            expectedRevision: 3,
            limit: 4,
            ...(cursor === undefined ? {} : { cursor }),
          });
          paged.push(...page.findings);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        assert.deepEqual(paged, whole.findings);
        const loadsBefore = loads.length;
        const subset = yield* readCadChecks(snapshot, state, geometry, {
          expectedRevision: 3,
          checks: ["coincident-instances"],
          limit: 1,
        });
        assert.deepEqual(subset.checks, ["coincident-instances"]);
        assert.equal(subset.findings[0]?.check, "coincident-instances");
        // Coincidence needs transforms only, so no geometry is read.
        assert.equal(loads.length, loadsBefore);
        const leads = yield* readCadChecks(snapshot, state, geometry, {
          expectedRevision: 3,
          checks: ["overlapping-bounds"],
        });
        assert.deepEqual(leads.checks, ["overlapping-bounds"]);
        assert.lengthOf(leads.findings, 6);
        for (const cursor of [
          `${snapshotId}:mesh-interference+coincident-instances+degenerate-geometry:4`,
          `${snapshotId}:coincident-instances:9`,
          `00000000-0000-4000-8000-000000000002:coincident-instances:0`,
        ])
          assert.equal(
            (yield* readCadChecks(snapshot, state, geometry, {
              expectedRevision: 3,
              checks: ["coincident-instances"],
              cursor,
            }).pipe(Effect.flip)).reason,
            "invalid-operation",
          );
      }),
  );
  it.effect("rejects stale revisions and malformed input before reading geometry", () =>
    Effect.gen(function* () {
      const before = loads.length;
      assert.equal(
        (yield* readCadChecks(snapshot, state, geometry, { expectedRevision: 2 }).pipe(Effect.flip))
          .reason,
        "revision-conflict",
      );
      const malformed = yield* readCadChecks(snapshot, state, geometry, {
        expectedRevision: 3,
        checks: ["interference"],
      }).pipe(Effect.flip);
      assert.equal(malformed.reason, "invalid-operation");
      assert.include(malformed.details, "checks");
      assert.equal(loads.length, before);
    }),
  );
  it.effect(
    "states each explanation once per page and rounds numbers to four significant digits",
    () =>
      Effect.gen(function* () {
        const page = yield* readCadChecks(snapshot, state, geometry, { expectedRevision: 3 });
        assert.deepEqual(Object.keys(page.explanations), [...page.checks]);
        for (const check of page.checks)
          assert.equal(page.explanations[check], CAD_CHECK_EXPLANATIONS[check]);
        const numbers: number[] = [];
        const collect = (value: unknown): void => {
          if (typeof value === "number") numbers.push(value);
          else if (value !== null && typeof value === "object")
            Object.values(value).forEach(collect);
        };
        for (const finding of page.findings) {
          assert.notProperty(finding, "explanation");
          collect(finding);
        }
        assert.isNotEmpty(numbers);
        for (const value of numbers) assert.equal(value, Number(value.toPrecision(4)));
      }),
  );
  it.effect("keeps every page under the byte cap and still returns each finding once", () =>
    Effect.gen(function* () {
      // 40 copies of one part at one placement: 780 coincident pairs with long names.
      const crowded = manifest(
        Array.from({ length: 40 }, (_, i) => ({
          number: i + 1,
          part: 10,
          name: `Bracket ${i + 1} ${"x".repeat(180)}`,
        })),
      );
      const crowdedState = { ...initialCadView(crowded), revision: 1 };
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const page = yield* readCadChecks(crowded, crowdedState, geometry, {
          expectedRevision: 1,
          checks: ["coincident-instances"],
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pageCount++;
        assert.isAtMost(
          new TextEncoder().encode(encodeJson(page)).length,
          CAD_CHECK_LIMITS.pageBytes,
        );
        assert.isNotEmpty(page.findings);
        for (const finding of page.findings) {
          assert.isFalse(seen.has(pairKey(finding)));
          seen.add(pairKey(finding));
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.equal(seen.size, 780);
      // The cap, not the limit, ended the pages: 100 of these findings would not fit.
      assert.isAbove(pageCount, 8);
    }),
  );
  it.effect("keeps a first page with many drafts under the byte cap", () =>
    Effect.gen(function* () {
      // 12 copies at one placement: 66 near-total overlaps, each a duplicate draft.
      const crowded = manifest(
        Array.from({ length: 12 }, (_, i) => ({
          number: i + 1,
          part: 10,
          name: `Bracket ${i + 1} ${"x".repeat(180)}`,
        })),
      );
      const crowdedState = { ...initialCadView(crowded), revision: 1 };
      const page = yield* readCadChecks(crowded, crowdedState, geometry, {
        expectedRevision: 1,
        checks: ["mesh-interference"],
        limit: 1,
      });
      assert.isNotEmpty(page.drafts ?? []);
      assert.isNotEmpty(page.findings);
      assert.isAtMost(
        new TextEncoder().encode(encodeJson(page)).length,
        CAD_CHECK_LIMITS.pageBytes,
      );
    }),
  );
});

describe("draftCadComments", () => {
  // Ways drafts can go wrong: a draft from a finding that is not a problem, a duplicate drafted
  // when a drivetrain draft already names its parts, a repeated issue left as separate comments,
  // or a target on a part that is only incidental to the issue (the gear a bare shaft carries),
  // which lets an unrelated comment on that gear count as covering the draft. Wording goes wrong
  // when a body reads like tool output: raw CAD names with instance tags or specs, a lowercase
  // start, one sentence repeated for each part, a merged draft that leaves out a part or the gear
  // a shaft carries, or a next step cut off by the length limit.
  const part = (n: number, name: string) => ({
    occurrenceId: n.toString(16).padStart(64, "0"),
    name,
  });
  const shaftA = part(1, "1.75 in. Hex Shaft <1>");
  const shaftB = part(2, "2.39 in. Hex Shaft <1>");
  const gear = part(3, '40t Pocketed Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>');
  const plateA = part(4, "Part 17 <2>");
  const plateB = part(5, "Part 20 <3>");
  const drivetrain = (
    kind: Extract<CadCheckFinding, { check: "drivetrain" }>["kind"],
    problem: boolean,
    occurrences: ReturnType<typeof part>[],
  ): CadCheckFinding => ({
    check: "drivetrain",
    kind,
    problem,
    summary: `${kind} summary.`,
    occurrences,
  });
  const snapshotId = CadSnapshotId.make("00000000-0000-4000-8000-000000000003");
  const drafts = draftCadComments(
    [
      drivetrain("power-path", false, [gear]),
      drivetrain("gear-mesh", false, [gear, shaftA]),
      drivetrain("shaft-support", true, [shaftA, gear]),
      drivetrain("shaft-support", true, [shaftB]),
      drivetrain("stacked-shafts", true, [shaftA, shaftB]),
      {
        check: "mesh-interference",
        occurrences: [shaftA, shaftB],
        intersectionVolume: 1e-6,
        intersectionFraction: 0.95,
        withinSubassembly: false,
        reading: readOverlap(shaftA.name, shaftB.name, 1e-6, 0.95, false).reading,
      },
      {
        check: "mesh-interference",
        occurrences: [plateA, plateB],
        intersectionVolume: 1e-4,
        intersectionFraction: 1,
        withinSubassembly: false,
        reading: readOverlap(plateB.name, plateA.name, 1e-4, 1, false).reading,
      },
    ],
    snapshotId,
  );

  it("drafts only problems, and merges a repeated issue into one comment", () => {
    assert.deepEqual(
      drafts.map((draft) => draft.title),
      ["Shaft has no bearing", "Two shafts on one axis", "Duplicate part"],
    );
  });

  it("keys a defect by its snapshot and parts, whichever other checks ran", () => {
    const duplicate = drafts.find((draft) => draft.title === "Duplicate part")!;
    // Drafted from a call that ran only mesh-interference, the plate keeps its key.
    const alone = draftCadComments(
      [
        {
          check: "mesh-interference",
          occurrences: [plateA, plateB],
          intersectionVolume: 1e-4,
          intersectionFraction: 1,
          withinSubassembly: false,
          reading: readOverlap(plateB.name, plateA.name, 1e-4, 1, false).reading,
        },
      ],
      snapshotId,
    );
    assert.equal(alone[0]!.publicationKey, duplicate.publicationKey);
    assert.equal(new Set(drafts.map((draft) => draft.publicationKey)).size, drafts.length);
    // A new snapshot gets new keys, so a later review in the chat never reuses a published key.
    const later = draftCadComments(
      [drivetrain("shaft-support", true, [shaftB])],
      CadSnapshotId.make("00000000-0000-4000-8000-000000000004"),
    );
    const before = draftCadComments([drivetrain("shaft-support", true, [shaftB])], snapshotId);
    assert.notEqual(later[0]!.publicationKey, before[0]!.publicationKey);
  });

  it("targets only the shafts a bearing draft is about, not the parts they carry", () => {
    assert.deepEqual(
      drafts[0]!.targets.flatMap((target) => (target.kind === "part" ? [target.occurrenceId] : [])),
      [shaftA.occurrenceId, shaftB.occurrenceId],
    );
  });

  it("ends every draft with a next step for the student", () => {
    for (const draft of drafts) assert.match(draft.body, /\b(Add|Move|Keep|Remove)\b[^.]*\.$/);
  });

  it("keeps instance numbers where a merged draft names one part twice", () => {
    const [hexA, hexB] = [part(8, "13 in. Hex Shaft <1>"), part(9, "13 in. Hex Shaft <2>")];
    const [roundA, roundB] = [part(10, "Rounded Hex <1>"), part(11, "Rounded Hex <2>")];
    const [merged] = draftCadComments(
      [
        drivetrain("stacked-shafts", true, [hexA, roundA]),
        drivetrain("stacked-shafts", true, [hexB, roundB]),
      ],
      snapshotId,
    );
    assert.deepEqual(
      merged!.targets.map((target) => target.label),
      ["13 in. Hex Shaft <1>", "Rounded Hex <1>", "13 in. Hex Shaft <2>", "Rounded Hex <2>"],
    );
  });

  it("drafts one comment for a stack of copies, and keeps other overlaps as pairs", () => {
    const overlap = (a: ReturnType<typeof part>, b: ReturnType<typeof part>): CadCheckFinding => ({
      check: "mesh-interference",
      occurrences: [a, b],
      intersectionVolume: 1e-4,
      intersectionFraction: 1,
      withinSubassembly: false,
      reading: readOverlap(a.name, b.name, 1e-4, 1, false).reading,
    });
    const copies = [part(20, "Part 20 <1>"), part(21, "Part 20 <2>"), part(22, "Part 20 <3>")];
    const ids = (draft: ReturnType<typeof draftCadComments>[number]) =>
      draft.targets.flatMap((target) => (target.kind === "part" ? [target.occurrenceId] : []));
    const [stack, ...rest] = draftCadComments(
      [
        overlap(copies[0]!, copies[1]!),
        overlap(copies[0]!, copies[2]!),
        overlap(copies[1]!, copies[2]!),
      ],
      snapshotId,
    );
    assert.deepEqual(rest, []);
    assert.deepEqual(
      ids(stack!),
      copies.map((copy) => copy.occurrenceId),
    );
    assert.match(stack!.body, /\bKeep\b[^.]*\.$/);
    // Pairs met in any order still give one stack for four copies that all overlap.
    const four = [...copies, part(25, "Part 20 <4>")];
    const allPairs = [
      [2, 3],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
    ].map(([a, b]) => overlap(four[a!]!, four[b!]!));
    assert.deepEqual(
      draftCadComments(allPairs, snapshotId).map((draft) => draft.targets.length),
      [4],
    );
    // A stack with more copies than a comment has targets still counts every copy.
    const long = Array.from({ length: 21 }, (_, i) =>
      part(40 + i, `${"Bracket ".repeat(26)}<${i + 1}>`),
    );
    const longPairs = long.flatMap((a, i) => long.slice(i + 1).map((b) => overlap(a, b)));
    const [longStack] = draftCadComments(longPairs, snapshotId);
    assert.isAtMost(longStack!.body.length, 4000);
    assert.match(
      longStack!.body,
      /^21 copies of the Bracket .*\. Keep one and remove the others\.$/,
    );
    // Two stacks that overlap each other keep the overlap between them as its own pair.
    const spacers = [part(70, "Spacer <1>"), part(71, "Spacer <2>"), part(72, "Spacer <3>")];
    const spacerPairs = [
      [0, 1],
      [0, 2],
      [1, 2],
    ].map(([a, b]) => overlap(spacers[a!]!, spacers[b!]!));
    const across = draftCadComments(
      [
        overlap(four[0]!, four[1]!),
        overlap(four[0]!, four[2]!),
        overlap(four[1]!, four[2]!),
        ...spacerPairs,
        overlap(four[0]!, spacers[0]!),
      ],
      snapshotId,
    );
    assert.deepEqual(
      across.map((draft) => draft.targets.length),
      [3, 3, 2],
    );
    // A spacer inside two copies is not a third copy: it stays out of their stack.
    const spacer = part(23, "Spacer <1>");
    const withSpacer = draftCadComments(
      [overlap(copies[0]!, copies[1]!), overlap(spacer, copies[0]!), overlap(spacer, copies[1]!)],
      snapshotId,
    );
    assert.deepEqual(withSpacer.map(ids), [
      [copies[0]!.occurrenceId, copies[1]!.occurrenceId],
      [spacer.occurrenceId, copies[0]!.occurrenceId],
      [spacer.occurrenceId, copies[1]!.occurrenceId],
    ]);
    // Two copies that each sit inside one large part, but not inside each other, are no stack.
    const plate = part(24, "Side Plate <1>");
    const contained = draftCadComments(
      [overlap(copies[0]!, plate), overlap(copies[1]!, plate)],
      snapshotId,
    );
    assert.deepEqual(
      contained.map((draft) => draft.targets.length),
      [2, 2],
    );
  });

  it("merges collisions into one part into one draft that keeps every marker", () => {
    const controller = part(6, "SPARK Flex Brushless Motor Controller <1>");
    const collision = (shaft: ReturnType<typeof part>): CadCheckFinding => ({
      check: "drivetrain",
      kind: "collision",
      problem: true,
      summary: `${shaft.name} runs into ${controller.name}.`,
      occurrences: [shaft, controller],
    });
    const findings = [collision(shaftA), collision(shaftB)];
    const placementOf = (shaft: ReturnType<typeof part>) => ({
      occurrenceId: shaft.occurrenceId,
      point: [0, 0, 0] as const,
      normal: [1, 0, 0] as const,
      isolate: [shaft.occurrenceId, controller.occurrenceId],
      expected: `where ${shaft.name} meets the controller`,
    });
    const merged = draftCadComments(
      findings,
      snapshotId,
      new Map([
        [findings[0]!, placementOf(shaftA)],
        [findings[1]!, placementOf(shaftB)],
      ]),
    );
    assert.equal(merged.length, 1);
    assert.equal(
      merged[0]!.title,
      "1.75 in. Hex Shaft and 2.39 in. Hex Shaft run into SPARK Flex Brushless Motor Controller",
    );
    assert.equal(
      merged[0]!.body,
      "The 1.75 in. Hex Shaft and the 2.39 in. Hex Shaft run into the SPARK Flex Brushless Motor Controller, so they can't turn as drawn. Move a part or cut clearance, then check the gap through a full turn.",
    );
    assert.deepEqual(
      merged[0]!.placements?.map((placement) => placement.occurrenceId),
      [shaftA.occurrenceId, shaftB.occurrenceId],
    );
  });

  it("words each merged draft once, in the names a student would use", () => {
    assert.deepEqual(
      drafts.map((draft) => draft.body),
      [
        "The 1.75 in. Hex Shaft (which carries the 40T gear) and the 2.39 in. Hex Shaft have no bearings, so nothing holds them in line. Add a bearing where each shaft passes through a plate.",
        "The 1.75 in. Hex Shaft and the 2.39 in. Hex Shaft sit on the same axis, one modeled inside the other. Keep the shaft the parts are designed for and remove the other.",
        "Part 17 and Part 20 sit in the same place, one almost entirely inside the other. One is likely a duplicate or stale copy, or a part in the wrong place. Remove or move one.",
      ],
    );
    const hexes = [1, 2, 3].map((n) => part(80 + n, `13 in. Hex Shaft <${n}>`));
    const rounds = [1, 2, 3].map((n) => part(90 + n, '1/2" Rounded Hex (11.5" L, 13.75mm OD) <1>'));
    const [stacked] = draftCadComments(
      hexes.map((hex, i) => drivetrain("stacked-shafts", true, [hex, rounds[i]!])),
      snapshotId,
    );
    assert.equal(
      stacked!.body,
      'The 13 in. Hex Shaft and the 1/2" Rounded Hex sit on the same axis, one modeled inside the other, in 3 places. In each place, keep the shaft the parts are designed for and remove the other.',
    );
    const [lone] = draftCadComments([drivetrain("shaft-support", true, [shaftB])], snapshotId);
    assert.equal(
      lone!.body,
      "The 2.39 in. Hex Shaft has no bearing, so nothing holds it in line. Add a bearing where it passes through a plate.",
    );
  });

  it("words copies of one part as copies", () => {
    const overlap = (a: ReturnType<typeof part>, b: ReturnType<typeof part>): CadCheckFinding => ({
      check: "mesh-interference",
      occurrences: [a, b],
      intersectionVolume: 1e-4,
      intersectionFraction: 1,
      withinSubassembly: false,
      reading: readOverlap(a.name, b.name, 1e-4, 1, false).reading,
    });
    const plates = [1, 2, 3].map((n) => part(100 + n, `Side Plate <${n}>`));
    assert.deepEqual(
      draftCadComments([overlap(plates[0]!, plates[1]!)], snapshotId).map((draft) => draft.body),
      [
        "Two copies of the Side Plate sit in the same place, one almost entirely inside the other, so one is likely a stale copy. Keep one and remove the other.",
      ],
    );
    assert.deepEqual(
      draftCadComments(
        [
          overlap(plates[0]!, plates[1]!),
          overlap(plates[0]!, plates[2]!),
          overlap(plates[1]!, plates[2]!),
        ],
        snapshotId,
      ).map((draft) => draft.body),
      [
        "3 copies of the Side Plate sit in the same place and overlap almost completely, so all but one are likely stale copies. Keep one and remove the others.",
      ],
    );
  });

  it("calls parts copies only when they are one part, and counts places, not pairs", () => {
    const overlap = (a: ReturnType<typeof part>, b: ReturnType<typeof part>): CadCheckFinding => ({
      check: "mesh-interference",
      occurrences: [a, b],
      intersectionVolume: 1e-4,
      intersectionFraction: 1,
      withinSubassembly: false,
      reading: readOverlap(a.name, b.name, 1e-4, 1, false).reading,
    });
    // Two different plates whose names differ only in their specs are not copies of one part.
    const [thin, thick] = [
      part(110, "Side Plate (0.25 in) <1>"),
      part(111, "Side Plate (0.50 in) <1>"),
    ];
    assert.deepEqual(
      draftCadComments([overlap(thin, thick)], snapshotId).map((draft) => draft.body),
      [
        "The Side Plate (0.25 in) and the Side Plate (0.50 in) sit in the same place, one almost entirely inside the other. One is likely a duplicate or stale copy, or a part in the wrong place. Remove or move one.",
      ],
    );
    const [hexA, hexB] = [part(112, "Hex Shaft (6 in) <1>"), part(113, "Hex Shaft (8 in) <1>")];
    assert.equal(
      draftCadComments([drivetrain("stacked-shafts", true, [hexA, hexB])], snapshotId)[0]!.body,
      "The Hex Shaft (6 in) and the Hex Shaft (8 in) sit on the same axis, one modeled inside the other. Keep the shaft the parts are designed for and remove the other.",
    );
    // Three shafts in a row that overlap only their neighbors are two places, not one stack.
    const row = [1, 2, 3].map((n) => part(130 + n, `Hex Shaft <${n}>`));
    assert.equal(
      draftCadComments(
        [
          drivetrain("stacked-shafts", true, [row[0]!, row[1]!]),
          drivetrain("stacked-shafts", true, [row[1]!, row[2]!]),
        ],
        snapshotId,
      )[0]!.body,
      "Two copies of the Hex Shaft sit on the same axis, one modeled inside the other, in 2 places. In each place, keep the shaft the parts are designed for and remove the other.",
    );
    // Three copies of one shaft in one spot are one place, though they make three pairs.
    const copies = [1, 2, 3].map((n) => part(120 + n, `13 in. Hex Shaft <${n}>`));
    assert.equal(
      draftCadComments(
        [
          drivetrain("stacked-shafts", true, [copies[0]!, copies[1]!]),
          drivetrain("stacked-shafts", true, [copies[0]!, copies[2]!]),
          drivetrain("stacked-shafts", true, [copies[1]!, copies[2]!]),
        ],
        snapshotId,
      )[0]!.body,
      "3 copies of the 13 in. Hex Shaft sit on the same axis, modeled inside one another. Keep the shaft the parts are designed for and remove the others.",
    );
  });

  it("publishes a drivetrain finding's own student wording, not the agent's summary", () => {
    const finding = drivetrain("gear-mesh", true, [gear, shaftA]);
    const comment =
      "The 7T gear and the 40T gear are 1.152 in apart, but these 20 DP gears need 1.175 in. Move one shaft so the centers are 1.175 in apart.";
    const [draft] = draftCadComments(
      [finding],
      snapshotId,
      new Map(),
      new Map([[finding, comment]]),
    );
    assert.equal(draft!.body, comment);
  });

  it("keeps the next step when a merged draft names too many parts to fit", () => {
    const shafts = Array.from({ length: 60 }, (_, i) =>
      part(200 + i, `${"Very Long Jackshaft Name ".repeat(4)}${i} <1>`),
    );
    const [merged] = draftCadComments(
      shafts.map((shaft) => drivetrain("shaft-support", true, [shaft])),
      snapshotId,
    );
    assert.isAtMost(merged!.body.length, 4000);
    assert.match(merged!.body, /Add a bearing where each shaft passes through a plate\.$/);
  });

  it("never shows the student a raw CAD name or a lowercase start", () => {
    for (const draft of drafts) {
      assert.notMatch(draft.body, /<\d+>/);
      assert.match(draft.body.charAt(0), /[A-Z0-9]/);
      assert.match(draft.title.charAt(0), /[A-Z0-9]/);
    }
  });

  it("skips a duplicate whose parts a drivetrain draft already names", () => {
    const duplicate = drafts.filter((draft) => draft.title === "Duplicate part");
    assert.deepEqual(
      duplicate.map((draft) =>
        draft.targets.flatMap((target) => (target.kind === "part" ? [target.occurrenceId] : [])),
      ),
      [[plateA.occurrenceId, plateB.occurrenceId]],
    );
  });
});

// Cases from "Check-placed points" in CadComments.md.
describe("check-placed points", () => {
  const checks = new Set(["drivetrain", "mesh-interference"] as const);
  const INCH = 0.0254;
  /** Gear turned so its axis runs along world Y, then moved to (x, y, z). */
  const onY = (x: number, y: number, z: number) => [
    1,
    0,
    0,
    x,
    0,
    0,
    1,
    y,
    0,
    -1,
    0,
    z,
    0,
    0,
    0,
    1,
  ];
  const apply = (m: readonly number[], [x, y, z]: Point): Point => [
    m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  ];
  it.effect("puts a collision marker at the seam, in the spinning part's own frame", () =>
    Effect.gen(function* () {
      const radius = 1.05 * INCH;
      const half = 0.25 * INCH;
      const gearAt = onY(0.3, 0.2, 0.1);
      // A 1 in tube whose wall the gear's rim cuts into by about 0.1 in.
      const tubeMin: Point = [0.3 + radius - 0.1 * INCH, 0.2 - 2 * INCH, 0.1 - 0.5 * INCH];
      const tubeMax: Point = [tubeMin[0] + INCH, 0.2 + 2 * INCH, 0.1 + 0.5 * INCH];
      const snapshot = manifest(
        [
          {
            number: 1,
            part: 10,
            name: '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
            transform: gearAt,
          },
          { number: 2, part: 11, name: 'Tube 1"x1"x11" <1>' },
        ],
        [10, 11],
      );
      const assets = [solidCylinder(radius, 2 * half), solidBox(tubeMin, tubeMax)];
      const bounds = new Map(
        [10, 11].map((part, i) => [id(part), readCadGeometryBounds(assets[i]!)]),
      );
      const meshes = new Map(
        [10, 11].map((part, i) => [id(part), readCadTriangleMesh(assets[i]!)]),
      );
      const kernel = yield* loadCadSolidKernel;
      const result = runCadChecks(snapshot, bounds, checks, undefined, { meshes, kernel });
      const collision = result.findings.find(
        (finding) => finding.check === "drivetrain" && finding.kind === "collision",
      );
      assert.isDefined(collision);
      const placement = result.placements.get(collision!);
      assert.isDefined(placement);
      assert.equal(placement!.occurrenceId, id(1));
      assert.deepEqual([...placement!.isolate].sort(), [id(1), id(2)]);
      // On the gear: its local point is on the rim or a face.
      const [lx, ly, lz] = placement!.point;
      // Within the seam offset (0.3 mm) of the rim or a face.
      const onGear =
        Math.abs(Math.hypot(lx, ly) - radius) < 4e-4 || Math.abs(Math.abs(lz) - half) < 4e-4;
      assert.isTrue(onGear, `local ${placement!.point}`);
      // On the tube: the world point is on one of the tube's faces.
      const world = apply(gearAt, placement!.point);
      const faceGap = Math.min(
        ...[0, 1, 2].flatMap((axis) => [
          Math.abs(world[axis]! - tubeMin[axis]!),
          Math.abs(world[axis]! - tubeMax[axis]!),
        ]),
      );
      assert.isBelow(faceGap, 4e-4, `world ${world}`);
      assert.closeTo(Math.hypot(...placement!.normal), 1, 1e-6);
    }),
  );
  it.effect("offers no placement when the parts do not overlap", () =>
    Effect.gen(function* () {
      const snapshot = manifest(
        [
          {
            number: 1,
            part: 10,
            name: '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
            transform: onY(0, 0, 0),
          },
          { number: 2, part: 11, name: 'Tube 1"x1"x11" <1>' },
        ],
        [10, 11],
      );
      const assets = [solidCylinder(INCH, 0.5 * INCH), solidBox([0.2, 0.2, 0.2], [0.3, 0.3, 0.3])];
      const bounds = new Map(
        [10, 11].map((part, i) => [id(part), readCadGeometryBounds(assets[i]!)]),
      );
      const meshes = new Map(
        [10, 11].map((part, i) => [id(part), readCadTriangleMesh(assets[i]!)]),
      );
      const kernel = yield* loadCadSolidKernel;
      const result = runCadChecks(snapshot, bounds, checks, undefined, { meshes, kernel });
      assert.equal(result.placements.size, 0);
    }),
  );
});
