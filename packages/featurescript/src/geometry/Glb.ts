import type { BodyMesh } from "./Tessellate.ts";

/** Grey for plain faces, amber (the CAD panel's comment color) for highlighted ones. Linear RGB. */
const MATERIALS = [
  { name: "plain", baseColorFactor: [0.55, 0.58, 0.62, 1] },
  { name: "highlight", baseColorFactor: [0.98, 0.79, 0.25, 1] },
] as const;

/**
 * One binary glTF with a node and mesh per body, one indexed primitive per material, meters, Z up
 * (as CAD).
 */
export function toGlb(meshes: readonly BodyMesh[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  // Every view is 4-byte data, so offsets stay aligned as glTF requires.
  const addView = (data: Float32Array | Uint32Array, min?: number[], max?: number[]) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const indices = data instanceof Uint32Array;
    bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.byteLength,
      target: indices ? 34963 : 34962,
    });
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: indices ? 5125 : 5126,
      count: indices ? data.length : data.length / 3,
      type: indices ? "SCALAR" : "VEC3",
      ...(min && max ? { min, max } : {}),
    });
    return accessors.length - 1;
  };
  const bounds = (positions: Float32Array) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
      max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
    }
    return { min, max };
  };
  const gltfMeshes = meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.groups.map((group) => {
      const { min, max } = bounds(group.positions);
      return {
        attributes: {
          POSITION: addView(group.positions, min, max),
          NORMAL: addView(group.normals),
        },
        indices: addView(group.indices),
        material: group.material,
      };
    }),
  }));
  const json = {
    asset: { version: "2.0", generator: "@cadsense/featurescript" },
    scene: 0,
    scenes: [{ nodes: gltfMeshes.map((_, i) => i) }],
    nodes: gltfMeshes.map((mesh, i) => ({ name: mesh.name, mesh: i })),
    meshes: gltfMeshes,
    materials: MATERIALS.map((material) => ({
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: material.baseColorFactor,
        metallicFactor: 0,
        roughnessFactor: 0.7,
      },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify(json) + " ".repeat(pad(JSON.stringify(json).length)),
  );
  const binLength = byteLength + pad(byteLength);
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  let offset = binStart + 8;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
