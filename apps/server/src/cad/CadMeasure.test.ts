import { CadMeasureResult, CadSnapshotManifest } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { measureCad } from "./CadMeasure.ts";
import { normalizeCadGeometry } from "./CadGeometry.ts";
import { initialCadView } from "./CadViewState.ts";
import { invokeCadTool, cadToolDefinitions } from "../provider/CadProviderTools.ts";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const first = "2".repeat(64),
  second = "3".repeat(64),
  key = "4".repeat(64),
  hash = "5".repeat(64);
const source = {
  host: "cad.onshape.com",
  documentId: "a".repeat(24),
  documentMicroversion: "b".repeat(24),
  documentVersion: null,
  elementId: "c".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  partId: "test",
  tessellationProfile: "test-mesh",
};
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000002",
  rootId: "1".repeat(64),
  projectId: "test",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: source.host,
    documentId: source.documentId,
    elementId: source.elementId,
    kind: "assembly",
    originalRevision: { kind: "m", id: source.documentMicroversion },
    microversionId: source.documentMicroversion,
    configuration: "default",
    tessellationProfile: "test-mesh",
  },
  nodes: [first, second].map((id, index) => ({
    id,
    parentId: null,
    occurrencePath: [id],
    instanceId: id,
    name: id,
    kind: "part",
    suppressed: false,
    defaultVisible: true,
    sourcePartKey: key,
    transform: index === 0 ? identity : [0, -1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 3, 0, 0, 0, 1],
  })),
  parts: [
    {
      geometryKey: key,
      source,
      geometryRequired: true,
      metadata: {
        name: "test",
        bodyType: "solid",
        isHidden: false,
        isMesh: false,
        partIdentity: null,
        configurationId: null,
        appearance: null,
        material: null,
      },
    },
  ],
  assets: [
    {
      geometryKey: key,
      sha256: hash,
      byteLength: 1024,
      relativePath: `${hash}.glb`,
      format: "glb",
    },
  ],
  dependencies: [],
});
const state = initialCadView(snapshot, 7);
const request = { expectedRevision: 7, snapshotId: snapshot.snapshotId };
const clearance = {
  ...request,
  mode: "surface-clearance",
  fromOccurrenceId: first,
  toOccurrenceId: second,
};
const unused = () => Effect.die("Point measurement must not read mesh assets");
const decodeResult = Schema.decodeUnknownSync(CadMeasureResult);
const triangle = (options?: { mode?: number; empty?: boolean }) => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return normalizeCadGeometry(
    new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [
          {
            byteLength: positions.byteLength,
            uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString("base64")}`,
          },
        ],
        bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: 3,
            type: "VEC3",
            min: [0, 0, 0],
            max: [1, 1, 0],
          },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: options?.mode ?? 4 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [options?.empty ? {} : { nodes: [0] }],
        scene: 0,
      }),
    ),
  );
};

it.effect(
  "measures explicit part coordinates through original assembled rotation and translation",
  () =>
    Effect.gen(function* () {
      const result = decodeResult(
        yield* measureCad(
          snapshot,
          state,
          {
            ...request,
            mode: "point-distance",
            from: { space: "world", point: [1, 1, 0] },
            to: { space: "part", occurrenceId: second, point: [1, 0, 0] },
          },
          unused,
        ),
      );
      assert.equal(result.status, "measured");
      assert.equal(result.distanceMeters, 3);
      assert.deepEqual(result.closestPoints, [
        [1, 1, 0],
        [1, 1, 3],
      ]);
      assert.equal(result.units, "meters");
      assert.equal(result.snapshotId, snapshot.snapshotId);
      assert.equal(result.revision, 7);
      assert.equal(result.accuracy.source, "caller-specified-points");
    }),
);
it.effect("measures geometry for two instances independently of explosion and visibility", () =>
  Effect.gen(function* () {
    const bytes = yield* triangle();
    const read = () => Effect.succeed(bytes);
    const result = decodeResult(yield* measureCad(snapshot, state, clearance, read));
    assert.equal(result.status, "measured");
    assert.equal(result.distanceMeters, 3);
    assert.deepEqual(
      result.geometry.map((g) => g.assetSha256),
      [hash, hash],
    );
    assert.equal(result.accuracy.certifiedErrorBoundMeters, null);
    const exploded = {
      ...state,
      explosion: 1,
      visibility: { [first]: false },
      isolatedOccurrenceIds: [second],
    };
    assert.deepEqual(yield* measureCad(snapshot, exploded, clearance, read), result);
  }),
);
it.effect("reports unavailable, malformed, and over-budget geometry without a numeric answer", () =>
  Effect.gen(function* () {
    for (const [manifest, read, reason] of [
      [{ ...snapshot, assets: [] }, unused, "missing-geometry"],
      [snapshot, () => Effect.fail("unavailable"), "missing-geometry"],
      [snapshot, () => Effect.succeed(new Uint8Array([1, 2, 3])), "invalid-geometry"],
      [
        {
          ...snapshot,
          assets: snapshot.assets.map((a) => ({ ...a, byteLength: 129 * 1024 ** 2 })),
        },
        unused,
        "budget-exceeded",
      ],
    ] as const) {
      const result = decodeResult(yield* measureCad(manifest, state, clearance, read));
      assert.equal(result.status, "unknown");
      if (result.status === "unknown") assert.equal(result.reason, reason);
      assert.equal(result.distanceMeters, null);
      assert.equal(result.closestPoints, null);
    }
    const missing = yield* measureCad(
      snapshot,
      state,
      { ...clearance, fromOccurrenceId: "f".repeat(64) },
      unused,
    );
    assert.equal(missing.status, "unknown");
  }),
);
it.effect("returns typed unknown for unsupported, empty, and unrepresentable measurements", () =>
  Effect.gen(function* () {
    for (const [options, reason] of [
      [{ mode: 0 }, "unsupported-geometry"],
      [{ empty: true }, "empty-geometry"],
    ] as const) {
      const bytes = yield* triangle(options);
      const result = decodeResult(
        yield* measureCad(snapshot, state, clearance, () => Effect.succeed(bytes)),
      );
      assert.equal(result.status, "unknown");
      if (result.status === "unknown") assert.equal(result.reason, reason);
      assert.equal(result.distanceMeters, null);
    }
    const result = decodeResult(
      yield* measureCad(
        snapshot,
        state,
        {
          ...request,
          mode: "point-distance",
          from: { space: "world", point: [1e308, 0, 0] },
          to: { space: "world", point: [-1e308, 0, 0] },
        },
        unused,
      ),
    );
    assert.equal(result.status, "unknown");
    if (result.status === "unknown") assert.equal(result.reason, "numeric-failure");
  }),
);
it.effect("rejects stale snapshots, stale revisions, and nonfinite input before asset reads", () =>
  Effect.gen(function* () {
    for (const stale of [
      { ...clearance, expectedRevision: 6 },
      { ...clearance, snapshotId: "00000000-0000-4000-8000-000000000003" },
    ])
      assert.equal(
        (yield* measureCad(snapshot, state, stale, unused).pipe(Effect.flip)).reason,
        "revision-conflict",
      );
    const invalid = {
      ...request,
      mode: "point-distance",
      from: { space: "world", point: [NaN, 0, 0] },
      to: { space: "world", point: [0, 0, 0] },
    };
    assert.equal(
      (yield* measureCad(snapshot, state, invalid, unused).pipe(Effect.flip)).reason,
      "invalid-operation",
    );
  }),
);
it.effect("registers the typed provider tool and dispatches a measurement", () =>
  Effect.gen(function* () {
    const definition = cadToolDefinitions.find((tool) => tool.name === "cad_measure");
    assert.ok(definition);
    assert.equal(definition.inputSchema.type, "object");
    const input = {
      ...request,
      mode: "point-distance",
      from: { space: "world", point: [0, 0, 0] },
      to: { space: "world", point: [3, 4, 0] },
    };
    const tools = {
      context: unused,
      hierarchy: unused,
      partInfo: unused,
      findParts: unused,
      capture: unused,
      updateView: unused,
      measure: (value: unknown) => measureCad(snapshot, state, value, unused),
    };
    const delivered = yield* invokeCadTool(tools, "cad_measure", input);
    assert.equal(decodeResult(delivered.result).distanceMeters, 5);
    const { measure: _measure, ...withoutMeasure } = tools;
    assert.equal(
      (yield* invokeCadTool(withoutMeasure, "cad_measure", input).pipe(Effect.flip)).reason,
      "capability-unavailable",
    );
  }),
);
