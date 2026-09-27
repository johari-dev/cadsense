import { CadSnapshotManifest, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAD_CHECK_LIMITS,
  loadCadBounds,
  readCadChecks,
  readCadGeometryBounds,
  runCadChecks,
  type CadBounds,
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
    assert.include(finding!.explanation, "not proof");
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
  const loads: ReadonlySet<string>[] = [];
  const loadBounds = (keys: ReadonlySet<string>) => {
    loads.push(keys);
    return Effect.succeed(bounds);
  };
  it.effect(
    "pages deterministic findings with cursors bound to the snapshot and check selection",
    () =>
      Effect.gen(function* () {
        const whole = yield* readCadChecks(snapshot, state, loadBounds, { expectedRevision: 3 });
        assert.equal(whole.snapshotId, snapshotId);
        assert.deepEqual(whole.checks, [
          "overlapping-bounds",
          "coincident-instances",
          "degenerate-geometry",
        ]);
        assert.deepEqual(
          whole.findings.map((finding) => finding.check),
          [...Array.from({ length: 6 }, () => "overlapping-bounds"), "coincident-instances"],
        );
        assert.isNull(whole.nextCursor);
        assert.equal(whole.summary.totalFindings, 7);
        const paged: (typeof whole.findings)[number][] = [];
        let cursor: string | undefined;
        do {
          const page = yield* readCadChecks(snapshot, state, loadBounds, {
            expectedRevision: 3,
            limit: 4,
            ...(cursor === undefined ? {} : { cursor }),
          });
          paged.push(...page.findings);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        assert.deepEqual(paged, whole.findings);
        const loadsBefore = loads.length;
        const subset = yield* readCadChecks(snapshot, state, loadBounds, {
          expectedRevision: 3,
          checks: ["coincident-instances"],
          limit: 1,
        });
        assert.deepEqual(subset.checks, ["coincident-instances"]);
        assert.equal(subset.findings[0]?.check, "coincident-instances");
        // Coincidence needs transforms only, so no geometry is read.
        assert.equal(loads.length, loadsBefore);
        for (const cursor of [
          `${snapshotId}:overlapping-bounds+coincident-instances+degenerate-geometry:4`,
          `${snapshotId}:coincident-instances:9`,
          `00000000-0000-4000-8000-000000000002:coincident-instances:0`,
        ])
          assert.equal(
            (yield* readCadChecks(snapshot, state, loadBounds, {
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
        (yield* readCadChecks(snapshot, state, loadBounds, { expectedRevision: 2 }).pipe(
          Effect.flip,
        )).reason,
        "revision-conflict",
      );
      const malformed = yield* readCadChecks(snapshot, state, loadBounds, {
        expectedRevision: 3,
        checks: ["interference"],
      }).pipe(Effect.flip);
      assert.equal(malformed.reason, "invalid-operation");
      assert.include(malformed.details, "checks");
      assert.equal(loads.length, before);
    }),
  );
});
