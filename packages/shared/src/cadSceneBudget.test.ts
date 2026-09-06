import type { CadSnapshotNode } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";
import { CAD_SCENE_LIMITS, createCadSceneBudget, measureCadGeometry } from "./cadSceneBudget";

const glb = (document: unknown) => {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(20 + length),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20);
  bytes.set(json, 20);
  return bytes;
};
const node = (id: string, key: string, suppressed = false): CadSnapshotNode => ({
  id,
  parentId: null,
  occurrencePath: [id],
  instanceId: id,
  name: id,
  kind: "part",
  suppressed,
  defaultVisible: true,
  sourcePartKey: key,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});
const document = {
  accessors: [
    { count: 3, type: "VEC3" },
    { count: 3, type: "SCALAR" },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  nodes: [{ mesh: 0 }, { mesh: 0 }],
};

describe("whole-scene admission", () => {
  it("counts GLB mesh placements and conservatively accounts expanded accessors", () => {
    const bytes = glb(document);
    expect(measureCadGeometry(bytes)).toEqual({
      triangles: 2,
      decodedBytes: bytes.length + 96 + 8192,
      drawCalls: 2,
      nodeCount: 2,
    });
  });
  it("rejects sparse-accessor and texture expansion before allocating them", () => {
    expect(() =>
      measureCadGeometry(
        glb({
          ...document,
          accessors: [
            { count: 100_000_000, type: "VEC3" },
            { count: 3, type: "SCALAR" },
          ],
        }),
      ),
    ).toThrow("too-large");
    const png = new Uint8Array(24),
      header = new DataView(png.buffer);
    header.setUint32(0, 0x89504e47);
    header.setUint32(4, 0x0d0a1a0a);
    header.setUint32(16, 32768);
    header.setUint32(20, 32768);
    expect(() =>
      measureCadGeometry(
        glb({ images: [{ uri: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` }] }),
      ),
    ).toThrow("too-large");
  });
  it("counts shared geometry once in memory but all unsuppressed placements in rendering", () => {
    const budget = createCadSceneBudget([
      node("1", "a"),
      node("2", "a"),
      node("3", "b"),
      node("4", "b", true),
    ]);
    expect(
      budget.add(
        { geometryKey: "a", sha256: "shared" },
        { decodedBytes: 100, triangles: 10, drawCalls: 1, nodeCount: 1 },
      ),
    ).toEqual({ decodedBytes: 6 * 4096 + 100, triangles: 20, drawCalls: 2 });
    expect(
      budget.add(
        { geometryKey: "b", sha256: "shared" },
        { decodedBytes: 100, triangles: 10, drawCalls: 1, nodeCount: 1 },
      ),
    ).toEqual({ decodedBytes: 7 * 4096 + 100, triangles: 30, drawCalls: 3 });
  });
  it("bounds the whole root even when every individual geometry file is small", () => {
    const nodes = Array.from({ length: 404 }, (_, i) => node(String(i), "bearing"));
    expect(() =>
      createCadSceneBudget(nodes).add(
        { geometryKey: "bearing", sha256: "hash" },
        { decodedBytes: 1_000_000, triangles: 14872, drawCalls: 1, nodeCount: 1 },
      ),
    ).toThrow("too-large");
    expect(() =>
      createCadSceneBudget(
        Array.from({ length: CAD_SCENE_LIMITS.occurrences + 1 }, (_, i) => node(String(i), "a")),
      ),
    ).toThrow("too-large");
    const budget = createCadSceneBudget([node("1", "a"), node("2", "b")]);
    budget.add(
      { geometryKey: "a", sha256: "a" },
      { decodedBytes: 150 * 1024 ** 2, triangles: 1, drawCalls: 1, nodeCount: 1 },
    );
    expect(() =>
      budget.add(
        { geometryKey: "b", sha256: "b" },
        { decodedBytes: 150 * 1024 ** 2, triangles: 1, drawCalls: 1, nodeCount: 1 },
      ),
    ).toThrow("too-large");
  });
  it("rejects malformed containers and missing geometry metrics", () => {
    expect(() => measureCadGeometry(new Uint8Array(12))).toThrow("invalid-geometry");
    expect(() => measureCadGeometry(glb({ ...document, accessors: [] }))).toThrow(
      "invalid-geometry",
    );
  });
  it("rejects excessive draw calls and cloned scene-node memory independently of triangles", () => {
    const nodes = [node("1", "a"), node("2", "a")];
    expect(() =>
      createCadSceneBudget(nodes).add(
        { geometryKey: "a", sha256: "a" },
        { decodedBytes: 100, triangles: 10, drawCalls: 2001, nodeCount: 1 },
      ),
    ).toThrow("too-large");
    expect(() =>
      createCadSceneBudget(nodes).add(
        { geometryKey: "a", sha256: "a" },
        { decodedBytes: 100, triangles: 10, drawCalls: 1, nodeCount: 40_000 },
      ),
    ).toThrow("too-large");
    expect(() =>
      measureCadGeometry(glb({ ...document, extensionsUsed: ["EXT_mesh_gpu_instancing"] })),
    ).toThrow("invalid-geometry");
  });
});
