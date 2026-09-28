import { CadSnapshotManifest, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAD_CHECK_EXPLANATIONS,
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
        assert.deepEqual(whole.checks, [
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
  it.effect("states each explanation once per page and rounds numbers to four significant digits", () =>
    Effect.gen(function* () {
      const page = yield* readCadChecks(snapshot, state, geometry, { expectedRevision: 3 });
      assert.deepEqual(Object.keys(page.explanations), [...page.checks]);
      for (const check of page.checks)
        assert.equal(page.explanations[check], CAD_CHECK_EXPLANATIONS[check]);
      const numbers: number[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "number") numbers.push(value);
        else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
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
        assert.isAtMost(new TextEncoder().encode(encodeJson(page)).length, CAD_CHECK_LIMITS.pageBytes);
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
});
