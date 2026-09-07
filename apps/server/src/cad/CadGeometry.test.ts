import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { normalizeCadGeometry } from "./CadGeometry.ts";

const codec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const bytes = (value: Record<string, unknown>) =>
  new TextEncoder().encode(Schema.encodeSync(codec)(value));
const triangle = {
  asset: { version: "2.0" },
  buffers: [{ byteLength: 3, uri: "data:application/octet-stream;base64,AQID" }],
  bufferViews: [{ buffer: 0, byteLength: 3, target: 34962 }],
};
const readJson = (glb: Uint8Array) => {
  const length = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  return Schema.decodeUnknownSync(codec)(new TextDecoder().decode(glb.subarray(20, 20 + length)));
};

describe("CAD geometry normalization", () => {
  it.effect(
    "preserves optional Onshape metadata without accepting unknown required extensions",
    () =>
      Effect.gen(function* () {
        const value = {
          ...triangle,
          extensionsUsed: ["PTC_onshape_metadata"],
          extensions: { PTC_onshape_metadata: { test: "part identity" } },
        };
        const result = yield* normalizeCadGeometry(bytes(value));
        assert.deepEqual(readJson(result).extensions, value.extensions);
        assert.equal(
          (yield* normalizeCadGeometry(
            bytes({ ...value, extensionsRequired: value.extensionsUsed }),
          ).pipe(Effect.flip)).reason,
          "invalid-geometry",
        );
      }),
  );
  it.effect(
    "converts embedded geometry to stable self-contained GLB and preserves attributes",
    () =>
      Effect.gen(function* () {
        const result = yield* normalizeCadGeometry(bytes(triangle));
        assert.deepEqual(readJson(result).buffers, [{ byteLength: 4 }]);
        assert.deepEqual(readJson(result).bufferViews, [
          { buffer: 0, byteOffset: 0, byteLength: 3, target: 34962 },
        ]);
        assert.deepEqual(result.subarray(-4), new Uint8Array([1, 2, 3, 0]));
        assert.deepEqual(yield* normalizeCadGeometry(result), result);
      }),
  );

  it.effect("combines multiple buffers with aligned view offsets", () =>
    Effect.gen(function* () {
      const result = yield* normalizeCadGeometry(
        bytes({
          ...triangle,
          buffers: [
            ...triangle.buffers,
            { byteLength: 2, uri: "data:application/gltf-buffer;base64,BAU=" },
          ],
          bufferViews: [...triangle.bufferViews, { buffer: 1, byteOffset: 1, byteLength: 1 }],
        }),
      );
      assert.deepEqual(readJson(result).buffers, [{ byteLength: 8 }]);
      assert.deepEqual(readJson(result).bufferViews, [
        { buffer: 0, byteOffset: 0, byteLength: 3, target: 34962 },
        { buffer: 0, byteOffset: 5, byteLength: 1 },
      ]);
    }),
  );

  for (const uri of ["https://example.com/mesh.bin", "file:///mesh.bin", "../mesh.bin"]) {
    it.effect(`rejects external resource ${uri}`, () =>
      Effect.gen(function* () {
        const error = yield* normalizeCadGeometry(bytes({ ...triangle, images: [{ uri }] })).pipe(
          Effect.flip,
        );
        assert.equal(error.reason, "external-resource");
      }),
    );
  }

  it.effect("rejects malformed, truncated, and mismatched geometry", () =>
    Effect.gen(function* () {
      for (const value of [
        { ...triangle, asset: { version: "1.0" } },
        { ...triangle, buffers: [{ byteLength: 9, uri: triangle.buffers[0]!.uri }] },
        { ...triangle, bufferViews: [{ buffer: 0, byteOffset: 2, byteLength: 2 }] },
        {
          ...triangle,
          buffers: [{ byteLength: 1, uri: "data:application/octet-stream;base64,??==" }],
        },
      ]) {
        assert.equal(
          (yield* normalizeCadGeometry(bytes(value)).pipe(Effect.flip))._tag,
          "CadGeometryError",
        );
      }
      const valid = yield* normalizeCadGeometry(bytes(triangle));
      for (const malformed of [
        valid.subarray(0, valid.length - 1),
        new Uint8Array([103, 108, 84, 70]),
      ]) {
        assert.equal(
          (yield* normalizeCadGeometry(malformed).pipe(Effect.flip)).reason,
          "invalid-geometry",
        );
      }
    }),
  );

  it.effect("rejects broken accessor references and unsupported compressed buffer references", () =>
    Effect.gen(function* () {
      for (const value of [
        { ...triangle, meshes: [{ primitives: [{ attributes: { POSITION: 999 } }] }] },
        {
          ...triangle,
          nodes: [
            {
              mesh: 0,
              extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } } },
            },
          ],
        },
        {
          ...triangle,
          bufferViews: [
            {
              ...triangle.bufferViews[0],
              extensions: {
                EXT_meshopt_compression: {
                  buffer: 1,
                  byteLength: 3,
                  byteStride: 4,
                  count: 1,
                  mode: "ATTRIBUTES",
                },
              },
            },
          ],
        },
      ]) {
        assert.equal(
          (yield* normalizeCadGeometry(bytes(value)).pipe(Effect.flip)).reason,
          "invalid-geometry",
        );
      }
    }),
  );
});
