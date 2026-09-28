import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { applyOnshapeOpacity } from "./OnshapeGeometryAppearance.ts";
import { bulkFixture, encodeFixture } from "./testFixtures/bulkExport.ts";

const appearance = { color: { red: 230, green: 230, blue: 230 }, opacity: 127 };
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      materials: Schema.Array(
        Schema.Struct({
          alphaMode: Schema.optionalKey(Schema.String),
          pbrMetallicRoughness: Schema.Struct({ baseColorFactor: Schema.Array(Schema.Number) }),
        }),
      ),
    }),
  ),
);
const material = (rgb: number, extra = {}) => ({
  pbrMetallicRoughness: {
    baseColorFactor: [rgb, rgb, rgb, 1],
    metallicFactor: 0,
    roughnessFactor: 0.7,
  },
  ...extra,
});
const geometry = (materials: unknown[], extra = {}) =>
  normalizeCadGeometry(
    new TextEncoder().encode(encodeFixture({ ...bulkFixture(1).gltf, materials, ...extra })),
  );
const binary = (bytes: Uint8Array) =>
  bytes.subarray(28 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true));
const materials = (bytes: Uint8Array) =>
  decode(
    new TextDecoder().decode(
      bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)),
    ),
  ).materials;

describe("Onshape opacity repair", () => {
  for (const [name, factor, color] of [
    ["display RGB", 0.9019607843137255, appearance.color],
    ["linear RGB", 0.7912979403326302, appearance.color],
    ["black", 0, { red: 0, green: 0, blue: 0 }],
    ["white", 1, { red: 255, green: 255, blue: 255 }],
  ] as const) {
    it.effect(`restores omitted opacity for ${name} without changing geometry`, () =>
      Effect.gen(function* () {
        const input = yield* geometry([material(factor)]);
        const output = applyOnshapeOpacity(input, { ...appearance, color });
        const verified = yield* normalizeCadGeometry(output);
        assert.equal(materials(verified)[0]!.alphaMode, "BLEND");
        assert.closeTo(
          materials(verified)[0]!.pbrMetallicRoughness.baseColorFactor[3]!,
          0.4980392156862745,
          1e-12,
        );
        assert.deepEqual(binary(verified), binary(input));
        assert.equal(materials(input)[0]!.pbrMetallicRoughness.baseColorFactor[3], 1);
        assert.strictEqual(applyOnshapeOpacity(output, { ...appearance, color }), output);
      }),
    );
  }
  it.effect("keeps identical geometry independent when source parts have different opacity", () =>
    Effect.gen(function* () {
      const input = yield* geometry([material(0.9019607843137255)]);
      const invisible = applyOnshapeOpacity(input, { ...appearance, opacity: 0 });
      const translucent = applyOnshapeOpacity(input, appearance);
      assert.equal(materials(invisible)[0]!.pbrMetallicRoughness.baseColorFactor[3], 0);
      assert.equal(materials(invisible)[0]!.alphaMode, "BLEND");
      assert.closeTo(
        materials(translucent)[0]!.pbrMetallicRoughness.baseColorFactor[3]!,
        0.4980392156862745,
        1e-12,
      );
      assert.strictEqual(applyOnshapeOpacity(input, { ...appearance, opacity: 255 }), input);
      assert.strictEqual(applyOnshapeOpacity(input, null), input);
      assert.equal(materials(input)[0]!.pbrMetallicRoughness.baseColorFactor[3], 1);
    }),
  );
  it.effect("preserves authored alpha modes, different face colors, and material extensions", () =>
    Effect.gen(function* () {
      const input = yield* geometry(
        [
          material(0.9019607843137255, { alphaMode: "BLEND" }),
          material(0.9019607843137255, { alphaMode: "MASK", alphaCutoff: 0.5 }),
          material(0.9019607843137255, {
            alphaMode: "BLEND",
            pbrMetallicRoughness: { baseColorFactor: [0.9, 0.9, 0.9, 0.2] },
          }),
          material(0.2),
          material(0.9019607843137255, { extensions: { KHR_materials_unlit: {} } }),
        ],
        { extensionsUsed: ["PTC_onshape_metadata", "KHR_materials_unlit"] },
      );
      assert.strictEqual(applyOnshapeOpacity(input, appearance), input);
    }),
  );
  it.effect("preserves vertex-colored materials even when their factor matches the part", () =>
    Effect.gen(function* () {
      const input = yield* geometry([material(0.9019607843137255)], {
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 1 }, material: 0 }] },
        ],
      });
      assert.strictEqual(applyOnshapeOpacity(input, appearance), input);
    }),
  );
  it.effect("preserves texture alpha when the factor matches the part", () =>
    Effect.gen(function* () {
      const input = yield* geometry(
        [
          material(0.9019607843137255, {
            pbrMetallicRoughness: {
              baseColorFactor: [0.9019607843137255, 0.9019607843137255, 0.9019607843137255, 1],
              baseColorTexture: { index: 0 },
            },
          }),
        ],
        {
          meshes: [
            {
              primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }],
            },
          ],
          bufferViews: bulkFixture(1).gltf.bufferViews.map((view, index) =>
            index === 0 ? { ...view, byteStride: 12 } : view,
          ),
          accessors: [
            ...bulkFixture(1).gltf.accessors,
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC2" },
          ],
          textures: [{ source: 0 }],
          images: [
            {
              uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            },
          ],
        },
      );
      assert.strictEqual(applyOnshapeOpacity(input, appearance), input);
    }),
  );
});
