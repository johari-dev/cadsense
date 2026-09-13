import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
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
  it.effect.each([
    { length: 1, rise: 1e-9 },
    { length: 1e8, rise: 0.1 },
  ])(
    "detects crossing collapsed triangles with near-parallel edges at $length meters",
    ({ length, rise }) =>
      Effect.gen(function* () {
        const first: CadMeshTriangle = [
          [0, 0, 0],
          [length, rise, 0],
          [length, rise, 0],
        ];
        const second: CadMeshTriangle = [
          [0, rise, 0],
          [length, 0, 0],
          [length, 0, 0],
        ];
        const result = cadTriangleDistance(first, second);
        expect(result.distance).toBe(0);
        expect(result.points).toEqual([
          [length / 2, rise / 2, 0],
          [length / 2, rise / 2, 0],
        ]);
        expect((yield* cadSurfaceDistance([first], [second]))?.distance).toBe(0);
      }),
  );

  it("keeps near-parallel closest points on finite segments and preserves a skew gap", () => {
    const first: CadMeshTriangle = [
      [0, 0, 0],
      [1, 1e-9, 0],
      [1, 1e-9, 0],
    ];
    const beyond: CadMeshTriangle = [
      [2, 1e-9, 0],
      [3, 0, 0],
      [3, 0, 0],
    ];
    expect(cadTriangleDistance(first, beyond).distance).toBeCloseTo(1, 12);
    const skew: CadMeshTriangle = [
      [0, 1e-9, 0.25],
      [1, 0, 0.25],
      [1, 0, 0.25],
    ];
    expect(cadTriangleDistance(first, skew).distance).toBe(0.25);
  });

  it.effect("does not return an overlapping box as zero surface separation", () =>
    Effect.gen(function* () {
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
      expect((yield* cadSurfaceDistance([first], [second]))?.distance).toBeCloseTo(Math.sqrt(2));
    }),
  );
  it.effect("matches exhaustive geometry after tree pruning", () =>
    Effect.gen(function* () {
      const a = Array.from({ length: 25 }, (_, i) => shift(flat, [i * 5, 0, 0]));
      const b = Array.from({ length: 24 }, (_, i) =>
        shift(flat, [i * 5 + 0.2, 1, i === 17 ? 2 : 4]),
      );
      const expected = Math.min(
        ...a.flatMap((left) => b.map((right) => cadTriangleDistance(left, right).distance)),
      );
      expect((yield* cadSurfaceDistance(a, b))?.distance).toBe(expected);
      expect((yield* cadSurfaceDistance(b, a))?.distance).toBe(expected);
    }),
  );
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
  it.effect("returns an established zero minimum without exhausting the remaining search", () =>
    Effect.gen(function* () {
      expect(
        (yield* cadSurfaceDistance(
          Array.from({ length: 100 }, () => flat),
          Array.from({ length: 100 }, () => flat),
          1,
        ))?.distance,
      ).toBe(0);
    }),
  );
  it.effect(
    "returns unknown for empty geometry or exhausted work, even with a partial candidate",
    () =>
      Effect.gen(function* () {
        expect(yield* cadSurfaceDistance([], [flat])).toBeNull();
        expect(yield* cadSurfaceDistance([flat], [shift(flat, [0, 0, 2])], 0)).toBeNull();
        expect(
          yield* cadSurfaceDistance(
            Array.from({ length: 100_001 }, () => flat),
            [flat],
          ),
        ).toBeNull();
      }),
  );
});

it.live.each([500, 100_000])(
  "allows event-loop callbacks to interrupt a %i-triangle surface search",
  (count) =>
    Effect.gen(function* () {
      const a: CadMeshTriangle = [
        [0, 0, 0],
        [3, 0, 0],
        [0, 3, 0],
      ];
      const b: CadMeshTriangle = [
        [3, 3, 0],
        [3, 2, 0],
        [2, 3, 0],
      ];
      let completed = false;
      const fiber = yield* Effect.forkScoped(
        cadSurfaceDistance(
          Array.from({ length: count }, () => a),
          Array.from({ length: count }, () => b),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
      );
      yield* Effect.sleep("1 millis");
      expect(completed).toBe(false);
      yield* Fiber.interrupt(fiber);
      expect(completed).toBe(false);
    }),
);

it.effect("discards a partial minimum when a nonzero search exhausts its budget", () =>
  Effect.gen(function* () {
    const a: CadMeshTriangle = [
      [0, 0, 0],
      [3, 0, 0],
      [0, 3, 0],
    ];
    const b: CadMeshTriangle = [
      [3, 3, 0],
      [3, 2, 0],
      [2, 3, 0],
    ];
    expect(
      yield* cadSurfaceDistance(
        Array.from({ length: 500 }, () => a),
        Array.from({ length: 500 }, () => b),
        600,
      ),
    ).toBeNull();
  }),
);

it.effect("matches exhaustive distance after sorting and merging a large tree", () =>
  Effect.gen(function* () {
    const a = Array.from({ length: 600 }, (_, i) => shift(flat, [((i * 277) % 601) * 5, 0, 0]));
    const b = shift(flat, [1370.2, 1, 2]);
    const expected = Math.min(...a.map((left) => cadTriangleDistance(left, b).distance));
    expect((yield* cadSurfaceDistance(a, [b]))?.distance).toBe(expected);
  }),
);
