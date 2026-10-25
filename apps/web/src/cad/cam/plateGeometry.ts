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
      /** Bosses standing up from the floor; the tool clears around them. */
      readonly islands: readonly (readonly Vec2[])[];
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
  /**
   * Which flat face borders the loop and on which side: the outline's top face is inside it, and
   * the base is the bottom face's edge. A rim's wall goes down from it, an island's goes up. A
   * ceiling faces down above the base: the top of a recess cut from the bottom.
   */
  readonly role: "outline" | "base" | "rim" | "island" | "floor" | "ceiling" | "exit" | "other";
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
  // A hex or other coarse polygon also has its corners on one circle; a real hole's facets sit
  // within a hundredth of the arc.
  const sagitta = radius * (1 - Math.cos(Math.PI / points.length));
  return even && sagitta < 0.01 && radii.every((rr) => Math.abs(rr - radius) < radius * 0.006)
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
    if (Math.abs(area) < 1e-9) continue;
    // Area centroid: a vertex average shifts when the top and bottom of a hole are faceted
    // differently, and the two would no longer match.
    let cx = 0,
      cy = 0;
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[(i + 1) % points.length]!;
      const cross = x0 * y1 - x1 * y0;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    const centroid: Vec2 = [cx / (6 * area), cy / (6 * area)];
    // The flat face on one edge of the loop says what the loop is, and the wall on the same edge
    // whether it rises or falls. The face's centroid, not a corner that may sit on the loop, says
    // which side the face is on.
    let role: Loop["role"] = "other";
    let wallRises = false;
    const a = chain[0]!,
      b = chain[1]!;
    for (const f of edgeFaces.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? []) {
      const corners = [0, 1, 2].map((k) => triangles[f * 3 + k]!);
      const nw = normalW(f);
      if (Math.abs(nw) < 0.999) {
        const far = corners.find((vertex) => vertex !== a && vertex !== b)!;
        wallRises = z(far) > z(a) + flatTol;
        continue;
      }
      const tri = corners.map(xy);
      const inside = pointInPolygon(
        [(tri[0]![0] + tri[1]![0] + tri[2]![0]) / 3, (tri[0]![1] + tri[1]![1] + tri[2]![1]) / 3],
        points,
      );
      role =
        nw > 0
          ? inside
            ? z(a) > thickness - flatTol
              ? "outline"
              : "floor"
            : "rim"
          : inside
            ? z(a) < flatTol
              ? "base"
              : "ceiling"
            : "exit";
    }
    if (role === "rim" && wallRises) role = "island";
    loops.push({ points, z: z(a), area: Math.abs(area), centroid, role });
  }

  // The profile follows the top face's edge or, when an edge is chamfered or rounded, the larger
  // bottom one. Anything else that changes the outline through the thickness (a step, an ear, a
  // boss, two bodies) is not a plate a top-down cut can make.
  const byArea = (role: Loop["role"]) =>
    loops.filter((loop) => loop.role === role).sort((p, q) => q.area - p.area);
  const tops = byArea("outline");
  const top = tops[0];
  const base = byArea("base")[0];
  if (!top || (tops[1] && tops[1].area > 0.5 * top.area)) return null;
  // A floor outside the top face is a step or ledge at the edge, which the profile can't make.
  if (loops.some((loop) => loop.role === "floor" && !pointInPolygon(loop.centroid, top.points)))
    return null;
  const span = (loop: Loop) => {
    const xs = loop.points.map((p) => p[0]);
    const ys = loop.points.map((p) => p[1]);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] as const;
  };
  const outline = base && base.area > top.area ? base : top;
  const [width, height] = span(outline);
  const [topWidth, topHeight] = span(top);
  if (
    Math.abs(width - part.frame.size[0] * inch) > 0.01 ||
    Math.abs(height - part.frame.size[1] * inch) > 0.01 ||
    width - topWidth > 0.06 ||
    height - topHeight > 0.06
  )
    return null;
  const sameShape = (p: Loop, q: Loop) =>
    Math.hypot(p.centroid[0] - q.centroid[0], p.centroid[1] - q.centroid[1]) < 0.003 &&
    Math.abs(p.area - q.area) <= 0.02 * p.area + 1e-6;
  const features: PlateFeature[] = [];
  const warnings: string[] = [];
  if (outline !== top)
    warnings.push("The top edge is chamfered or rounded; the profile cuts the bottom edge square.");
  const islands = loops.filter((loop) => loop.role === "island");
  for (const rim of loops.filter(
    (loop) => loop.role === "rim" && pointInPolygon(loop.centroid, outline.points),
  )) {
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
    else
      features.push({
        kind: "pocket",
        polygon: rim.points,
        islands: islands
          .filter(
            (island) =>
              Math.abs(island.z - end.z) < flatTol && pointInPolygon(island.centroid, rim.points),
          )
          .map((island) => island.points),
        top: rim.z,
        floor: end.z,
      });
  }
  const bottomOnly = loops.filter(
    (loop) =>
      loop.role === "ceiling" ||
      (loop.role === "exit" &&
        !loops.some((other) => other.role === "rim" && sameShape(other, loop))),
  );
  if (bottomOnly.length > 0)
    warnings.push(
      `${bottomOnly.length} feature${bottomOnly.length === 1 ? "" : "s"} open only on the bottom face; flip the plate to cut ${bottomOnly.length === 1 ? "it" : "them"}.`,
    );
  return {
    thickness,
    width,
    height,
    outline: outline.points,
    features,
    warnings,
  };
};
