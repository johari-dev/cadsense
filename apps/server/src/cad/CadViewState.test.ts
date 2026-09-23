import { CadSnapshotManifest, CadViewState, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { indexCadSnapshot, initialCadView, rebaseCadView, updateCadView } from "./CadViewState.ts";
import { readCadHierarchy } from "./CadHierarchy.ts";

const id = (value: number) => value.toString(16).padStart(64, "0");
const rootId = id(20);
const snapshotId = "00000000-0000-4000-8000-000000000001";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId,
  rootId,
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
  nodes: [
    { number: 1, parent: null, name: "Root" },
    { number: 2, parent: 1, name: "Intake left" },
    { number: 3, parent: 2, name: "Bolt" },
    { number: 4, parent: 1, name: "Intake right" },
    { number: 5, parent: 4, name: "Bolt" },
    { number: 6, parent: 4, name: "Suppressed bolt" },
  ].map(({ number, parent, name }) => ({
    id: id(number),
    parentId: parent === null ? null : id(parent),
    name,
    occurrencePath: [String(number)],
    instanceId: String(number),
    kind: "assembly",
    suppressed: number === 6,
    defaultVisible: true,
    transform: identity,
    sourcePartKey: null,
  })),
  parts: [],
  dependencies: [],
  assets: [],
});
const snapshots = new Map([[rootId, snapshot]]);
const encodeViewJson = Schema.encodeEffect(Schema.fromJsonString(CadViewState));
const decodeViewJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CadViewState));

describe("private CAD semantic state", () => {
  it.effect("rejects invalid camera geometry and zoom without applying earlier operations", () =>
    Effect.gen(function* () {
      const before = initialCadView(snapshot);
      const pose = {
        position: [1, -2, 3],
        target: [0, 0, 0],
        up: [0, 0, 1],
        projection: "perspective",
        zoom: 1,
      };
      for (const change of [
        { position: [0, 0, 0] },
        { up: [0, 0, 0] },
        { up: [1, -2, 3] },
        { target: [Infinity, 0, 0] },
        { zoom: 0 },
        { zoom: -1 },
        { zoom: 100_001 },
      ]) {
        const error = yield* updateCadView(
          before,
          {
            expectedRevision: 0,
            operations: [
              { type: "hide", occurrenceIds: [id(2)] },
              { type: "camera-pose", pose: { ...pose, ...change } },
            ],
          },
          snapshots,
        ).pipe(Effect.flip);
        assert.equal(error.reason, "invalid-operation");
        assert.deepEqual(before, initialCadView(snapshot));
      }
    }),
  );

  it.effect(
    "pages direct occurrence children and rejects cursors from another parent or snapshot",
    () =>
      Effect.gen(function* () {
        const index = indexCadSnapshot(snapshot);
        const state = initialCadView(snapshot);
        const first = yield* readCadHierarchy(index, state, {
          parentOccurrenceId: id(1),
          limit: 1,
        });
        assert.deepEqual(
          first.entries.map((entry) => entry.occurrenceId),
          [id(2)],
        );
        assert.equal(first.entries[0]!.hasChildren, true);
        assert.isNotNull(first.nextCursor);
        const next = yield* readCadHierarchy(index, state, {
          parentOccurrenceId: id(1),
          limit: 1,
          cursor: first.nextCursor,
        });
        assert.deepEqual(
          next.entries.map((entry) => entry.occurrenceId),
          [id(4)],
        );
        assert.isNull(next.nextCursor);
        for (const input of [
          { parentOccurrenceId: id(4), cursor: first.nextCursor },
          {
            parentOccurrenceId: id(1),
            cursor: first.nextCursor!.replace(snapshotId, "00000000-0000-4000-8000-000000000002"),
          },
          { limit: 201 },
        ])
          assert.equal(
            (yield* readCadHierarchy(index, state, input).pipe(Effect.flip)).reason,
            "invalid-operation",
          );
      }),
  );
  it.effect("rejects a whole ordered batch without modifying the caller's state", () =>
    Effect.gen(function* () {
      const before = initialCadView(snapshot);
      const result = yield* updateCadView(
        before,
        {
          expectedRevision: 0,
          operations: [
            { type: "hide", occurrenceIds: [id(2)] },
            { type: "fit", occurrenceIds: [id(99)] },
          ],
        },
        snapshots,
      ).pipe(Effect.flip);
      assert.equal(result.reason, "invalid-operation");
      assert.deepEqual(before, initialCadView(snapshot));
      assert.equal(
        (yield* updateCadView(
          before,
          { expectedRevision: 1, operations: [{ type: "explode", amount: 0.5 }] },
          snapshots,
        ).pipe(Effect.flip)).reason,
        "revision-conflict",
      );
    }),
  );

  it.effect("changes one repeated occurrence's subtree, never its sibling design instance", () =>
    Effect.gen(function* () {
      const state = yield* updateCadView(
        initialCadView(snapshot),
        {
          expectedRevision: 0,
          operations: [
            { type: "hide", occurrenceIds: [id(2)] },
            { type: "explode", amount: 0.75 },
          ],
        },
        snapshots,
      );
      const visibility = indexCadSnapshot(snapshot).visible(state);
      assert.equal(visibility.get(id(3)), false);
      assert.equal(visibility.get(id(5)), true);
      assert.equal(visibility.get(id(6)), false);
      assert.equal(state.revision, 1);
      assert.equal(state.explosion, 0.75);
    }),
  );

  it.effect("isolates subtrees, restores visibility, and cannot unsuppress geometry", () =>
    Effect.gen(function* () {
      const isolated = yield* updateCadView(
        initialCadView(snapshot),
        {
          expectedRevision: 0,
          operations: [
            { type: "isolate", occurrenceIds: [id(4)] },
            { type: "show", occurrenceIds: [id(6)] },
          ],
        },
        snapshots,
      );
      const visibility = indexCadSnapshot(snapshot).visible(isolated);
      assert.equal(visibility.get(id(3)), false);
      assert.equal(visibility.get(id(5)), true);
      assert.equal(visibility.get(id(6)), false);
      const restored = yield* updateCadView(
        isolated,
        { expectedRevision: 1, operations: [{ type: "reset-visibility" }] },
        snapshots,
      );
      assert.equal(indexCadSnapshot(snapshot).visible(restored).get(id(3)), true);
    }),
  );

  it.effect("isolates a previously hidden occurrence and exposes its ancestor path", () =>
    Effect.gen(function* () {
      const state = yield* updateCadView(
        initialCadView(snapshot),
        {
          expectedRevision: 0,
          operations: [
            { type: "hide", occurrenceIds: [id(2)] },
            { type: "isolate", occurrenceIds: [id(3)] },
          ],
        },
        snapshots,
      );
      const visible = indexCadSnapshot(snapshot).visible(state);
      assert.equal(visible.get(id(1)), true);
      assert.equal(visible.get(id(2)), true);
      assert.equal(visible.get(id(3)), true);
      assert.equal(visible.get(id(5)), false);
    }),
  );

  it.effect("selects another cached root with a fitted camera and clean root-specific state", () =>
    Effect.gen(function* () {
      const second = {
        ...snapshot,
        rootId: id(21),
        snapshotId: "00000000-0000-4000-8000-000000000002",
      };
      const state = yield* updateCadView(
        { ...initialCadView(snapshot), explosion: 1, visibility: { [id(2)]: false } },
        {
          expectedRevision: 0,
          operations: [{ type: "select-root", rootId: second.rootId }],
        },
        new Map([...snapshots, [second.rootId, second]]),
      );
      assert.deepEqual(state, initialCadView(second, 1));
    }),
  );

  it("drops incompatible references and refits when an idle view adopts new geometry", () => {
    const next = {
      ...snapshot,
      snapshotId: "00000000-0000-4000-8000-000000000002",
      nodes: snapshot.nodes.filter((node) => node.id !== id(3)),
    };
    const state = rebaseCadView(
      {
        ...initialCadView(snapshot),
        visibility: { [id(3)]: false, [id(5)]: false },
        camera: { kind: "preset", preset: "front", fit: [id(3)] },
      },
      next,
    );
    assert.deepEqual(state.visibility, { [id(5)]: false });
    assert.deepEqual(state.camera, { kind: "preset", preset: "isometric", fit: [] });
    assert.equal(state.snapshotId, next.snapshotId);
  });
});

it.effect(
  "persists bounded inspection state, rebases selections, and resets without changing framing",
  () =>
    Effect.gen(function* () {
      const legacy = initialCadView(snapshot);
      assert.deepEqual(yield* decodeViewJson(yield* encodeViewJson(legacy)), legacy);
      const inspected = yield* updateCadView(
        legacy,
        {
          expectedRevision: 0,
          operations: [
            { type: "highlight", occurrenceIds: [id(3), id(5)] },
            { type: "ghost", occurrenceIds: [id(3), id(5)], opacity: 0.25 },
            { type: "section", planes: [{ normal: [1, 0, 0], constant: -0.01 }] },
          ],
        },
        snapshots,
      );
      const persisted = yield* decodeViewJson(yield* encodeViewJson(inspected));
      assert.deepEqual(persisted, inspected);
      const rebased = rebaseCadView(persisted, {
        ...snapshot,
        nodes: snapshot.nodes.filter((node) => node.id !== id(3)),
      });
      assert.deepEqual(rebased.highlightedOccurrenceIds, [id(5)]);
      assert.deepEqual(rebased.ghost?.occurrenceIds, [id(5)]);
      assert.deepEqual(rebased.sectionPlanes, inspected.sectionPlanes);
      const cleared = yield* updateCadView(
        inspected,
        { expectedRevision: 1, operations: [{ type: "reset-inspection" }] },
        snapshots,
      );
      assert.deepEqual(cleared.highlightedOccurrenceIds, []);
      assert.isNull(cleared.ghost);
      assert.deepEqual(cleared.sectionPlanes, []);
      assert.deepEqual(cleared.camera, legacy.camera);
      assert.equal(cleared.revision, 2);
    }),
);

it.effect("rejects invalid inspection batches without partial changes", () =>
  Effect.gen(function* () {
    const before = initialCadView(snapshot);
    for (const operation of [
      { type: "highlight", occurrenceIds: [id(99)] },
      { type: "ghost", occurrenceIds: [id(99)], opacity: 0.3 },
      { type: "ghost", occurrenceIds: [], opacity: 0 },
      { type: "ghost", occurrenceIds: [], opacity: 1 },
      { type: "highlight", occurrenceIds: Array(257).fill(id(3)) },
      ...[
        [0, 0, 0],
        [2, 0, 0],
        [Infinity, 0, 0],
      ].map((normal) => ({ type: "section", planes: [{ normal, constant: 0 }] })),
      { type: "section", planes: [{ normal: [1, 0, 0], constant: Infinity }] },
      {
        type: "section",
        planes: Array.from({ length: 7 }, () => ({ normal: [1, 0, 0], constant: 0 })),
      },
    ]) {
      const error = yield* updateCadView(
        before,
        { expectedRevision: 0, operations: [{ type: "hide", occurrenceIds: [id(2)] }, operation] },
        snapshots,
      ).pipe(Effect.flip);
      assert.equal(error.reason, "invalid-operation");
      assert.deepEqual(before, initialCadView(snapshot));
    }
  }),
);
