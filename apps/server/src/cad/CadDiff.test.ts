import {
  CadSnapshotManifest,
  OnshapeWorkspaceId,
  ThreadId,
  TurnId,
  type CadComment,
  type CadSnapshotNode,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  chooseCadDiffBase,
  diffCadManifests,
  pageCadDiff,
  retainedCadCandidates,
} from "./CadDiff.ts";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const hash = (seed: string) => seed.repeat(64).slice(0, 64);
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
const source = (microversion: string, partId: string) => ({
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  documentMicroversion: microversion.repeat(24),
  documentVersion: null,
  elementId: "b".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  partId,
  tessellationProfile: "test",
});
const metadata = {
  name: "Part",
  bodyType: "solid",
  isHidden: null,
  isMesh: null,
  partIdentity: null,
  configurationId: null,
  appearance: null,
  material: null,
};
type Part = { key: string; microversion: string; partId: string; sha: string; required?: boolean };
const part = (
  key: string,
  microversion: string,
  partId: string,
  sha: string,
  required = true,
): Part => ({
  key: hash(key),
  microversion,
  partId,
  sha: hash(sha),
  required,
});
type NodeInput = {
  id: string;
  parent: string | null;
  path: readonly string[];
  name: string;
  kind?: CadSnapshotNode["kind"];
  transform?: readonly number[];
  part?: Part;
  suppressed?: boolean;
  visible?: boolean;
};
const manifest = (snapshotId: string, createdAt: string, nodes: readonly NodeInput[]) => {
  const parts = new Map(nodes.flatMap((node) => (node.part ? [[node.part.key, node.part]] : [])));
  return decodeManifest({
    schemaVersion: 1,
    snapshotId,
    rootId: hash("1"),
    projectId: "diff-project",
    createdAt,
    root: {
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      elementId: "c".repeat(24),
      kind: "assembly",
      originalRevision: { kind: "w", id: "d".repeat(24) },
      microversionId: snapshotId.slice(-1).repeat(24),
      configuration: "default",
      tessellationProfile: "test",
    },
    nodes: nodes.map((node) => ({
      id: hash(node.id),
      parentId: node.parent === null ? null : hash(node.parent),
      occurrencePath: node.path,
      instanceId: node.path.at(-1) ?? null,
      name: node.name,
      kind: node.kind ?? (node.part ? "part" : "assembly"),
      suppressed: node.suppressed ?? false,
      defaultVisible: node.visible ?? true,
      transform: node.transform ?? identity,
      sourcePartKey: node.part?.key ?? null,
    })),
    parts: [...parts.values()].map((item) => ({
      geometryKey: item.key,
      source: source(item.microversion, item.partId),
      geometryRequired: item.required ?? true,
      metadata: item.required === false ? null : metadata,
    })),
    assets: [...parts.values()]
      .filter((item) => item.required !== false)
      .map((item) => ({
        geometryKey: item.key,
        sha256: item.sha,
        byteLength: 3,
        format: "glb",
        relativePath: `${item.sha}.glb`,
      })),
    dependencies: [...new Set([...parts.values()].map((item) => item.microversion))].map(
      (microversion) => {
        const {
          partId: _partId,
          tessellationProfile: _profile,
          ...studio
        } = source(microversion, "x");
        return studio;
      },
    ),
  });
};
const baseId = "00000000-0000-4000-8000-00000000000a";
const targetId = "00000000-0000-4000-8000-00000000000b";
const bolt = part("f", "1", "bolt", "a");
const plate = part("e", "1", "plate", "b");
const root: NodeInput = { id: "2", parent: null, path: [], name: "Assembly" };
const base = manifest(baseId, "2026-09-01T00:00:00Z", [
  root,
  { id: "3", parent: "2", path: ["frame"], name: "Frame", transform: translate(0, 0, 0) },
  { id: "4", parent: "3", path: ["frame", "plate"], name: "Plate", part: plate },
  {
    id: "5",
    parent: "2",
    path: ["bolt-1"],
    name: "Bolt",
    part: bolt,
    transform: translate(0.1, 0, 0),
  },
  {
    id: "6",
    parent: "2",
    path: ["bolt-2"],
    name: "Bolt",
    part: bolt,
    transform: translate(0.2, 0, 0),
  },
  { id: "7", parent: "2", path: ["washer"], name: "Washer", part: part("d", "1", "washer", "c") },
  { id: "8", parent: "2", path: ["cover"], name: "Cover", part: part("9", "1", "cover", "d") },
]);

describe("diffCadManifests", () => {
  it("reports every category once per occurrence path and leaves untouched paths alone", () => {
    // Frame moves; Plate keeps its placement inside Frame so only Frame is reported as moved.
    // bolt-1 moves; bolt-2 is a second instance of the same part and stays put.
    // Washer keeps its bytes under a new studio microversion: not a geometry change.
    // Cover is removed, Bracket added, Assembly renamed, and bolt-2 suppressed and hidden.
    const target = manifest(targetId, "2026-09-02T00:00:00Z", [
      { ...root, name: "Assembly v2" },
      { id: "3", parent: "2", path: ["frame"], name: "Frame", transform: translate(0, 0.5, 0) },
      {
        id: "4",
        parent: "3",
        path: ["frame", "plate"],
        name: "Plate",
        part: part("7", "2", "plate", "e"),
        transform: translate(0, 0.5, 0),
      },
      {
        id: "5",
        parent: "2",
        path: ["bolt-1"],
        name: "Bolt",
        part: bolt,
        transform: translate(0.3, 0, 0),
      },
      {
        id: "6",
        parent: "2",
        path: ["bolt-2"],
        name: "Bolt",
        part: bolt,
        transform: translate(0.2, 0, 0),
        suppressed: true,
        visible: false,
      },
      {
        id: "7",
        parent: "2",
        path: ["washer"],
        name: "Washer",
        part: part("6", "2", "washer", "c"),
      },
      {
        id: "9",
        parent: "2",
        path: ["bracket"],
        name: "Bracket",
        part: part("8", "2", "bracket", "f"),
      },
    ]);
    const diff = diffCadManifests(base, target);
    assert.deepEqual(diff.counts, {
      added: 1,
      removed: 1,
      modified: 5,
      moved: 2,
      geometryChanged: 1,
      renamed: 1,
      suppressionChanged: 1,
      visibilityChanged: 1,
      unchanged: 1,
    });
    assert.deepEqual(
      diff.entries.map((entry) => [entry.status, entry.occurrencePath.join("/"), ...entry.changes]),
      [
        ["added", "bracket"],
        ["removed", "cover"],
        ["modified", "", "renamed"],
        ["modified", "bolt-1", "moved"],
        ["modified", "bolt-2", "suppression-changed", "visibility-changed"],
        ["modified", "frame", "moved"],
        ["modified", "frame/plate", "geometry-changed"],
      ],
    );
    const renamed = diff.entries.find((entry) => entry.changes.includes("renamed"))!;
    assert.equal(renamed.previousName, "Assembly");
    assert.equal(renamed.name, "Assembly v2");
    const added = diff.entries[0]!;
    assert.isNull(added.baseOccurrenceId);
    assert.equal(added.targetOccurrenceId, hash("9"));
    const removed = diff.entries[1]!;
    assert.equal(removed.baseOccurrenceId, hash("8"));
    assert.isNull(removed.targetOccurrenceId);
    assert.equal(removed.kind, "part");
  });
  it("reports both instances of a shared part whose geometry changed", () => {
    const changed = part("5", "2", "bolt", "9");
    const target = manifest(targetId, "2026-09-02T00:00:00Z", [
      root,
      { id: "3", parent: "2", path: ["frame"], name: "Frame" },
      { id: "4", parent: "3", path: ["frame", "plate"], name: "Plate", part: plate },
      {
        id: "5",
        parent: "2",
        path: ["bolt-1"],
        name: "Bolt",
        part: changed,
        transform: translate(0.1, 0, 0),
      },
      {
        id: "6",
        parent: "2",
        path: ["bolt-2"],
        name: "Bolt",
        part: changed,
        transform: translate(0.2, 0, 0),
      },
      {
        id: "7",
        parent: "2",
        path: ["washer"],
        name: "Washer",
        part: part("d", "1", "washer", "c"),
      },
      { id: "8", parent: "2", path: ["cover"], name: "Cover", part: part("9", "1", "cover", "d") },
    ]);
    const diff = diffCadManifests(base, target);
    assert.equal(diff.counts.geometryChanged, 2);
    assert.deepEqual(
      diff.entries.map((entry) => entry.occurrencePath.join("/")),
      ["bolt-1", "bolt-2"],
    );
  });
  it("treats import noise below the epsilon and a reimported identical model as unchanged", () => {
    const reimported = manifest(targetId, "2026-09-02T00:00:00Z", [
      root,
      { id: "3", parent: "2", path: ["frame"], name: "Frame", transform: translate(1e-9, 0, 0) },
      { id: "4", parent: "3", path: ["frame", "plate"], name: "Plate", part: plate },
      {
        id: "5",
        parent: "2",
        path: ["bolt-1"],
        name: "Bolt",
        part: bolt,
        transform: translate(0.1, 0, 0),
      },
      {
        id: "6",
        parent: "2",
        path: ["bolt-2"],
        name: "Bolt",
        part: bolt,
        transform: translate(0.2, 0, 0),
      },
      {
        id: "7",
        parent: "2",
        path: ["washer"],
        name: "Washer",
        part: part("d", "1", "washer", "c"),
      },
      { id: "8", parent: "2", path: ["cover"], name: "Cover", part: part("9", "1", "cover", "d") },
    ]);
    const diff = diffCadManifests(base, reimported);
    assert.deepEqual(diff.entries, []);
    assert.equal(diff.counts.unchanged, base.nodes.length);
    assert.equal(diff.counts.modified, 0);
  });
  it("reports a suppressed part whose source changed even though neither side has geometry", () => {
    const before = manifest(baseId, "2026-09-01T00:00:00Z", [
      root,
      {
        id: "5",
        parent: "2",
        path: ["bolt"],
        name: "Bolt",
        part: part("f", "1", "bolt", "a", false),
        suppressed: true,
      },
    ]);
    const after = manifest(targetId, "2026-09-02T00:00:00Z", [
      root,
      {
        id: "5",
        parent: "2",
        path: ["bolt"],
        name: "Bolt",
        part: part("5", "2", "bolt", "a", false),
        suppressed: true,
      },
    ]);
    assert.deepEqual(diffCadManifests(before, after).entries[0]?.changes, ["geometry-changed"]);
  });
});

describe("pageCadDiff", () => {
  const diff = diffCadManifests(
    base,
    manifest(targetId, "2026-09-02T00:00:00Z", [
      root,
      { id: "3", parent: "2", path: ["frame"], name: "Frame" },
    ]),
  );
  it.effect("pages in order with a cursor bound to the snapshot pair", () =>
    Effect.gen(function* () {
      assert.equal(diff.entries.length, 5);
      const first = yield* pageCadDiff(diff, baseId, targetId, { limit: 2 });
      assert.equal(first.nextCursor, `${baseId}:${targetId}:2`);
      const second = yield* pageCadDiff(diff, baseId, targetId, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      const third = yield* pageCadDiff(diff, baseId, targetId, { cursor: second.nextCursor! });
      assert.isNull(third.nextCursor);
      assert.deepEqual([...first.entries, ...second.entries, ...third.entries], diff.entries);
      const foreign = yield* pageCadDiff(diff, targetId, baseId, {
        cursor: first.nextCursor!,
      }).pipe(Effect.flip);
      assert.equal(foreign.reason, "invalid-operation");
      assert.include(foreign.details, "different snapshot pair");
      const past = yield* pageCadDiff(diff, baseId, targetId, {
        cursor: `${baseId}:${targetId}:6`,
      }).pipe(Effect.flip);
      assert.include(past.details, "past the end");
    }),
  );
});

describe("chooseCadDiffBase", () => {
  const retained = (
    snapshotId: string,
    createdAt: string,
    retainedBy: ("current" | "rollback" | "comments")[],
    commentNumbers: number[] = [],
  ) => ({
    snapshotId,
    createdAt,
    microversionId: OnshapeWorkspaceId.make("a".repeat(24)),
    retainedBy,
    commentNumbers,
  });
  const target = {
    snapshotId: targetId,
    createdAt: "2026-09-03T00:00:00Z",
    microversionId: OnshapeWorkspaceId.make("b".repeat(24)),
  };
  it("picks the newest snapshot created before the target and explains why", () => {
    const older = retained(baseId, "2026-09-01T00:00:00Z", ["comments"], [2, 1]);
    const newer = retained(
      "00000000-0000-4000-8000-00000000000c",
      "2026-09-02T00:00:00Z",
      ["rollback", "comments"],
      [3],
    );
    const later = retained(
      "00000000-0000-4000-8000-00000000000d",
      "2026-09-04T00:00:00Z",
      ["comments"],
      [4],
    );
    const chosen = chooseCadDiffBase(
      [later, older, newer, retained(targetId, target.createdAt, ["current"])],
      target,
    );
    assert.equal(chosen?.snapshot.snapshotId, newer.snapshotId);
    assert.include(chosen?.reason, "rollback, comments; inspected by comment #3");
  });
  it("returns null when only the target itself or later snapshots are retained", () => {
    assert.isNull(chooseCadDiffBase([retained(targetId, target.createdAt, ["current"])], target));
    assert.isNull(
      chooseCadDiffBase([retained(baseId, "2026-09-05T00:00:00Z", ["comments"], [1])], target),
    );
  });
});

describe("retainedCadCandidates", () => {
  const metadata = (snapshotId: string, createdAt: string) => ({
    snapshotId,
    createdAt,
    microversionId: OnshapeWorkspaceId.make("a".repeat(24)),
    manifestBytes: 1,
    assetBytes: 0,
  });
  const comment = (number: number, snapshotId: string, rootId = hash("1")): CadComment => ({
    id: `comment-${number}`,
    threadId: ThreadId.make("thread"),
    rootId,
    snapshotId,
    modelKey: hash("5"),
    modelDescriptor: "descriptor",
    title: "Finding",
    body: "Body",
    targets: [
      { kind: "part", label: "Part", occurrenceId: hash("4"), preciseLocationLimitation: "whole" },
    ],
    link: null,
    state: "open",
    version: 0,
    number,
    createdAt: "2026-09-01T00:00:00Z",
    turnId: TurnId.make("turn"),
  });
  it("merges lineage roles with this root's comment snapshots and ignores other roots", () => {
    const olderId = "00000000-0000-4000-8000-00000000000c";
    const candidates = retainedCadCandidates(
      {
        current: metadata(targetId, "2026-09-03T00:00:00Z"),
        rollback: metadata(baseId, "2026-09-02T00:00:00Z"),
      },
      [comment(2, baseId), comment(1, baseId), comment(3, olderId), comment(4, olderId, hash("9"))],
      hash("1"),
    );
    assert.deepEqual(
      [...candidates].map(([id, entry]) => [
        id,
        entry.retainedBy,
        entry.commentNumbers,
        entry.header !== null,
      ]),
      [
        [targetId, ["current"], [], true],
        [baseId, ["rollback", "comments"], [1, 2], true],
        [olderId, ["comments"], [3], false],
      ],
    );
  });
});
