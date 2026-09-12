import { describe, expect, it } from "vite-plus/test";
import type { CadMeshPoint, CadMeshTriangle } from "./CadMeshGeometry.ts";
import { cadSurfaceDistance, cadTriangleDistance } from "./CadSurfaceDistance.ts";

const flat: CadMeshTriangle = [
  [0, 0, 0],
  [4, 0, 0],
  [0, 4, 0],
];
const shift = (triangle: CadMeshTriangle, offset: CadMeshPoint): CadMeshTriangle => {
  const translate = (p: CadMeshPoint): CadMeshPoint => [
    p[0] + offset[0],
    p[1] + offset[1],
    p[2] + offset[2],
  ];
  return [translate(triangle[0]), translate(triangle[1]), translate(triangle[2])];
};

describe("triangle surface distance", () => {
  it("measures parallel faces and returns witness points on the faces", () => {
    const result = cadTriangleDistance(flat, shift(flat, [0.5, 0.5, 3]));
    expect(result.distance).toBe(3);
    expect(result.points[0][2]).toBe(0);
    expect(result.points[1][2]).toBe(3);
  });
  it("detects edge-face crossing when no vertex or edge pair has zero distance", () => {
    const crossing: CadMeshTriangle = [
      [1, 1, -1],
      [1, 1, 1],
      [5, 5, 1],
    ];
    expect(cadTriangleDistance(flat, crossing).distance).toBe(0);
  });
  it("handles coplanar overlap and coplanar disjoint faces", () => {
    expect(cadTriangleDistance(flat, shift(flat, [1, 1, 0])).distance).toBe(0);
    expect(cadTriangleDistance(flat, shift(flat, [5, 0, 0])).distance).toBeCloseTo(1, 12);
  });
  it("retains collapsed triangles as line segments or points", () => {
    const point: CadMeshTriangle = [
      [1, 1, 2],
      [1, 1, 2],
      [1, 1, 2],
    ];
    expect(cadTriangleDistance(point, flat).distance).toBe(2);
    const line: CadMeshTriangle = [
      [0, 0, 2],
      [2, 0, 2],
      [1, 0, 2],
    ];
    const other: CadMeshTriangle = [
      [1, -1, 4],
      [1, 1, 4],
      [1, 0, 4],
    ];
    expect(cadTriangleDistance(line, other).distance).toBe(2);
  });
  it("does not return an overlapping box as zero surface separation", () => {
    const first: CadMeshTriangle = [
      [0, 0, 0],
      [3, 0, 0],
      [0, 3, 0],
    ];
    const second: CadMeshTriangle = [
      [3, 3, 0],
      [3, 2, 0],
      [2, 3, 0],
    ];
    expect(cadSurfaceDistance([first], [second])?.distance).toBeCloseTo(Math.sqrt(2));
  });
  it("matches exhaustive geometry after tree pruning", () => {
    const a = Array.from({ length: 25 }, (_, i) => shift(flat, [i * 5, 0, 0]));
    const b = Array.from({ length: 24 }, (_, i) => shift(flat, [i * 5 + 0.2, 1, i === 17 ? 2 : 4]));
    const expected = Math.min(
      ...a.flatMap((left) => b.map((right) => cadTriangleDistance(left, right).distance)),
    );
    expect(cadSurfaceDistance(a, b)?.distance).toBe(expected);
    expect(cadSurfaceDistance(b, a)?.distance).toBe(expected);
  });
  it("normalizes extreme scales before face projection and rejects unrepresentable ranges", () => {
    for (const scale of [1e100, 1e-100]) {
      const first: CadMeshTriangle = [
        [0, 0, 0],
        [4 * scale, 0, 0],
        [0, 4 * scale, 0],
      ];
      const point: CadMeshTriangle = [
        [scale, scale, 2 * scale],
        [scale, scale, 2 * scale],
        [scale, scale, 2 * scale],
      ];
      expect(cadTriangleDistance(first, point).distance / scale).toBeCloseTo(2);
    }
    const enormous: CadMeshTriangle = [
      [1e308, 0, 0],
      [1e308, 1, 0],
      [1e308, 0, 1],
    ];
    expect(() =>
      cadTriangleDistance(enormous, [
        [-1e308, 0, 0],
        [-1e308, 1, 0],
        [-1e308, 0, 1],
      ]),
    ).toThrow();
  });
  it("returns an established zero minimum without exhausting the remaining search", () => {
    expect(
      cadSurfaceDistance(
        Array.from({ length: 100 }, () => flat),
        Array.from({ length: 100 }, () => flat),
        1,
      )?.distance,
    ).toBe(0);
  });
  it("returns unknown for empty geometry or exhausted work, even with a partial candidate", () => {
    expect(cadSurfaceDistance([], [flat])).toBeNull();
    expect(cadSurfaceDistance([flat], [shift(flat, [0, 0, 2])], 0)).toBeNull();
    expect(
      cadSurfaceDistance(
        Array.from({ length: 100_001 }, () => flat),
        [flat],
      ),
    ).toBeNull();
  });
});
