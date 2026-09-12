import type { CadMeshPoint, CadMeshTriangle } from "./CadMeshGeometry.ts";

type Point = CadMeshPoint;
type Triangle = CadMeshTriangle;
type Pair = { distance: number; points: readonly [Point, Point] };
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const multiply = (a: number, b: number) => {
  const result = a * b;
  if (!Number.isFinite(result) || (result === 0 && a !== 0 && b !== 0))
    throw new Error("CAD distance arithmetic exceeded Float64 range");
  return result;
};
const dot = (a: Point, b: Point) =>
  multiply(a[0], b[0]) + multiply(a[1], b[1]) + multiply(a[2], b[2]);
const cross = (a: Point, b: Point): Point => [
  multiply(a[1], b[2]) - multiply(a[2], b[1]),
  multiply(a[2], b[0]) - multiply(a[0], b[2]),
  multiply(a[0], b[1]) - multiply(a[1], b[0]),
];
const along = (a: Point, direction: Point, t: number): Point => {
  const result: Point = [a[0] + direction[0] * t, a[1] + direction[1] * t, a[2] + direction[2] * t];
  if (result.some((value) => !Number.isFinite(value)))
    throw new Error("CAD distance projection exceeded Float64 range");
  return result;
};
const clamp = (t: number) => Math.max(0, Math.min(1, t));
const pair = (a: Point, b: Point): Pair => ({
  distance: Math.hypot(...sub(a, b)),
  points: [a, b],
});
const edges = (t: Triangle): readonly (readonly [Point, Point])[] => [
  [t[0], t[1]],
  [t[1], t[2]],
  [t[2], t[0]],
];
const pointSegment = (p: Point, a: Point, b: Point) => {
  const direction = sub(b, a);
  const length = dot(direction, direction);
  return along(a, direction, length === 0 ? 0 : clamp(dot(sub(p, a), direction) / length));
};
const inside = (p: Point, t: Triangle, normal: Point) =>
  edges(t).every(([a, b]) => dot(cross(sub(b, a), sub(p, a)), normal) >= 0);

function pointTriangle(p: Point, t: Triangle): Pair {
  let best = pair(p, t[0]);
  for (const [a, b] of edges(t)) {
    const candidate = pair(p, pointSegment(p, a, b));
    if (candidate.distance < best.distance) best = candidate;
  }
  const normal = cross(sub(t[1], t[0]), sub(t[2], t[0]));
  const squared = dot(normal, normal);
  // Collapsed triangles retain their edges and points as geometry.
  if (squared > 0) {
    const projected = along(p, normal, -dot(sub(p, t[0]), normal) / squared);
    if (inside(projected, t, normal)) {
      const candidate = pair(p, projected);
      if (candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
}

function segmentPair(a: Point, b: Point, c: Point, d: Point): Pair {
  const u = sub(b, a),
    v = sub(d, c),
    w = sub(a, c);
  const uu = dot(u, u),
    vv = dot(v, v),
    uv = dot(u, v);
  const uw = dot(u, w),
    vw = dot(v, w);
  if (uu === 0) return pair(a, pointSegment(a, c, d));
  if (vv === 0) return pair(pointSegment(c, a, b), c);
  const determinant = multiply(uu, vv) - multiply(uv, uv);
  let s = determinant > 0 ? clamp((multiply(uv, vw) - multiply(uw, vv)) / determinant) : 0;
  let t = (uv * s + vw) / vv;
  if (t < 0) {
    t = 0;
    s = clamp(-uw / uu);
  } else if (t > 1) {
    t = 1;
    s = clamp((uv - uw) / uu);
  }
  return pair(along(a, u, s), along(c, v, t));
}

function segmentHit(a: Point, b: Point, triangle: Triangle): Point | null {
  const normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]));
  const direction = sub(b, a);
  const denominator = dot(normal, direction);
  if (denominator === 0) return null;
  const t = dot(normal, sub(triangle[0], a)) / denominator;
  if (t < 0 || t > 1) return null;
  const p = along(a, direction, t);
  return inside(p, triangle, normal) ? p : null;
}

/** Vertex-face, edge-edge, and edge-face cases cover disjoint and crossing triangles. */
function triangleDistance(a: Triangle, b: Triangle): Pair {
  let best = pair(a[0], b[0]);
  const consider = (candidate: Pair) => {
    if (candidate.distance < best.distance) best = candidate;
  };
  for (const p of a) consider(pointTriangle(p, b));
  for (const p of b) {
    const candidate = pointTriangle(p, a);
    consider({ distance: candidate.distance, points: [candidate.points[1], candidate.points[0]] });
  }
  for (const [start, end] of edges(a)) {
    const hit = segmentHit(start, end, b);
    if (hit) return pair(hit, hit);
    for (const [otherStart, otherEnd] of edges(b))
      consider(segmentPair(start, end, otherStart, otherEnd));
  }
  for (const [start, end] of edges(b)) {
    const hit = segmentHit(start, end, a);
    if (hit) return pair(hit, hit);
  }
  return best;
}

/** Rebase and scale each pair before products to avoid overflow on large or tiny CAD units. */
export function cadTriangleDistance(a: Triangle, b: Triangle): Pair {
  const origin = a[0];
  const offsets = [...a, ...b].map((p) => sub(p, origin));
  const scale = Math.max(...offsets.flatMap((p) => p.map(Math.abs)));
  if (!Number.isFinite(scale)) throw new Error("CAD distance coordinates exceeded Float64 range");
  if (scale === 0) return pair(a[0], b[0]);
  const normalized = offsets.map((p): Point => [p[0] / scale, p[1] / scale, p[2] / scale]);
  for (let i = 0; i < offsets.length; i++)
    for (const axis of [0, 1, 2] as const)
      if (offsets[i]![axis] !== 0 && normalized[i]![axis] === 0)
        throw new Error("CAD distance normalization exceeded Float64 range");
  const result = triangleDistance(
    [normalized[0]!, normalized[1]!, normalized[2]!],
    [normalized[3]!, normalized[4]!, normalized[5]!],
  );
  const restore = (p: Point): Point => [
    origin[0] + p[0] * scale,
    origin[1] + p[1] * scale,
    origin[2] + p[2] * scale,
  ];
  const distance = multiply(result.distance, scale);
  const points = [restore(result.points[0]), restore(result.points[1])] as const;
  if (points.some((p) => p.some((value) => !Number.isFinite(value))))
    throw new Error("CAD distance witnesses exceeded Float64 range");
  return { distance, points };
}

type Bounds = { min: Point; max: Point };
type Tree = Bounds & ({ triangles: readonly Triangle[] } | { children: readonly [Tree, Tree] });
function tree(triangles: readonly Triangle[]): Tree {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles)
    for (const point of triangle)
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
  if (triangles.length <= 8) return { min, max, triangles };
  let axis: 0 | 1 | 2 = 0;
  if (max[1] - min[1] > max[axis] - min[axis]) axis = 1;
  if (max[2] - min[2] > max[axis] - min[axis]) axis = 2;
  const center = (t: Triangle) => t[0][axis] + t[1][axis] + t[2][axis];
  const sorted = [...triangles].sort((a, b) => center(a) - center(b));
  const middle = Math.floor(sorted.length / 2);
  return { min, max, children: [tree(sorted.slice(0, middle)), tree(sorted.slice(middle))] };
}
const boundsDistance = (a: Bounds, b: Bounds) =>
  Math.hypot(
    ...([0, 1, 2] as const).map((axis) =>
      Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]),
    ),
  );
export const CAD_DISTANCE_LIMITS = { trianglesPerPart: 100_000, comparisons: 250_000 } as const;

/** Boxes only prune triangle work. A box distance is never returned as a measurement. */
export function cadSurfaceDistance(
  a: readonly Triangle[],
  b: readonly Triangle[],
  comparisonBudget: number = CAD_DISTANCE_LIMITS.comparisons,
): Pair | null {
  if (
    comparisonBudget < 1 ||
    !a.length ||
    !b.length ||
    a.length > CAD_DISTANCE_LIMITS.trianglesPerPart ||
    b.length > CAD_DISTANCE_LIMITS.trianglesPerPart
  )
    return null;
  let best = cadTriangleDistance(a[0]!, b[0]!);
  if (best.distance === 0) return best;
  let remaining = comparisonBudget - 1;
  const pending: (readonly [Tree, Tree])[] = [[tree(a), tree(b)]];
  while (pending.length > 0) {
    if (--remaining < 0) return null;
    const [left, right] = pending.pop()!;
    if (boundsDistance(left, right) >= best.distance) continue;
    if ("triangles" in left && "triangles" in right) {
      for (const first of left.triangles)
        for (const second of right.triangles) {
          if (--remaining < 0) return null;
          const candidate = cadTriangleDistance(first, second);
          if (candidate.distance < best.distance) best = candidate;
          if (best.distance === 0) return best;
        }
    } else {
      const pairs: (readonly [Tree, Tree])[] =
        "children" in left
          ? left.children.map((child) => [child, right] as const)
          : "children" in right
            ? right.children.map((child) => [left, child] as const)
            : [];
      pairs.sort((x, y) => boundsDistance(y[0], y[1]) - boundsDistance(x[0], x[1]));
      pending.push(...pairs);
    }
  }
  return best;
}
