// @effect-diagnostics nodeBuiltinImport:off
import { zip } from "./testFixtures/zip.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { normalizeOnshapeExport, readOnshapeZip } from "./OnshapeExportBundle.ts";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { bulkFixture, encodeFixture } from "./testFixtures/bulkExport.ts";

const fixtureArchive = (uri = "mesh.bin") => {
  const fixture = bulkFixture(1);
  return [
    {
      name: "export/model.gltf",
      bytes: Buffer.from(encodeFixture({ ...fixture.gltf, buffers: [{ byteLength: 72, uri }] })),
    },
    {
      name: "export/mesh.bin",
      bytes: Buffer.from(fixture.gltf.buffers[0]!.uri.split(",")[1]!, "base64"),
    },
  ];
};
describe("Onshape export bundle", () => {
  it("reads Onshape ZIP64 directories and rejects corrupt 64-bit offsets", () => {
    const bytes = zip([{ name: "model", bytes: Buffer.from("geometry") }], false, true);
    assert.equal(new TextDecoder().decode(readOnshapeZip(bytes).get("model")!()), "geometry");
    const corrupt = Buffer.from(bytes);
    corrupt.writeBigUInt64LE(9007199254740992n, corrupt.length - 34);
    assert.throws(() => readOnshapeZip(corrupt));
  });
  it.effect("normalizes a bulk response above the per-part input limit", () =>
    Effect.gen(function* () {
      const fixture = bulkFixture(1);
      const input = new TextEncoder().encode(
        " ".repeat(129 * 1024 * 1024) + encodeFixture(fixture.gltf),
      );
      assert.equal((yield* normalizeCadGeometry(input).pipe(Effect.flip)).reason, "too-large");
      const normalized = yield* normalizeOnshapeExport(input);
      assert.isBelow(normalized.byteLength, 4096);
    }),
  );
  it.effect("resolves a compressed glTF and its binary into a self-contained GLB", () =>
    Effect.gen(function* () {
      const bytes = yield* normalizeOnshapeExport(zip(fixtureArchive()));
      assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), 0x46546c67);
    }),
  );
  it.effect("rejects corrupt payloads, ambiguous models, and resources outside the archive", () =>
    Effect.gen(function* () {
      const entries = fixtureArchive();
      const archives = [
        zip(entries, true),
        zip([...entries, { ...entries[0]!, name: "second.gltf" }]),
        zip(fixtureArchive("https://example.com/mesh.bin")),
        zip(fixtureArchive("../../mesh.bin")),
        zip([...entries, { name: "../escape", bytes: Buffer.from("x") }]),
      ];
      for (const archive of archives) {
        const error = yield* normalizeOnshapeExport(archive).pipe(Effect.flip);
        assert.equal(error._tag, "CadGeometryError");
      }
    }),
  );
});
