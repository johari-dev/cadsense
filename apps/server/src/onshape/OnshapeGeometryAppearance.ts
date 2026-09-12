import type { CadPartAppearance } from "@cadsense/contracts";
import * as Schema from "effect/Schema";

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const isObject = Schema.is(ObjectValue);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue));
const encode = Schema.encodeSync(Schema.fromJsonString(ObjectValue));
const factors = Schema.decodeUnknownSync(Schema.Array(Schema.Number));

/** Repair omitted part opacity in a self-contained GLB before hashing or caching.
 * Only matching, opaque base colors inherit it. Authored alpha, textures, vertex
 * colors, material extensions and different face colors keep their own appearance.
 */
export function applyOnshapeOpacity(
  input: Uint8Array,
  appearance: typeof CadPartAppearance.Type | null | undefined,
): Uint8Array {
  if (!appearance || appearance.opacity >= 255 || appearance.opacity < 0) return input;
  const { red, green, blue } = appearance.color;
  const rgb = [red, green, blue].map((value) => value / 255);
  if (rgb.some((value) => value < 0 || value > 1)) return input;
  const linear = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const jsonEnd = 20 + header.getUint32(12, true);
  const document = decode(new TextDecoder().decode(input.subarray(20, jsonEnd)));
  if (!Array.isArray(document.materials)) return input;
  const vertexMaterials = new Set<unknown>();
  for (const mesh of Array.isArray(document.meshes) ? document.meshes : []) {
    if (!isObject(mesh) || !Array.isArray(mesh.primitives)) continue;
    for (const primitive of mesh.primitives)
      if (
        isObject(primitive) &&
        isObject(primitive.attributes) &&
        primitive.attributes.COLOR_0 !== undefined
      )
        vertexMaterials.add(primitive.material);
  }
  let changed = false;
  const materials = document.materials.map((material, index) => {
    if (
      !isObject(material) ||
      vertexMaterials.has(index) ||
      material.extensions !== undefined ||
      (material.alphaMode !== undefined && material.alphaMode !== "OPAQUE")
    )
      return material;
    const pbr = isObject(material.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {};
    if (pbr.baseColorTexture !== undefined) return material;
    const color = factors(pbr.baseColorFactor ?? [1, 1, 1, 1]);
    if (
      color.length !== 4 ||
      color[3] !== 1 ||
      ![rgb, linear].some((expected) =>
        expected.every((value, i) => Math.abs(value - color[i]!) < 1e-6),
      )
    )
      return material;
    changed = true;
    return {
      ...material,
      alphaMode: "BLEND",
      pbrMetallicRoughness: {
        ...pbr,
        baseColorFactor: [...color.slice(0, 3), appearance.opacity / 255],
      },
    };
  });
  if (!changed) return input;
  const json = new TextEncoder().encode(encode({ ...document, materials }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const output = new Uint8Array(20 + jsonLength + input.length - jsonEnd);
  output.set(input.subarray(0, 20));
  const view = new DataView(output.buffer);
  view.setUint32(8, output.length, true);
  view.setUint32(12, jsonLength, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  output.set(input.subarray(jsonEnd), 20 + jsonLength);
  return output;
}
