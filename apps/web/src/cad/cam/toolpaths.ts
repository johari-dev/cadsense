// A 2.5D router plan for one plate: pockets, then holes and cutouts, then the outside profile
// with tabs. Paths are tool-centre lines in plate inches; Clipper does every offset.
import ClipperLib from "clipper-lib";
import type { Vec2 } from "../drawing/analysis";
import type { PlateFeature, PlateGeometry } from "./plateGeometry";

export interface CamSettings {
  /** End mill diameter, inches. */
  readonly tool: number;
  /** Depth per pass, inches. */
  readonly stepdown: number;
  /** Cutting feed, inches per minute. */
  readonly feed: number;
  readonly plunge: number;
  readonly tabs: number;
}

export const DEFAULT_CAM: CamSettings = {
  tool: 0.125,
  stepdown: 0.04,
  feed: 60,
  plunge: 15,
  tabs: 4,
};

/** Below the plate the profile cuts this far into the spoilboard so it falls free at the tabs. */
const BREAKTHROUGH = 0.01;
const TAB_WIDTH = 0.25;
const TAB_HEIGHT = 0.04;
const STEPOVER = 0.4;
const SCALE = 10_000;

export interface CamOperation {
  readonly kind: "pocket" | "bore" | "cutout" | "profile";
  /** Short operation name and detail for the operations table, e.g. "Bore" and "Ø.210". */
  readonly name: string;
  readonly detail: string;
  /** Features this operation cuts: one per hole for bores, otherwise one. */
  readonly count: number;
  /** Closed tool-centre loops, cut in order, each repeated for every pass. */
  readonly paths: readonly (readonly Vec2[])[];
  readonly depth: number;
  readonly passes: number;
  /** Tab centres along the profile, as points on its path. */
  readonly tabs: readonly Vec2[];
  readonly minutes: number;
}

export interface CamPlan {
  readonly operations: readonly CamOperation[];
  /** Holes the tool cannot mill: drill them by hand. */
  readonly drill: readonly { readonly diameter: number; readonly count: number }[];
  readonly minutes: number;
  readonly warnings: readonly string[];
}

// The region inside `polygon` and outside its `holes`. The outline is positively oriented and the
// holes negatively, so a negative offset always shrinks the region. Round joins trace the arc the
// tool sweeps around outside corners.
const offset = (
  polygon: readonly Vec2[],
  by: number,
  holes: readonly (readonly Vec2[])[] = [],
): Vec2[][] => {
  const toPath = (points: readonly Vec2[], positive: boolean) => {
    const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
    if (ClipperLib.Clipper.Orientation(path) !== positive) path.reverse();
    return path;
  };
  const clipper = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
  clipper.AddPaths(
    [toPath(polygon, true), ...holes.map((hole) => toPath(hole, false))],
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon,
  );
  const out: ClipperLib.Paths = [];
  clipper.Execute(out, by * SCALE);
  return out.map((result) => result.map((p) => [p.X / SCALE, p.Y / SCALE] as Vec2));
};

const pathLength = (path: readonly Vec2[]) =>
  path.reduce(
    (sum, p, i) =>
      sum +
      Math.hypot(path[(i + 1) % path.length]![0] - p[0], path[(i + 1) % path.length]![1] - p[1]),
    0,
  );

const circle = ([cx, cy]: Vec2, radius: number): Vec2[] =>
  Array.from(
    { length: 48 },
    (_, i) =>
      [
        cx + radius * Math.cos((i / 48) * 2 * Math.PI),
        cy + radius * Math.sin((i / 48) * 2 * Math.PI),
      ] as Vec2,
  );

/** Points `count` evenly spaced along a closed path, for tab placement. */
const along = (path: readonly Vec2[], count: number): Vec2[] => {
  const total = pathLength(path);
  const marks = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * total);
  const out: Vec2[] = [];
  let walked = 0;
  for (let i = 0; i < path.length && out.length < marks.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (out.length < marks.length && walked + step >= marks[out.length]!) {
      const t = step === 0 ? 0 : (marks[out.length]! - walked) / step;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    walked += step;
  }
  return out;
};

const minutes = (
  paths: readonly (readonly Vec2[])[],
  passes: number,
  depth: number,
  settings: CamSettings,
) =>
  (paths.reduce((sum, path) => sum + pathLength(path), 0) * passes) / settings.feed +
  (paths.length * passes * (depth / passes)) / settings.plunge;

export const planPlate = (plate: PlateGeometry, settings: CamSettings): CamPlan => {
  const r = settings.tool / 2;
  const passesFor = (depth: number) => Math.max(1, Math.ceil(depth / settings.stepdown - 1e-9));
  const operations: CamOperation[] = [];
  const warnings: string[] = [...plate.warnings];
  const drill = new Map<string, { diameter: number; count: number }>();

  // Pockets first: each clears its floor in rings from the wall inward, around any islands.
  const pockets = plate.features.filter(
    (f): f is Extract<PlateFeature, { kind: "pocket" }> => f.kind === "pocket",
  );
  pockets.forEach((pocket, i) => {
    const rings: Vec2[][] = [];
    for (let inset = r; ; inset += settings.tool * STEPOVER) {
      const ring = offset(pocket.polygon, -inset, pocket.islands);
      if (ring.length === 0) break;
      rings.push(...ring);
      if (rings.length > 400) break;
    }
    const depth = pocket.top - pocket.floor;
    if (rings.length === 0) {
      warnings.push(`Pocket ${i + 1} is narrower than the ${fraction(settings.tool)} tool.`);
      return;
    }
    const passes = passesFor(depth);
    operations.push({
      kind: "pocket",
      name: "Pocket",
      detail: `${fmt(depth)} deep`,
      count: 1,
      paths: rings,
      depth,
      passes,
      tabs: [],
      minutes: minutes(rings, passes, depth, settings),
    });
  });

  // Holes: helical bores when wider than the tool, otherwise a drill list. A bore groups holes of
  // one size and depth; a hole at the bottom of a counterbore is shallower than one from the top.
  const bores = new Map<string, { diameter: number; depth: number; paths: Vec2[][] }>();
  for (const hole of plate.features.filter(
    (f): f is Extract<PlateFeature, { kind: "hole" }> => f.kind === "hole",
  )) {
    if (hole.diameter < settings.tool * 1.1) {
      const key = hole.diameter.toFixed(3);
      const entry = drill.get(key) ?? { diameter: hole.diameter, count: 0 };
      drill.set(key, { ...entry, count: entry.count + 1 });
      continue;
    }
    const depth = hole.top - hole.bottom + BREAKTHROUGH;
    const key = `${hole.diameter.toFixed(3)}|${depth.toFixed(3)}`;
    const entry = bores.get(key) ?? { diameter: hole.diameter, depth, paths: [] };
    entry.paths.push(circle(hole.center, hole.diameter / 2 - r));
    bores.set(key, entry);
  }
  for (const bore of bores.values()) {
    const passes = passesFor(bore.depth);
    operations.push({
      kind: "bore",
      name: "Bore",
      detail: `Ø${fmt(bore.diameter)}`,
      count: bore.paths.length,
      paths: bore.paths,
      depth: bore.depth,
      passes,
      tabs: [],
      minutes: minutes(bore.paths, passes, bore.depth, settings),
    });
  }

  const cutouts = plate.features.filter(
    (f): f is Extract<PlateFeature, { kind: "cutout" }> => f.kind === "cutout",
  );
  cutouts.forEach((cutout, i) => {
    const paths = offset(cutout.polygon, -r);
    const depth = cutout.top - cutout.bottom + BREAKTHROUGH;
    if (paths.length === 0) {
      warnings.push(`Cutout ${i + 1} is narrower than the ${fraction(settings.tool)} tool.`);
      return;
    }
    const passes = passesFor(depth);
    operations.push({
      kind: "cutout",
      name: "Contour",
      detail: cutouts.length > 1 ? `opening ${i + 1}` : "",
      count: 1,
      paths,
      depth,
      passes,
      tabs: [],
      minutes: minutes(paths, passes, depth, settings),
    });
  });

  // The outside profile last, so the plate stays held until everything inside is cut.
  const profile = offset(plate.outline, r);
  const depth = plate.thickness + BREAKTHROUGH;
  const passes = passesFor(depth);
  const main = profile.reduce(
    (best, path) => (pathLength(path) > pathLength(best) ? path : best),
    profile[0] ?? [],
  );
  operations.push({
    kind: "profile",
    name: "Profile",
    detail:
      settings.tabs === 0 ? "no tabs" : `${settings.tabs} tab${settings.tabs === 1 ? "" : "s"}`,
    count: 1,
    paths: profile,
    depth,
    passes,
    tabs: settings.tabs > 0 ? along(main, settings.tabs) : [],
    minutes: minutes(profile, passes, depth, settings),
  });
  if (settings.tabs === 0)
    warnings.push("No tabs: hold the plate down another way before the last pass.");
  return {
    operations,
    drill: [...drill.values()].sort((a, b) => a.diameter - b.diameter),
    minutes: operations.reduce((sum, op) => sum + op.minutes, 0),
    warnings,
  };
};

export const TAB_SIZE = { width: TAB_WIDTH, height: TAB_HEIGHT };

const fmt = (inches: number) => {
  const text = inches.toFixed(3);
  return text.startsWith("0.") ? text.slice(1) : text;
};

export const fraction = (inches: number) => {
  const n = Math.round(inches * 64);
  if (Math.abs(n / 64 - inches) > 0.0005) return `${fmt(inches)}"`;
  let num = n,
    den = 64;
  while (num % 2 === 0 && den > 1) {
    num /= 2;
    den /= 2;
  }
  return den === 1 ? `${num}"` : `${num}/${den}"`;
};
