import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CadSnapshotRoot } from "@cadsense/contracts";
import { normalizeCadGeometry } from "./CadGeometry.ts";
import { normalizeOnshapeExport } from "../onshape/OnshapeExportBundle.ts";
import { readOnshapeExportGeometry } from "../onshape/OnshapeExportGeometry.ts";
import { parseAssemblySnapshotDraft, snapshotRootId } from "../onshape/OnshapeSnapshotManifest.ts";
import { bulkFixture, bulkInput, bulkMicroversion } from "../onshape/testFixtures/bulkExport.ts";
import * as Schema from "effect/Schema";
import {
  CAD_MESH_MAX_TRIANGLES,
  readCadMeshTriangles,
  transformCadMeshPoint,
} from "./CadMeshGeometry.ts";

const encode = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function meshFixture(
  overrides: Record<string, unknown> = {},
  binary = new Uint8Array(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer),
) {
  const document = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: binary.length }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-99, -99, -99],
        max: [99, 99, 99],
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...overrides,
  };
  const json = new TextEncoder().encode(encode(document)),
    length = Math.ceil(json.length / 4) * 4,
    binLength = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(28 + length + binLength),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + length);
  bytes.set(json, 20);
  view.setUint32(20 + length, binLength, true);
  view.setUint32(24 + length, 0x004e4942, true);
  bytes.set(binary, 28 + length);
  return bytes;
}

describe("cached CAD mesh geometry", () => {
  it("uses binary positions and composes GLTF hierarchy with the original occurrence transform", () => {
    const transform = [0, -1, 0, 10, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    const bytes = meshFixture({
      nodes: [
        { translation: [1, 2, 3], children: [1] },
        { mesh: 0, scale: [2, 3, 4] },
      ],
    });
    expect(readCadMeshTriangles(bytes, transform)).toEqual([
      [
        [8, 21, 33],
        [8, 25, 33],
        [5, 21, 33],
      ],
    ]);
    expect(transformCadMeshPoint([1, 2, 3], transform)).toEqual([8, 21, 33]);
  });
  it("handles GLTF column-major matrices, quaternion rotation, and repeated mesh nodes", () => {
    const bytes = meshFixture({
      nodes: [
        { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1], children: [1, 2] },
        { mesh: 0 },
        { mesh: 0, rotation: [0, 0, 1, 0] },
      ],
    });
    const result = readCadMeshTriangles(bytes, identity);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([
      [3, 4, 5],
      [1, 4, 5],
      [3, 3, 5],
    ]);
    expect(result[1]).toEqual([
      [3, 4, 5],
      [5, 4, 5],
      [3, 5, 5],
    ]);
  });
  it("reads indexed, strided, normalized integer vertices and excludes unreferenced positions", () => {
    const binary = new Uint8Array([
      255, 0, 0, 99, 0, 255, 0, 99, 0, 0, 255, 99, 255, 255, 255, 99, 2, 0, 1,
    ]);
    const bytes = meshFixture(
      {
        extensionsUsed: ["KHR_mesh_quantization"],
        bufferViews: [
          { buffer: 0, byteLength: 16, byteStride: 4 },
          { buffer: 0, byteOffset: 16, byteLength: 3 },
        ],
        accessors: [
          { bufferView: 0, componentType: 5121, normalized: true, count: 4, type: "VEC3" },
          { bufferView: 1, componentType: 5121, count: 3, type: "SCALAR" },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      },
      binary,
    );
    expect(readCadMeshTriangles(bytes, identity)).toEqual([
      [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
  });
  it("fails explicitly for unsupported or empty geometry", () => {
    for (const change of [
      { animations: [] },
      { accessors: [{ sparse: {}, componentType: 5126, count: 3, type: "VEC3" }] },
      { nodes: [{ mesh: 0, skin: 0 }] },
      { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [] }] }] },
      { extensionsRequired: ["KHR_draco_mesh_compression"] },
    ]) {
      expect(() => readCadMeshTriangles(meshFixture(change), identity)).toThrow(
        "unsupported-geometry",
      );
    }
    expect(() =>
      readCadMeshTriangles(meshFixture({ nodes: [], scenes: [{ nodes: [] }] }), identity),
    ).toThrow("empty-geometry");
  });
  it("rejects cycles, invalid accessors, non-finite positions and truncated GLB", () => {
    for (const bytes of [
      meshFixture({ nodes: [{ mesh: 0, children: [0] }] }),
      meshFixture({ bufferViews: [{ buffer: 0, byteLength: 4 }] }),
      meshFixture({}, new Uint8Array(new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)),
      meshFixture().subarray(0, 32),
    ]) {
      expect(() => readCadMeshTriangles(bytes, identity)).toThrow("invalid-geometry");
    }
  });
  it("bounds triangle allocation before decoding positions", () => {
    const count = (CAD_MESH_MAX_TRIANGLES + 1) * 3;
    const bytes = meshFixture(
      { accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3" }] },
      new Uint8Array(count * 12),
    );
    expect(() => readCadMeshTriangles(bytes, identity)).toThrow("too-large");
  });
});

const bulkRoot = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: bulkInput.source.host,
  documentId: bulkInput.source.documentId,
  elementId: bulkInput.root.elementId,
  kind: "assembly",
  originalRevision: { kind: "w", id: bulkInput.source.workspaceId },
  microversionId: bulkMicroversion,
  configuration: "default",
  tessellationProfile: "test",
});
it.effect("reads split Onshape export meshes with retained PTC metadata", () =>
  Effect.gen(function* () {
    const fixture = bulkFixture(2);
    const draft = yield* parseAssemblySnapshotDraft(
      {
        snapshotId: "00000000-0000-4000-8000-000000000001",
        projectId: bulkInput.projectId,
        createdAt: "2026-09-07T00:00:00Z",
        root: bulkRoot,
        rootId: snapshotRootId(bulkRoot),
      },
      fixture.definition,
    );
    const exported = readOnshapeExportGeometry(draft, yield* normalizeOnshapeExport(fixture.bytes));
    for (const node of draft.nodes) {
      if (!node.sourcePartKey) continue;
      const bytes = yield* normalizeCadGeometry(exported.extract(node.sourcePartKey));
      const x = node.transform[3]!;
      expect(readCadMeshTriangles(bytes, node.transform)).toEqual([
        [
          [x, 0, 0],
          [x + 1, 0, 0],
          [x, 1, 0],
        ],
      ]);
    }
  }),
);
