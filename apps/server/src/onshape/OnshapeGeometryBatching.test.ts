import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { batchOnshapeGeometry } from "./OnshapeGeometryBatching.ts";
import { bulkFixture, encodeFixture } from "./testFixtures/bulkExport.ts";
import { measureCadGeometry } from "@cadsense/shared/cadSceneBudget";

describe("Onshape face batching", () => {
  it.effect("preserves triangles and material boundaries while reducing face draw calls", () =>
    Effect.gen(function* () {
      const fixture = bulkFixture(1);
      const source = {
        ...fixture.gltf,
        materials: [
          fixture.gltf.materials[0],
          { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
        ],
        meshes: [
          {
            primitives: Array.from({ length: 40 }, (_, i) => ({
              attributes: { POSITION: 0, NORMAL: 1 },
              material: i % 2,
            })),
          },
        ],
      };
      const input = yield* normalizeCadGeometry(new TextEncoder().encode(encodeFixture(source)));
      const output = yield* normalizeCadGeometry(batchOnshapeGeometry(input));
      assert.equal(measureCadGeometry(input).triangles, measureCadGeometry(output).triangles);
      assert.equal(measureCadGeometry(input).drawCalls, 40);
      assert.equal(measureCadGeometry(output).drawCalls, 2);
      const header = new DataView(output.buffer);
      const document = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            meshes: Schema.Array(
              Schema.Struct({
                primitives: Schema.Array(Schema.Struct({ material: Schema.Number })),
              }),
            ),
            materials: Schema.Array(Schema.Unknown),
          }),
        ),
      )(new TextDecoder().decode(output.subarray(20, 20 + header.getUint32(12, true))));
      assert.deepEqual(
        document.meshes[0]!.primitives.map((p) => p.material),
        [0, 1],
      );
      assert.deepEqual(document.materials, source.materials);
    }),
  );
});
