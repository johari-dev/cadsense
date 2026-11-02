import type { BodyMesh, Point } from "./Tessellate.ts";

/**
 * Grey for plain faces, amber (the CAD panel's comment color) for highlighted ones, red for error
 * entities, indexed by `MeshMaterial`; then near-black (#1d2126) for bodies' outlines, which say
 * so in their extras (three.js reads them into the material's `userData`). Linear RGB.
 */
const MATERIALS = [
  { name: "plain", baseColorFactor: [0.55, 0.58, 0.62, 1] },
  { name: "highlight", baseColorFactor: [0.98, 0.79, 0.25, 1] },
  { name: "error", baseColorFactor: [0.86, 0.12, 0.1, 1] },
  { name: "outline", baseColorFactor: [0.0123, 0.0158, 0.0194, 1], extras: { outline: true } },
] as const;
/** glTF primitive modes. */
const POINTS = 0;
const LINES = 1;
const ERROR_MATERIAL = 2;
const OUTLINE_MATERIAL = 3;

/** A point rounded to the nanometer, for the JSON. */
const rounded = (point: Point) => point.map((n) => Math.round(n * 1e9) / 1e9);

/**
 * One binary glTF with a node and mesh per body, one indexed primitive per material, meters, Z up
 * (as CAD). Error edges and vertices are a LINES and a POINTS primitive in the error material, and
 * a body's outline (its B-rep edges and vertices) two more in the outline material.
 *
 * What a viewer needs to name what a click hit: a triangle's vertices carry its face's index
 * (`_FACE`), and a body node's `extras.faces` has each face's probe; an outline segment's ends
 * carry its edge's index (`_EDGE`), and `extras.edges` has each edge's middle on its curve.
 */
export function toGlb(meshes: readonly BodyMesh[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  // Every view is 4-byte data, so offsets stay aligned as glTF requires. Floats are points
  // (VEC3) unless `scalar`, one number per vertex.
  const addView = (
    data: Float32Array | Uint32Array,
    { min, max, scalar = false }: { min?: number[]; max?: number[]; scalar?: boolean } = {},
  ) => {
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
      count: indices || scalar ? data.length : data.length / 3,
      type: indices || scalar ? "SCALAR" : "VEC3",
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
  const unshaded = (
    positions: Float32Array,
    mode: typeof POINTS | typeof LINES,
    material: typeof ERROR_MATERIAL | typeof OUTLINE_MATERIAL,
    edgeOf?: Float32Array,
  ) => ({
    attributes: {
      POSITION: addView(positions, bounds(positions)),
      ...(edgeOf ? { _EDGE: addView(edgeOf, { scalar: true }) } : {}),
    },
    mode,
    material,
  });
  // glTF accessors can't be empty.
  const some = (positions: Float32Array | undefined): positions is Float32Array =>
    positions !== undefined && positions.length > 0;
  // Views are laid out in the order they're added: every body's triangles, then every body's
  // vertices' faces, then every body's lines and points. A pattern's bodies share normals and
  // indices, which gzip finds only within 32 KB of each other; anything more of each body between
  // them puts them out of reach.
  const shapes = meshes.map((mesh) =>
    mesh.groups.map((group) => ({
      POSITION: addView(group.positions, bounds(group.positions)),
      NORMAL: addView(group.normals),
      indices: addView(group.indices),
    })),
  );
  const triangles = meshes.map((mesh, i) =>
    mesh.groups.map((group, j) => {
      const { indices, ...attributes } = shapes[i]![j]!;
      return {
        attributes: { ...attributes, _FACE: addView(group.faces, { scalar: true }) },
        indices,
        material: group.material,
      };
    }),
  );
  const unshadedOf = meshes.map(({ edges, vertices, outline }) => [
    ...(some(edges) ? [unshaded(edges, LINES, ERROR_MATERIAL)] : []),
    ...(some(vertices) ? [unshaded(vertices, POINTS, ERROR_MATERIAL)] : []),
    ...(outline && some(outline.edges)
      ? [unshaded(outline.edges, LINES, OUTLINE_MATERIAL, outline.edgeOf)]
      : []),
    ...(outline && some(outline.vertices)
      ? [unshaded(outline.vertices, POINTS, OUTLINE_MATERIAL)]
      : []),
  ]);
  const gltfMeshes = meshes.map((mesh, i) => ({
    name: mesh.name,
    primitives: [...triangles[i]!, ...unshadedOf[i]!],
  }));
  const json = {
    asset: { version: "2.0", generator: "@cadsense/featurescript" },
    scene: 0,
    scenes: [{ nodes: gltfMeshes.map((_, i) => i) }],
    // An overlay's node says so (three.js reads extras into userData), so a viewer can leave it
    // out of picking; a body's names the body, so a viewer can find the body a click hit, and
    // has its faces' probes and its edges' middles.
    nodes: meshes.map((mesh, i) => ({
      name: mesh.name,
      mesh: i,
      extras: mesh.overlay
        ? { overlay: true }
        : {
            body: mesh.bodyId,
            faces: (mesh.probes ?? []).map((probe) => (probe ? rounded(probe) : null)),
            edges: (mesh.outline?.midpoints ?? []).map(rounded),
          },
    })),
    meshes: gltfMeshes,
    materials: MATERIALS.map(({ name, baseColorFactor, ...rest }) => ({
      name,
      pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0, roughnessFactor: 0.7 },
      ...rest,
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
