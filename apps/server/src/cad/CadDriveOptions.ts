/**
 * cad_drive_options: stock FRC gears, belts, and chain that reach a target reduction, sized to the
 * center distance between two parts in the CAD when the agent names them. See CadDriveOptions.md.
 */
import {
  CAD_DRIVE_FAMILIES,
  CAD_DRIVE_MOTORS,
  CadDriveOptionsInput,
  CadViewError,
  type CadDriveFamily,
  type CadDriveMotor,
  type CadDriveOption,
  type CadDriveOptionsResult,
  type CadDriveStage,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { partOccurrences, type CadTriangleMesh } from "./CadChecks.ts";
import {
  MESH_TOO_CLOSE,
  MESH_TOO_FAR,
  PARALLEL,
  dot,
  fitCadAxis,
  lineDistance,
  loopLengthFits,
  loopLengthNeededMm,
  norm,
  recognizeDrivetrainParts,
  scale,
  sub,
  type CadAxis,
} from "./CadDrivetrain.ts";
import type { DriveCatalog } from "./CadDriveCatalog.ts";
import { decodeCadToolInput } from "./CadViewState.ts";

type Vector3 = readonly [number, number, number];

interface Listing {
  readonly teeth: number;
  readonly vendor: string;
  readonly sku: string | null;
  readonly url: string;
}
interface WheelListing extends Listing {
  readonly bore: string | null;
}
interface BeltListing extends Listing {
  readonly widthMm: number | null;
}

/** Free speeds from ReCalc's motor data. */
export const DRIVE_MOTOR_FREE_RPM: Record<CadDriveMotor, number> = {
  "Kraken X60": 6065,
  "Kraken X60 (FOC)": 5784,
  "Kraken X44": 7757,
  "Kraken X44 (FOC)": 7367,
  "NEO Vortex": 6825,
  "NEO 2.0": 5906,
  NEO: 5906,
  "NEO 550": 11710,
  "Falcon 500": 6380,
  "Falcon 500 (FOC)": 6080,
  Minion: 7703,
  "Thrifty Pulsar": 7500,
  CIM: 5330,
  MiniCIM: 5840,
  "775pro": 18730,
  BAG: 13180,
};
// More specific names first: "NEO 550" before "NEO", "MiniCIM" before "CIM".
const MOTOR_NAMES: ReadonlyArray<readonly [RegExp, CadDriveMotor]> = [
  [/\bneo\s*550\b/i, "NEO 550"],
  [/\bvortex\b/i, "NEO Vortex"],
  [/\bneo\s*2(\.0)?\b/i, "NEO 2.0"],
  [/\bneo\b/i, "NEO"],
  [/\bkraken\s*x?44\b/i, "Kraken X44"],
  [/\bkraken\b/i, "Kraken X60"],
  [/\bfalcon\b/i, "Falcon 500"],
  [/\bminion\b/i, "Minion"],
  [/\bpulsar\b/i, "Thrifty Pulsar"],
  [/\bmini\s*cim\b/i, "MiniCIM"],
  [/\bcim\b/i, "CIM"],
  [/\b775/i, "775pro"],
  [/\bbag\b/i, "BAG"],
];
/** The motor a CAD part name names, or null. */
export const driveMotorFromName = (name: string): CadDriveMotor | null =>
  MOTOR_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? null;

const INCH = 0.0254;
// FRC practice sets gears 0.003 in past their exact spacing.
const GEAR_ALLOWANCE = 0.003 * INCH;
const WHEEL_GAP = 0.125 * INCH;
const MAX_STAGE = 7;
const MIN_BELT_TEETH_IN_MESH = 6;
const MIN_CHAIN_WRAP = (2 * Math.PI) / 3;
const NEAR_MISS = 0.5 * INCH;
const PER_SIGNATURE = 2;
const PARTS_PER_LISTING = 3;
const RECALC = "https://www.reca.lc";

type Shape =
  | { readonly kind: "gear"; readonly dp: number }
  | { readonly kind: "belt"; readonly profile: string; readonly pitchMm: number }
  | { readonly kind: "chain"; readonly chain: string; readonly pitchMm: number };
const SHAPES: Record<CadDriveFamily, Shape> = {
  "gear-20dp": { kind: "gear", dp: 20 },
  "gear-32dp": { kind: "gear", dp: 32 },
  "htd-5mm": { kind: "belt", profile: "HTD", pitchMm: 5 },
  "gt2-3mm": { kind: "belt", profile: "GT2", pitchMm: 3 },
  rt25: { kind: "belt", profile: "RT25", pitchMm: 6.35 },
  "chain-25": { kind: "chain", chain: "#25", pitchMm: 6.35 },
  "chain-35": { kind: "chain", chain: "#35", pitchMm: 9.525 },
};

interface Family {
  readonly name: CadDriveFamily;
  readonly order: number;
  readonly shape: Shape;
  readonly wheels: ReadonlyMap<number, readonly WheelListing[]>;
  /** Stock belts by tooth count; empty for gears and chains, which are cut to length. */
  readonly belts: ReadonlyMap<number, readonly BeltListing[]>;
}
const byTeeth = <T extends Listing>(listings: readonly T[], keep: (teeth: number) => boolean) => {
  const map = new Map<number, T[]>();
  for (const listing of listings)
    if (keep(listing.teeth)) map.set(listing.teeth, [...(map.get(listing.teeth) ?? []), listing]);
  return map;
};
// Pinions under 10 teeth are usually profile shifted, and the catalog does not say their spacing.
const familiesOf = (catalog: DriveCatalog): ReadonlyMap<CadDriveFamily, Family> =>
  new Map(
    CAD_DRIVE_FAMILIES.map((name, order): [CadDriveFamily, Family] => {
      const shape = SHAPES[name];
      const wheels =
        shape.kind === "gear"
          ? byTeeth(
              catalog.gears.filter((gear) => gear.dp === shape.dp),
              (teeth) => teeth >= 10 && teeth <= 84,
            )
          : shape.kind === "belt"
            ? byTeeth(
                catalog.pulleys.filter(
                  (pulley) => pulley.profile === shape.profile && pulley.pitchMm === shape.pitchMm,
                ),
                (teeth) => teeth >= 8 && teeth <= 84,
              )
            : byTeeth(
                catalog.sprockets.filter((sprocket) => sprocket.chain === shape.chain),
                (teeth) => teeth >= 8 && teeth <= 84,
              );
      const belts =
        shape.kind === "belt"
          ? byTeeth(
              catalog.belts.filter(
                (belt) => belt.profile === shape.profile && belt.pitchMm === shape.pitchMm,
              ),
              () => true,
            )
          : new Map<number, BeltListing[]>();
      return [name, { name, order, shape, wheels, belts }];
    }),
  );
// One catalog serves many calls between downloads, so its families are built once.
const families = new WeakMap<DriveCatalog, ReadonlyMap<CadDriveFamily, Family>>();
const familiesFor = (catalog: DriveCatalog) => {
  let found = families.get(catalog);
  if (!found) families.set(catalog, (found = familiesOf(catalog)));
  return found;
};

/** Pitch radius in meters. */
const pitchRadius = (shape: Shape, teeth: number) =>
  shape.kind === "gear"
    ? (teeth / (2 * shape.dp)) * INCH
    : (teeth * shape.pitchMm) / (2 * Math.PI) / 1000;

interface Stage {
  readonly family: Family;
  readonly driver: number;
  readonly driven: number;
  readonly reduction: number;
}
const radii = (stage: Stage) =>
  [
    pitchRadius(stage.family.shape, stage.driver),
    pitchRadius(stage.family.shape, stage.driven),
  ] as const;

/**
 * Center in meters where a loop `lengthMm` long wraps both wheels exactly: the root of
 * `loopLengthNeededMm`, so the loop-length check reads zero error there.
 */
const loopCenter = (stage: Stage, lengthMm: number) => {
  const [ra, rb] = radii(stage);
  const b = lengthMm / 1000 - Math.PI * (ra + rb);
  const discriminant = b * b - 8 * (ra - rb) ** 2;
  return b <= 0 || discriminant < 0 ? null : (b + Math.sqrt(discriminant)) / 4;
};
/** Whether a belt or chain at `center` clears its wheels and wraps enough of the small one. */
const loopUsable = (stage: Stage, center: number) => {
  const [ra, rb] = radii(stage);
  if (center - ra - rb < WHEEL_GAP) return false;
  const wrap = Math.PI - 2 * Math.asin(Math.abs(rb - ra) / center);
  const smallTeeth = Math.min(stage.driver, stage.driven);
  return stage.family.shape.kind === "chain"
    ? wrap >= MIN_CHAIN_WRAP
    : (smallTeeth * wrap) / (2 * Math.PI) >= MIN_BELT_TEETH_IN_MESH;
};

/** One way to build a stage: its center in meters and, for a belt or chain, the loop's teeth or links. */
interface Build {
  readonly center: number;
  readonly loop: number | null;
}
/** Every center the stage can be built at with stock parts up to `maxCenter`, ascending. */
const stageBuilds = (stage: Stage, maxCenter: number): Build[] => {
  const { shape } = stage.family;
  if (shape.kind === "gear")
    return [
      {
        center: ((stage.driver + stage.driven) / (2 * shape.dp)) * INCH + GEAR_ALLOWANCE,
        loop: null,
      },
    ];
  const loops =
    shape.kind === "belt"
      ? [...stage.family.belts.keys()]
      : Array.from(
          { length: Math.ceil((2 * maxCenter * 1000) / shape.pitchMm / 2) + 200 },
          (_, i) => 2 * (i + 1),
        );
  return loops
    .flatMap((loop) => {
      const center = loopCenter(stage, loop * shape.pitchMm);
      return center !== null && center <= maxCenter && loopUsable(stage, center)
        ? [{ center, loop }]
        : [];
    })
    .sort((a, b) => a.center - b.center);
};

/** A single stage at a fixed center: the build cad_checks would judge closest to it. */
const buildAt = (stage: Stage, center: number): (Build & { readonly fits: boolean }) | null => {
  const { shape } = stage.family;
  if (shape.kind === "gear") {
    const exact = ((stage.driver + stage.driven) / (2 * shape.dp)) * INCH;
    const error = center - exact;
    return {
      center: exact + GEAR_ALLOWANCE,
      loop: null,
      fits: error >= -MESH_TOO_CLOSE && error <= MESH_TOO_FAR,
    };
  }
  if (!loopUsable(stage, center)) return null;
  const needed = loopLengthNeededMm(center, stage.driver, stage.driven, shape.pitchMm);
  const loops =
    shape.kind === "belt"
      ? [...stage.family.belts.keys()]
      : [2 * Math.floor(needed / shape.pitchMm / 2), 2 * Math.ceil(needed / shape.pitchMm / 2)];
  // A loop's own center can sit up to half a link from `center`, so it must meet the rules too.
  let best: { loop: number; error: number; built: number } | null = null;
  for (const loop of loops) {
    const error = needed - loop * shape.pitchMm;
    const built = loopCenter(stage, loop * shape.pitchMm);
    if (built === null || !loopUsable(stage, built)) continue;
    if (!best || Math.abs(error) < Math.abs(best.error)) best = { loop, error, built };
  }
  return best
    ? {
        center: best.built,
        loop: best.loop,
        fits: loopLengthFits(best.error, shape.kind === "chain", shape.pitchMm),
      }
    : null;
};

/** The pair of builds whose centers reach between axes `center` apart with the least excess. */
const jackshaftBuilds = (first: readonly Build[], second: readonly Build[], center: number) => {
  let best: readonly [Build, Build] | null = null;
  for (const a of first) {
    const low = Math.max(center - a.center, a.center - center);
    let lo = 0;
    let hi = second.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (second[mid]!.center < low) lo = mid + 1;
      else hi = mid;
    }
    const b = second[lo];
    if (!b || b.center > a.center + center) continue;
    if (!best || a.center + b.center < best[0].center + best[1].center) best = [a, b];
  }
  return best;
};

export interface DriveSearch {
  readonly catalog: DriveCatalog;
  /** Above 1 slows the output. */
  readonly reduction: number;
  /** Fraction, not percent. */
  readonly tolerance: number;
  readonly families: readonly CadDriveFamily[];
  readonly maxStages: 1 | 2;
  readonly driverBore: string | null;
  /** Fixed center between the first driver and the last driven axis, in meters. */
  readonly centerMeters: number | null;
  readonly limit: number;
}
export type FoundDriveOption = Omit<
  CadDriveOption,
  "jackshaftPositions" | "outputRpm" | "surfaceFeetPerSecond"
> & {
  /** Two stages at a fixed center: each stage's center, driver side first, in meters. */
  readonly jackshaftCenters: readonly [number, number] | null;
};

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const recalcUrl = (path: string, params: Record<string, string | number>) =>
  `${RECALC}/${path}?${new URLSearchParams(Object.entries(params).map(([key, value]): [string, string] => [key, String(value)]))}`;
const measurement = (s: number, u: "in" | "mm") => JSON.stringify({ s: round(s, 4), u });
/** The ReCalc ratio finder, set to this reduction. */
export const recalcRatioUrl = (reduction: number) =>
  recalcUrl("ratio-finder", {
    targetReduction: JSON.stringify(
      reduction >= 1
        ? { magnitude: round(reduction, 4), ratioType: "Reduction" }
        : { magnitude: round(1 / reduction, 4), ratioType: "Step-up" },
    ),
  });
const stageRecalcUrl = (stage: Stage, desiredCenter: number | null) => {
  const { shape } = stage.family;
  if (shape.kind === "gear")
    return recalcUrl("gears", {
      gear1Teeth: stage.driver,
      gear2Teeth: stage.driven,
      gearDP: shape.dp,
    });
  return recalcUrl(shape.kind === "belt" ? "belts" : "chains", {
    p1Teeth: stage.driver,
    p2Teeth: stage.driven,
    pitch:
      shape.kind === "belt"
        ? measurement(shape.pitchMm, "mm")
        : measurement(shape.pitchMm / 25.4, "in"),
    ...(desiredCenter === null ? {} : { desiredCenter: measurement(desiredCenter / INCH, "in") }),
  });
};

const presentParts = <T extends Listing>(listings: readonly T[], rank: (listing: T) => number) => {
  const seen = new Set<string>();
  return listings
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        a.vendor.localeCompare(b.vendor) ||
        (a.sku ?? "").localeCompare(b.sku ?? "") ||
        a.url.localeCompare(b.url),
    )
    .filter((listing) => !seen.has(listing.url) && seen.add(listing.url))
    .slice(0, PARTS_PER_LISTING);
};
const presentWheel = (family: Family, teeth: number, bore: string | null) => {
  const listings = family.wheels.get(teeth) ?? [];
  const preferred = bore ?? '1/2" Hex';
  return {
    teeth,
    bores: [...new Set(listings.flatMap((listing) => (listing.bore ? [listing.bore] : [])))].sort(),
    parts: presentParts(
      bore ? listings.filter((listing) => listing.bore === bore) : listings,
      (listing) => (listing.bore === preferred ? 0 : 1),
    ).map(({ vendor, sku, bore, url }) => ({ vendor, sku, bore, url })),
  };
};
const presentLoop = (family: Family, loop: number) => {
  const listings = family.belts.get(loop) ?? [];
  return {
    teeth: loop,
    widthsMm: [
      ...new Set(
        listings.flatMap((listing) => (listing.widthMm === null ? [] : [listing.widthMm])),
      ),
    ].sort((a, b) => a - b),
    parts: presentParts(listings, (listing) => listing.widthMm ?? 0).map(
      ({ vendor, sku, url }) => ({
        vendor,
        sku,
        bore: null,
        url,
      }),
    ),
  };
};
const presentStage = (
  stage: Stage,
  build: Build | null,
  driverBore: string | null,
  desiredCenter: number | null,
): CadDriveStage => ({
  family: stage.family.name,
  driver: presentWheel(stage.family, stage.driver, driverBore),
  driven: presentWheel(stage.family, stage.driven, null),
  reduction: round(stage.reduction, 4),
  centerInches: build ? round(build.center / INCH, 4) : null,
  loop: build?.loop != null ? presentLoop(stage.family, build.loop) : null,
  recalcUrl: stageRecalcUrl(stage, desiredCenter),
});

interface Candidate {
  readonly stages: readonly Stage[];
  readonly reduction: number;
  readonly bucket: number;
  readonly size: number;
}
const signature = (stages: readonly Stage[]) => stages.map((stage) => stage.family.name).join("+");
const compareCandidates = (a: Candidate, b: Candidate) => {
  const first = a.stages.length - b.stages.length || a.bucket - b.bucket || a.size - b.size;
  if (first !== 0) return first;
  for (let i = 0; i < a.stages.length; i++) {
    const x = a.stages[i]!;
    const y = b.stages[i]!;
    const order = x.family.order - y.family.order || x.driver - y.driver || x.driven - y.driven;
    if (order !== 0) return order;
  }
  return 0;
};

/**
 * Ranked stock drives for a reduction. Pure: the CAD supplies only `centerMeters`. With a fixed
 * center, options that fit come first, then single stages that miss it by under 0.5 in.
 */
export const searchDriveOptions = (
  search: DriveSearch,
): { readonly options: FoundDriveOption[]; readonly notes: string[] } => {
  const { reduction, tolerance, centerMeters, driverBore } = search;
  const catalogFamilies = familiesFor(search.catalog);
  const families = CAD_DRIVE_FAMILIES.filter((name) => search.families.includes(name)).map(
    (name) => catalogFamilies.get(name)!,
  );
  const reduces = reduction >= 1;
  const stages = families
    .flatMap((family) => {
      const teeth = [...family.wheels.keys()];
      return teeth.flatMap((driver) =>
        teeth.flatMap((driven): Stage[] => {
          const ratio = driven / driver;
          return (reduces ? ratio >= 1 && ratio <= MAX_STAGE : ratio <= 1 && ratio >= 1 / MAX_STAGE)
            ? [{ family, driver, driven, reduction: ratio }]
            : [];
        }),
      );
    })
    .sort((a, b) => a.reduction - b.reduction);
  const canLead = (stage: Stage) =>
    driverBore === null ||
    (stage.family.wheels.get(stage.driver) ?? []).some((listing) => listing.bore === driverBore);
  const low = reduction * (1 - tolerance);
  const high = reduction * (1 + tolerance);
  const candidate = (picked: readonly Stage[]): Candidate => {
    const total = picked.reduce((product, stage) => product * stage.reduction, 1);
    return {
      stages: picked,
      reduction: total,
      bucket: Math.round(Math.abs(total / reduction - 1) * 200),
      size: Math.max(...picked.flatMap((stage) => radii(stage))),
    };
  };
  const candidates: Candidate[] = stages
    .filter((stage) => canLead(stage) && stage.reduction >= low && stage.reduction <= high)
    .map((stage) => candidate([stage]));
  if (search.maxStages === 2)
    for (const first of stages) {
      if (!canLead(first)) continue;
      let i = 0;
      let hi = stages.length;
      while (i < hi) {
        const mid = (i + hi) >> 1;
        if (first.reduction * stages[mid]!.reduction < low) i = mid + 1;
        else hi = mid;
      }
      for (; i < stages.length && first.reduction * stages[i]!.reduction <= high; i++)
        candidates.push(candidate([first, stages[i]!]));
    }
  candidates.sort(compareCandidates);

  const option = (
    found: Candidate,
    builds: readonly (Build | null)[],
    fits: boolean | null,
    desired: readonly (number | null)[],
  ): FoundDriveOption => {
    const single = found.stages.length === 1 && centerMeters !== null && builds[0];
    const [first, second] = builds;
    const jackshaft = found.stages.length === 2 && fits && first && second;
    return {
      reduction: round(found.reduction, 4),
      errorPercent: round((found.reduction / reduction - 1) * 100, 2),
      stages: found.stages.map((stage, index) =>
        presentStage(
          stage,
          builds[index] ?? null,
          index === 0 ? driverBore : null,
          desired[index] ?? null,
        ),
      ),
      fits,
      centerErrorInches: single ? round((single.center - centerMeters) / INCH, 4) : null,
      jackshaftCenters: jackshaft ? [first.center, second.center] : null,
    };
  };
  const picked = new Map<string, number>();
  const take = (stages: readonly Stage[]) => {
    const key = signature(stages);
    const count = picked.get(key) ?? 0;
    if (count >= PER_SIGNATURE) return false;
    picked.set(key, count + 1);
    return true;
  };
  const percent = round(tolerance * 100, 2);
  const options: FoundDriveOption[] = [];
  const notes: string[] = [];

  if (centerMeters === null) {
    // A belt or chain stage needs some stock loop it can use, up to a meter apart.
    const usable = new Map<Stage, boolean>();
    const buildable = (stage: Stage) => {
      let found = usable.get(stage);
      if (found === undefined) usable.set(stage, (found = stageBuilds(stage, 1).length > 0));
      return found;
    };
    for (const found of candidates) {
      if (options.length >= search.limit) break;
      if (!found.stages.every(buildable)) continue;
      if (!take(found.stages)) continue;
      const builds = found.stages.map((stage) =>
        stage.family.shape.kind === "gear" ? stageBuilds(stage, Infinity)[0]! : null,
      );
      options.push(option(found, builds, null, []));
    }
    if (options.length === 0)
      notes.push(
        `No stock drive is within ${percent}% of ${round(reduction, 4)}:1. Widen tolerancePercent, allow more families, or allow two stages.`,
      );
    return { options, notes };
  }

  const maxCenter = 2 * centerMeters + 0.05;
  const cache = new Map<Stage, Build[]>();
  const builds = (stage: Stage) => {
    let found = cache.get(stage);
    if (!found) cache.set(stage, (found = stageBuilds(stage, maxCenter)));
    return found;
  };
  const misses: { found: Candidate; build: Build }[] = [];
  for (const found of candidates) {
    if (options.length >= search.limit) break;
    if ((picked.get(signature(found.stages)) ?? 0) >= PER_SIGNATURE) continue;
    if (found.stages.length === 1) {
      const [stage] = found.stages;
      const build = buildAt(stage!, centerMeters);
      if (!build) continue;
      if (build.fits) {
        take(found.stages);
        options.push(option(found, [build], true, [centerMeters]));
      } else if (Math.abs(build.center - centerMeters) <= NEAR_MISS) misses.push({ found, build });
      continue;
    }
    const [first, second] = found.stages as readonly [Stage, Stage];
    const pair = jackshaftBuilds(builds(first), builds(second), centerMeters);
    if (!pair) continue;
    take(found.stages);
    options.push(option(found, pair, true, [pair[0].center, pair[1].center]));
  }
  const center = round(centerMeters / INCH, 3);
  if (!options.some((found) => found.stages.length === 1))
    notes.push(
      search.maxStages === 2
        ? `No single stock stage fits the ${center} in center. Two-stage options put a jackshaft between the axes.`
        : `No single stock stage fits the ${center} in center.`,
    );
  if (options.length === 0)
    notes.push(
      `No stock drive within ${percent}% of ${round(reduction, 4)}:1 fits the ${center} in center. Widen tolerancePercent, allow more families${search.maxStages === 1 ? ", allow two stages" : ""}, or move a shaft.`,
    );
  const missed = new Map<string, number>();
  for (const { found, build } of misses.sort(
    (a, b) =>
      Math.abs(a.build.center - centerMeters) - Math.abs(b.build.center - centerMeters) ||
      compareCandidates(a.found, b.found),
  )) {
    if (options.length >= search.limit) break;
    const key = signature(found.stages);
    if ((missed.get(key) ?? 0) >= PER_SIGNATURE) continue;
    missed.set(key, (missed.get(key) ?? 0) + 1);
    options.push(option(found, [build], false, [centerMeters]));
  }
  return { options, notes };
};

const add = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/**
 * Where a jackshaft can sit `fromDriver` meters from the driver's middle and `toDriven` from the
 * driven axis: the two intersections of those circles in the plane across the driven axis through
 * the driver's middle, where cad_drive_options measures the center, or one point when the circles
 * touch, or none when they cannot reach.
 */
export const jackshaftPositions = (
  driver: CadAxis,
  driven: CadAxis,
  fromDriver: number,
  toDriven: number,
): Vector3[] => {
  const offset = sub(driven.center, driver.center);
  const across = sub(offset, scale(driven.axis, dot(offset, driven.axis)));
  const center = norm(across);
  if (center === 0) return [];
  const toward = scale(across, 1 / center);
  const side = cross(driven.axis, toward);
  const along = (fromDriver ** 2 - toDriven ** 2 + center ** 2) / (2 * center);
  const height = fromDriver ** 2 - along ** 2;
  if (height < -1e-12) return [];
  const base = add(driver.center, scale(toward, along));
  const h = Math.sqrt(Math.max(0, height));
  return h < 1e-9 ? [base] : [add(base, scale(side, h)), add(base, scale(side, -h))];
};

const invalid = (details: string) => new CadViewError({ reason: "invalid-operation", details });
const meters = (point: Vector3): Vector3 => [
  round(point[0], 5),
  round(point[1], 5),
  round(point[2], 5),
];

/**
 * Tool entry point. Reads part geometry only when the input names parts, and the catalog only
 * once the input is valid.
 */
export const readCadDriveOptions = Effect.fn("readCadDriveOptions")(function* (
  manifest: CadSnapshotManifest,
  state: CadViewState,
  meshes: (
    geometryKeys: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyMap<string, CadTriangleMesh | null>, CadViewError>,
  driveCatalog: Effect.Effect<DriveCatalog, CadViewError>,
  rawInput: unknown,
): Effect.fn.Return<CadDriveOptionsResult, CadViewError> {
  const input = yield* decodeCadToolInput(CadDriveOptionsInput, rawInput);
  if (input.expectedRevision !== state.revision)
    return yield* new CadViewError({ reason: "revision-conflict" });

  const named = { driver: input.driverOccurrenceId, driven: input.drivenOccurrenceId };
  const axes: {
    driver: (CadAxis & { name: string; id: string }) | null;
    driven: (CadAxis & { name: string; id: string }) | null;
  } = {
    driver: null,
    driven: null,
  };
  if (named.driver !== undefined || named.driven !== undefined) {
    const occurrences = partOccurrences(manifest);
    const loaded = yield* meshes(new Set(occurrences.map((occurrence) => occurrence.geometryKey)));
    // Snapped onto a shaft through them the way cad_checks does it.
    const recognized = new Map(
      recognizeDrivetrainParts(occurrences, loaded).map((part) => [part.occurrenceId, part.fit]),
    );
    for (const side of ["driver", "driven"] as const) {
      const id = named[side];
      if (id === undefined) continue;
      const field = `${side}OccurrenceId`;
      const occurrence = occurrences.find((candidate) => candidate.occurrenceId === id);
      if (!occurrence)
        return yield* invalid(
          `${field} is not an unsuppressed part in this snapshot. Use a part occurrence ID from cad_find_parts or cad_hierarchy.`,
        );
      const mesh = loaded.get(occurrence.geometryKey);
      const fit = recognized.get(id) ?? (mesh ? fitCadAxis(mesh, occurrence.transform) : null);
      if (!fit)
        return yield* invalid(
          `${field} (${occurrence.name}) has no readable geometry, so its axis is unknown.`,
        );
      axes[side] = { ...fit, name: occurrence.name, id };
    }
  }
  const { driver, driven } = axes;
  const notes: string[] = [];
  let centerMeters = input.centerInches === undefined ? null : input.centerInches * INCH;
  if (driver && driven) {
    const alignment = Math.abs(dot(driver.axis, driven.axis));
    if (alignment < PARALLEL)
      return yield* invalid(
        `${driver.name} and ${driven.name} are not parallel (${round((Math.acos(Math.min(1, alignment)) * 180) / Math.PI, 1)} degrees apart), so no gear, belt, or chain stage joins them directly.`,
      );
    if (centerMeters !== null)
      notes.push("centerInches was ignored: the center comes from the named parts.");
    // Measured at the driver's middle, where the drive sits, across the driven part's axis: fitted
    // axes tilt slightly, and a tilt grows with the distance along the axis it is carried.
    centerMeters = lineDistance(driver.center, driven.center, driven.axis);
  }

  const motor = input.motor ?? (driver ? driveMotorFromName(driver.name) : null);
  const freeRpm = motor ? DRIVE_MOTOR_FREE_RPM[motor] : null;
  const diameterInches = input.rollerDiameterInches ?? (driven ? (2 * driven.radius) / INCH : null);
  const { target } = input;
  if (target.kind !== "reduction" && freeRpm === null)
    return yield* invalid(
      `A speed target needs the motor's free speed. Pass motor, one of ${CAD_DRIVE_MOTORS.join(", ")}, or a driverOccurrenceId whose name names the motor.`,
    );
  if (target.kind === "surface-speed" && diameterInches === null)
    return yield* invalid(
      "A surface-speed target needs the roller's diameter. Pass rollerDiameterInches or drivenOccurrenceId.",
    );
  const reduction =
    target.kind === "reduction"
      ? target.reduction
      : target.kind === "output-rpm"
        ? freeRpm! / target.rpm
        : freeRpm! / ((target.feetPerSecond * 720) / (Math.PI * diameterInches!));
  if (motor)
    notes.push(
      `Speeds use the ${motor}'s free speed of ${freeRpm} rpm. Under load the output turns slower.`,
    );

  const catalog = yield* driveCatalog;
  const found = searchDriveOptions({
    catalog,
    reduction,
    tolerance: (input.tolerancePercent ?? 3) / 100,
    families: input.families ?? CAD_DRIVE_FAMILIES,
    maxStages: input.maxStages ?? 2,
    driverBore: input.driverBore ?? null,
    centerMeters,
    limit: input.limit ?? 8,
  });
  const presentAxis = (axis: CadAxis & { name: string; id: string }) => ({
    occurrenceId: axis.id,
    name: axis.name,
    center: meters(axis.center),
    axis: meters(axis.axis),
    diameterInches: round((2 * axis.radius) / INCH, 3),
  });
  return {
    revision: state.revision,
    snapshotId: state.snapshotId,
    reduction: round(reduction, 4),
    motor: motor && freeRpm ? { name: motor, freeRpm } : null,
    centerInches: centerMeters === null ? null : round(centerMeters / INCH, 4),
    driver: driver ? presentAxis(driver) : null,
    driven: driven ? presentAxis(driven) : null,
    options: found.options.map(({ jackshaftCenters, ...option }) => {
      const outputRpm = freeRpm === null ? null : freeRpm / option.reduction;
      return {
        ...option,
        jackshaftPositions:
          jackshaftCenters && driver && driven
            ? jackshaftPositions(driver, driven, ...jackshaftCenters).map(meters)
            : null,
        outputRpm: outputRpm === null ? null : round(outputRpm, 0),
        surfaceFeetPerSecond:
          outputRpm === null || diameterInches === null
            ? null
            : round((outputRpm * Math.PI * diameterInches) / 720, 2),
      };
    }),
    notes: [...found.notes, ...notes],
    recalcUrl: recalcRatioUrl(reduction),
    catalog: catalog.source,
  };
});
