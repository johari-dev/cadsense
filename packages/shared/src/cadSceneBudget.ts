import type { CadGeometryAsset, CadSnapshotNode } from "@cadsense/contracts";
import * as Schema from "effect/Schema";

// A scene's CPU/GPU geometry copies fit within this budget independently of compressed file size.
export const CAD_SCENE_LIMITS = {
  occurrences: 2_000,
  decodedBytes: 1536 * 1024 ** 2,
  triangles: 32_000_000,
  drawCalls: 4_000,
} as const;
export class CadSceneBudgetError extends Error {
  readonly _tag = "CadSceneBudgetError";
  readonly reason: "too-large" | "invalid-geometry";
  constructor(reason: CadSceneBudgetError["reason"]) {
    super(`CAD scene ${reason}`);
    this.reason = reason;
  }
}
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Document = Schema.Struct({
  extensionsUsed: Schema.optionalKey(Schema.Array(Schema.String)),
  accessors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ count: nonnegative, type: Schema.String })),
  ),
  meshes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        primitives: Schema.Array(
          Schema.Struct({
            attributes: Schema.Record(Schema.String, nonnegative),
            indices: Schema.optionalKey(nonnegative),
            mode: Schema.optionalKey(nonnegative),
          }),
        ),
      }),
    ),
  ),
  nodes: Schema.optionalKey(Schema.Array(Schema.Struct({ mesh: Schema.optionalKey(nonnegative) }))),
  bufferViews: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ byteOffset: Schema.optionalKey(nonnegative), byteLength: nonnegative }),
    ),
  ),
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        bufferView: Schema.optionalKey(nonnegative),
        uri: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Document));
const components = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);
const invalid = () => new CadSceneBudgetError("invalid-geometry");
const checked = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};

/** Inspect normalized, uncompressed GLB before the graphics loader allocates accessors or textures. */
export function measureCadGeometry(bytes: Uint8Array) {
  try {
    if (bytes.length > CAD_SCENE_LIMITS.decodedBytes) throw new CadSceneBudgetError("too-large");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 20 ||
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length ||
      view.getUint32(16, true) !== 0x4e4f534a
    )
      throw invalid();
    const length = view.getUint32(12, true),
      end = 20 + length;
    if (end > bytes.length) throw invalid();
    const document = decode(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, end)),
    );
    if (document.extensionsUsed?.includes("EXT_mesh_gpu_instancing")) throw invalid();
    const accessors = document.accessors ?? [];
    const nodeCount = document.nodes?.length ?? 0;
    let decodedBytes = bytes.length + nodeCount * 4096;
    for (const accessor of accessors) {
      const size = components.get(accessor.type);
      if (!size) throw invalid();
      // Conservatively allow 32-bit expansion plus CPU and GPU copies, including sparse accessors.
      decodedBytes += checked(accessor.count * size * 4 * 2);
    }
    const meshTriangles = (document.meshes ?? []).map((mesh) =>
      mesh.primitives.reduce((sum, primitive) => {
        const accessor = accessors[primitive.indices ?? primitive.attributes.POSITION ?? -1];
        if (!accessor) throw invalid();
        const count = accessor.count,
          mode = primitive.mode ?? 4;
        if (mode > 6) throw invalid();
        return (
          sum + (mode === 4 ? Math.ceil(count / 3) : mode >= 5 ? Math.max(0, count - 2) : count)
        );
      }, 0),
    );
    let triangles = 0,
      drawCalls = 0;
    for (const node of document.nodes ?? [])
      if (node.mesh !== undefined) {
        const count = meshTriangles[node.mesh];
        if (count === undefined) throw invalid();
        triangles += count;
        drawCalls += document.meshes![node.mesh]!.primitives.length;
      }
    for (const image of document.images ?? []) {
      let data: DataView;
      if (image.uri !== undefined) {
        const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.uri);
        if (!match) throw invalid();
        const decoded = Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0));
        data = new DataView(decoded.buffer);
      } else {
        if (image.bufferView === undefined) throw invalid();
        const buffer = document.bufferViews?.[image.bufferView];
        if (!buffer || end + 8 > bytes.length || view.getUint32(end + 4, true) !== 0x004e4942)
          throw invalid();
        const start = end + 8 + (buffer.byteOffset ?? 0),
          stop = start + buffer.byteLength;
        if (stop > bytes.length) throw invalid();
        data = new DataView(bytes.buffer, bytes.byteOffset + start, buffer.byteLength);
      }
      let width = 0,
        height = 0;
      if (
        data.byteLength >= 24 &&
        data.getUint32(0) === 0x89504e47 &&
        data.getUint32(4) === 0x0d0a1a0a
      ) {
        width = data.getUint32(16);
        height = data.getUint32(20);
      } else if (data.byteLength >= 4 && data.getUint16(0) === 0xffd8) {
        for (let offset = 2; offset + 4 <= data.byteLength; ) {
          if (data.getUint8(offset) !== 0xff) throw invalid();
          const marker = data.getUint8(offset + 1);
          if (marker === 0xff) {
            offset++;
            continue;
          }
          const size = data.getUint16(offset + 2);
          if (size < 2 || offset + 2 + size > data.byteLength) throw invalid();
          if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 7) {
            height = data.getUint16(offset + 5);
            width = data.getUint16(offset + 7);
            break;
          }
          offset += 2 + size;
        }
      }
      if (!width || !height) throw invalid();
      // RGBA, mipmaps, CPU decode, and GPU residency; reject before image decoding.
      decodedBytes += checked(width * height * 12);
    }
    checked(triangles);
    checked(decodedBytes);
    if (
      decodedBytes > CAD_SCENE_LIMITS.decodedBytes ||
      triangles > CAD_SCENE_LIMITS.triangles ||
      drawCalls > CAD_SCENE_LIMITS.drawCalls
    )
      throw new CadSceneBudgetError("too-large");
    return { decodedBytes, triangles, drawCalls, nodeCount };
  } catch (error) {
    if (error instanceof CadSceneBudgetError) throw error;
    throw invalid();
  }
}

/** Account shared geometry once in memory, but every occurrence in rendering work. */
export function createCadSceneBudget(nodes: readonly CadSnapshotNode[]) {
  if (nodes.length > CAD_SCENE_LIMITS.occurrences) throw new CadSceneBudgetError("too-large");
  const counts = new Map<string, number>();
  for (const node of nodes)
    if (!node.suppressed && node.sourcePartKey !== null)
      counts.set(node.sourcePartKey, (counts.get(node.sourcePartKey) ?? 0) + 1);
  const hashes = new Set<string>(),
    keys = new Set<string>();
  let decodedBytes = nodes.length * 4096,
    triangles = 0,
    drawCalls = 0;
  return {
    add(
      asset: Pick<CadGeometryAsset, "geometryKey" | "sha256">,
      complexity: NonNullable<CadGeometryAsset["complexity"]>,
    ) {
      if (keys.has(asset.geometryKey)) throw invalid();
      keys.add(asset.geometryKey);
      triangles += checked(complexity.triangles * (counts.get(asset.geometryKey) ?? 0));
      drawCalls += checked(complexity.drawCalls * (counts.get(asset.geometryKey) ?? 0));
      decodedBytes += checked(complexity.nodeCount * 4096 * (counts.get(asset.geometryKey) ?? 0));
      if (!hashes.has(asset.sha256)) {
        hashes.add(asset.sha256);
        decodedBytes += checked(complexity.decodedBytes);
      }
      if (
        decodedBytes > CAD_SCENE_LIMITS.decodedBytes ||
        triangles > CAD_SCENE_LIMITS.triangles ||
        drawCalls > CAD_SCENE_LIMITS.drawCalls
      )
        throw new CadSceneBudgetError("too-large");
      return { decodedBytes, triangles, drawCalls };
    },
  };
}
