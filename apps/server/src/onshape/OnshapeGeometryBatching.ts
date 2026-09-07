import * as Schema from "effect/Schema";
import { CadGeometryError } from "../cad/CadGeometry.ts";

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const object = Schema.decodeUnknownSync(ObjectValue);
const numbers = Schema.decodeUnknownSync(Schema.Array(Schema.Number));
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectValue));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue));
const encode = Schema.encodeSync(Schema.fromJsonString(ObjectValue));
const invalid = () => new CadGeometryError({ reason: "invalid-geometry" });
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const components = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
]);
const sizes = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);

/** Batch face primitives by material without changing vertices, normals, triangles, or placement.
 * Input has already passed the self-contained GLB validator. Unsupported layouts stay unchanged.
 */
export function batchOnshapeGeometry(input: Uint8Array): Uint8Array {
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const jsonEnd = 20 + header.getUint32(12, true);
  const document = decode(new TextDecoder().decode(input.subarray(20, jsonEnd)));
  if (
    document.images !== undefined ||
    document.animations !== undefined ||
    document.skins !== undefined
  )
    return input;
  const meshes = objects(document.meshes ?? []);
  const accessors = objects(document.accessors ?? []);
  const views = objects(document.bufferViews ?? []);
  const binary = input.subarray(jsonEnd + 8);
  const primitiveGroups = meshes.map((mesh) => {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const primitive of objects(mesh.primitives)) {
      if (
        (primitive.mode ?? 4) !== 4 ||
        primitive.targets !== undefined ||
        primitive.extensions !== undefined
      )
        return null;
      const attributes = object(primitive.attributes);
      const format = Object.entries(attributes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, index]) => {
          const accessor = accessors[integer(index)];
          if (!accessor || accessor.sparse !== undefined || accessor.bufferView === undefined)
            return null;
          return [name, accessor.componentType, accessor.type, accessor.normalized ?? false];
        });
      if (format.includes(null)) return null;
      const key = encode({ material: primitive.material ?? null, format });
      const group = groups.get(key) ?? [];
      group.push(primitive);
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  if (primitiveGroups.some((groups) => groups === null)) return input;
  const outputAccessors: Record<string, unknown>[] = [];
  const outputViews: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (data: Uint8Array, accessor: Record<string, unknown>) => {
    const index = outputAccessors.length;
    outputAccessors.push({ ...accessor, bufferView: outputViews.length, byteOffset: 0 });
    outputViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length });
    chunks.push(data);
    byteLength += Math.ceil(data.length / 4) * 4;
    return index;
  };
  const read = (accessor: Record<string, unknown>) => {
    const view = views[integer(accessor.bufferView)];
    if (!view) throw invalid();
    const width = components.get(String(accessor.type));
    const size = sizes.get(integer(accessor.componentType));
    if (!width || !size || accessor.sparse !== undefined) throw invalid();
    const count = integer(accessor.count),
      elementBytes = width * size;
    const stride = integer(view.byteStride ?? elementBytes);
    const start = integer(view.byteOffset ?? 0) + integer(accessor.byteOffset ?? 0);
    if (
      stride < elementBytes ||
      start + Math.max(0, count - 1) * stride + elementBytes > binary.length
    )
      throw invalid();
    const result = new Uint8Array(count * elementBytes);
    for (let i = 0; i < count; i++)
      result.set(
        binary.subarray(start + i * stride, start + i * stride + elementBytes),
        i * elementBytes,
      );
    return result;
  };
  const outputMeshes = meshes.map((mesh, meshIndex) => ({
    ...mesh,
    primitives: primitiveGroups[meshIndex]!.map((group) => {
      const attributes: Record<string, number> = {};
      const first = object(group[0]!.attributes);
      const vertexCounts = group.map((primitive) => {
        const attrs = object(primitive.attributes);
        return integer(accessors[integer(attrs.POSITION)]?.count);
      });
      for (const name of Object.keys(first)) {
        const values = group.map((primitive) => {
          const attrs = object(primitive.attributes);
          const accessor = accessors[integer(attrs[name])];
          if (!accessor) throw invalid();
          return accessor;
        });
        const data = values.map(read);
        const merged = new Uint8Array(data.reduce((sum, item) => sum + item.length, 0));
        let offset = 0;
        for (const item of data) {
          merged.set(item, offset);
          offset += item.length;
        }
        const descriptor: Record<string, unknown> = {
          ...values[0],
          count: values.reduce((sum, value) => sum + integer(value.count), 0),
        };
        // Recompute position bounds from all source accessors, preserving exact coordinates.
        const bounds: Record<string, unknown> = {};
        if (name === "POSITION")
          for (const field of ["min", "max"]) {
            const arrays = values.map((value) => numbers(value[field]));
            bounds[field] = [0, 1, 2].map((axis) =>
              arrays.reduce(
                (result, value) =>
                  field === "min" ? Math.min(result, value[axis]!) : Math.max(result, value[axis]!),
                field === "min" ? Infinity : -Infinity,
              ),
            );
          }
        attributes[name] = append(merged, {
          componentType: descriptor.componentType,
          type: descriptor.type,
          normalized: descriptor.normalized,
          count: descriptor.count,
          ...bounds,
        });
      }
      const indices: Uint32Array[] = [];
      let vertexOffset = 0;
      for (const [i, primitive] of group.entries()) {
        let result: Uint32Array;
        if (primitive.indices === undefined)
          result = Uint32Array.from(
            { length: vertexCounts[i]! },
            (_, index) => index + vertexOffset,
          );
        else {
          const accessor = accessors[integer(primitive.indices)];
          if (!accessor || accessor.type !== "SCALAR") throw invalid();
          const bytes = read(accessor),
            view = new DataView(bytes.buffer);
          result = new Uint32Array(integer(accessor.count));
          for (let j = 0; j < result.length; j++) {
            const index =
              accessor.componentType === 5125
                ? view.getUint32(j * 4, true)
                : accessor.componentType === 5123
                  ? view.getUint16(j * 2, true)
                  : accessor.componentType === 5121
                    ? view.getUint8(j)
                    : NaN;
            if (index >= vertexCounts[i]! || !Number.isFinite(index)) throw invalid();
            result[j] = index + vertexOffset;
          }
        }
        indices.push(result);
        vertexOffset += vertexCounts[i]!;
      }
      const merged = new Uint32Array(indices.reduce((sum, item) => sum + item.length, 0));
      let offset = 0;
      for (const item of indices) {
        merged.set(item, offset);
        offset += item.length;
      }
      return {
        ...group[0],
        attributes,
        indices: append(new Uint8Array(merged.buffer), {
          componentType: 5125,
          type: "SCALAR",
          count: merged.length,
        }),
      };
    }),
  }));
  const json = new TextEncoder().encode(
    encode({
      ...document,
      meshes: outputMeshes,
      accessors: outputAccessors,
      bufferViews: outputViews,
      buffers: [{ byteLength }],
    }),
  );
  const length = Math.ceil(json.length / 4) * 4;
  const output = new Uint8Array(28 + length + byteLength),
    view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(32, 20, 20 + length);
  output.set(json, 20);
  view.setUint32(20 + length, byteLength, true);
  view.setUint32(24 + length, 0x004e4942, true);
  let offset = 28 + length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += Math.ceil(chunk.length / 4) * 4;
  }
  return output;
}
