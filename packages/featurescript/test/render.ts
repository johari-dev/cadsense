// @effect-diagnostics nodeBuiltinImport:off - encodes PNGs with Node's zlib.
import * as NodeZlib from "node:zlib";
import type { BodyMesh } from "../src/geometry/Tessellate.ts";

/**
 * A small software renderer for corpus artifacts: an isometric, flat-shaded, z-buffered PNG of
 * tessellated bodies, so a reviewer can see a result without a browser. Not used by the app.
 */
const COLORS: Record<0 | 1, readonly [number, number, number]> = {
  0: [150, 158, 168],
  1: [245, 196, 66],
};

export function renderPng(meshes: readonly BodyMesh[], size = 640): Uint8Array {
  // Isometric camera: view direction (-1, -1, -1), Z up.
  const right = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  const up = [-1 / Math.sqrt(6), -1 / Math.sqrt(6), 2 / Math.sqrt(6)];
  const toward = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const light = [0.3, 0.5, 0.81];
  const dot = (a: readonly number[], b: ArrayLike<number>, o = 0) =>
    a[0]! * b[o]! + a[1]! * b[o + 1]! + a[2]! * b[o + 2]!;

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const mesh of meshes)
    for (const group of mesh.groups)
      for (let i = 0; i < group.positions.length; i += 3) {
        const x = dot(right, group.positions, i);
        const y = dot(up, group.positions, i);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const scale = (size * 0.85) / Math.max(maxX - minX, maxY - minY, 1e-9);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pixels = new Uint8Array(size * size * 3).fill(255);
  const depth = new Float32Array(size * size).fill(-Infinity);

  for (const mesh of meshes)
    for (const group of mesh.groups)
      for (let i = 0; i < group.positions.length; i += 9) {
        const corners = [0, 3, 6].map((k) => ({
          x: (dot(right, group.positions, i + k) - cx) * scale + size / 2,
          y: size / 2 - (dot(up, group.positions, i + k) - cy) * scale,
          z: dot(toward, group.positions, i + k),
        }));
        const shade = 0.35 + 0.65 * Math.abs(dot(light, group.normals, i));
        const color = COLORS[group.material].map((c) => Math.round(c * shade));
        const [a, b, c] = corners as [
          (typeof corners)[number],
          (typeof corners)[number],
          (typeof corners)[number],
        ];
        const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (Math.abs(area) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const x1 = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const y1 = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
            const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * a.z + w1 * b.z + w2 * c.z;
            const index = y * size + x;
            if (z <= depth[index]!) continue;
            depth[index] = z;
            pixels.set(color, index * 3);
          }
      }
  return encodePng(pixels, size, size);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
