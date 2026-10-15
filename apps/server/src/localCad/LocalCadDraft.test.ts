import { ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";

import { snapshotRootId } from "../onshape/OnshapeSnapshotManifest.ts";
import { localCadMicroversionId, localCadRootIdentity } from "./LocalCadFiles.ts";
import { buildLocalCadDraft } from "./LocalCadImport.ts";
import { LOCAL_CAD_TESSELLATION_PROFILE, type LocalCadModel } from "./LocalCadTessellation.ts";

// One triangle, so every component holding it becomes a part.
const triangle = {
  name: "SOLID",
  color: null,
  faces: [{ first: 0, last: 0, color: null }],
  position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normal: null,
  index: new Uint32Array([0, 1, 2]),
};

/** Occurrence paths of the parts under one assembly whose components have these names. */
const siblingPaths = (names: readonly string[]) => {
  const root = {
    ...localCadRootIdentity(ProjectId.make("local-cad-draft"), "robot.step"),
    kind: "assembly" as const,
    microversionId: localCadMicroversionId(new Uint8Array([1])),
    tessellationProfile: LOCAL_CAD_TESSELLATION_PROFILE,
  };
  const model: LocalCadModel = {
    root: {
      name: "robot",
      meshes: [],
      children: names.map((name) => ({ name, meshes: [0], children: [] })),
    },
    meshes: [triangle],
  };
  const { draft } = buildLocalCadDraft(
    {
      root,
      rootId: snapshotRootId(root),
      projectId: ProjectId.make("local-cad-draft"),
      snapshotId: "snapshot",
      createdAt: "2026-10-15T00:00:00.000Z",
    },
    model,
    "robot.step",
  );
  const parts = draft.nodes.filter((node) => node.kind === "part");
  return {
    paths: parts.map((node) => node.occurrencePath.join("/")),
    ids: new Set(parts.map((node) => node.id)),
  };
};

describe("buildLocalCadDraft", () => {
  it("numbers repeated sibling names, so their ids stay stable across imports", () => {
    assert.deepStrictEqual(siblingPaths(["bolt", "bolt", "bolt"]).paths, [
      "bolt",
      "bolt#2",
      "bolt#3",
    ]);
  });

  it("keeps sibling ids unique when a name already ends in a number suffix", () => {
    const { paths, ids } = siblingPaths(["bolt", "bolt#2", "bolt"]);
    assert.strictEqual(ids.size, 3, JSON.stringify(paths));
    assert.deepStrictEqual(paths, ["bolt", "bolt#2", "bolt#3"]);
  });
});
