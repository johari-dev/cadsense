// The 2D features of a plate cut on a router: its outline, and the holes, cutouts, and pockets
// machined from the top face. Read from the part mesh: every flat crease loop is a rim, a pocket
// floor, a bottom exit, or the outline, depending on which side its flat face lies.
import { METERS_PER_INCH, type PartAnalysis, type Vec2 } from "../drawing/analysis";

export type PlateFeature =
  | {
      readonly kind: "hole";
      readonly center: Vec2;
      readonly diameter: number;
      readonly top: number;
      readonly bottom: number;
    }
  | {
      readonly kind: "cutout";
      readonly polygon: readonly Vec2[];
      readonly top: number;
      readonly bottom: number;
    }
  | {
      readonly kind: "pocket";
      readonly polygon: readonly Vec2[];
      readonly top: number;
      readonly floor: number;
    };

/** Plate geometry in inches: x/y from the outline's lower-left corner, z up from the bottom face. */
export interface PlateGeometry {
  readonly thickness: number;
  readonly width: number;
  readonly height: number;
  readonly outline: readonly Vec2[];
  readonly features: readonly PlateFeature[];
  /** Geometry a top-down 2.5D cut cannot make, said in plain words. */
  readonly warnings: readonly string[];
}

interface Loop {
  readonly points: Vec2[];
  readonly z: number;
  readonly area: number;
  readonly centroid: Vec2;
  /** Which flat face borders the loop and on which side: the outline's top face is inside it. */
  readonly role: "outline" | "rim" | "floor" | "exit" | "other";
}

const polygonArea = (points: readonly Vec2[]) => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
};

const pointInPolygon = ([x, y]: Vec2, polygon: readonly Vec2[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Least-squares circle through 2D points, or null when they are not evenly spaced on one. */
const circleOf = (points: readonly Vec2[]) => {
  if (points.length < 6) return null;
  let sx = 0,
    sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const cx = sx / points.length;
  const cy = sy / points.length;
  // Kasa fit about the centroid: x² + y² + Dx + Ey + F = 0.
  let a = 0,
    b = 0,
    c = 0,
    d = 0,
    e = 0,
    f = 0,
    g = 0,
    h = 0;
  for (const [px, py] of points) {
    const x = px - cx;
    const y = py - cy;
    const z = x * x + y * y;
    a += x * x;
    b += x * y;
    c += x;
    d += y * y;
    e += y;
    f += 1;
    g -= z * x;
    h -= z * y;
  }
  const zs = points.reduce((sum, [px, py]) => sum - ((px - cx) ** 2 + (py - cy) ** 2), 0);
  const m = [a, b, c, b, d, e, c, e, f];
  const r = [g, h, zs];
  const det = (k: number[]) =>
    k[0]! * (k[4]! * k[8]! - k[5]! * k[7]!) -
    k[1]! * (k[3]! * k[8]! - k[5]! * k[6]!) +
    k[2]! * (k[3]! * k[7]! - k[4]! * k[6]!);
  const base = det(m);
  if (Math.abs(base) < 1e-18) return null;
  const solve = (col: number) =>
    det(m.map((v, i) => (i % 3 === col ? r[Math.floor(i / 3)]! : v))) / base;
  const D = solve(0),
    E = solve(1),
    F = solve(2);
  const ox = -D / 2,
    oy = -E / 2;
  const radius = Math.sqrt(Math.max(0, ox * ox + oy * oy - F));
  const center: Vec2 = [cx + ox, cy + oy];
  const radii = points.map(([x, y]) => Math.hypot(x - center[0], y - center[1]));
  const steps = points
    .map((p, i) =>
      Math.hypot(
        points[(i + 1) % points.length]![0] - p[0],
        points[(i + 1) % points.length]![1] - p[1],
      ),
    )
    .sort((m1, m2) => m1 - m2);
  const even = steps.at(-1)! <= 2.5 * steps[Math.floor(steps.length / 2)]!;
  return even && radii.every((rr) => Math.abs(rr - radius) < radius * 0.006)
    ? { center, radius }
    : null;
};

/** Plate geometry, or null when the part is not flat enough to be a plate. */
export const plateGeometry = (part: PartAnalysis): PlateGeometry | null => {
  if (part.shape.kind !== "plate") return null;
  const { positions, triangles } = part.mesh;
  const { u, v, w } = part.frame;
  const vertexCount = positions.length / 3;
  const inch = 1 / METERS_PER_INCH;
  const at = (i: number, axis: readonly number[]) =>
    (positions[i * 3]! * axis[0]! +
      positions[i * 3 + 1]! * axis[1]! +
      positions[i * 3 + 2]! * axis[2]!) *
    inch;
  const x0 = part.frame.min[0] * inch,
    y0 = part.frame.min[1] * inch,
    z0 = part.frame.min[2] * inch;
  const xy = (i: number): Vec2 => [at(i, u) - x0, at(i, v) - y0];
  const z = (i: number) => at(i, w) - z0;
  const thickness = part.frame.size[2] * inch;
  const flatTol = 0.0005;
  const normalW = (f: number) =>
    part.faceNormals[f * 3]! * w[0] +
    part.faceNormals[f * 3 + 1]! * w[1] +
    part.faceNormals[f * 3 + 2]! * w[2];

  // Flat creases: both ends at one height. Walked into closed loops.
  const neighbors = new Map<number, number[]>();
  const edgeFaces = new Map<string, number[]>();
  for (const edge of part.edges) {
    if (
      !part.creaseKeys.has(edge.a * vertexCount + edge.b) ||
      Math.abs(z(edge.a) - z(edge.b)) > flatTol
    )
      continue;
    neighbors.set(edge.a, [...(neighbors.get(edge.a) ?? []), edge.b]);
    neighbors.set(edge.b, [...(neighbors.get(edge.b) ?? []), edge.a]);
    edgeFaces.set(`${Math.min(edge.a, edge.b)}:${Math.max(edge.a, edge.b)}`, edge.faces);
  }
  const visited = new Set<number>();
  const loops: Loop[] = [];
  for (const start of neighbors.keys()) {
    if (visited.has(start) || neighbors.get(start)!.length !== 2) continue;
    const chain = [start];
    visited.add(start);
    let previous = start;
    let current = neighbors.get(start)![0]!;
    let closed = false;
    while (true) {
      const next = neighbors.get(current);
      if (!next || next.length !== 2) break;
      if (current === start) {
        closed = true;
        break;
      }
      if (visited.has(current)) break;
      visited.add(current);
      chain.push(current);
      const step = next[0] === previous ? next[1]! : next[0]!;
      previous = current;
      current = step;
    }
    if (!closed || chain.length < 3) continue;
    const points = chain.map(xy);
    const area = polygonArea(points);
    const centroid: Vec2 = [
      points.reduce((s, p) => s + p[0], 0) / points.length,
      points.reduce((s, p) => s + p[1], 0) / points.length,
    ];
    // The flat face on one edge of the loop says what the loop is.
    let role: Loop["role"] = "other";
    const a = chain[0]!,
      b = chain[1]!;
    for (const f of edgeFaces.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? []) {
      const nw = normalW(f);
      if (Math.abs(nw) < 0.999) continue;
      const opposite = [0, 1, 2]
        .map((k) => triangles[f * 3 + k]!)
        .find((vertex) => vertex !== a && vertex !== b)!;
      const inside = pointInPolygon(xy(opposite), points);
      role =
        nw > 0
          ? inside
            ? z(a) > thickness - flatTol
              ? "outline"
              : "floor"
            : "rim"
          : inside
            ? "other"
            : "exit";
    }
    loops.push({ points, z: z(a), area: Math.abs(area), centroid, role });
  }

  const outline = loops
    .filter((loop) => loop.role === "outline")
    .sort((p, q) => q.area - p.area)[0];
  if (!outline) return null;
  const sameShape = (p: Loop, q: Loop) =>
    Math.hypot(p.centroid[0] - q.centroid[0], p.centroid[1] - q.centroid[1]) < 0.003 &&
    Math.abs(p.area - q.area) <= 0.02 * p.area + 1e-6;
  const features: PlateFeature[] = [];
  const warnings: string[] = [];
  for (const rim of loops.filter((loop) => loop.role === "rim")) {
    // The loop below a rim with the same shape ends the feature: an exit means through.
    const end = loops
      .filter((loop) => loop !== rim && loop.z < rim.z - flatTol && sameShape(rim, loop))
      .sort((p, q) => q.z - p.z)[0];
    const through = !end || end.role === "exit" || end.z < flatTol;
    const circle = circleOf(rim.points);
    if (through && circle)
      features.push({
        kind: "hole",
        center: circle.center,
        diameter: 2 * circle.radius,
        top: rim.z,
        bottom: 0,
      });
    else if (through) features.push({ kind: "cutout", polygon: rim.points, top: rim.z, bottom: 0 });
    else features.push({ kind: "pocket", polygon: rim.points, top: rim.z, floor: end.z });
  }
  const bottomOnly = loops.filter(
    (loop) =>
      loop.role === "exit" &&
      !loops.some((other) => other.role === "rim" && sameShape(other, loop)),
  );
  if (bottomOnly.length > 0)
    warnings.push(
      `${bottomOnly.length} feature${bottomOnly.length === 1 ? "" : "s"} open only on the bottom face; flip the plate to cut ${bottomOnly.length === 1 ? "it" : "them"}.`,
    );
  const xs = outline.points.map((p) => p[0]);
  const ys = outline.points.map((p) => p[1]);
  return {
    thickness,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    outline: outline.points,
    features,
    warnings,
  };
};
