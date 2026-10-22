// @effect-diagnostics nodeBuiltinImport:off
// SolidWorks part keys are SHA-256 hex, like the bridge makes them.
import * as NodeCrypto from "node:crypto";
import { CadSnapshotDraft, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { snapshotRootId } from "../onshape/OnshapeSnapshotManifest.ts";
import { localCadMicroversionId, localCadRootIdentity } from "./LocalCadFiles.ts";
import { buildLocalCadDraft } from "./LocalCadImport.ts";
import { LOCAL_CAD_TESSELLATION_PROFILE, type LocalCadModel } from "./LocalCadTessellation.ts";
import type { SolidWorksNode } from "./SolidWorksBridge.ts";
import {
  buildSolidWorksDraft,
  reusableSolidWorksParts,
  type SolidWorksPartGeometry,
} from "./SolidWorksImport.ts";

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
    ...localCadRootIdentity(ProjectId.make("local-cad-draft"), "robot.step", "default"),
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

/** A SolidWorks part key: the SHA-256 of a file and configuration, as the bridge reports it. */
const partKey = (seed: string) => NodeCrypto.createHash("sha256").update(seed).digest("hex");
const swPart = (name: string, key: string, configuration = "Default"): SolidWorksNode => ({
  name,
  kind: "part",
  configuration,
  suppressed: false,
  visible: true,
  transform: null,
  key,
  children: [],
});
const swContext = () => {
  const root = {
    ...localCadRootIdentity(ProjectId.make("local-cad-draft"), "Pillow.SLDASM", "NPD-16"),
    kind: "assembly" as const,
    microversionId: localCadMicroversionId(new Uint8Array([2])),
    tessellationProfile: LOCAL_CAD_TESSELLATION_PROFILE,
  };
  return {
    root,
    rootId: snapshotRootId(root),
    projectId: ProjectId.make("local-cad-draft"),
    snapshotId: "00000000-0000-4000-8000-000000000002",
    createdAt: "2026-10-22T00:00:00.000Z",
  };
};
const decodeDraft = Schema.decodeUnknownSync(CadSnapshotDraft);

describe("buildSolidWorksDraft", () => {
  it("names each part's material and gives a mass only when SolidWorks knows it", () => {
    const [screw, bearing, weight] = ["screw", "bearing", "weight"].map(partKey);
    const tree: SolidWorksNode = {
      ...swPart("Pillow", "", "NPD-16"),
      kind: "assembly",
      key: null,
      children: [
        swPart("socket head cap screw-1", screw!, ".375-16 X1.50 LONG SHCS"),
        swPart("bearing-1", bearing!, "NPD-16"),
        swPart("weight-1", weight!),
      ],
    };
    const geometry = new Map<string, SolidWorksPartGeometry>([
      [
        screw!,
        {
          kind: "mesh",
          name: "socket head cap screw",
          mesh: triangle,
          material: "Alloy Steel",
          massKg: 0.0251,
        },
      ],
      // No material: SolidWorks' own mass comes from a default density, so the bridge sent none.
      [bearing!, { kind: "mesh", name: "bearing", mesh: triangle, material: null, massKg: null }],
      // A mass the user typed in, on a part with no material.
      [weight!, { kind: "mesh", name: "weight", mesh: triangle, material: null, massKg: 2.5 }],
    ]);
    const { draft } = buildSolidWorksDraft(swContext(), tree, "Pillow.SLDASM", geometry);
    decodeDraft(draft);
    const metadata = new Map(draft.parts.map((part) => [part.metadata?.name, part.metadata]));
    assert.deepStrictEqual(metadata.get("socket head cap screw")?.material, {
      displayName: "Alloy Steel",
    });
    assert.strictEqual(metadata.get("socket head cap screw")?.massKg, 0.0251);
    assert.strictEqual(metadata.get("bearing")?.material, null);
    // Absent, not zero: a missing massKg means unknown.
    assert.isFalse(Object.hasOwn(metadata.get("bearing")!, "massKg"));
    assert.strictEqual(metadata.get("weight")?.material, null);
    assert.strictEqual(metadata.get("weight")?.massKg, 2.5);
    // Each part's source names the configuration its component uses.
    assert.strictEqual(
      draft.parts.find((part) => part.metadata?.name === "socket head cap screw")?.source
        .configuration,
      ".375-16 X1.50 LONG SHCS",
    );
  });

  it("keeps the material and mass of a part reused from the latest snapshot", () => {
    const screw = partKey("screw");
    const tree: SolidWorksNode = {
      ...swPart("Pillow", "", "NPD-16"),
      kind: "assembly",
      key: null,
      children: [swPart("socket head cap screw-1", screw)],
    };
    const first = buildSolidWorksDraft(
      swContext(),
      tree,
      "Pillow.SLDASM",
      new Map<string, SolidWorksPartGeometry>([
        [
          screw,
          {
            kind: "mesh",
            name: "socket head cap screw",
            mesh: triangle,
            material: "Alloy Steel",
            massKg: 0.0251,
          },
        ],
      ]),
    ).draft;
    // The next revision skips the screw's export, so the latest snapshot's part is all it has.
    const reusable = reusableSolidWorksParts(first.parts, LOCAL_CAD_TESSELLATION_PROFILE);
    const next = buildSolidWorksDraft(
      swContext(),
      tree,
      "Pillow.SLDASM",
      new Map<string, SolidWorksPartGeometry>([
        [screw, { kind: "reused", part: reusable.get(screw)! }],
      ]),
    ).draft;
    decodeDraft(next);
    assert.deepStrictEqual(next.parts[0]!.metadata, first.parts[0]!.metadata);
    assert.strictEqual(next.parts[0]!.metadata?.massKg, 0.0251);
  });
});
