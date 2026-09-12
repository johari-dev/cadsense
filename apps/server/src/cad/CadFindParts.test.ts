import {
  CadFindPartsInput,
  CadFindPartsResult,
  CadSnapshotManifest,
  ProjectId,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { findCadParts } from "./CadFindParts.ts";
import { initialCadView } from "./CadViewState.ts";

const id = (value: number) => value.toString(16).padStart(64, "0");
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: id(1000),
  projectId: ProjectId.make("find-parts"),
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
  nodes: [
    { number: 1, parent: null, name: "Root", key: null },
    { number: 2, parent: 1, name: "Left", key: null },
    { number: 3, parent: 2, name: "Bolt", key: 100 },
    { number: 4, parent: 1, name: "Right", key: null },
    { number: 5, parent: 4, name: "Bolt", key: 100 },
    { number: 6, parent: 4, name: "Bolt", key: 101 },
    { number: 7, parent: 4, name: "Bracket", key: 102 },
    { number: 8, parent: 4, name: "Suppressed bolt", key: 100 },
    { number: 9, parent: 4, name: "Unknown part", key: 103 },
  ].map(({ number, parent, name, key }) => ({
    id: id(number),
    parentId: parent === null ? null : id(parent),
    name,
    occurrencePath: [String(number)],
    instanceId: String(number),
    kind: key === null ? "assembly" : "part",
    suppressed: number === 8,
    defaultVisible: number !== 2 && number !== 7,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    sourcePartKey: key === null ? null : id(key),
  })),
  parts: [100, 101, 102, 103].map((key) => ({
    geometryKey: id(key),
    geometryRequired: false,
    source: {
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      documentMicroversion: "d".repeat(24),
      documentVersion: null,
      elementId: "b".repeat(24),
      configuration: key === 101 ? "size=6" : "size=5",
      fullConfiguration: key === 101 ? "size=6" : "size=5",
      partId: "JHD",
      tessellationProfile: "test",
    },
    metadata:
      key === 103
        ? null
        : {
            name: "Source part",
            bodyType: key === 101 ? "surface" : "solid",
            isMesh: false,
            isHidden: false,
            partIdentity: null,
            configurationId: null,
            appearance: null,
            material:
              key === 102
                ? null
                : { displayName: key === 101 ? "Aluminum 6061" : "Stainless Steel" },
          },
  })),
  assets: [],
  dependencies: [],
});
const state = initialCadView(snapshot, 3);
const request = { snapshotId: snapshot.snapshotId, expectedRevision: 3 };
const validResult = Schema.is(CadFindPartsResult);
const validInput = Schema.is(CadFindPartsInput);
const ids = (result: CadFindPartsResult) => result.entries.map((entry) => entry.occurrenceId);
const encode = Schema.encodeSync(Schema.fromJsonString(CadFindPartsResult));

describe("cad_find_parts", () => {
  it.effect(
    "disambiguates duplicate names by assembly paths and exact configured source keys",
    () =>
      Effect.gen(function* () {
        const result = yield* findCadParts(snapshot, state, { ...request, nameQuery: " bOlT " });
        assert.deepEqual(ids(result), [3, 5, 6, 8].map(id));
        assert.isTrue(validResult(result));
        assert.deepEqual(result.entries[0]!.assemblyPath, [
          { occurrenceId: id(1), name: "Root" },
          { occurrenceId: id(2), name: "Left" },
        ]);
        assert.deepEqual(result.entries[1]!.assemblyPath, [
          { occurrenceId: id(1), name: "Root" },
          { occurrenceId: id(4), name: "Right" },
        ]);
        assert.equal(result.entries[1]!.source?.configuration, "size=5");
        assert.equal(result.entries[2]!.source?.configuration, "size=6");
        assert.deepEqual(
          ids(yield* findCadParts(snapshot, state, { ...request, sourcePartKey: id(100) })),
          [3, 5, 8].map(id),
        );
        assert.deepEqual(
          ids(yield* findCadParts(snapshot, state, { ...request, sourcePartKey: id(999) })),
          [],
        );
      }),
  );
  it.effect("combines material and body filters while reporting absent metadata explicitly", () =>
    Effect.gen(function* () {
      const steel = yield* findCadParts(snapshot, state, {
        ...request,
        nameQuery: "BOLT",
        materialName: " STEEL ",
        bodyType: " SOLID ",
      });
      assert.deepEqual(ids(steel), [3, 5, 8].map(id));
      const surface = yield* findCadParts(snapshot, state, { ...request, bodyType: "surface" });
      assert.deepEqual(ids(surface), [id(6)]);
      const noMaterial = yield* findCadParts(snapshot, state, { ...request, nameQuery: "bracket" });
      assert.deepEqual(noMaterial.entries[0]!.material, { status: "unavailable", name: null });
      assert.isTrue(noMaterial.entries[0]!.metadataAvailable);
      const noMetadata = yield* findCadParts(snapshot, state, { ...request, nameQuery: "unknown" });
      assert.isFalse(noMetadata.entries[0]!.metadataAvailable);
      assert.isNull(noMetadata.entries[0]!.bodyType);
      assert.deepEqual(noMetadata.entries[0]!.material, { status: "unavailable", name: null });
      assert.equal(
        (yield* findCadParts(snapshot, state, { ...request, kind: "all" })).totalMatches,
        9,
      );
      assert.deepEqual(
        ids(yield* findCadParts(snapshot, state, { ...request, kind: "assembly" })),
        [1, 2, 4].map(id),
      );
    }),
  );
  it.effect(
    "uses effective ancestor, isolation and suppression visibility without mutating the view",
    () =>
      Effect.gen(function* () {
        const before = structuredClone(state);
        assert.deepEqual(
          ids(yield* findCadParts(snapshot, state, { ...request, visibility: "hidden" })),
          [3, 7, 8].map(id),
        );
        assert.deepEqual(
          ids(
            yield* findCadParts(
              snapshot,
              { ...state, visibility: { [id(2)]: true } },
              { ...request, visibility: "visible" },
            ),
          ),
          [3, 5, 6, 9].map(id),
        );
        assert.deepEqual(
          ids(
            yield* findCadParts(
              snapshot,
              { ...state, isolatedOccurrenceIds: [id(5)] },
              { ...request, visibility: "visible" },
            ),
          ),
          [id(5)],
        );
        assert.deepEqual(state, before);
      }),
  );
  it.effect("paginates deterministically without duplicate or missing occurrences", () =>
    Effect.gen(function* () {
      const all: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* findCadParts(snapshot, state, {
          ...request,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(page.totalMatches, 6);
        assert.isTrue(validResult(page));
        all.push(...ids(page));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(all, [3, 5, 6, 7, 8, 9].map(id));
      assert.equal(new Set(all).size, 6);
      const first = yield* findCadParts(snapshot, state, {
        ...request,
        nameQuery: " bolt ",
        limit: 2,
      });
      const same = yield* findCadParts(snapshot, state, {
        ...request,
        nameQuery: "BOLT",
        limit: 2,
      });
      assert.equal(first.nextCursor, same.nextCursor);
      assert.deepEqual(
        ids(
          yield* findCadParts(snapshot, state, {
            ...request,
            nameQuery: "  bOlT",
            limit: 2,
            cursor: first.nextCursor,
          }),
        ),
        [6, 8].map(id),
      );
    }),
  );
  it.effect(
    "rejects cursor mismatches, stale revisions, and malformed or out-of-page offsets",
    () =>
      Effect.gen(function* () {
        const first = yield* findCadParts(snapshot, state, { ...request, limit: 2 });
        const cursor = first.nextCursor!;
        for (const change of [
          { nameQuery: "bolt" },
          { materialName: "steel" },
          { sourcePartKey: id(100) },
          { bodyType: "solid" },
          { kind: "all" },
          { visibility: "visible" },
          { limit: 3 },
        ])
          assert.equal(
            (yield* findCadParts(snapshot, state, { ...request, limit: 2, cursor, ...change }).pipe(
              Effect.flip,
            )).reason,
            "invalid-operation",
          );
        for (const suffix of ["0", "-2", "3", "6", "8", "02", "1.5", "NaN", "9007199254740992"])
          assert.equal(
            (yield* findCadParts(snapshot, state, {
              ...request,
              limit: 2,
              cursor: cursor.replace(/:[0-9]+$/, `:${suffix}`),
            }).pipe(Effect.flip)).reason,
            "invalid-operation",
          );
        assert.equal(
          (yield* findCadParts(snapshot, state, { ...request, expectedRevision: 2 }).pipe(
            Effect.flip,
          )).reason,
          "revision-conflict",
        );
        assert.equal(
          (yield* findCadParts(
            snapshot,
            { ...state, revision: 4 },
            { ...request, expectedRevision: 4, limit: 2, cursor },
          ).pipe(Effect.flip)).reason,
          "invalid-operation",
        );
        const nextId = "00000000-0000-4000-8000-000000000002";
        assert.equal(
          (yield* findCadParts(
            { ...snapshot, snapshotId: nextId },
            { ...state, snapshotId: nextId },
            { ...request, snapshotId: nextId, limit: 2, cursor },
          ).pipe(Effect.flip)).reason,
          "invalid-operation",
        );
        assert.equal(
          (yield* findCadParts(snapshot, state, { ...request, snapshotId: nextId }).pipe(
            Effect.flip,
          )).reason,
          "revision-conflict",
        );
      }),
  );
  it.effect("caps response text and nearest ancestors while keeping occurrence identity", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 21 }, (_, i) => ({
        ...snapshot.nodes[0]!,
        id: id(i + 1),
        parentId: i === 0 ? null : id(i),
        name: "a".repeat(4096),
        kind: i === 20 ? ("part" as const) : ("assembly" as const),
        sourcePartKey: i === 20 ? id(100) : null,
      }));
      const result = yield* findCadParts({ ...snapshot, nodes }, state, request);
      assert.isTrue(validResult(result));
      const entry = result.entries[0]!;
      assert.equal(entry.occurrenceId, id(21));
      assert.lengthOf(entry.name, 256);
      assert.lengthOf(entry.assemblyPath, 16);
      assert.equal(entry.assemblyPath[0]!.occurrenceId, id(5));
      assert.equal(entry.omittedAncestorCount, 4);
      assert.isTrue(entry.textTruncated);
      assert.isBelow(encode(result).length, 8000);
    }),
  );
  it.effect("keeps unfiltered 100,000-node searches bounded", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 100_000 }, (_, i) => ({
        ...snapshot.nodes[2]!,
        id: id(i + 1000),
        parentId: null,
      }));
      const result = yield* findCadParts({ ...snapshot, nodes }, state, request);
      assert.equal(result.totalMatches, 100_000);
      assert.lengthOf(result.entries, 25);
      assert.isNotNull(result.nextCursor);
      assert.isTrue(validResult(result));
      const empty = yield* findCadParts({ ...snapshot, nodes: [] }, state, request);
      assert.deepEqual(empty.entries, []);
      assert.equal(empty.totalMatches, 0);
      assert.isNull(empty.nextCursor);
    }),
  );
  it("rejects unbounded input pages and invalid filters", () => {
    for (const limit of [0, 51, 1.5, -1]) assert.isFalse(validInput({ ...request, limit }));
    assert.isFalse(validInput({ ...request, nameQuery: "x".repeat(257) }));
    assert.isFalse(validInput({ ...request, cursor: "x".repeat(161) }));
    assert.isFalse(validInput({ ...request, kind: "face" }));
  });
});
