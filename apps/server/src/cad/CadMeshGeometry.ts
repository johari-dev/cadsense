import * as Schema from "effect/Schema";

export type CadMeshPoint = readonly [number, number, number];
export type CadMeshTriangle = readonly [CadMeshPoint, CadMeshPoint, CadMeshPoint];
export const CAD_MESH_MAX_TRIANGLES = 100_000;
export const CAD_MESH_MAX_BYTES = 128 * 1024 ** 2;
export class CadMeshGeometryError extends Error {
  readonly _tag = "CadMeshGeometryError";
  readonly reason: "invalid-geometry" | "unsupported-geometry" | "too-large" | "empty-geometry";
  constructor(reason: CadMeshGeometryError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
const invalid = () => new CadMeshGeometryError("invalid-geometry");
const unsupported = () => new CadMeshGeometryError("unsupported-geometry");
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const object = Schema.decodeUnknownSync(ObjectValue);
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectValue));
const numbers = Schema.decodeUnknownSync(Schema.Array(Schema.Number.check(Schema.isFinite())));
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue));
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const matrix = (values: readonly number[]) => {
  if (
    values.length !== 16 ||
    values.some((value) => !Number.isFinite(value)) ||
    values[12] !== 0 ||
    values[13] !== 0 ||
    values[14] !== 0 ||
    values[15] !== 1
  )
    throw invalid();
  return values;
};
export function transformCadMeshPoint(
  point: CadMeshPoint,
  rowMajorMatrix: readonly number[],
): CadMeshPoint {
  const m = matrix(rowMajorMatrix);
  const [x, y, z] = point;
  const result: CadMeshPoint = [
    m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  ];
  if (result.some((value) => !Number.isFinite(value))) throw invalid();
  return result;
}
const multiply = (a: readonly number[], b: readonly number[]) =>
  matrix(
    Array.from({ length: 16 }, (_, i) => {
      const row = Math.floor(i / 4),
        col = i % 4;
      return [0, 1, 2, 3].reduce((sum, k) => sum + a[row * 4 + k]! * b[k * 4 + col]!, 0);
    }),
  );
const nodeMatrix = (node: Record<string, unknown>) => {
  if (node.matrix !== undefined) {
    if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined)
      throw invalid();
    const source = numbers(node.matrix);
    if (source.length !== 16) throw invalid();
    return matrix(Array.from({ length: 16 }, (_, i) => source[(i % 4) * 4 + Math.floor(i / 4)]!));
  }
  const t = numbers(node.translation ?? [0, 0, 0]),
    s = numbers(node.scale ?? [1, 1, 1]),
    q = numbers(node.rotation ?? [0, 0, 0, 1]);
  if (t.length !== 3 || s.length !== 3 || q.length !== 4 || Math.abs(Math.hypot(...q) - 1) > 1e-5)
    throw invalid();
  const [x, y, z, w] = q as [number, number, number, number];
  return matrix([
    (1 - 2 * y * y - 2 * z * z) * s[0]!,
    (2 * x * y - 2 * z * w) * s[1]!,
    (2 * x * z + 2 * y * w) * s[2]!,
    t[0]!,
    (2 * x * y + 2 * z * w) * s[0]!,
    (1 - 2 * x * x - 2 * z * z) * s[1]!,
    (2 * y * z - 2 * x * w) * s[2]!,
    t[1]!,
    (2 * x * z - 2 * y * w) * s[0]!,
    (2 * y * z + 2 * x * w) * s[1]!,
    (1 - 2 * x * x - 2 * y * y) * s[2]!,
    t[2]!,
    0,
    0,
    0,
    1,
  ]);
};

/** Decode only cached, self-contained static triangle meshes. Never resolves resource URIs.
 * Returned vertices use assembled CAD coordinates in meters, with Z up. Accessor min/max
 * hints are deliberately ignored. Every returned triangle comes from the binary positions.
 */
export function readCadMeshTriangles(
  bytes: Uint8Array,
  occurrenceTransform: readonly number[],
): readonly CadMeshTriangle[] {
  try {
    if (bytes.length > CAD_MESH_MAX_BYTES) throw new CadMeshGeometryError("too-large");
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 28 ||
      header.getUint32(0, true) !== 0x46546c67 ||
      header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== bytes.length ||
      header.getUint32(16, true) !== 0x4e4f534a
    )
      throw invalid();
    const jsonLength = header.getUint32(12, true),
      end = 20 + jsonLength;
    if (
      jsonLength % 4 !== 0 ||
      end + 8 > bytes.length ||
      header.getUint32(end + 4, true) !== 0x004e4942 ||
      end + 8 + header.getUint32(end, true) !== bytes.length
    )
      throw invalid();
    const doc = decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, end)));
    if (object(doc.asset).version !== "2.0") throw invalid();
    if (doc.animations !== undefined || doc.skins !== undefined) throw unsupported();
    // Bulk exports retain optional material/texture declarations on every split part.
    // They do not affect positions. Required extensions and geometry extensions still gate reads.
    if (
      strings(doc.extensionsRequired ?? []).some(
        (name) =>
          !["KHR_mesh_quantization", "KHR_materials_unlit", "PTC_onshape_metadata"].includes(name),
      ) ||
      strings(doc.extensionsUsed ?? []).some((name) =>
        [
          "KHR_draco_mesh_compression",
          "EXT_meshopt_compression",
          "EXT_mesh_gpu_instancing",
        ].includes(name),
      )
    )
      throw unsupported();
    const buffers = objects(doc.buffers);
    if (buffers.length !== 1 || buffers[0]!.uri !== undefined) throw unsupported();
    const binaryLength = integer(buffers[0]!.byteLength);
    if (binaryLength > bytes.length - end - 8) throw invalid();
    const binary = new DataView(bytes.buffer, bytes.byteOffset + end + 8, binaryLength);
    const views = objects(doc.bufferViews ?? []),
      accessors = objects(doc.accessors ?? []),
      meshes = objects(doc.meshes ?? []),
      nodes = objects(doc.nodes ?? []),
      scenes = objects(doc.scenes ?? []);
    const scene = scenes[integer(doc.scene ?? 0)];
    if (!scene) throw invalid();
    const accessor = (index: unknown, width: 1 | 3) => {
      const acc = accessors[integer(index)];
      if (!acc || acc.type !== (width === 1 ? "SCALAR" : "VEC3")) throw invalid();
      if (acc.sparse !== undefined || acc.bufferView === undefined || acc.extensions !== undefined)
        throw unsupported();
      const view = views[integer(acc.bufferView)];
      if (!view || integer(view.buffer) !== 0 || view.extensions !== undefined) throw unsupported();
      const type = integer(acc.componentType);
      const size =
        type === 5120 || type === 5121
          ? 1
          : type === 5122 || type === 5123
            ? 2
            : type === 5125 || type === 5126
              ? 4
              : 0;
      if (
        !size ||
        (width === 1 && (![5121, 5123, 5125].includes(type) || acc.normalized === true)) ||
        (width === 3 && type === 5125)
      )
        throw unsupported();
      const count = integer(acc.count),
        stride = integer(view.byteStride ?? width * size),
        viewStart = integer(view.byteOffset ?? 0),
        viewLength = integer(view.byteLength),
        offset = integer(acc.byteOffset ?? 0);
      if (
        stride < width * size ||
        viewStart + viewLength > binaryLength ||
        offset + Math.max(0, count - 1) * stride + (count ? width * size : 0) > viewLength
      )
        throw invalid();
      const read = (i: number, component: number) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= count) throw invalid();
        const at = viewStart + offset + i * stride + component * size;
        let value =
          type === 5120
            ? binary.getInt8(at)
            : type === 5121
              ? binary.getUint8(at)
              : type === 5122
                ? binary.getInt16(at, true)
                : type === 5123
                  ? binary.getUint16(at, true)
                  : type === 5125
                    ? binary.getUint32(at, true)
                    : binary.getFloat32(at, true);
        if (acc.normalized === true)
          value =
            type === 5120
              ? Math.max(value / 127, -1)
              : type === 5121
                ? value / 255
                : type === 5122
                  ? Math.max(value / 32767, -1)
                  : type === 5123
                    ? value / 65535
                    : value;
        if (!Number.isFinite(value)) throw invalid();
        return value;
      };
      return { count, read };
    };
    const triangles: CadMeshTriangle[] = [];
    const visited = new Set<number>();
    const pending = numbers(scene.nodes ?? []).map((id) => ({
      id: integer(id),
      parent: matrix(occurrenceTransform),
    }));
    while (pending.length) {
      const entry = pending.pop()!;
      if (visited.has(entry.id)) throw invalid();
      visited.add(entry.id);
      if (visited.size > 10_000) throw new CadMeshGeometryError("too-large");
      const node = nodes[entry.id];
      if (!node) throw invalid();
      if (
        node.skin !== undefined ||
        node.weights !== undefined ||
        (node.extensions !== undefined &&
          Object.keys(object(node.extensions)).some(
            (key) => key !== "PTC_onshape_metadata" && key !== "KHR_lights_punctual",
          ))
      )
        throw unsupported();
      const world = multiply(entry.parent, nodeMatrix(node));
      for (const id of numbers(node.children ?? []))
        pending.push({ id: integer(id), parent: world });
      if (node.mesh === undefined) continue;
      const mesh = meshes[integer(node.mesh)];
      if (!mesh) throw invalid();
      if (mesh.weights !== undefined || mesh.extensions !== undefined) throw unsupported();
      for (const primitive of objects(mesh.primitives)) {
        if (
          (primitive.mode ?? 4) !== 4 ||
          primitive.targets !== undefined ||
          primitive.extensions !== undefined
        )
          throw unsupported();
        const positions = accessor(object(primitive.attributes).POSITION, 3);
        const indices = primitive.indices === undefined ? null : accessor(primitive.indices, 1);
        const count = indices?.count ?? positions.count;
        if (count % 3 !== 0) throw invalid();
        if (triangles.length + count / 3 > CAD_MESH_MAX_TRIANGLES)
          throw new CadMeshGeometryError("too-large");
        const point = (i: number) => {
          const at = indices ? indices.read(i, 0) : i;
          return transformCadMeshPoint(
            [positions.read(at, 0), positions.read(at, 1), positions.read(at, 2)],
            world,
          );
        };
        for (let i = 0; i < count; i += 3) triangles.push([point(i), point(i + 1), point(i + 2)]);
      }
    }
    if (!triangles.length) throw new CadMeshGeometryError("empty-geometry");
    return triangles;
  } catch (error) {
    if (error instanceof CadMeshGeometryError) throw error;
    throw invalid();
  }
}
