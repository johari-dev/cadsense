// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
export function zip(
  entries: Array<{ name: string; bytes: Uint8Array }>,
  corruptCrc = false,
  zip64 = false,
) {
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
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    const extra = Buffer.alloc(zip64 ? 12 : 0);
    if (zip64) {
      central.writeUInt16LE(12, 30);
      extra.writeUInt16LE(1);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(offset), 4);
    }
    locals.push(local, name, packed);
    records.push(central, name, extra);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(records),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const trailer = Buffer.alloc(zip64 ? 76 : 0);
  if (zip64) {
    trailer.writeUInt32LE(0x06064b50);
    trailer.writeBigUInt64LE(44n, 4);
    trailer.writeBigUInt64LE(BigInt(entries.length), 24);
    trailer.writeBigUInt64LE(BigInt(entries.length), 32);
    trailer.writeBigUInt64LE(BigInt(directory.length), 40);
    trailer.writeBigUInt64LE(BigInt(offset), 48);
    trailer.writeUInt32LE(0x07064b50, 56);
    trailer.writeBigUInt64LE(BigInt(offset + directory.length), 64);
    trailer.writeUInt32LE(1, 72);
  }
  return Buffer.concat([...locals, directory, trailer, end]);
}
