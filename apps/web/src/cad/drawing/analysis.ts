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

export interface Edge {
  readonly a: number;
  readonly b: number;
  readonly faces: number[];
}

/**
 * A closed loop of crease edges whose vertices lie on one circle, seen along `normal`: a round
 * edge, or the six corners of a hex bore.
 */
export interface CircleLoop {
  /** On a cross hole's rim, the rim point farthest out of the part. */
  readonly center: Vec3;
  readonly normal: Vec3;
  /** Circle radius; through the corners for a hex. */
  readonly radius: number;
  readonly outline: "round" | "hex";
  /** False for a cross hole's rim, which rises and falls with the round surface it enters. */
  readonly planar: boolean;
  readonly edgeKeys: ReadonlySet<number>;
  /** Outward normal of the surface around a hole opening; null when the loop is not an opening. */
  readonly openingNormal: Vec3 | null;
  /** The wall past the opening is a cone (a chamfer or countersink), not the hole itself. */
  readonly conical: boolean;
  /**
   * When the loop edges an outside cylinder (a shaft journal, groove floor, or the bar itself),
   * the side of the loop that cylinder runs to along `normal`: 1 or -1. Otherwise 0.
   */
  readonly shaftSide: number;
  /** The loop edges an inside surface (a hole or bore wall), not the outside of the part. */
  readonly inside: boolean;
  /**
   * Along `normal`, the way the faces off the hole wall point: 1 or -1, 0 when they disagree. At
   * the far end of a hole, a bottom (drill point, flat, step down) points back up the hole; an
   * exit face or a far countersink points on.
   */
  readonly cap: number;
  /**
   * A cone widening from the loop (a chamfer or countersink): the way it points along `normal`,
   * its outer radius, and its included angle.
   */
  readonly flare: { readonly side: number; readonly radius: number; readonly angle: number } | null;
}

export interface Countersink {
  readonly diameter: number;
  /** Included angle in degrees. */
  readonly angle: number;
}

export interface Hole {
  readonly id: string;
  /** Across flats for a hex bore. */
  readonly diameter: number;
  readonly hex: boolean;
  /** Null means the hole runs through the part. */
  readonly depth: number | null;
  /** Countersink at the entry, when the entry cone is more than an edge break. */
  readonly countersink: Countersink | null;
  /** Countersink where a through hole comes out. */
  readonly farCountersink: Countersink | null;
  /** Two walls drilled in one pass on one axis (both walls of a tube, across a bore). */
  readonly bothWalls: boolean;
  readonly entry: Vec3;
  /** Direction the drill travels, into the material. */
  readonly direction: Vec3;
}

export interface HoleGroup {
  readonly key: string;
  readonly diameter: number;
  readonly hex: boolean;
  readonly depth: number | null;
  readonly countersink: Countersink | null;
  readonly farCountersink: Countersink | null;
  readonly bothWalls: boolean;
  readonly holes: readonly Hole[];
  /** Two opposite axial holes on a turned part. */
  readonly bothEnds: boolean;
}

/**
 * A section of a shaft turned smaller than the bar: a journal at an end, or a groove or neck
 * between shoulders. `start` and `end` run along u from the frame's low end.
 */
export interface ShaftStep {
  readonly diameter: number;
  readonly start: number;
  readonly end: number;
}

/** Features the mesh shows but the analysis cannot dimension. Sheets print them as warnings. */
export interface Unresolved {
  /** Hole openings whose bottom or exit was not found, by diameter. */
  readonly holes: readonly { readonly diameter: number; readonly count: number }[];
  /** Closed edges on a shaft's round surface that are not plain holes, usually cross holes. */
  readonly crossFeatures: number;
  /**
   * A round shaft holds less metal than its bar, steps, and holes account for: tapers, fillets,
   * splines, or other sections the drawing does not dimension.
   */
  readonly profile: boolean;
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
  /** Round tube along u, sold by OD and wall. */
  | {
      readonly kind: "roundTube";
      readonly diameter: number;
      readonly wall: number;
      readonly length: number;
    }
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
  /** Turned-down sections; empty unless the part is a shaft. */
  readonly steps: readonly ShaftStep[];
  readonly unresolved: Unresolved;
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

/** analyzePart runs on the main thread; parts with more triangles than this are not analyzed. */
export const MAX_ANALYZED_TRIANGLES = 150_000;

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

  // Hole rims meet their face at about 90°. Coarse holes have few facets, so the facet
  // seams are creases too; following only sharp edges keeps the rim a simple loop.
  const rimKeys = new Set(
    [...creaseKeys].filter((key) => {
      const edge = edgeMap.get(key)!;
      return (
        edge.faces.length === 2 &&
        dot(faceNormal(edge.faces[0]!), faceNormal(edge.faces[1]!)) < 0.34
      );
    }),
  );
  // Shallower rims (a drill point meeting its hole wall, a cross hole's rim at the sides of the
  // shaft) only show up in the plain crease pass.
  const rimPass = findCircles(positions, triangles, edgeMap, rimKeys, faceNormal, vertexCount);
  const creasePass = findCircles(
    positions,
    triangles,
    edgeMap,
    creaseKeys,
    faceNormal,
    vertexCount,
  );
  const circles: CircleLoop[] = [];
  for (const loop of [...rimPass.loops, ...creasePass.loops]) {
    const duplicate = circles.some(
      (other) =>
        Math.abs(other.radius - loop.radius) < loop.radius * 0.005 &&
        length(sub(other.center, loop.center)) < loop.radius * 0.01,
    );
    if (!duplicate) circles.push(loop);
  }

  let frame = partFrame(positions, triangles);
  const diag = Math.hypot(...frame.size);
  const shape = classifyShape(positions, triangles, frame, circles);
  const found = findHoles(circles, frame, diag, positions, triangles);
  let holes = found.holes;
  if (shape.kind === "roundTube") {
    // The bore is the tube's inside, not a hole to drill.
    const bore = shape.diameter - 2 * shape.wall;
    holes = holes.filter(
      (hole) =>
        !(
          hole.depth === null &&
          isAlong(hole.direction, frame.u) &&
          Math.abs(hole.diameter - bore) < bore * 0.005
        ),
    );
  }
  // Round stock looks the same from every side, so turn the frame to look straight down its
  // first cross hole, from the side the drill enters (w points back up the drill).
  const crossHole = holes.find((hole) => Math.abs(dot(hole.direction, frame.u)) < 0.001);
  if ((shape.kind === "turned" || shape.kind === "roundTube") && crossHole) {
    frame = boxFrame(
      positions,
      frame.u,
      snapToAxis(normalize(cross(frame.u, crossHole.direction))),
    );
  }
  const lost = new Map<string, { diameter: number; count: number }>();
  for (const hole of found.lost) {
    const key = (hole.diameter / METERS_PER_INCH).toFixed(3);
    lost.set(key, { diameter: hole.diameter, count: (lost.get(key)?.count ?? 0) + 1 });
  }
  // Closed edges that wander off a plane on round stock are cross holes or flats the hole
  // finder could not read. Both passes can find the same one. A countersink's rim on a round
  // surface is one too, but its hole already prints it.
  const sunk = holes.flatMap((hole) =>
    [hole.countersink, hole.farCountersink].flatMap((sink) =>
      sink ? [{ axis: hole.entry, direction: hole.direction, radius: sink.diameter / 2 }] : [],
    ),
  );
  const strays: Vec3[] = [];
  for (const loop of [
    ...rimPass.nonPlanar,
    ...creasePass.nonPlanar,
    ...circles.filter((loop) => !loop.planar && !found.rims.has(loop)).map((loop) => loop.center),
  ]) {
    const onSink = sunk.some(({ axis, direction, radius }) => {
      const offset = sub(loop, axis);
      return length(sub(offset, scale(direction, dot(offset, direction)))) < radius;
    });
    if (!onSink && !strays.some((other) => length(sub(other, loop)) < diag * 1e-3))
      strays.push(loop);
  }
  const profile = isShaft(shape) ? shaftProfile(positions, frame) : null;
  const steps = isShaft(shape) && profile ? shaftSteps(circles, frame, shape, profile) : [];
  return {
    mesh,
    frame,
    shape,
    holes: groupHoles(holes, shape, frame),
    steps,
    unresolved: {
      holes: [...lost.values()],
      crossFeatures: isShaft(shape) ? strays.length : 0,
      profile:
        profile !== null &&
        profileUnexplained(
          shape,
          steps,
          holes,
          frame,
          meshVolume(positions, triangles),
          circles,
          found.rims,
          profile,
        ),
    },
    triangleCount: faceCount,
    edges: [...edgeMap.values()],
    faceNormals,
    creaseKeys,
    circles,
    diag,
  };
};

const AXES = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const satisfies Record<string, Vec3>;

/** The box around every vertex on axes u, v, and w = u × v. */
const boxFrame = (positions: Float64Array, u: Vec3, v: Vec3): PartFrame => {
  const w = cross(u, v);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length / 3; i++) {
    const p = point(positions, i);
    const values = [dot(p, u), dot(p, v), dot(p, w)];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, values[k]!);
      max[k] = Math.max(max[k]!, values[k]!);
    }
  }
  return { u, v, w, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
};

/** The box on two square directions, reordered so u is the longest extent and w the smallest. */
const sortedFrame = (positions: Float64Array, a: Vec3, b: Vec3): PartFrame => {
  const box = boxFrame(positions, a, b);
  const axes = [box.u, box.v, box.w];
  const order = [0, 1, 2].sort((i, j) => box.size[j]! - box.size[i]!);
  return boxFrame(positions, axes[order[0]!]!, axes[order[1]!]!);
};

const isPartAxis = (n: Vec3) =>
  Object.values(AXES).some((axis) => Math.abs(dot(axis, n)) > 1 - 1e-6);

/** A unit direction within float noise of a part axis becomes that axis exactly. */
const snapToAxis = (n: Vec3): Vec3 =>
  isPartAxis(n) ? [Math.round(n[0]), Math.round(n[1]), Math.round(n[2])] : n;

/**
 * The drawing frame. Most parts are modeled square to their own axes. One modeled at an angle
 * is boxed on its own axes instead, when that box is smaller: along the normals of its largest
 * flat faces (a tube laid on a diagonal), or along the axis of round or hex stock. Cylinder
 * facets are narrow strips, so they never lead the flat faces.
 */
const partFrame = (positions: Float64Array, triangles: Uint32Array): PartFrame => {
  const axes = sortedFrame(positions, AXES.x, AXES.y);
  // Flat area per normal direction; opposite faces share a direction.
  const bins = new Map<string, { area: number; sum: Vec3 }>();
  // Area-weighted spread of the normals, n nᵀ summed.
  const spread = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = point(positions, triangles[t]!);
    const n = cross(
      sub(point(positions, triangles[t + 1]!), a),
      sub(point(positions, triangles[t + 2]!), a),
    );
    const area = length(n) / 2;
    if (area === 0) continue;
    total += area;
    const lead = [0, 1, 2].reduce((best, k) => (Math.abs(n[k]!) > Math.abs(n[best]!) ? k : best));
    const unit = scale(n, (n[lead]! < 0 ? -1 : 1) / (2 * area));
    const key = unit.map((x) => Math.round(x * 1000)).join(",");
    const bin = bins.get(key) ?? { area: 0, sum: [0, 0, 0] };
    bins.set(key, { area: bin.area + area, sum: add(bin.sum, scale(unit, area)) });
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) spread[i * 3 + j]! += area * unit[i]! * unit[j]!;
  }
  const ranked = [...bins.values()].sort((p, q) => q.area - p.area);
  // Side faces square to `a`, largest first.
  const squareTo = (a: Vec3) =>
    ranked
      .map((bin) => ({ n: normalize(bin.sum), area: bin.area }))
      .filter((side) => side.area >= total * 0.02 && Math.abs(dot(side.n, a)) < 0.002);
  // With no side to go by, keep the part axis most square to `a`.
  const across = (a: Vec3, seed: Vec3 | undefined) => {
    const from =
      seed ??
      Object.values(AXES).reduce((best, axis) =>
        Math.abs(dot(axis, a)) < Math.abs(dot(best, a)) ? axis : best,
      );
    return snapToAxis(normalize(sub(from, scale(a, dot(from, a)))));
  };
  const flatFrame = (): PartFrame | null => {
    const first = ranked[0];
    if (!first || first.area < total * 0.1) return null;
    const a = snapToAxis(normalize(first.sum));
    // Side faces square to the first. One along a part axis keeps the part square to its axes.
    // Otherwise a side counts when it is large (a tube's side) or has a side square to it (a
    // rectangle's edges); angled edges in mirrored pairs are styling, not the part's axes.
    const square = squareTo(a);
    const second =
      square.find((side) => isPartAxis(side.n)) ??
      square.find(
        (side) =>
          side.area >= total * 0.1 ||
          square.some((other) => Math.abs(dot(other.n, side.n)) < 0.002),
      );
    return sortedFrame(positions, a, across(a, second?.n));
  };

  // Round and hex stock: the side normals all lie square to the axis and spread evenly around
  // it, so the axis is the one direction the normals barely reach. Hex flats, when present, set
  // the second direction.
  const stockFrame = (): PartFrame | null => {
    const apply = (x: Vec3): Vec3 => [
      spread[0]! * x[0] + spread[1]! * x[1] + spread[2]! * x[2],
      spread[3]! * x[0] + spread[4]! * x[1] + spread[5]! * x[2],
      spread[6]! * x[0] + spread[7]! * x[1] + spread[8]! * x[2],
    ];
    const trace = spread[0]! + spread[4]! + spread[8]!;
    if (trace === 0) return null;
    // Power iteration on (trace I - spread) finds spread's smallest direction.
    let e: Vec3 = normalize([1, 0.37, 0.21]);
    for (let k = 0; k < 100; k++) e = normalize(sub(scale(e, trace), apply(e)));
    const p = across(e, undefined);
    const q = cross(e, p);
    const least = dot(e, apply(e));
    const pp = dot(p, apply(p));
    const qq = dot(q, apply(q));
    const pq = dot(p, apply(q));
    const mean = (pp + qq) / 2;
    const uneven = Math.hypot(pp - qq, 2 * pq);
    if (least > mean * 0.5 || uneven > mean * 0.2) return null;
    const a = snapToAxis(e);
    return sortedFrame(positions, a, across(a, squareTo(a)[0]?.n));
  };

  const volume = (frame: PartFrame) => frame.size[0] * frame.size[1] * frame.size[2];
  const candidates = [flatFrame(), stockFrame()].filter((frame) => frame !== null);
  const best = candidates.reduce(
    (smallest, frame) => (volume(frame) < volume(smallest) ? frame : smallest),
    axes,
  );
  return volume(best) < volume(axes) * 0.995 ? best : axes;
};

/** Enclosed volume of a closed mesh. */
const meshVolume = (positions: Float64Array, triangles: Uint32Array) => {
  let volume = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = point(positions, triangles[t]!);
    volume +=
      dot(a, cross(point(positions, triangles[t + 1]!), point(positions, triangles[t + 2]!))) / 6;
  }
  return Math.abs(volume);
};

/** Where a shaft's vertices sit: distance along u from the low end, and distance from the axis. */
const shaftProfile = (positions: Float64Array, frame: PartFrame) => {
  const cv = (frame.min[1] + frame.max[1]) / 2;
  const cw = (frame.min[2] + frame.max[2]) / 2;
  const count = positions.length / 3;
  const along = new Float64Array(count);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const p = point(positions, i);
    along[i] = dot(p, frame.u) - frame.min[0];
    out[i] = Math.hypot(dot(p, frame.v) - cv, dot(p, frame.w) - cw);
  }
  return {
    at: (loop: CircleLoop) => dot(loop.center, frame.u) - frame.min[0],
    onAxis: (loop: CircleLoop) =>
      isAlong(loop.normal, frame.u) &&
      Math.hypot(dot(loop.center, frame.v) - cv, dot(loop.center, frame.w) - cw) <
        loop.radius * 0.02,
    /**
     * Metal an end chamfer takes off a bar of `radius` at one end (-1 low, 1 high): a frustum
     * from the end face's edge out to where the bar reaches full size. 0 when the end is not a
     * plain cone.
     */
    endLoss: (radius: number, side: number) => {
      let face = 0;
      let reach = Infinity;
      for (let i = 0; i < count; i++) {
        const fromEnd = side < 0 ? along[i]! : frame.size[0] - along[i]!;
        if (fromEnd < 1e-5) face = Math.max(face, out[i]!);
        if (out[i]! > radius * 0.99) reach = Math.min(reach, fromEnd);
      }
      if (!Number.isFinite(reach) || face >= radius) return 0;
      // Only a straight cone: anything sunk below the line from face to bar (a journal, a
      // fillet) is a section the drawing has to show, not an edge break.
      for (let i = 0; i < count; i++) {
        const fromEnd = side < 0 ? along[i]! : frame.size[0] - along[i]!;
        if (fromEnd <= 1e-5 || fromEnd >= reach - 1e-5) continue;
        if (out[i]! < face + ((radius - face) * fromEnd) / reach - radius * 0.02) return 0;
      }
      return (
        Math.PI * reach * (radius * radius - (radius * radius + radius * face + face * face) / 3)
      );
    },
    /** True when metal stands proud of `radius` anywhere past `from` toward `side` (-1 or 1). */
    proudBeyond: (from: number, radius: number, side: number) => {
      for (let i = 0; i < count; i++) {
        if ((along[i]! - from) * side > 1e-5 && out[i]! > radius * 1.01) return true;
      }
      return false;
    },
  };
};

/**
 * True when a shaft's outline has sections the drawing does not dimension: an outside edge away
 * from the ends that no step or hole accounts for (a V-groove, a taper), or round stock missing
 * more than 1.5% of the metal its bar, end chamfers, steps, and holes leave (a filleted
 * shoulder, a spline). Facets cost a round bar under 1%.
 */
const profileUnexplained = (
  shape: Shape,
  steps: readonly ShaftStep[],
  holes: readonly Hole[],
  frame: PartFrame,
  volume: number,
  circles: readonly CircleLoop[],
  rims: ReadonlySet<CircleLoop>,
  profile: ReturnType<typeof shaftProfile>,
) => {
  if (!isShaft(shape)) return false;
  const loose = circles.some((loop) => {
    if (loop.outline !== "round" || !loop.planar || loop.inside || rims.has(loop)) return false;
    if (!profile.onAxis(loop)) return false;
    const at = profile.at(loop);
    return (
      profile.proudBeyond(at, loop.radius, -1) &&
      profile.proudBeyond(at, loop.radius, 1) &&
      !steps.some(
        (step) => Math.abs(step.start - at) < STEP_MATCH || Math.abs(step.end - at) < STEP_MATCH,
      )
    );
  });
  if (loose) return true;
  if (shape.kind === "hex") return false;
  const area = (diameter: number) => (Math.PI * diameter * diameter) / 4;
  const bar =
    area(shape.diameter) * shape.length -
    (shape.kind === "roundTube" ? area(shape.diameter - 2 * shape.wall) * shape.length : 0);
  // Ends a step already reaches are counted by the step.
  const chamfers = [-1, 1]
    .filter((side) => steps.every((step) => (side < 0 ? step.start > 0 : step.end < shape.length)))
    .reduce((sum, side) => sum + profile.endLoss(shape.diameter / 2, side), 0);
  const expected =
    bar -
    chamfers -
    steps.reduce(
      (sum, step) => sum + (area(shape.diameter) - area(step.diameter)) * (step.end - step.start),
      0,
    ) -
    holes.reduce((sum, hole) => {
      // Cross holes run at most across the bar.
      const reach = isAlong(hole.direction, frame.u) ? shape.length : shape.diameter;
      const face = hole.hex ? (Math.sqrt(3) / 2) * hole.diameter ** 2 : area(hole.diameter);
      return sum + face * (hole.depth ?? reach);
    }, 0);
  return volume < expected - bar * 0.015;
};

const classifyShape = (
  positions: Float64Array,
  triangles: Uint32Array,
  frame: PartFrame,
  circles: readonly CircleLoop[],
): Shape => {
  const [su, sv, sw] = frame.size;
  const volume = meshVolume(positions, triangles);
  // Turned about u: square cross-section in (v, w) and no vertex outside the OD. The largest
  // circle square to u is the OD; its fitted centre and radius are exact, where the box
  // midpoint and corner vertices are off by the facets.
  const ends = circles.filter(
    (loop) => loop.outline === "round" && loop.planar && isAlong(loop.normal, frame.u),
  );
  const od = ends.reduce<CircleLoop | null>(
    (best, loop) => (!best || loop.radius > best.radius ? loop : best),
    null,
  );
  const fromAxis = (p: Vec3, center: Vec3) => {
    const d = sub(p, center);
    return length(sub(d, scale(frame.u, dot(d, frame.u))));
  };
  const boxCenter = add(
    scale(frame.v, (frame.min[1] + frame.max[1]) / 2),
    scale(frame.w, (frame.min[2] + frame.max[2]) / 2),
  );
  const farthest = (center: Vec3) => {
    let radius = 0;
    for (let i = 0; i < positions.length / 3; i++) {
      radius = Math.max(radius, fromAxis(point(positions, i), center));
    }
    return radius;
  };
  // Without an OD loop that holds every vertex, fall back to the farthest vertex from the box.
  const fitted = od && farthest(od.center) < od.radius * 1.002 ? od : null;
  const center = fitted?.center ?? boxCenter;
  const radius = fitted?.radius ?? farthest(boxCenter);
  if (Math.abs(sv - sw) / sv < 0.01 && Math.abs(2 * radius - sv) / sv < 0.01) {
    // Mostly empty inside its OD, and the material is all wall around a bore down the axis:
    // round tube, sold by OD and wall. A turned-down or splined shaft is light too, but its
    // volume does not match a wall.
    const bore = ends
      .filter(
        (loop) =>
          loop.openingNormal !== null &&
          loop.radius < radius * 0.98 &&
          fromAxis(loop.center, center) < radius * 0.01,
      )
      .reduce((largest, loop) => Math.max(largest, loop.radius), 0);
    const wall = Math.PI * (radius * radius - bore * bore) * su;
    if (
      bore > 0 &&
      volume < 0.6 * Math.PI * radius * radius * su &&
      Math.abs(volume - wall) < wall * 0.1
    ) {
      return { kind: "roundTube", diameter: 2 * radius, wall: radius - bore, length: su };
    }
    return { kind: "turned", diameter: 2 * radius, length: su };
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
  if (su / sv > 3 && sv > 0.4 * METERS_PER_INCH && volume / (su * sv * sw) < 0.6) {
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
): { loops: CircleLoop[]; nonPlanar: Vec3[] } => {
  // Crease edges only, walked as chains through degree-two vertices.
  const neighbors = new Map<number, number[]>();
  for (const key of creaseKeys) {
    const edge = edgeMap.get(key)!;
    neighbors.set(edge.a, [...(neighbors.get(edge.a) ?? []), edge.b]);
    neighbors.set(edge.b, [...(neighbors.get(edge.b) ?? []), edge.a]);
  }
  const visited = new Set<number>();
  const loops: CircleLoop[] = [];
  // Centroids of closed loops that leave their plane and are not a hole rim.
  const nonPlanar: Vec3[] = [];
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
    // Distances are measured in the loop's plane: a cross hole's rim rises and falls with the
    // shaft it enters, but still lies on the hole's cylinder.
    const inPlane = (p: Vec3) => {
      const d = sub(p, center);
      return sub(d, scale(normal, dot(d, normal)));
    };
    const rise = Math.max(...points.map((p) => Math.abs(dot(sub(p, center), normal))));
    const planar = rise < radius * 0.002;
    const onCircle = points.every((p) => Math.abs(length(inPlane(p)) - radius) < radius * 0.005);
    // Evenly spaced points too: a rounded hex end has every point on one circle, but its flats
    // are long chords between short arc segments.
    const segments = points
      .map((p, k) => length(sub(points[(k + 1) % points.length]!, p)))
      .sort((a, b) => a - b);
    const even = segments.at(-1)! <= 2.5 * segments[Math.floor(segments.length / 2)]!;
    // A polygon is not a tessellated circle: six or fewer sides, or chords that stray more than
    // .01" from the arc. Every six-vertex loop in the FRC parts seen so far is a hex bore; real
    // round edges have 29 or more vertices.
    const span = 2 * Math.asin(Math.min(1, segments.at(-1)! / (2 * radius)));
    const polygon =
      span > (55 * Math.PI) / 180 ||
      (span > (31 * Math.PI) / 180 && radius * (1 - Math.cos(span / 2)) > 0.01 * METERS_PER_INCH);
    const hex = planar && onCircle && chain.length === 6 && segments.at(-1)! < segments[0]! * 1.02;
    const round = onCircle && even && !polygon;
    if ((!hex && !round) || (!planar && rise > radius)) {
      if (!planar) nonPlanar.push(centroid);
      continue;
    }
    const apothem = hex ? radius * Math.cos(Math.PI / 6) : radius;
    const edgeKeys = new Set(chain.map((p, i) => keyOf(p, chain[(i + 1) % chain.length]!)));
    // Read the two faces along each loop edge. An opening has the outside surface on one side,
    // square to the axis (flat, or the round surface a cross hole enters) and outside the loop,
    // and the hole wall on the other, facing the axis. A shaft shoulder or groove floor has the
    // same flat face, but its wall is an outside cylinder facing away from the axis.
    let openings = 0;
    let outward: Vec3 | null = null;
    let slope = 0;
    let shaftEdges = 0;
    let shaftSide = 0;
    let insideEdges = 0;
    let cap = 0;
    let flares = 0;
    let flareSide = 0;
    let flareSlope = 0;
    let flareRadius = 0;
    for (const key of edgeKeys) {
      const edge = edgeMap.get(key)!;
      if (edge.faces.length !== 2) continue;
      const radial = normalize(
        inPlane(scale(add(point(positions, edge.a), point(positions, edge.b)), 0.5)),
      );
      const readFace = (f: number): FaceSide => {
        const n = faceNormal(f);
        const opposite = [0, 1, 2]
          .map((k) => triangles[f * 3 + k]!)
          .find((vertex) => vertex !== edge.a && vertex !== edge.b)!;
        const offset = inPlane(point(positions, opposite));
        return {
          n,
          axial: dot(n, normal),
          facing: dot(n, radial),
          along: dot(sub(point(positions, opposite), center), normal),
          reach: length(offset),
          outside: hex ? dot(offset, radial) > apothem * 1.001 : length(offset) > radius * 1.001,
        };
      };
      const first = readFace(edge.faces[0]!);
      const second = readFace(edge.faces[1]!);
      for (const [surface, wall] of [
        [first, second],
        [second, first],
      ] as const) {
        if (
          Math.abs(surface.axial) >= (planar ? 0.999 : 0.5) &&
          surface.outside &&
          wall.facing < -0.05
        ) {
          openings++;
          slope += Math.abs(wall.axial);
          outward ??= planar ? surface.n : scale(normal, Math.sign(surface.axial));
          break;
        }
      }
      if (first.facing < -0.5 || second.facing < -0.5) insideEdges++;
      const cylinder = [first, second].find((side) => side.facing > 0.95);
      if (cylinder) {
        shaftEdges++;
        shaftSide += Math.sign(cylinder.along);
      }
      // The face off the wall is the one facing most along the axis.
      const off = Math.abs(first.axial) > Math.abs(second.axial) ? first : second;
      if (Math.abs(off.axial) > 0.05) cap += Math.sign(off.axial);
      for (const side of [first, second]) {
        if (side.outside && Math.abs(side.axial) > 0.2 && Math.abs(side.axial) < 0.95) {
          flares++;
          flareSide += Math.sign(side.axial);
          flareSlope += Math.abs(side.axial);
          flareRadius = Math.max(flareRadius, side.reach);
        }
      }
    }
    const openingNormal = openings * 2 >= edgeKeys.size ? outward : null;
    // A cross hole is measured from the rim point farthest out, where the drill first touches.
    const top =
      openingNormal && !planar
        ? Math.max(...points.map((p) => dot(sub(p, center), openingNormal)))
        : 0;
    loops.push({
      center: openingNormal ? add(center, scale(openingNormal, top)) : center,
      normal,
      radius,
      outline: hex ? "hex" : "round",
      planar,
      edgeKeys,
      openingNormal,
      conical: openingNormal !== null && slope / openings > 0.2,
      shaftSide: shaftEdges * 2 >= edgeKeys.size ? Math.sign(shaftSide) : 0,
      inside: insideEdges * 2 >= edgeKeys.size,
      cap: Math.abs(cap) * 2 >= edgeKeys.size ? Math.sign(cap) : 0,
      // A cone at half-angle a has a normal tilted a off the radial plane: |axial| = sin a.
      flare:
        flares * 2 >= edgeKeys.size
          ? {
              side: Math.sign(flareSide),
              radius: flareRadius,
              angle: (2 * Math.asin(flareSlope / flares) * 180) / Math.PI,
            }
          : null,
    });
  }
  return { loops, nonPlanar };
};

/** One face beside a loop edge, read against the loop's axis. */
interface FaceSide {
  readonly n: Vec3;
  /** Normal along the loop axis. */
  readonly axial: number;
  /** Normal along the outward radius at the edge: below zero faces the axis. */
  readonly facing: number;
  /** Where the face's third vertex sits along the loop axis. */
  readonly along: number;
  /** Distance of the face's third vertex from the loop axis. */
  readonly reach: number;
  /** The face's third vertex lies outside the loop. */
  readonly outside: boolean;
}

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

/** Edge breaks up to this radial size are left to the deburr note; larger cones are countersinks. */
const COUNTERSINK_MIN = 0.04 * METERS_PER_INCH;

/** The countersink a cone makes between two radii `depth` apart, or null for an edge break. */
const sinkBetween = (outer: number, inner: number, depth: number): Countersink | null =>
  outer - inner > COUNTERSINK_MIN && depth > 0
    ? { diameter: 2 * outer, angle: (2 * Math.atan((outer - inner) / depth) * 180) / Math.PI }
    : null;

/** True when a ray from `origin` along `direction` leaves the part without touching a face. */
const rayLeaves = (
  positions: Float64Array,
  triangles: Uint32Array,
  origin: Vec3,
  direction: Vec3,
) => {
  // Möller-Trumbore against every triangle; only openings with no loop at their far end get here.
  for (let t = 0; t < triangles.length; t += 3) {
    const a = point(positions, triangles[t]!);
    const ab = sub(point(positions, triangles[t + 1]!), a);
    const ac = sub(point(positions, triangles[t + 2]!), a);
    const p = cross(direction, ac);
    const det = dot(ab, p);
    if (Math.abs(det) < 1e-18) continue;
    const s = sub(origin, a);
    const bu = dot(s, p) / det;
    if (bu < 0 || bu > 1) continue;
    const q = cross(s, ab);
    const bv = dot(direction, q) / det;
    if (bv < 0 || bu + bv > 1) continue;
    if (dot(ac, q) / det > 0) return false;
  }
  return true;
};

/**
 * Holes from opening loops. A hole runs from its opening to the nearest loop of its size on its
 * axis: another opening (through), or its bottom (blind). With no such loop, a hole is through
 * only if its axis leaves the part untouched; otherwise it is `lost`, not guessed. `rims` holds
 * every loop a hole used.
 */
const findHoles = (
  circles: readonly CircleLoop[],
  frame: PartFrame,
  diag: number,
  positions: Float64Array,
  triangles: Uint32Array,
) => {
  const found: Hole[] = [];
  const lost: Hole[] = [];
  const rims = new Set<CircleLoop>();
  // Distance from one loop to another along `direction`, when both sit on one axis.
  const along = (from: CircleLoop, to: CircleLoop, direction: Vec3) => {
    const offset = sub(to.center, from.center);
    const distance = dot(offset, direction);
    const off = length(sub(offset, scale(direction, distance)));
    return off < Math.min(from.radius, to.radius) * 0.01 ? distance : null;
  };
  // Past a chamfer or countersink cone, the hole proper starts at the next smaller loop.
  const innerOf = new Map<CircleLoop, CircleLoop>();
  for (const loop of circles) {
    if (!loop.openingNormal || !loop.conical) continue;
    const direction = scale(loop.openingNormal, -1);
    let best: { loop: CircleLoop; distance: number } | null = null;
    for (const other of circles) {
      if (other.outline !== loop.outline || other.radius > loop.radius * 0.995) continue;
      const distance = along(loop, other, direction);
      if (distance === null || distance <= diag * 1e-4 || distance > loop.radius * 2) continue;
      if (!best || distance < best.distance) best = { loop: other, distance };
    }
    if (best) innerOf.set(loop, best.loop);
  }
  const outerOf = new Map([...innerOf].map(([outer, inner]) => [inner, outer]));
  // Coned openings go first, so a countersunk hole is entered from its countersink.
  for (const entry of [...circles].sort((a, b) => Number(b.conical) - Number(a.conical))) {
    if (!entry.openingNormal || rims.has(entry)) continue;
    const direction = scale(entry.openingNormal, -1);
    const rim = entry.conical ? innerOf.get(entry) : entry;
    const start = rim && rim !== entry ? along(entry, rim, direction)! : 0;
    const size = rim ?? entry;
    const hole: Hole = {
      id: `${found.length + lost.length}`,
      diameter: 2 * size.radius * (size.outline === "hex" ? Math.cos(Math.PI / 6) : 1),
      hex: size.outline === "hex",
      depth: null,
      countersink: rim ? sinkBetween(entry.radius, rim.radius, start) : null,
      farCountersink: null,
      bothWalls: false,
      entry: entry.center,
      direction,
    };
    rims.add(entry);
    if (!rim) {
      lost.push(hole);
      continue;
    }
    rims.add(rim);
    let best: { loop: CircleLoop; distance: number } | null = null;
    for (const other of circles) {
      if (
        other === entry ||
        other === rim ||
        other.outline !== rim.outline ||
        Math.abs(other.radius - rim.radius) > rim.radius * 0.005
      )
        continue;
      const distance = along(entry, other, direction);
      if (distance === null || distance <= start + diag * 1e-4) continue;
      if (!best || distance < best.distance) best = { loop: other, distance };
    }
    if (!best) {
      // Start just inside the rim so faces in the opening's own plane do not count.
      const origin = add(rim.center, scale(direction, diag * 1e-4));
      if (rayLeaves(positions, triangles, origin, direction)) found.push(hole);
      else lost.push(hole);
      continue;
    }
    // A through hole leaves by an opening facing on, or by the inside of its chamfer. An opening
    // facing back means the hole already broke into a void (a bore it crosses) whose edge was
    // not found; that opening starts the next stretch, so it stays free.
    const far = best.loop;
    const leaving = (loop: CircleLoop | undefined) =>
      loop?.openingNormal && dot(loop.openingNormal, direction) > 0 ? loop : null;
    const exit = leaving(far) ?? leaving(outerOf.get(far));
    const brokeOut = far.openingNormal !== null && dot(far.openingNormal, direction) < 0;
    if (exit) rims.add(exit);
    if (!brokeOut) rims.add(far);
    if (exit || brokeOut) {
      const cone = exit && exit !== far ? along(far, exit, direction) : null;
      found.push({
        ...hole,
        farCountersink: exit && cone !== null ? sinkBetween(exit.radius, far.radius, cone) : null,
      });
      continue;
    }
    // The far loop is the bottom only when the faces past it point back up the hole (a drill
    // point, a flat bottom, a step down). A cone widening past it is a countersink on the far
    // side whose outer rim was not found (it lies on a round surface); then the hole is through
    // if its axis leaves the part.
    const onward = Math.sign(dot(far.normal, direction));
    if (far.cap === -onward) {
      found.push({ ...hole, depth: best.distance });
      continue;
    }
    const origin = add(far.center, scale(direction, diag * 1e-4));
    if (!rayLeaves(positions, triangles, origin, direction)) {
      lost.push(hole);
      continue;
    }
    const flare = far.flare?.side === onward ? far.flare : null;
    found.push({
      ...hole,
      farCountersink:
        flare && flare.radius - far.radius > COUNTERSINK_MIN
          ? { diameter: 2 * flare.radius, angle: flare.angle }
          : null,
    });
  }
  // Ignore openings that are really the part outline (a turned part's end faces are not holes).
  const real = (hole: Hole) => hole.diameter < Math.max(...frame.size) * 0.98;
  // Through holes on one axis (both walls of a tube) are one drilling operation.
  const merged: Hole[] = [];
  for (const hole of found.filter(real)) {
    const twin = merged.find((other) => {
      if (
        other.depth !== null ||
        hole.depth !== null ||
        other.hex !== hole.hex ||
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
    if (!twin) {
      merged.push(hole);
      continue;
    }
    // Keep the entry nearest the viewer side of the frame so the callout points at the outer wall.
    const [near, other] =
      dot(hole.entry, hole.direction) < dot(twin.entry, twin.direction)
        ? [hole, twin]
        : [twin, hole];
    merged[merged.indexOf(twin)] = {
      ...near,
      countersink: near.countersink ?? other.countersink,
      farCountersink: near.farCountersink ?? other.farCountersink,
      bothWalls: true,
    };
  }
  return { holes: merged, lost: lost.filter(real), rims };
};

const groupHoles = (holes: readonly Hole[], shape: Shape, frame: PartFrame): HoleGroup[] => {
  const groups = new Map<string, Hole[]>();
  const inches = (meters: number) => (meters / METERS_PER_INCH).toFixed(3);
  const sink = (name: string, countersink: Countersink | null) =>
    countersink ? `|${name}${inches(countersink.diameter)}x${countersink.angle.toFixed(0)}` : "";
  for (const hole of holes) {
    const key = `${hole.hex ? "hex" : ""}${inches(hole.diameter)}|${hole.depth === null ? "thru" : inches(hole.depth)}${hole.bothWalls ? "|2w" : ""}${sink("csk", hole.countersink)}${sink("far", hole.farCountersink)}`;
    groups.set(key, [...(groups.get(key) ?? []), hole]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    diameter: members[0]!.diameter,
    hex: members[0]!.hex,
    depth: members[0]!.depth,
    countersink: members[0]!.countersink,
    farCountersink: members[0]!.farCountersink,
    bothWalls: members[0]!.bothWalls,
    holes: members,
    bothEnds:
      isShaft(shape) &&
      members.length === 2 &&
      dot(members[0]!.direction, members[1]!.direction) < -0.999 &&
      Math.abs(dot(members[0]!.direction, frame.u)) > 0.999,
  }));
};

/** A loop this close to a step's end is that step's edge. */
const STEP_MATCH = 0.001 * METERS_PER_INCH;

/**
 * Turned-down sections of a shaft. Each runs from a loop whose outside cylinder heads up u to
 * the next loop of the same size heading back. When nothing between a section and the bar's
 * end stands proud of it (only an end chamfer), the section runs to that end.
 */
const shaftSteps = (
  circles: readonly CircleLoop[],
  frame: PartFrame,
  shape: Extract<Shape, { kind: "turned" | "hex" | "roundTube" }>,
  profile: ReturnType<typeof shaftProfile>,
): ShaftStep[] => {
  // Round sections on hex stock can be as large as the flats; on round stock, under the OD.
  const limit = shape.kind === "hex" ? frame.size[1] / 2 : shape.diameter / 2;
  const edges = circles
    .filter(
      (loop) =>
        loop.outline === "round" &&
        loop.planar &&
        loop.shaftSide !== 0 &&
        loop.radius < limit * 0.995 &&
        profile.onAxis(loop),
    )
    .map((loop) => ({
      radius: loop.radius,
      at: profile.at(loop),
      heads: loop.shaftSide * Math.sign(dot(loop.normal, frame.u)),
    }))
    .sort((a, b) => a.at - b.at);
  const steps: ShaftStep[] = [];
  for (const edge of edges) {
    if (edge.heads <= 0) continue;
    const end = edges.find(
      (other) =>
        other.at > edge.at &&
        other.heads < 0 &&
        Math.abs(other.radius - edge.radius) < edge.radius * 0.005,
    );
    if (!end) continue;
    steps.push({
      diameter: 2 * edge.radius,
      start: profile.proudBeyond(edge.at, edge.radius, -1) ? edge.at : 0,
      end: profile.proudBeyond(end.at, edge.radius, 1) ? end.at : frame.size[0],
    });
  }
  return steps;
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

// Depth buffer size: a square view gets RASTER pixels a side. A long, thin view spends the same
// pixel count along its length, up to RASTER_MAX_SIDE, so a .0625" wall still spans several
// pixels of depth on a 60" tube.
const RASTER = 1400;
const RASTER_MAX_SIDE = 12000;

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
  const pxPerInch = Math.min(
    (RASTER_MAX_SIDE - pad * 2) / span,
    Math.max(
      (RASTER - pad * 2) / span,
      Math.sqrt((RASTER * RASTER) / ((maxX - minX) * (maxY - minY))),
    ),
  );
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
  // Depth slack of two pixels: enough for the raster's sampling error, small enough that a
  // tube's inner wall (.063" behind its outer face) still reads as hidden on a 60" tube.
  const epsilon = 2 / pxPerInch;
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

  // Flat circles square to the view become true circles instead of polygons. Hex bores and
  // cross hole rims keep their edges.
  const circles: ViewCircle[] = [];
  const replaced = new Set<number>();
  for (const loop of part.circles) {
    if (loop.outline !== "round" || !loop.planar || Math.abs(dot(loop.normal, spec.toward)) < 0.999)
      continue;
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

/** Shafts drawn along their axis: round (turned), hex, and round tube stock. */
export const isShaft = (
  shape: Shape,
): shape is Extract<Shape, { kind: "turned" | "hex" | "roundTube" }> =>
  shape.kind === "turned" || shape.kind === "hex" || shape.kind === "roundTube";
