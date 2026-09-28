import type { CadCommentTarget, CadGeometryAsset, CadSnapshotNode } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import { cadCommentOutdatedCheck } from "./CadCommentOutdated.ts";

type Snapshot = { nodes: readonly CadSnapshotNode[]; assets: readonly CadGeometryAsset[] };
const outdated = (targets: readonly CadCommentTarget[], from: Snapshot, to: Snapshot) =>
  cadCommentOutdatedCheck(from, to)({ targets });

const translate = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const node = (
  path: readonly string[],
  geometry: string | null,
  overrides: Partial<CadSnapshotNode> = {},
): CadSnapshotNode => ({
  id: path.length === 0 ? "root" : `node:${path.join("/")}`,
  parentId:
    path.length === 0 ? null : path.length === 1 ? "root" : `node:${path.slice(0, -1).join("/")}`,
  occurrencePath: path,
  instanceId: path.at(-1) ?? null,
  name: path.join("/"),
  kind: geometry === null ? "assembly" : "part",
  suppressed: false,
  defaultVisible: true,
  transform: translate(0),
  sourcePartKey: geometry,
  ...overrides,
});
const asset = (geometryKey: string, sha256: string): CadGeometryAsset => ({
  geometryKey,
  sha256,
  byteLength: 4,
  format: "glb",
  relativePath: `${sha256}.glb`,
});
const wholePart = (occurrenceId: string): CadCommentTarget => ({
  kind: "part",
  label: occurrenceId,
  occurrenceId,
  preciseLocationLimitation: "Whole part",
});
const point = (occurrenceId: string): CadCommentTarget => ({
  kind: "point",
  label: occurrenceId,
  occurrenceId,
  point: [0, 0, 0],
  normal: null,
  captureId: "capture",
  inspectionId: "inspection",
  confirmationReason: "Seen from the side",
});
// Two instances of the same bracket, a plate, and a gearbox subassembly holding a bolt.
// Manifest transforms are absolute, so the bolt sits wherever the gearbox does.
const before: Snapshot = {
  nodes: [
    node([], null),
    node(["bracket-1"], "bracket"),
    node(["bracket-2"], "bracket"),
    node(["plate"], "plate"),
    node(["gearbox"], null, { transform: translate(0.5) }),
    node(["gearbox", "bolt"], "bolt", { transform: translate(0.5) }),
  ],
  assets: [
    asset("bracket", "b".repeat(64)),
    asset("plate", "p".repeat(64)),
    asset("bolt", "t".repeat(64)),
  ],
};
const withNode = (
  snapshot: Snapshot,
  name: string,
  change: (node: CadSnapshotNode) => CadSnapshotNode,
): Snapshot => ({
  ...snapshot,
  nodes: snapshot.nodes.map((n) => (n.name === name ? change(n) : n)),
});
// A resync rekeys untouched parts under a new document microversion without changing geometry.
const rekeyed = ({ nodes, assets }: Snapshot): Snapshot => ({
  nodes: nodes.map((n) => ({ ...n, sourcePartKey: n.sourcePartKey && `v2:${n.sourcePartKey}` })),
  assets: assets.map((a) => ({ ...a, geometryKey: `v2:${a.geometryKey}` })),
});

describe("cadCommentOutdatedCheck", () => {
  it("keeps comments current when the targeted instance is unchanged, even after rekeying", () => {
    const after = rekeyed(before);
    assert.equal(outdated([point("node:bracket-1")], before, after), null);
    assert.equal(outdated([wholePart("node:plate")], before, after), null);
    assert.equal(outdated([point("node:gearbox/bolt")], before, after), null);
  });
  it("ignores reimport noise below cad_diff's epsilon, including on a parent", () => {
    const noisy = withNode(
      withNode(
        withNode(before, "plate", (n) => ({ ...n, transform: translate(1e-7) })),
        "gearbox",
        (n) => ({ ...n, transform: translate(0.5 + 5e-7) }),
      ),
      "gearbox/bolt",
      (n) => ({ ...n, transform: translate(0.5 + 5e-7) }),
    );
    assert.equal(outdated([point("node:plate")], before, noisy), null);
    assert.equal(outdated([point("node:gearbox/bolt")], before, noisy), null);
  });
  it("reports a part inside a moved subassembly as moved, and leaves other parts alone", () => {
    const shifted = withNode(
      withNode(before, "gearbox", (n) => ({ ...n, transform: translate(0.6) })),
      "gearbox/bolt",
      (n) => ({ ...n, transform: translate(0.6) }),
    );
    assert.equal(outdated([wholePart("node:gearbox/bolt")], before, shifted), "moved");
    assert.equal(outdated([point("node:plate")], before, shifted), null);
  });
  it("reports a removed, suppressed, or geometry-less instance as removed", () => {
    const removed = { ...before, nodes: before.nodes.filter((n) => n.name !== "plate") };
    assert.equal(outdated([wholePart("node:plate")], before, removed), "removed");
    const suppressed = withNode(before, "plate", (n) => ({ ...n, suppressed: true }));
    assert.equal(outdated([point("node:plate")], before, suppressed), "removed");
    const geometryless = {
      ...before,
      assets: before.assets.filter((a) => a.geometryKey !== "plate"),
    };
    assert.equal(outdated([point("node:plate")], before, geometryless), "removed");
    const withoutPart = withNode(before, "plate", (n) => ({ ...n, sourcePartKey: null }));
    assert.equal(outdated([point("node:plate")], before, withoutPart), "removed");
    assert.equal(outdated([point("node:unknown")], before, before), "removed");
  });
  it("reports moved only for the repeated instance whose placement changed", () => {
    const after = withNode(before, "bracket-2", (n) => ({ ...n, transform: translate(0.01) }));
    assert.equal(outdated([point("node:bracket-1")], before, after), null);
    assert.equal(outdated([point("node:bracket-2")], before, after), "moved");
    assert.equal(
      outdated([point("node:bracket-1"), point("node:bracket-2")], before, after),
      "moved",
    );
  });
  it("reports geometry changes by asset hash and prefers the most severe change", () => {
    // A part studio edit rekeys the bracket and exports different bytes for it.
    const reshaped = {
      nodes: withNode(before, "plate", (n) => ({ ...n, transform: translate(0.01) })).nodes.map(
        (n) => (n.sourcePartKey === "bracket" ? { ...n, sourcePartKey: "v2:bracket" } : n),
      ),
      assets: before.assets.map((a) =>
        a.geometryKey === "bracket" ? asset("v2:bracket", "c".repeat(64)) : a,
      ),
    };
    assert.equal(outdated([wholePart("node:bracket-1")], before, reshaped), "geometry-changed");
    assert.equal(outdated([point("node:plate")], before, reshaped), "moved");
    assert.equal(
      outdated([point("node:plate"), point("node:bracket-2")], before, reshaped),
      "geometry-changed",
    );
    const gone = { ...reshaped, nodes: reshaped.nodes.filter((n) => n.name !== "plate") };
    assert.equal(outdated([point("node:bracket-1"), point("node:plate")], before, gone), "removed");
  });
  it("clears once a later snapshot restores the target", () => {
    const moved = withNode(before, "plate", (n) => ({ ...n, transform: translate(0.01) }));
    assert.equal(outdated([point("node:plate")], before, moved), "moved");
    // A rollback restores the original placement up to import noise.
    const restored = withNode(rekeyed(moved), "plate", (n) => ({
      ...n,
      transform: translate(2e-7),
    }));
    assert.equal(outdated([point("node:plate")], before, restored), null);
  });
});
