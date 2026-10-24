// Turns one part's triangle mesh into drawing views and manufacturing features. Onshape puts
// mesh vertices on the true surface, so sizes and hole diameters are exact for the model; the
// mesh has no thread or tolerance data, so tap sizes are read from hole diameters.

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

export const METERS_PER_INCH = 0.0254;

/** One welded, indexed triangle mesh in part coordinates (meters). */
export interface PartMesh {
  readonly positions: Float64Array;
  readonly triangles: Uint32Array;
}

interface Edge {
  readonly a: number;
  readonly b: number;
  readonly faces: number[];
}

/** A closed loop of crease edges whose vertices lie on one circle. */
export interface CircleLoop {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly edgeKeys: ReadonlySet<number>;
  /** Outward normal of the flat face around a hole opening; null when the loop is not an opening. */
  readonly openingNormal: Vec3 | null;
}

export interface Hole {
  readonly id: string;
  readonly diameter: number;
  /** Null means the hole runs through the part. */
  readonly depth: number | null;
  readonly entry: Vec3;
  /** Direction the drill travels, into the material. */
  readonly direction: Vec3;
}

export interface HoleGroup {
  readonly key: string;
  readonly diameter: number;
  readonly depth: number | null;
  readonly holes: readonly Hole[];
  /** Two opposite axial holes on a turned part. */
  readonly bothEnds: boolean;
}

/** The drawing frame: u is the longest extent, w the smallest, (u, v, w) right-handed. */
export interface PartFrame {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly w: Vec3;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Extents along u, v, w in meters. */
  readonly size: Vec3;
}

export type Shape =
  | { readonly kind: "turned"; readonly diameter: number; readonly length: number }
  /** Hex shaft along u; `flats` is the across-flats size the stock is sold by. */
  | { readonly kind: "hex"; readonly flats: number; readonly length: number }
  | { readonly kind: "plate"; readonly thickness: number }
  | {
      readonly kind: "tube";
      readonly width: number;
      readonly height: number;
      readonly length: number;
    }
  | { readonly kind: "block" };

export interface PartAnalysis {
  readonly mesh: PartMesh;
  readonly frame: PartFrame;
  readonly shape: Shape;
  readonly holes: readonly HoleGroup[];
  readonly triangleCount: number;
  readonly edges: readonly Edge[];
  readonly faceNormals: Float64Array;
  readonly creaseKeys: ReadonlySet<number>;
  readonly circles: readonly CircleLoop[];
  readonly diag: number;
}

const point = (positions: Float64Array, index: number): Vec3 => [
  positions[index * 3]!,
  positions[index * 3 + 1]!,
  positions[index * 3 + 2]!,
];

/** Merges duplicate vertices so faces share edges. Onshape splits vertices per face. */
export const weldMesh = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
): PartMesh => {
  const lookup = new Map<string, number>();
  const welded: number[] = [];
  const remap = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    const key = `${Math.round(x * 1e7)},${Math.round(y * 1e7)},${Math.round(z * 1e7)}`;
    let target = lookup.get(key);
    if (target === undefined) {
      target = welded.length / 3;
      lookup.set(key, target);
      welded.push(x, y, z);
    }
    remap[i] = target;
  }
  const count = indices ? indices.length : positions.length / 3;
  const triangles: number[] = [];
  for (let t = 0; t < count; t += 3) {
    const a = remap[indices ? indices[t]! : t]!;
    const b = remap[indices ? indices[t + 1]! : t + 1]!;
    const c = remap[indices ? indices[t + 2]! : t + 2]!;
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { positions: Float64Array.from(welded), triangles: Uint32Array.from(triangles) };
};

const CREASE_COS = Math.cos((25 * Math.PI) / 180);

export const analyzePart = (mesh: PartMesh): PartAnalysis => {
  const { positions, triangles } = mesh;
  const vertexCount = positions.length / 3;
  const faceCount = triangles.length / 3;
  const faceNormals = new Float64Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const a = point(positions, triangles[f * 3]!);
    const n = normalize(
      cross(
        sub(point(positions, triangles[f * 3 + 1]!), a),
        sub(point(positions, triangles[f * 3 + 2]!), a),
      ),
    );
    faceNormals.set(n, f * 3);
  }
  const faceNormal = (f: number): Vec3 => [
    faceNormals[f * 3]!,
    faceNormals[f * 3 + 1]!,
    faceNormals[f * 3 + 2]!,
  ];

  const edgeMap = new Map<number, Edge>();
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const p = triangles[f * 3 + k]!;
      const q = triangles[f * 3 + ((k + 1) % 3)]!;
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = a * vertexCount + b;
      const edge = edgeMap.get(key);
      if (edge) edge.faces.push(f);
      else edgeMap.set(key, { a, b, faces: [f] });
    }
  }
  const creaseKeys = new Set<number>();
  for (const [key, edge] of edgeMap) {
    if (
      edge.faces.length !== 2 ||
      dot(faceNormal(edge.faces[0]!), faceNormal(edge.faces[1]!)) < CREASE_COS
    ) {
      creaseKeys.add(key);
    }
  }

  // Bounding box in part axes. Onshape parts are almost always modeled square to their axes.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i * 3 + k]!);
      max[k] = Math.max(max[k]!, positions[i * 3 + k]!);
    }
  }
  const extents = [0, 1, 2].map((k) => max[k]! - min[k]!);
  const order = [0, 1, 2].sort((a, b) => extents[b]! - extents[a]!);
  const axis = (k: number): Vec3 => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  const u = axis(order[0]!);
  const v = axis(order[1]!);
  const w = cross(u, v);
  const corners = [min, max] as const;
  const project = (n: Vec3) => {
    const values = corners.flatMap((x) =>
      corners.flatMap((y) => corners.map((z) => dot([x[0], y[1], z[2]], n))),
    );
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const [u0, u1] = project(u);
  const [v0, v1] = project(v);
  const [w0, w1] = project(w);
  const frame: PartFrame = {
    u,
    v,
    w,
    min: [u0, v0, w0],
    max: [u1, v1, w1],
    size: [u1 - u0, v1 - v0, w1 - w0],
  };
  const diag = Math.hypot(...frame.size);

  const shape = classifyShape(positions, triangles, frame);
  // Hole rims meet their face at about 90°. Coarse holes have only 6-8 facets, so the
  // facet seams are creases too; following only sharp edges keeps the rim a simple loop.
  const rimKeys = new Set(
    [...creaseKeys].filter((key) => {
      const edge = edgeMap.get(key)!;
      return (
        edge.faces.length === 2 &&
        dot(faceNormal(edge.faces[0]!), faceNormal(edge.faces[1]!)) < 0.34
      );
    }),
  );
  // Shallower rims (a drill point meeting its hole wall) only show up in the plain crease pass.
  const circles: CircleLoop[] = [];
  for (const loop of [
    ...findCircles(positions, triangles, edgeMap, rimKeys, faceNormal, vertexCount),
    ...findCircles(positions, triangles, edgeMap, creaseKeys, faceNormal, vertexCount),
  ]) {
    const duplicate = circles.some(
      (other) =>
        Math.abs(other.radius - loop.radius) < loop.radius * 0.005 &&
        length(sub(other.center, loop.center)) < loop.radius * 0.01,
    );
    if (!duplicate) circles.push(loop);
  }
  const holes = groupHoles(findHoles(circles, frame, diag), shape, frame);
  return {
    mesh,
    frame,
    shape,
    holes,
    triangleCount: faceCount,
    edges: [...edgeMap.values()],
    faceNormals,
    creaseKeys,
    circles,
    diag,
  };
};

const classifyShape = (
  positions: Float64Array,
  triangles: Uint32Array,
  frame: PartFrame,
): Shape => {
  const [su, sv, sw] = frame.size;
  // Turned about u: square cross-section in (v, w) and no vertex outside the inscribed circle.
  const cv = (frame.min[1] + frame.max[1]) / 2;
  const cw = (frame.min[2] + frame.max[2]) / 2;
  let maxRadius = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = point(positions, i);
    maxRadius = Math.max(maxRadius, Math.hypot(dot(p, frame.v) - cv, dot(p, frame.w) - cw));
  }
  if (Math.abs(sv - sw) / sv < 0.01 && Math.abs(2 * maxRadius - sv) / sv < 0.01) {
    return { kind: "turned", diameter: 2 * maxRadius, length: su };
  }
  // Hex shaft along u: the side area concentrates on six flats 60° apart. Rounded hex leaves a
  // good share on its corners, so the flats need half the side area and all six must be present
  // (a rectangular bar also concentrates its sides, but on four directions).
  if (su / sv > 1.5 && sv / sw > 1.03 && sv / sw < 1.2) {
    const bins = new Float64Array(360);
    let side = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const a = point(positions, triangles[t]!);
      const n = cross(
        sub(point(positions, triangles[t + 1]!), a),
        sub(point(positions, triangles[t + 2]!), a),
      );
      const area = length(n) / 2;
      if (area === 0 || Math.abs(dot(n, frame.u)) / (2 * area) > 0.05) continue;
      const angle = (Math.atan2(dot(n, frame.w), dot(n, frame.v)) * 180) / Math.PI;
      bins[Math.floor(((angle % 360) + 360) % 360)]! += area;
      side += area;
    }
    const around = (degree: number) =>
      bins[(degree + 359) % 360]! + bins[degree % 360]! + bins[(degree + 1) % 360]!;
    for (let offset = 0; offset < 60 && side > 0; offset++) {
      const flats = [0, 1, 2, 3, 4, 5].map((k) => around(offset + 60 * k) / side);
      if (
        flats.every((share) => share > 0.04) &&
        flats.reduce((sum, share) => sum + share, 0) > 0.5
      )
        return { kind: "hex", flats: sw, length: su };
    }
  }
  // A disc is turned about w instead; draw it as a plate with a round outline.
  if (sw < 0.5 * METERS_PER_INCH && sw / sv < 0.25) return { kind: "plate", thickness: sw };
  // Box tube: long, and mostly empty inside its bounding box.
  let volume = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = point(positions, triangles[t]!);
    volume +=
      dot(a, cross(point(positions, triangles[t + 1]!), point(positions, triangles[t + 2]!))) / 6;
  }
  if (su / sv > 3 && sv > 0.4 * METERS_PER_INCH && Math.abs(volume) / (su * sv * sw) < 0.6) {
    return { kind: "tube", width: sv, height: sw, length: su };
  }
  return { kind: "block" };
};

const findCircles = (
  positions: Float64Array,
  triangles: Uint32Array,
  edgeMap: Map<number, Edge>,
  creaseKeys: ReadonlySet<number>,
  faceNormal: (f: number) => Vec3,
  vertexCount: number,
): CircleLoop[] => {
  // Crease edges only, walked as chains through degree-two vertices.
  const neighbors = new Map<number, number[]>();
  for (const key of creaseKeys) {
    const edge = edgeMap.get(key)!;
    neighbors.set(edge.a, [...(neighbors.get(edge.a) ?? []), edge.b]);
    neighbors.set(edge.b, [...(neighbors.get(edge.b) ?? []), edge.a]);
  }
  const visited = new Set<number>();
  const loops: CircleLoop[] = [];
  const keyOf = (p: number, q: number) => Math.min(p, q) * vertexCount + Math.max(p, q);
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
    if (!closed || chain.length < 6) continue;
    const points = chain.map((i) => point(positions, i));
    const centroid = scale(points.reduce(add, [0, 0, 0]), 1 / points.length);
    let newell: Vec3 = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      newell = add(newell, [
        (a[1] - b[1]) * (a[2] + b[2]),
        (a[2] - b[2]) * (a[0] + b[0]),
        (a[0] - b[0]) * (a[1] + b[1]),
      ]);
    }
    const normal = normalize(newell);
    // Vertices are unevenly spaced around a rim, so fit the circle instead of averaging.
    const fit = fitCircle(points, centroid, normal);
    if (!fit) continue;
    const { center, radius } = fit;
    const radii = points.map((p) => length(sub(p, center)));
    const flat = points.every((p) => Math.abs(dot(sub(p, center), normal)) < radius * 0.002);
    // Evenly spaced points too: a rounded hex end has every point on one circle, but its flats
    // are long chords between short arc segments.
    const segments = points
      .map((p, k) => length(sub(points[(k + 1) % points.length]!, p)))
      .sort((a, b) => a - b);
    const even = segments.at(-1)! <= 2.5 * segments[Math.floor(segments.length / 2)]!;
    const round = even && radii.every((r) => Math.abs(r - radius) < radius * 0.005);
    if (!flat || !round) continue;
    const edgeKeys = new Set(chain.map((p, i) => keyOf(p, chain[(i + 1) % chain.length]!)));
    // An opening has a flat face, square to the loop, lying outside the circle.
    let openingNormal: Vec3 | null = null;
    for (const key of edgeKeys) {
      const edge = edgeMap.get(key)!;
      for (const f of edge.faces) {
        const n = faceNormal(f);
        if (Math.abs(dot(n, normal)) < 0.999) continue;
        const opposite = [0, 1, 2]
          .map((k) => triangles[f * 3 + k]!)
          .find((vertex) => vertex !== edge.a && vertex !== edge.b)!;
        const offset = sub(point(positions, opposite), center);
        const radial = length(sub(offset, scale(normal, dot(offset, normal))));
        if (radial > radius * 1.001) openingNormal = n;
      }
      if (openingNormal) break;
    }
    loops.push({ center, normal, radius, edgeKeys, openingNormal });
  }
  return loops;
};

/** Least-squares (Kasa) circle fit in the loop's plane. */
const fitCircle = (points: readonly Vec3[], origin: Vec3, normal: Vec3) => {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ex = normalize(cross(normal, seed));
  const ey = cross(normal, ex);
  // Normal equations for x² + y² + Dx + Ey + F = 0.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (const p of points) {
    const d = sub(p, origin);
    const x = dot(d, ex);
    const y = dot(d, ey);
    const row = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let i = 0; i < 3; i++) {
      r[i]! += row[i]! * rhs;
      for (let j = 0; j < 3; j++) m[i * 3 + j]! += row[i]! * row[j]!;
    }
  }
  const det = (a: number[]) =>
    a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) -
    a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) +
    a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
  const base = det(m);
  if (Math.abs(base) < 1e-30) return null;
  const solve = (column: number) =>
    det(m.map((value, index) => (index % 3 === column ? r[Math.floor(index / 3)]! : value))) / base;
  const D = solve(0);
  const E = solve(1);
  const F = solve(2);
  const cx = -D / 2;
  const cy = -E / 2;
  const radius = Math.sqrt(Math.max(0, cx * cx + cy * cy - F));
  return { center: add(origin, add(scale(ex, cx), scale(ey, cy))), radius };
};

const findHoles = (circles: readonly CircleLoop[], frame: PartFrame, diag: number): Hole[] => {
  const holes: Hole[] = [];
  const used = new Set<CircleLoop>();
  for (const entry of circles) {
    if (!entry.openingNormal || used.has(entry)) continue;
    const direction = scale(entry.openingNormal, -1);
    // The nearest loop of the same radius on the same axis, inside the material, ends the hole.
    let best: { loop: CircleLoop; distance: number } | null = null;
    for (const other of circles) {
      if (other === entry || Math.abs(other.radius - entry.radius) > entry.radius * 0.005) continue;
      const offset = sub(other.center, entry.center);
      const along = dot(offset, direction);
      const off = length(sub(offset, scale(direction, along)));
      if (along <= diag * 1e-4 || off > entry.radius * 0.01) continue;
      if (!best || along < best.distance) best = { loop: other, distance: along };
    }
    used.add(entry);
    const through = best?.loop.openingNormal != null;
    if (best && through) used.add(best.loop);
    holes.push({
      id: `${holes.length}`,
      diameter: entry.radius * 2,
      depth: through ? null : (best?.distance ?? null),
      entry: entry.center,
      direction,
    });
  }
  // Ignore openings that are really the part outline (a turned part's end faces are not holes).
  const real = holes.filter((hole) => hole.diameter < Math.max(...frame.size) * 0.98);
  // Through holes on one axis (both walls of a tube) are one drilling operation.
  const merged: Hole[] = [];
  for (const hole of real) {
    const twin = merged.find((other) => {
      if (
        other.depth !== null ||
        hole.depth !== null ||
        Math.abs(other.diameter - hole.diameter) > hole.diameter * 0.005
      )
        return false;
      if (Math.abs(dot(other.direction, hole.direction)) < 0.999) return false;
      const offset = sub(hole.entry, other.entry);
      return (
        length(sub(offset, scale(other.direction, dot(offset, other.direction)))) <
        hole.diameter * 0.01
      );
    });
    if (!twin) merged.push(hole);
    // Keep the entry nearest the viewer side of the frame so the callout points at the outer wall.
    else if (dot(hole.entry, hole.direction) < dot(twin.entry, twin.direction))
      merged[merged.indexOf(twin)] = hole;
  }
  return merged;
};

const groupHoles = (holes: readonly Hole[], shape: Shape, frame: PartFrame): HoleGroup[] => {
  const groups = new Map<string, Hole[]>();
  for (const hole of holes) {
    const key = `${(hole.diameter / METERS_PER_INCH).toFixed(3)}|${hole.depth === null ? "thru" : (hole.depth / METERS_PER_INCH).toFixed(3)}`;
    groups.set(key, [...(groups.get(key) ?? []), hole]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    diameter: members[0]!.diameter,
    depth: members[0]!.depth,
    holes: members,
    bothEnds:
      (shape.kind === "turned" || shape.kind === "hex") &&
      members.length === 2 &&
      dot(members[0]!.direction, members[1]!.direction) < -0.999 &&
      Math.abs(dot(members[0]!.direction, frame.u)) > 0.999,
  }));
};

// ---------------------------------------------------------------------------
// Views

export interface ViewSpec {
  readonly name: "front" | "top" | "right" | "iso";
  readonly right: Vec3;
  readonly up: Vec3;
  /** Points from the scene toward the viewer. */
  readonly toward: Vec3;
}

export const viewSpecs = (frame: PartFrame): Record<ViewSpec["name"], ViewSpec> => {
  const { u, v, w } = frame;
  const isoToward = normalize(add(add(u, v), w));
  const isoUp = normalize(sub(v, scale(isoToward, dot(v, isoToward))));
  return {
    front: { name: "front", right: u, up: v, toward: w },
    top: { name: "top", right: u, up: scale(w, -1), toward: v },
    right: { name: "right", right: scale(w, -1), up: v, toward: u },
    iso: { name: "iso", right: cross(isoUp, isoToward), up: isoUp, toward: isoToward },
  };
};

export interface ViewSegment {
  readonly from: Vec2;
  readonly to: Vec2;
}

export interface ViewCircle {
  readonly center: Vec2;
  readonly radius: number;
  readonly hidden: boolean;
}

/** A projected view in inches, with y up. */
export interface DrawingView {
  readonly spec: ViewSpec;
  readonly visible: readonly ViewSegment[];
  readonly hidden: readonly ViewSegment[];
  readonly circles: readonly ViewCircle[];
  readonly min: Vec2;
  readonly max: Vec2;
}

const RASTER = 1400;

/** Hidden-line projection: crease and silhouette edges, tested against a software depth buffer. */
export const projectView = (part: PartAnalysis, spec: ViewSpec): DrawingView => {
  const { positions, triangles } = part.mesh;
  const vertexCount = positions.length / 3;
  const toInch = 1 / METERS_PER_INCH;
  const sx = new Float64Array(vertexCount);
  const sy = new Float64Array(vertexCount);
  const sz = new Float64Array(vertexCount);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const p = point(positions, i);
    sx[i] = dot(p, spec.right) * toInch;
    sy[i] = dot(p, spec.up) * toInch;
    // Larger depth is farther from the viewer.
    sz[i] = -dot(p, spec.toward) * toInch;
    minX = Math.min(minX, sx[i]!);
    maxX = Math.max(maxX, sx[i]!);
    minY = Math.min(minY, sy[i]!);
    maxY = Math.max(maxY, sy[i]!);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 4;
  const pxPerInch = (RASTER - pad * 2) / span;
  const width = Math.ceil((maxX - minX) * pxPerInch) + pad * 2 + 1;
  const height = Math.ceil((maxY - minY) * pxPerInch) + pad * 2 + 1;
  const toPx = (x: number) => (x - minX) * pxPerInch + pad;
  const toPy = (y: number) => (maxY - y) * pxPerInch + pad;
  const depth = new Float32Array(width * height).fill(Infinity);
  for (let f = 0; f < triangles.length / 3; f++) {
    const a = triangles[f * 3]!;
    const b = triangles[f * 3 + 1]!;
    const c = triangles[f * 3 + 2]!;
    const ax = toPx(sx[a]!),
      ay = toPy(sy[a]!);
    const bx = toPx(sx[b]!),
      by = toPy(sy[b]!);
    const cx = toPx(sx[c]!),
      cy = toPy(sy[c]!);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
        const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * sz[a]! + w1 * sz[b]! + w2 * sz[c]!;
        const index = y * width + x;
        if (z < depth[index]!) depth[index] = z;
      }
    }
  }
  const epsilon = span * 0.004;
  const visibleAt = (x: number, y: number, z: number) => {
    const px = Math.round(toPx(x));
    const py = Math.round(toPy(y));
    let farthest = -Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) return true;
        farthest = Math.max(farthest, depth[qy * width + qx]!);
      }
    }
    return z <= farthest + epsilon;
  };

  // Circles square to the view become true circles instead of polygons.
  const circles: ViewCircle[] = [];
  const replaced = new Set<number>();
  for (const loop of part.circles) {
    if (Math.abs(dot(loop.normal, spec.toward)) < 0.999) continue;
    for (const key of loop.edgeKeys) replaced.add(key);
    const cx = dot(loop.center, spec.right) * toInch;
    const cy = dot(loop.center, spec.up) * toInch;
    const cz = -dot(loop.center, spec.toward) * toInch;
    const r = loop.radius * toInch;
    let seen = 0;
    for (let k = 0; k < 48; k++) {
      const angle = (k / 48) * Math.PI * 2;
      if (visibleAt(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, cz)) seen++;
    }
    circles.push({ center: [cx, cy], radius: r, hidden: seen < 24 });
  }

  const visible: ViewSegment[] = [];
  const hiddenRaw: ViewSegment[] = [];
  const faceFront = (f: number) =>
    part.faceNormals[f * 3]! * spec.toward[0] +
      part.faceNormals[f * 3 + 1]! * spec.toward[1] +
      part.faceNormals[f * 3 + 2]! * spec.toward[2] >
    1e-6;
  for (const edge of part.edges) {
    const key = edge.a * vertexCount + edge.b;
    if (replaced.has(key)) continue;
    const crease = part.creaseKeys.has(key);
    const silhouette =
      edge.faces.length === 2 && faceFront(edge.faces[0]!) !== faceFront(edge.faces[1]!);
    if (!crease && !silhouette) continue;
    const ax = sx[edge.a]!,
      ay = sy[edge.a]!,
      az = sz[edge.a]!;
    const bx = sx[edge.b]!,
      by = sy[edge.b]!,
      bz = sz[edge.b]!;
    const pixels = Math.hypot(bx - ax, by - ay) * pxPerInch;
    if (pixels < 0.05) continue;
    const samples = Math.max(2, Math.ceil(pixels / 1.5));
    let runStart = 0;
    let runVisible = visibleAt(ax, ay, az);
    const emit = (t0: number, t1: number, isVisible: boolean) => {
      const segment: ViewSegment = {
        from: [ax + (bx - ax) * t0, ay + (by - ay) * t0],
        to: [ax + (bx - ax) * t1, ay + (by - ay) * t1],
      };
      (isVisible ? visible : hiddenRaw).push(segment);
    };
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      const isVisible = visibleAt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      if (isVisible !== runVisible) {
        emit(runStart, t, runVisible);
        runStart = t;
        runVisible = isVisible;
      }
    }
    emit(runStart, 1, runVisible);
  }

  // Visible lines win where a hidden line projects onto them.
  const mask = new Uint8Array(width * height);
  const stamp = (x: number, y: number) => {
    const px = Math.round(toPx(x));
    const py = Math.round(toPy(y));
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx >= 0 && qy >= 0 && qx < width && qy < height) mask[qy * width + qx] = 1;
      }
  };
  for (const segment of visible) {
    const steps = Math.max(
      1,
      Math.ceil(
        Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]) * pxPerInch,
      ),
    );
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(
        segment.from[0] + (segment.to[0] - segment.from[0]) * t,
        segment.from[1] + (segment.to[1] - segment.from[1]) * t,
      );
    }
  }
  for (const circle of circles.filter((c) => !c.hidden)) {
    for (let k = 0; k < 360; k++) {
      const angle = (k / 360) * Math.PI * 2;
      stamp(
        circle.center[0] + Math.cos(angle) * circle.radius,
        circle.center[1] + Math.sin(angle) * circle.radius,
      );
    }
  }
  const covered = (x: number, y: number) =>
    mask[Math.round(toPy(y)) * width + Math.round(toPx(x))] === 1;
  const hidden = hiddenRaw.filter((segment) => {
    const mid: Vec2 = [
      (segment.from[0] + segment.to[0]) / 2,
      (segment.from[1] + segment.to[1]) / 2,
    ];
    return !(covered(...segment.from) && covered(...segment.to) && covered(...mid));
  });
  // A through hole leaves one loop per face; both project onto the same circle.
  const keptCircles: ViewCircle[] = [];
  for (const circle of circles) {
    const twin = keptCircles.findIndex(
      (other) =>
        Math.abs(other.radius - circle.radius) < 1e-4 &&
        Math.hypot(other.center[0] - circle.center[0], other.center[1] - circle.center[1]) < 1e-4,
    );
    if (twin === -1) keptCircles.push(circle);
    else if (!circle.hidden) keptCircles[twin] = circle;
  }

  return {
    spec,
    visible: mergeSegments(visible),
    hidden: mergeSegments(hidden),
    circles: keptCircles,
    min: [minX, minY],
    max: [maxX, maxY],
  };
};

/** Joins collinear segments that touch, so dashes run continuously along a line. */
const mergeSegments = (segments: readonly ViewSegment[]): ViewSegment[] => {
  const byLine = new Map<string, { dir: Vec2; origin: Vec2; spans: [number, number][] }>();
  for (const segment of segments) {
    let dx = segment.to[0] - segment.from[0];
    let dy = segment.to[1] - segment.from[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    dx /= len;
    dy /= len;
    if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dy < 0)) {
      dx = -dx;
      dy = -dy;
    }
    // Line key: direction and signed offset from origin.
    const offset = segment.from[0] * -dy + segment.from[1] * dx;
    const key = `${dx.toFixed(4)},${dy.toFixed(4)},${offset.toFixed(4)}`;
    const line = byLine.get(key) ?? {
      dir: [dx, dy] as Vec2,
      origin: [-dy * offset, dx * offset] as Vec2,
      spans: [],
    };
    const t0 = segment.from[0] * dx + segment.from[1] * dy;
    const t1 = segment.to[0] * dx + segment.to[1] * dy;
    line.spans.push([Math.min(t0, t1), Math.max(t0, t1)]);
    byLine.set(key, line);
  }
  const merged: ViewSegment[] = [];
  for (const { dir, origin, spans } of byLine.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = spans[0]!;
    const flush = () =>
      merged.push({
        from: [origin[0] + dir[0] * start, origin[1] + dir[1] * start],
        to: [origin[0] + dir[0] * end, origin[1] + dir[1] * end],
      });
    for (const [s, e] of spans.slice(1)) {
      if (s <= end + 1e-4) end = Math.max(end, e);
      else {
        flush();
        start = s;
        end = e;
      }
    }
    flush();
  }
  return merged;
};

/** Where a part-space point lands in a view, in inches. */
export const projectPoint = (spec: ViewSpec, p: Vec3): Vec2 => [
  dot(p, spec.right) / METERS_PER_INCH,
  dot(p, spec.up) / METERS_PER_INCH,
];

export const isAlong = (a: Vec3, b: Vec3) => Math.abs(dot(a, b)) > 0.999;

/** Shafts drawn along their axis: round (turned) and hex stock. */
export const isShaft = (shape: Shape): shape is Extract<Shape, { kind: "turned" | "hex" }> =>
  shape.kind === "turned" || shape.kind === "hex";
