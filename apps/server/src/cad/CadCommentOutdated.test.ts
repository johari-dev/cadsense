import type { CadCommentTarget, CadGeometryAsset, CadSnapshotNode } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import { cadCommentOutdatedReason } from "./CadCommentOutdated.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const SHIFTED = [1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const part = (
  path: readonly string[],
  geometry: string,
  overrides: Partial<CadSnapshotNode> = {},
): CadSnapshotNode => ({
  id: `node:${path.join("/")}`,
  parentId: "root",
  occurrencePath: path,
  instanceId: path.at(-1) ?? null,
  name: path.join("/"),
  kind: "part",
  suppressed: false,
  defaultVisible: true,
  transform: IDENTITY,
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
// Two instances of the same bracket plus a distinct plate, the shape of a small assembly.
const before = {
  nodes: [part(["bracket-1"], "bracket"), part(["bracket-2"], "bracket"), part(["plate"], "plate")],
  assets: [asset("bracket", "b".repeat(64)), asset("plate", "p".repeat(64))],
};
// A resync rekeys untouched parts under a new document microversion without changing geometry.
const rekeyed = (nodes: readonly CadSnapshotNode[], assets: readonly CadGeometryAsset[]) => ({
  nodes: nodes.map((n) => ({ ...n, sourcePartKey: n.sourcePartKey && `v2:${n.sourcePartKey}` })),
  assets: assets.map((a) => ({ ...a, geometryKey: `v2:${a.geometryKey}` })),
});

describe("cadCommentOutdatedReason", () => {
  it("keeps comments current when the targeted instance is unchanged, even after rekeying", () => {
    const after = rekeyed(before.nodes, before.assets);
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:bracket-1")] }, before, after),
      null,
    );
    assert.equal(
      cadCommentOutdatedReason({ targets: [wholePart("node:plate")] }, before, after),
      null,
    );
  });
  it("reports a removed, suppressed, or geometry-less instance as removed", () => {
    const removed = { ...before, nodes: before.nodes.filter((n) => n.name !== "plate") };
    assert.equal(
      cadCommentOutdatedReason({ targets: [wholePart("node:plate")] }, before, removed),
      "removed",
    );
    const suppressed = {
      ...before,
      nodes: before.nodes.map((n) => (n.name === "plate" ? { ...n, suppressed: true } : n)),
    };
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:plate")] }, before, suppressed),
      "removed",
    );
    const geometryless = {
      ...before,
      assets: before.assets.filter((a) => a.geometryKey !== "plate"),
    };
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:plate")] }, before, geometryless),
      "removed",
    );
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:unknown")] }, before, before),
      "removed",
    );
  });
  it("reports moved only for the repeated instance whose placement changed", () => {
    const after = {
      ...before,
      nodes: before.nodes.map((n) => (n.name === "bracket-2" ? { ...n, transform: SHIFTED } : n)),
    };
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:bracket-1")] }, before, after),
      null,
    );
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:bracket-2")] }, before, after),
      "moved",
    );
    assert.equal(
      cadCommentOutdatedReason(
        { targets: [point("node:bracket-1"), point("node:bracket-2")] },
        before,
        after,
      ),
      "moved",
    );
  });
  it("reports geometry changes by asset hash and prefers the most severe change", () => {
    const reshaped = {
      nodes: before.nodes.map((n) => (n.name === "plate" ? { ...n, transform: SHIFTED } : n)),
      assets: before.assets.map((a) =>
        a.geometryKey === "bracket" ? asset("bracket", "c".repeat(64)) : a,
      ),
    };
    assert.equal(
      cadCommentOutdatedReason({ targets: [wholePart("node:bracket-1")] }, before, reshaped),
      "geometry-changed",
    );
    assert.equal(
      cadCommentOutdatedReason({ targets: [point("node:plate")] }, before, reshaped),
      "moved",
    );
    assert.equal(
      cadCommentOutdatedReason(
        { targets: [point("node:plate"), point("node:bracket-2")] },
        before,
        reshaped,
      ),
      "geometry-changed",
    );
    const gone = { ...reshaped, nodes: reshaped.nodes.filter((n) => n.name !== "plate") };
    assert.equal(
      cadCommentOutdatedReason(
        { targets: [point("node:bracket-1"), point("node:plate")] },
        before,
        gone,
      ),
      "removed",
    );
  });
});
