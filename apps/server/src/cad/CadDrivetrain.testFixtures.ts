import type { CadTriangleMesh, PartOccurrence } from "./CadChecks.ts";
import {
  analyzeCadDrivetrain,
  fitCadAxis,
  recognizeDrivetrainParts,
  rotatingCollisions,
} from "./CadDrivetrain.ts";

// Synthetic FRC parts for drivetrain tests: meshes in meters, placed by inch coordinates.

export const INCH = 0.0254;
export type Vector3 = readonly [number, number, number];
export interface Mesh {
  readonly positions: number[];
  readonly indices: number[];
}

/** Closed cylinder along local z, centered on the origin. */
export const cylinder = (radius: number, length: number, segments = 24): Mesh => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const z of [-length / 2, length / 2])
    for (let i = 0; i < segments; i++) {
      const angle = (2 * Math.PI * i) / segments;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
  positions.push(0, 0, -length / 2, 0, 0, length / 2);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const n = segments;
    indices.push(i, j, n + j, i, n + j, n + i, 2 * n, j, i, 2 * n + 1, n + i, n + j);
  }
  return { positions, indices };
};
export const box = ([x0, y0, z0]: Vector3, [x1, y1, z1]: Vector3): Mesh => ({
  positions: [
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ],
  indices: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ],
});
/** A flat belt loop around two pulleys `centers` apart, in the local xy plane. */
export const beltLoop = (
  centers: number,
  radius: number | readonly [number, number],
  width: number,
  segments = 24,
): Mesh => {
  // One radius for both ends, or [the end at -x, the end at +x].
  const [low, high] = typeof radius === "number" ? [radius, radius] : radius;
  const line: [number, number][] = [];
  for (const [cx, start, radius] of [
    [centers / 2, -Math.PI / 2, high],
    [-centers / 2, Math.PI / 2, low],
  ] as const)
    for (let i = 0; i <= segments; i++) {
      const angle = start + (Math.PI * i) / segments;
      line.push([cx + radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
  const positions = line.flatMap(([x, y]) => [x, y, -width / 2, x, y, width / 2]);
  const indices = line.flatMap((_, i) => {
    const a = 2 * i;
    const b = 2 * ((i + 1) % line.length);
    return [a, b, b + 1, a, b + 1, a + 1];
  });
  return { positions, indices };
};
export const merge = (...parts: Mesh[]): Mesh => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions);
    indices.push(...part.indices.map((index) => index + base));
  }
  return { positions, indices };
};
export const toMesh = ({ positions, indices }: Mesh): CadTriangleMesh => ({
  positions: Float64Array.from(positions),
  indices: Uint32Array.from(indices),
});
/** Row-major transform that turns local z onto a world axis, then moves to `at` (inches). */
export const along = (axis: "x" | "y" | "z", [x, y, z]: Vector3) => {
  const [tx, ty, tz] = [x * INCH, y * INCH, z * INCH];
  return axis === "z"
    ? [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]
    : axis === "y"
      ? [1, 0, 0, tx, 0, 0, 1, ty, 0, -1, 0, tz, 0, 0, 0, 1]
      : [0, 0, 1, tx, 0, 1, 0, ty, -1, 0, 0, tz, 0, 0, 0, 1];
};

/** A scene of named parts. `analyze` runs recognition and analysis the way cad_checks does. */
export const scene = () => {
  const occurrences: PartOccurrence[] = [];
  const meshes = new Map<string, CadTriangleMesh | null>();
  let next = 0;
  const id = () => (++next).toString(16).padStart(64, "0");
  const add = (name: string, mesh: Mesh, transform: number[]) => {
    const geometryKey = id();
    const occurrenceId = id();
    meshes.set(geometryKey, toMesh(mesh));
    occurrences.push({ occurrenceId, name, geometryKey, transform });
    return occurrenceId;
  };
  return {
    add,
    analyze: () => analyzeCadDrivetrain(recognizeDrivetrainParts(occurrences, meshes)),
    /** Collisions among the given overlapping pairs, as cad_checks would pass them. */
    collisions: (pairs: ReadonlyArray<readonly [string, string]>, withinSubassembly = false) => {
      const parts = recognizeDrivetrainParts(occurrences, meshes);
      const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
      return rotatingCollisions(
        parts,
        pairs.map(([a, b]) => ({
          occurrences: [a, b].map((occurrenceId) => {
            const occurrence = byId.get(occurrenceId)!;
            const mesh = meshes.get(occurrence.geometryKey);
            return {
              occurrenceId,
              name: occurrence.name,
              fit: mesh ? fitCadAxis(mesh, occurrence.transform) : null,
            };
          }) as [OverlapSide, OverlapSide],
          volume: 1e-7,
          withinSubassembly,
        })),
      );
    },
  };
};
export type OverlapSide = Parameters<typeof rotatingCollisions>[1][number]["occurrences"][number];
