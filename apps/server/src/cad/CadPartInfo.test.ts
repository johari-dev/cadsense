import {
  CadPartInfoInput,
  CadPartInfoResult,
  CadSnapshotManifest,
  ProjectId,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readCadPartInfo } from "./CadPartInfo.ts";
import { initialCadView } from "./CadViewState.ts";
import { normalizeCadGeometry } from "./CadGeometry.ts";
import { bulkFixture } from "../onshape/testFixtures/bulkExport.ts";

const id = (i: number) => i.toString(16).padStart(64, "0");
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: id(1),
  projectId: ProjectId.make("part-info"),
  createdAt: "2026-09-12T00:00:00Z",
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
  nodes: Array.from({ length: 60 }, (_, i) => ({
    id: id(i + 2),
    parentId: null,
    occurrencePath: [`instance-${i}`],
    instanceId: `instance-${i}`,
    name: `Bolt ${i}`,
    kind: "part",
    suppressed: i === 1,
    defaultVisible: true,
    transform: [0, -1, 0, 10, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1],
    sourcePartKey: id(100),
  })),
  parts: [
    {
      geometryKey: id(100),
      geometryRequired: true,
      source: {
        host: "https://cad.onshape.com",
        documentId: "a".repeat(24),
        documentMicroversion: "d".repeat(24),
        documentVersion: null,
        elementId: "b".repeat(24),
        configuration: "size=5",
        fullConfiguration: "size=5",
        partId: "JHD",
        tessellationProfile: "test",
      },
      metadata: {
        name: "Bolt",
        bodyType: "solid",
        isHidden: false,
        isMesh: false,
        partIdentity: "stable-part",
        configurationId: "size=5",
        appearance: null,
        material: {
          displayName: "Steel",
          id: "steel",
          libraryName: "Standard",
          properties: [{ name: "density", units: "kg/m^3", value: "7800" }],
        },
      },
    },
  ],
  assets: [
    {
      geometryKey: id(100),
      sha256: id(101),
      byteLength: 72,
      format: "glb",
      relativePath: `${id(101)}.glb`,
    },
  ],
  dependencies: [],
});
const state = { ...initialCadView(snapshot, 7), explosion: 1, visibility: { [id(2)]: false } };
const request = { snapshotId: snapshot.snapshotId, expectedRevision: 7, occurrenceId: id(2) };
const checkResult = Schema.is(CadPartInfoResult);
const checkInput = Schema.is(CadPartInfoInput);
const encode = Schema.encodeSync(Schema.fromJsonString(CadPartInfoResult));
const unavailableAsset = () => Effect.fail("missing");

describe("cad_part_info", () => {
  it.effect(
    "returns cached identity, material and original assembled bounds independent of view edits",
    () =>
      Effect.gen(function* () {
        const bytes = yield* normalizeCadGeometry(bulkFixture(1).bytes);
        const reads: string[] = [];
        const before = structuredClone(state);
        const result = yield* readCadPartInfo(
          snapshot,
          state,
          (hash) => {
            reads.push(hash);
            return Effect.succeed(bytes);
          },
          request,
        );
        assert.isTrue(checkResult(result));
        assert.deepEqual(reads, [id(101)]);
        assert.equal(result.occurrence.name, "Bolt 0");
        assert.isFalse(result.occurrence.visible);
        assert.equal(result.source?.partId, "JHD");
        assert.equal(result.source?.configuration, "size=5");
        assert.equal(result.metadata?.bodyType, "solid");
        assert.equal(result.assembledTransform.status, "available");
        if (result.assembledTransform.status === "available")
          assert.deepEqual(result.assembledTransform.matrix, snapshot.nodes[0]!.transform);
        assert.equal(result.material.status, "available");
        if (result.material.status === "available")
          assert.equal(result.material.properties[0]?.value, "7800");
        assert.deepEqual(result.geometry, {
          status: "available",
          units: "meters",
          coordinateFrame: "assembled-world",
          upAxis: "Z",
          approximation: "tessellated-mesh",
          boundsKind: "axis-aligned",
          min: [9, 20, 30],
          max: [10, 21, 30],
          dimensions: [1, 1, 0],
          triangleCount: 1,
          assetSha256: id(101),
          tessellationProfile: "test",
        });
        assert.equal(result.repeatedOccurrences.total, 60);
        assert.equal(result.repeatedOccurrences.suppressedCount, 1);
        assert.lengthOf(result.repeatedOccurrences.occurrenceIds, 20);
        assert.isTrue(result.repeatedOccurrences.truncated);
        assert.deepEqual(state, before);
      }),
  );
  it.effect(
    "rejects stale snapshots/revisions and unknown occurrences before reading geometry",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const read = () => {
          reads++;
          return unavailableAsset();
        };
        for (const input of [
          { ...request, expectedRevision: 6 },
          { ...request, snapshotId: "00000000-0000-4000-8000-000000000002" },
        ])
          assert.equal(
            (yield* readCadPartInfo(snapshot, state, read, input).pipe(Effect.flip)).reason,
            "revision-conflict",
          );
        assert.equal(
          (yield* readCadPartInfo(snapshot, state, read, {
            ...request,
            occurrenceId: id(999),
          }).pipe(Effect.flip)).reason,
          "invalid-operation",
        );
        assert.equal(reads, 0);
      }),
  );
  it.effect(
    "bounds repeated occurrences and material properties without treating absence as zero",
    () =>
      Effect.gen(function* () {
        const part = snapshot.parts[0]!;
        const large = {
          ...snapshot,
          parts: [
            {
              ...part,
              metadata: {
                ...part.metadata!,
                material: {
                  displayName: "s".repeat(4096),
                  properties: Array.from({ length: 1024 }, () => ({
                    name: "n".repeat(4096),
                    value: "v".repeat(4096),
                  })),
                },
              },
            },
          ],
        };
        const result = yield* readCadPartInfo(large, state, unavailableAsset, {
          ...request,
          repeatedOccurrenceLimit: 50,
        });
        assert.isTrue(checkResult(result));
        assert.lengthOf(result.repeatedOccurrences.occurrenceIds, 50);
        assert.equal(result.repeatedOccurrences.total, 60);
        assert.equal(result.material.status, "available");
        if (result.material.status === "available") {
          assert.lengthOf(result.material.properties, 16);
          assert.equal(result.material.propertyCount, 1024);
          assert.lengthOf(result.material.displayName!, 512);
          assert.isTrue(result.material.truncated);
        }
        assert.isBelow(encode(result).length, 30_000);
        assert.deepEqual(result.geometry, { status: "unavailable", reason: "asset-unavailable" });
        for (const repeatedOccurrenceLimit of [0, 51, -1, 1.5])
          assert.isFalse(checkInput({ ...request, repeatedOccurrenceLimit }));
      }),
  );
  it.effect("reports missing metadata and uncached suppressed geometry explicitly", () =>
    Effect.gen(function* () {
      const missing = {
        ...snapshot,
        parts: [{ ...snapshot.parts[0]!, metadata: null, geometryRequired: false }],
        assets: [],
      };
      const result = yield* readCadPartInfo(
        missing,
        state,
        () => Effect.die("Must not read absent asset"),
        { ...request, occurrenceId: id(3) },
      );
      assert.isTrue(result.occurrence.suppressed);
      assert.isNull(result.metadata);
      assert.deepEqual(result.material, { status: "unavailable", reason: "not-in-snapshot" });
      assert.deepEqual(result.geometry, { status: "unavailable", reason: "suppressed" });
      const assembly = {
        ...missing,
        nodes: [{ ...missing.nodes[0]!, kind: "assembly" as const, sourcePartKey: null }],
      };
      const group = yield* readCadPartInfo(assembly, state, unavailableAsset, request);
      assert.isNull(group.source);
      assert.deepEqual(group.geometry, { status: "unavailable", reason: "not-part" });
      assert.equal(group.repeatedOccurrences.total, 0);
    }),
  );
  it.effect(
    "does not expose placeholder placement for suppressed instances with a cached sibling",
    () =>
      Effect.gen(function* () {
        const result = yield* readCadPartInfo(
          snapshot,
          state,
          () => Effect.die("Suppressed placement must not read sibling geometry"),
          { ...request, occurrenceId: id(3) },
        );
        assert.isTrue(checkResult(result));
        assert.deepEqual(result.assembledTransform, {
          status: "unavailable",
          reason: "suppressed",
        });
        assert.deepEqual(result.geometry, { status: "unavailable", reason: "suppressed" });
        assert.equal(result.metadata?.name, "Bolt");
        assert.equal(result.repeatedOccurrences.total, 60);
        assert.equal(result.repeatedOccurrences.suppressedCount, 1);
      }),
  );
  it.effect("distinguishes absent material fields from missing metadata", () =>
    Effect.gen(function* () {
      const part = snapshot.parts[0]!;
      const result = yield* readCadPartInfo(
        { ...snapshot, parts: [{ ...part, metadata: { ...part.metadata!, material: null } }] },
        state,
        unavailableAsset,
        request,
      );
      assert.isTrue(checkResult(result));
      assert.deepEqual(result.material, { status: "unavailable", reason: "not-in-metadata" });
    }),
  );
  it.effect("preserves metadata when a cached mesh cannot be decoded", () =>
    Effect.gen(function* () {
      const result = yield* readCadPartInfo(
        snapshot,
        state,
        () => Effect.succeed(new Uint8Array([1, 2, 3])),
        request,
      );
      assert.deepEqual(result.geometry, { status: "unavailable", reason: "invalid-geometry" });
      assert.equal(result.metadata?.name, "Bolt");
    }),
  );
});
