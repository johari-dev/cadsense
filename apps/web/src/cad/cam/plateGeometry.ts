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
  // A hex or other coarse polygon also has its corners on one circle. A real hole's facets sit
  // within a few thousandths of the arc; only small holes, which are drilled, are coarser.
  const sagitta = radius * (1 - Math.cos(Math.PI / points.length));
  const fine = sagitta < 0.004 || (radius < 0.0625 && sagitta < 0.01);
  return even && fine && radii.every((rr) => Math.abs(rr - radius) < radius * 0.006)
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

  const span = (loop: Loop) => {
    const xs = loop.points.map((p) => p[0]);
    const ys = loop.points.map((p) => p[1]);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] as const;
  };
  const sameShape = (p: Loop, q: Loop) =>
    Math.hypot(p.centroid[0] - q.centroid[0], p.centroid[1] - q.centroid[1]) < 0.003 &&
    Math.abs(p.area - q.area) <= 0.02 * p.area + 1e-6;
  // A loop inside another: any vertex will do, since crease loops do not cross.
  const within = (inner: Loop, outer: Loop) => pointInPolygon(inner.points[0]!, outer.points);
  const islands = loops.filter((loop) => loop.role === "island");
  const isIslandTop = (loop: Loop) => islands.some((island) => sameShape(island, loop));

  // The top face, not counting the tops of islands standing up through a groove or pocket.
  const tops = loops
    .filter((loop) => loop.role === "outline" && !isIslandTop(loop))
    .sort((p, q) => q.area - p.area);
  const top = tops[0];
  if (!top || (tops[1] && tops[1].area > 0.5 * top.area)) return null;
  // A floor that reaches outside the top face is a step or ledge at the edge, which the profile
  // can't make.
  if (
    loops.some(
      (loop) =>
        loop.role === "floor" &&
        !isIslandTop(loop) &&
        loop.points.some((point) => !pointInPolygon(point, top.points)),
    )
  )
    return null;
  // The profile follows the widest loop around the part, which is the top edge unless an edge is
  // chamfered or rounded. A larger change through the thickness (a step, an ear, a boss) is not
  // a plate a top-down cut can make.
  const frameWidth = part.frame.size[0] * inch;
  const frameHeight = part.frame.size[1] * inch;
  const outline = loops
    .filter((loop) => {
      const [w0, h0] = span(loop);
      return Math.abs(w0 - frameWidth) < 0.01 && Math.abs(h0 - frameHeight) < 0.01;
    })
    .sort((p, q) => q.area - p.area)[0];
  if (!outline) return null;
  const [width, height] = span(outline);
  const [topWidth, topHeight] = span(top);
  if (width - topWidth > 0.13 || height - topHeight > 0.13) return null;

  const features: PlateFeature[] = [];
  const warnings: string[] = [];
  if (width - topWidth > 0.002 || height - topHeight > 0.002)
    warnings.push("The edges are chamfered or rounded; the profile cuts them square.");
  let edgeBreaks = 0;
  for (const rim of loops.filter((loop) => loop.role === "rim" && within(loop, outline))) {
    // The loop below a rim with the same shape ends the feature. A chamfer or countersink makes
    // the rim wider than the wall, so failing that the highest floor or exit inside it does, and
    // the feature takes that loop's shape. No loop below means it goes through.
    const below = loops.filter(
      (loop) =>
        loop !== rim &&
        loop.z < rim.z - flatTol &&
        (loop.role === "floor" || loop.role === "exit") &&
        !isIslandTop(loop),
    );
    const matching = below.filter((loop) => sameShape(rim, loop));
    const narrower = below.filter((loop) => loop.area < rim.area && within(loop, rim));
    const end = (matching.length > 0 ? matching : narrower).sort((p, q) => q.z - p.z)[0];
    const wall = end && !sameShape(rim, end) ? end : rim;
    if (wall !== rim) edgeBreaks++;
    const through = !end || end.role === "exit" || end.z < flatTol;
    const circle = circleOf(wall.points);
    if (through && circle)
      features.push({
        kind: "hole",
        center: circle.center,
        diameter: 2 * circle.radius,
        top: rim.z,
        bottom: 0,
      });
    else if (through)
      features.push({ kind: "cutout", polygon: wall.points, top: rim.z, bottom: 0 });
    else {
      const own = islands.filter(
        (island) => Math.abs(island.z - end.z) < flatTol && within(island, wall),
      );
      // A boss whose top sits below the plate's top face is left standing full height.
      const low = own.filter((island) =>
        loops.some(
          (loop) => loop.role === "floor" && sameShape(island, loop) && loop.z < rim.z - flatTol,
        ),
      );
      if (low.length > 0)
        warnings.push(
          `${low.length} boss${low.length === 1 ? "" : "es"} in a pocket ${low.length === 1 ? "stands" : "stand"} lower than the top face; face ${low.length === 1 ? "it" : "them"} down by hand.`,
        );
      features.push({
        kind: "pocket",
        polygon: wall.points,
        islands: own.map((island) => island.points),
        top: rim.z,
        floor: end.z,
      });
    }
  }
  if (edgeBreaks > 0)
    warnings.push(
      `${edgeBreaks} hole or pocket edge${edgeBreaks === 1 ? " is" : "s are"} chamfered or countersunk; the plan cuts ${edgeBreaks === 1 ? "it" : "them"} square.`,
    );
  // A recess cut from the bottom shows as a ceiling; an exit no rim reaches is a hole from below.
  const ceilings = loops.filter((loop) => loop.role === "ceiling");
  const bottomOnly =
    ceilings.length +
    loops.filter(
      (loop) =>
        loop.role === "exit" &&
        !loops.some(
          (other) =>
            (other.role === "rim" && (sameShape(other, loop) || within(loop, other))) ||
            (other.role === "ceiling" && sameShape(other, loop)),
        ),
    ).length;
  if (bottomOnly > 0)
    warnings.push(
      `${bottomOnly} feature${bottomOnly === 1 ? "" : "s"} open only on the bottom face; flip the plate to cut ${bottomOnly === 1 ? "it" : "them"}.`,
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
