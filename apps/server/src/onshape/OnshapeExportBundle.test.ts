// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { normalizeOnshapeExport } from "./OnshapeExportBundle.ts";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { bulkFixture, encodeFixture } from "./testFixtures/bulkExport.ts";

function zip(entries: Array<{ name: string; bytes: Uint8Array }>, corruptCrc = false) {
  const locals: Buffer[] = [],
    records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      packed = NodeZlib.deflateRawSync(entry.bytes);
    const crc = corruptCrc ? 0 : NodeZlib.crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    records.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(records),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
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
