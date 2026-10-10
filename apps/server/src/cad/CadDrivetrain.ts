import type { CadCheckFinding } from "@cadsense/contracts";
import type { CadTriangleMesh, PartOccurrence } from "./CadChecks.ts";

/**
 * Deterministic drivetrain analysis: reads gears, pulleys, belts, shafts, bearings, motors, and
 * rollers from FRC vendor part names, fits each part's rotation axis from its mesh, and traces
 * power from every motor. It answers the questions the review guidance asks agents to work out
 * from screenshots: does each gear pair sit at the right center distance, does every belt wrap a
 * pulley at both ends, is every shaft carried by bearings, and does power reach the rollers.
 *
 * Name parsing is a heuristic: parts without vendor names (custom gears, "Part 12") are not
 * classified, so a missing part means "not recognized", never "absent". `cad_checks` reports
 * what was recognized so the agent can tell the difference.
 */

type Vector3 = readonly [number, number, number];
type Matrix = readonly number[];

export type CadDrivetrainRole =
  | { readonly kind: "motor" }
  /** `meshTeeth` differs from `teeth` for profile-shifted pinions ("8t, 10t Center Distance"). */
  | {
      readonly kind: "gear";
      readonly teeth: number;
      readonly meshTeeth: number;
      readonly diametralPitch: number | null;
    }
  | { readonly kind: "pulley"; readonly teeth: number }
  | { readonly kind: "sprocket"; readonly teeth: number }
  /** A belt or chain loop: tooth or link count and pitch in millimeters. */
  | {
      readonly kind: "loop";
      readonly wraps: "pulley" | "sprocket";
      readonly teeth: number;
      readonly pitchMm: number;
    }
  | { readonly kind: "gearbox"; readonly ratio: number }
  | { readonly kind: "shaft" }
  | { readonly kind: "bearing" }
  | { readonly kind: "roller" }
  /** A motor controller, which matters only for where it sits on a motor. */
  | { readonly kind: "controller" };

const teethIn = (name: string) => {
  const match = /(\d{1,3})\s*(?:t|tooth|teeth)\b/i.exec(name);
  return match ? Number(match[1]) : null;
};
const CHAIN_PITCH_MM: Readonly<Record<string, number>> = { "25": 6.35, "35": 9.525, "40": 12.7 };

/** Role from an FRC vendor part name, or null when the name does not identify one. */
export const cadDrivetrainRole = (rawName: string): CadDrivetrainRole | null => {
  const name = rawName.replace(/\s*<\d+>$/, "").replaceAll("_", " ");
  if (/bearing|bushing/i.test(name) && !/hat|block|housing|plate|retainer/i.test(name))
    return { kind: "bearing" };
  if (/\bbelt\b/i.test(name)) {
    const teeth = teethIn(name);
    const pitch = /(\d+(?:\.\d+)?)\s*m\b/i.exec(name) ?? /(\d+(?:\.\d+)?)\s*mm\s*pitch/i.exec(name);
    const pitchMm = pitch ? Number(pitch[1]) : /htd/i.test(name) ? 5 : /gt2/i.test(name) ? 3 : null;
    return teeth && pitchMm ? { kind: "loop", wraps: "pulley", teeth, pitchMm } : null;
  }
  if (/\bchain\b/i.test(name) && !/tension|guard|block/i.test(name)) {
    const links = /(\d+)\s*L\b/.exec(name);
    const pitchMm = CHAIN_PITCH_MM[/#\s*(\d+)/.exec(name)?.[1] ?? ""];
    return links && pitchMm
      ? { kind: "loop", wraps: "sprocket", teeth: Number(links[1]), pitchMm }
      : null;
  }
  if (/\b(gear|pinion)\b/i.test(name) && !/gearbox/i.test(name)) {
    const teeth = teethIn(name);
    const dp = /(\d+)\s*dp\b/i.exec(name);
    const shifted = /(\d+)\s*t\s*center\s*distance/i.exec(name);
    return teeth
      ? {
          kind: "gear",
          teeth,
          meshTeeth: shifted ? Number(shifted[1]) : teeth,
          diametralPitch: dp ? Number(dp[1]) : null,
        }
      : null;
  }
  if (/pulley|\bhtd\b|\bgt2\b|\bgt3\b|\brt25\b/i.test(name)) {
    const teeth = teethIn(name);
    return teeth ? { kind: "pulley", teeth } : null;
  }
  if (/sprocket/i.test(name)) {
    const teeth = teethIn(name);
    return teeth ? { kind: "sprocket", teeth } : null;
  }
  if (/planetary/i.test(name)) {
    const stage = /(\d+(?:\.\d+)?)\s*:\s*1/.exec(name);
    return { kind: "gearbox", ratio: stage ? Number(stage[1]) : 1 };
  }
  if (/spark\s*(flex|max)|talon|victor|motor controller/i.test(name)) return { kind: "controller" };
  // Tooth counts outrank hardware words ("Roller Endcap HTD 24 Tooth Square Nut" is a pulley).
  if (/\b(screw|bolt|nut|washer|bhcs|shcs|fhcs|rivet|insert|spacer|collar|standoff)\b/i.test(name))
    return null;
  if (
    /\b(motor|falcon|kraken|neo|vortex|cim|minion|775)\b/i.test(name) &&
    !/controller|shaft|dock|module|mount|spark|talon|victor|plate|bracket|adapter|support|section|cover|guard/i.test(
      name,
    )
  )
    return { kind: "motor" };
  // "Hex Bore" and "Hex ID" describe a hole, not a shaft.
  const shaftWords = name.replace(/hex\s*(bore|id)\b|\(\s*1\/2"\s*thunderhex\s*id\s*\)/gi, "");
  if (
    /shaft|\bhex\b|\baxle\b|thunderhex|\bmaxspline\b/i.test(shaftWords) &&
    !/tube|bore|hub|adapter|coupler|coupling/i.test(shaftWords)
  )
    return { kind: "shaft" };
  if (/\broller\b|round tube|deadaxle tube|dead axle tube|\bwheel\b/i.test(name))
    return { kind: "roller" };
  return null;
};

/** A rotation axis in world meters: the line through `center` along unit `axis`. */
export interface CadAxis {
  readonly center: Vector3;
  readonly axis: Vector3;
  /** Half the part's extent along the axis; `center` is the middle of that extent. */
  readonly halfLength: number;
  /** Largest distance from the axis to any vertex. */
  readonly radius: number;
}
/** A part's chosen axis plus one candidate per principal direction, largest spread first. */
export interface CadAxisFit extends CadAxis {
  readonly candidates: readonly [CadAxis, CadAxis, CadAxis];
  /** Middle of the part's extent along all three principal directions at once. */
  readonly boxCenter: Vector3;
}

const sub = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vector3, k: number): Vector3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Vector3) => Math.sqrt(dot(a, a));
const applyPoint = (m: Matrix, x: number, y: number, z: number): Vector3 => [
  m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
  m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
  m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
];
/** Distance from point p to the infinite line through c along unit axis a. */
const lineDistance = (p: Vector3, c: Vector3, a: Vector3) => {
  const d = sub(p, c);
  return norm(sub(d, scale(a, dot(d, a))));
};

/** Eigenvectors of a symmetric 3x3 matrix by Jacobi rotation, largest eigenvalue first. */
const eigen = (m: number[][]): { values: number[]; vectors: Vector3[] } => {
  const a = m.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
  }
  const order = [0, 1, 2].sort((i, j) => a[j]![j]! - a[i]![i]!);
  return {
    values: order.map((i) => a[i]![i]!),
    vectors: order.map((i): Vector3 => [v[0]![i]!, v[1]![i]!, v[2]![i]!]),
  };
};

/**
 * Fits a rotational part's axis from its placed mesh. Surface samples are triangle centroids
 * weighted by area, so dense fillets do not pull the fit. A rotationally symmetric part has two
 * equal spreads; the axis is the remaining direction: the smallest spread for a disc (gear,
 * pulley, bearing) and the largest for a rod (shaft, roller).
 */
export const fitCadAxis = (mesh: CadTriangleMesh, transform: Matrix): CadAxisFit | null => {
  const { positions, indices } = mesh;
  const world: Vector3[] = [];
  for (let i = 0; i < positions.length; i += 3)
    world.push(applyPoint(transform, positions[i]!, positions[i + 1]!, positions[i + 2]!));
  let total = 0;
  const mean = [0, 0, 0];
  const samples: { point: Vector3; weight: number }[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = world[indices[i]!]!;
    const b = world[indices[i + 1]!]!;
    const c = world[indices[i + 2]!]!;
    const ab = sub(b, a);
    const ac = sub(c, a);
    const cross: Vector3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const weight = norm(cross) / 2;
    if (weight === 0) continue;
    const point: Vector3 = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ];
    samples.push({ point, weight });
    total += weight;
    for (const k of [0, 1, 2] as const) mean[k]! += point[k] * weight;
  }
  if (total === 0) return null;
  const center: Vector3 = [mean[0]! / total, mean[1]! / total, mean[2]! / total];
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const { point, weight } of samples) {
    const d = sub(point, center);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) covariance[r]![c]! += (d[r]! * d[c]! * weight) / total;
  }
  const { values, vectors } = eigen(covariance);
  const [l1, l2, l3] = values as [number, number, number];
  const fitAlong = (axis: Vector3): CadAxis => {
    let low = Infinity;
    let high = -Infinity;
    for (const point of world) {
      const along = dot(sub(point, center), axis);
      low = Math.min(low, along);
      high = Math.max(high, along);
    }
    // The centroid of a part with an asymmetric hub sits off the middle; recenter on the extent.
    const middle = (low + high) / 2;
    const centered: Vector3 = [
      center[0] + axis[0] * middle,
      center[1] + axis[1] * middle,
      center[2] + axis[2] * middle,
    ];
    let radius = 0;
    for (const point of world) radius = Math.max(radius, lineDistance(point, centered, axis));
    return { center: centered, axis, halfLength: (high - low) / 2, radius };
  };
  const candidates = [fitAlong(vectors[0]!), fitAlong(vectors[1]!), fitAlong(vectors[2]!)] as const;
  // Each candidate moved the centroid along its own direction only; apply all three shifts.
  const boxCenter = candidates.reduce<Vector3>(
    (sum, candidate) => [
      sum[0] + candidate.center[0] - center[0],
      sum[1] + candidate.center[1] - center[1],
      sum[2] + candidate.center[2] - center[2],
    ],
    center,
  );
  // Ratios rather than differences, so a thick disc and a short rod are judged alike.
  const chosen =
    l1 / Math.max(l2, 1e-30) > l2 / Math.max(l3, 1e-30) ? candidates[0] : candidates[2];
  return { ...chosen, candidates, boxCenter };
};

export interface CadDrivetrainPart {
  readonly occurrenceId: string;
  readonly name: string;
  readonly role: CadDrivetrainRole;
  readonly fit: CadAxisFit;
}

const INCH = 0.0254;
const PARALLEL = 0.995;
const inches = (meters: number) => `${(meters / INCH).toFixed(3)} in`;
const ratio = (value: number) => `${Number(value.toFixed(2))}:1`;

/** What a draft publishes for one drivetrain problem; see `CadDrivetrainFinding.comment`. */
export interface CadDrivetrainComment {
  readonly title?: string;
  readonly body: string;
}
/** One problem or fact the agent should read, with the parts it concerns. */
export interface CadDrivetrainFinding {
  readonly kind: Extract<CadCheckFinding, { check: "drivetrain" }>["kind"];
  /** True when this describes something that will not work as modeled. */
  readonly problem: boolean;
  /** For the agent: exact CAD names, so it can find the parts. */
  readonly summary: string;
  /**
   * For the student: what a cad_checks draft publishes, in plain part names, its body ending with a
   * next step, and a title when the problem has a more specific one than its kind's. Set on the
   * problems drafted one per finding (gear meshes, loops, motor mounts, unpowered rollers);
   * `draftCadComments` words the kinds it merges across findings itself.
   */
  readonly comment?: CadDrivetrainComment;
  readonly occurrences: ReadonlyArray<{ readonly occurrenceId: string; readonly name: string }>;
}

/**
 * At most `max` UTF-16 units of `text`, never half of an emoji, and well formed: a lone surrogate
 * would make the follow-up's turn/start JSON unparsable for Codex.
 */
export const clip = (text: string, max: number) => {
  const cut = text.slice(0, max);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).toWellFormed();
};
/** A name without its instance tag, underscores, or invisible characters, trimmed. */
const visible = (name: string) =>
  name
    .replace(/\s*<\d+>$/, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();
/**
 * A part as a draft names it for the student: "40T gear" or "84T belt" for a part with teeth,
 * otherwise its name without the instance tag, trailing specs in parentheses, or underscores
 * ("13 in. Hex Shaft"). At most 120 characters, so a long name cannot crowd out the next step.
 */
export const partLabel = (name: string): string => {
  const role = cadDrivetrainRole(name);
  if (role?.kind === "gear" || role?.kind === "pulley" || role?.kind === "sprocket")
    return `${role.teeth}T ${role.kind}`;
  if (role?.kind === "loop" && role.wraps === "pulley") return `${role.teeth}T belt`;
  const plain = visible(name).replaceAll("_", " ").trim();
  const short = plain.replace(/\s*\([^()]*\)$/, "") || plain;
  // Motors and controllers go by the name a team uses: "NEO Vortex", "SPARK Flex".
  const spoken =
    role?.kind === "motor"
      ? short.replace(/\s+(brushless\s+)?motor$/i, "")
      : role?.kind === "controller"
        ? short.replace(/\s+(brushless\s+)?(motor\s+)?controller$/i, "")
        : short;
  return clip(spoken || short || "unnamed part", 120);
};
/** A part's name without its instance tag: every occurrence of one part has the same one. */
export const partName = (name: string) => name.replace(/\s*<\d+>$/, "");
/**
 * A part's full name for a target label or a marker's description: no instance tag, at most 120
 * characters, and never blank (an empty or whitespace name falls back to its label).
 */
export const fullName = (name: string) => clip(visible(name), 120) || partLabel(name);
const withArticle = (label: string) => (/^part\s*\d+$/i.test(label) ? label : `the ${label}`);
/** A part in a sentence: "the 40T gear", but "Part 20" for a part that kept its Onshape name. */
export const partPhrase = (name: string) => withArticle(partLabel(name));
/**
 * Parts named in one sentence. Two different parts whose labels match keep the specs their names
 * add ("the Side Plate (0.25 in)" and "the Side Plate (0.50 in)"), so the student can tell them apart.
 */
export const distinctPhrases = (names: readonly string[]) =>
  names.map((name) =>
    names.some(
      (other) => partName(other) !== partName(name) && partLabel(other) === partLabel(name),
    )
      ? withArticle(clip(visible(name).replaceAll("_", " ").trim(), 120) || partLabel(name))
      : partPhrase(name),
  );
/**
 * "a", "a and b", "a, b, and c". Past `limit` items the rest are counted ("and 34 more"), so a long
 * list cannot push the end of its sentence and the next step out of a comment.
 */
export const joinAnd = (items: readonly string[], limit = 6) => {
  const shown =
    items.length > limit ? [...items.slice(0, limit), `${items.length - limit} more`] : items;
  return shown.length <= 2
    ? shown.join(" and ")
    : `${shown.slice(0, -1).join(", ")}, and ${shown.at(-1)}`;
};
/** Phrases in a sentence, with repeats counted: "the 13 in. Hex Shaft (2 of them) and Part 4". */
export const countedList = (phrases: readonly string[], limit?: number) => {
  const counts = new Map<string, number>();
  for (const phrase of phrases) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  return joinAnd(
    [...counts].map(([phrase, count]) => (count > 1 ? `${phrase} (${count} of them)` : phrase)),
    limit,
  );
};
/** Parts in a sentence by name, with repeats counted. */
export const partList = (names: readonly string[], limit?: number) =>
  countedList(names.map(partPhrase), limit);
export const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Parts whose names identify a drivetrain role, with their fitted axes. */
export const recognizeDrivetrainParts = (
  occurrences: readonly PartOccurrence[],
  meshes: ReadonlyMap<string, CadTriangleMesh | null>,
): CadDrivetrainPart[] => {
  const parts = occurrences.flatMap((occurrence): CadDrivetrainPart[] => {
    const role = cadDrivetrainRole(occurrence.name);
    const mesh = meshes.get(occurrence.geometryKey);
    const fit = role && mesh ? fitCadAxis(mesh, occurrence.transform) : null;
    return role && fit
      ? [{ occurrenceId: occurrence.occurrenceId, name: occurrence.name, role, fit }]
      : [];
  });
  return parts.map((part) => alignToCarrier(part, parts));
};

/** Rods (shafts, rollers, and shaft-mounted pinions) whose fitted axis is reliable. */
const isRod = (part: CadDrivetrainPart) =>
  part.role.kind === "shaft" ||
  part.role.kind === "roller" ||
  (part.role.kind === "gear" && part.fit.halfLength > 2 * part.fit.radius);

/**
 * Parts about as long as they are wide (pulley endcaps, motors) have no clear principal axis, but
 * a part on a shaft always has one principal direction along it. When a candidate lines up with a
 * rod through the part's middle, that candidate becomes the axis, set exactly parallel to the rod.
 * Motors get a looser angle because terminals and docks skew their fit.
 */
const alignToCarrier = (
  part: CadDrivetrainPart,
  parts: readonly CadDrivetrainPart[],
): CadDrivetrainPart => {
  if (isRod(part) || part.role.kind === "loop") return part;
  const minimum = part.role.kind === "motor" ? 0.9 : PARALLEL;
  let best: { score: number; axis: CadAxis } | null = null;
  for (const rod of parts) {
    if (rod === part || !isRod(rod)) continue;
    for (const candidate of part.fit.candidates) {
      const alignment = dot(candidate.axis, rod.fit.axis);
      if (Math.abs(alignment) < minimum) continue;
      const offset = lineDistance(candidate.center, rod.fit.center, rod.fit.axis);
      if (offset > Math.max(0.0015, 0.25 * candidate.radius)) continue;
      const score = offset - Math.abs(alignment);
      if (best && best.score <= score) continue;
      const axis = scale(rod.fit.axis, Math.sign(alignment));
      // Recenter on the rod's line so later coaxial tests measure against the rod, not the skew.
      const d = sub(candidate.center, rod.fit.center);
      const center: Vector3 = [
        rod.fit.center[0] + rod.fit.axis[0] * dot(d, rod.fit.axis),
        rod.fit.center[1] + rod.fit.axis[1] * dot(d, rod.fit.axis),
        rod.fit.center[2] + rod.fit.axis[2] * dot(d, rod.fit.axis),
      ];
      best = { score, axis: { ...candidate, axis, center } };
    }
  }
  return best ? { ...part, fit: { ...part.fit, ...best.axis } } : part;
};

const ref = (part: CadDrivetrainPart) => ({ occurrenceId: part.occurrenceId, name: part.name });
/** Part names for a sentence, with repeats counted: "Deadaxle Tube <1> (3 of them)". */
const names = (parts: readonly CadDrivetrainPart[]) => {
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => (count > 1 ? `${name} (${count} of them)` : name))
    .join(", ");
};

type RoleOf<K extends CadDrivetrainRole["kind"]> = CadDrivetrainPart & {
  readonly role: Extract<CadDrivetrainRole, { kind: K }>;
};
const ofKind =
  <K extends CadDrivetrainRole["kind"]>(...kinds: K[]) =>
  (part: CadDrivetrainPart): part is RoleOf<K> =>
    (kinds as string[]).includes(part.role.kind);

// Center distance tolerance for gear pairs: FRC practice adds about 0.003 in to the exact value,
// while too close binds the teeth. Axes fitted from tessellated meshes carry about 0.002 in of
// noise, so smaller errors are not reported.
const MESH_TOO_CLOSE = 0.004 * INCH;
const MESH_TOO_FAR = 0.006 * INCH;
// Gear pairs this far apart along their axes are unrelated, such as mirrored sides of an arm.
const UNRELATED_AXIAL_GAP = 0.1 * INCH;

/**
 * The bare end of a belt or chain: of the loop's two ends along its span, the one farther from any
 * recognized pulley or sprocket, and the loop's mesh vertex farthest out at that end. The point is
 * in the loop's own coordinates; the view direction is normal to the loop's plane.
 */
export const beltEndPlacement = (
  loop: CadDrivetrainPart,
  mesh: CadTriangleMesh,
  transform: Matrix,
  parts: readonly CadDrivetrainPart[],
): { point: Vector3; normal: Vector3 } | null => {
  if (loop.role.kind !== "loop") return null;
  const wraps = loop.role.wraps;
  const span = loop.fit.candidates[0];
  const origin = loop.fit.boxCenter;
  const wheels = parts.filter((part) => part.role.kind === wraps);
  const clearance = (side: number) => {
    const end: Vector3 = [
      origin[0] + span.axis[0] * side * span.halfLength,
      origin[1] + span.axis[1] * side * span.halfLength,
      origin[2] + span.axis[2] * side * span.halfLength,
    ];
    return Math.min(Infinity, ...wheels.map((wheel) => norm(sub(wheel.fit.center, end))));
  };
  const side = clearance(1) >= clearance(-1) ? 1 : -1;
  let best: Vector3 | null = null;
  let reach = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const local: Vector3 = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!];
    const along = side * dot(sub(applyPoint(transform, ...local), origin), span.axis);
    if (along > reach) {
      reach = along;
      best = local;
    }
  }
  // Face the loop, so the image shows its whole shape and the empty end, not an edge-on sliver.
  return best ? { point: best, normal: loop.fit.candidates[2].axis } : null;
};

/** Coaxial: parallel axes, centers on one line, and axial extents that overlap or nearly touch. */
const coaxialAxes = (a: CadAxis, b: CadAxis, gap: number) => {
  if (Math.abs(dot(a.axis, b.axis)) < PARALLEL) return false;
  const tolerance = Math.max(0.0015, 0.25 * Math.min(a.radius, b.radius));
  if (lineDistance(b.center, a.center, a.axis) > tolerance) return false;
  return Math.abs(dot(sub(b.center, a.center), a.axis)) <= a.halfLength + b.halfLength + gap;
};

/** Names of parts whose overlaps are usually modeled on purpose: a squeezed game piece, threads. */
export const GAME_PIECE =
  /game\s*piece|frisbee|\bdisc\b|\bball\b|\bnote\b|cargo|\bcone\b|\bcube\b|coral|algae/i;
export const FASTENER = /screw|bolt|\bnut\b|washer|bhcs|shcs|fhcs|rivet|insert|thread/i;

/** One side of an exact overlap from cad_checks, with its fitted axis when the mesh has one. */
export interface CadOverlapSide {
  readonly occurrenceId: string;
  readonly name: string;
  readonly fit: CadAxisFit | null;
}
export interface CadOverlap {
  readonly occurrences: readonly [CadOverlapSide, CadOverlapSide];
  /** Shared volume in cubic meters. */
  readonly volume: number;
  readonly withinSubassembly: boolean;
}
const ROTATING: ReadonlySet<CadDrivetrainRole["kind"]> = new Set([
  "gear",
  "pulley",
  "sprocket",
  "shaft",
  "roller",
]);
const cubicInches = (cubicMeters: number) =>
  `${Number((cubicMeters / 1.6387064e-5).toPrecision(2))} in³`;

/**
 * Exact overlaps where a spinning part (gear, pulley, sprocket, shaft, roller) runs into a part it
 * should clear, such as a gear cutting into a frame tube or a jackshaft through a motor controller.
 * Intended fits are left out: anything coaxial with the spinning part (its shaft, hub, or spacer),
 * a pin or spacer parallel to it and wholly inside its radius (bolted to it, so it turns with it),
 * bearings, belts and chains, two gears (the mesh check covers them), game pieces, fasteners, and
 * overlaps inside one vendor subassembly. The spinning part comes first in each finding. Geometry
 * alone cannot see mates, so a part bolted on at an angle still reads as a collision.
 */
export const rotatingCollisions = (
  parts: readonly CadDrivetrainPart[],
  overlaps: readonly CadOverlap[],
): CadDrivetrainFinding[] => {
  const recognized = new Map(parts.map((part) => [part.occurrenceId, part]));
  return overlaps.flatMap((overlap): CadDrivetrainFinding[] => {
    if (overlap.withinSubassembly) return [];
    if (overlap.occurrences.some((side) => GAME_PIECE.test(side.name) || FASTENER.test(side.name)))
      return [];
    const [first, second] = overlap.occurrences.map((side) => ({
      side,
      part: recognized.get(side.occurrenceId),
    }));
    const spinning = (entry: typeof first) =>
      entry !== undefined && entry.part !== undefined && ROTATING.has(entry.part.role.kind);
    const subject = spinning(first) ? first : spinning(second) ? second : undefined;
    const other = subject === first ? second : first;
    if (!subject?.part || !other) return [];
    const otherKind = other.part?.role.kind;
    if (otherKind === "bearing" || otherKind === "loop") return [];
    if (otherKind === "gear" && subject.part.role.kind === "gear") return [];
    const otherAxis = other.part?.fit ?? other.side.fit;
    if (otherAxis && coaxialAxes(subject.part.fit, otherAxis, 0.002)) return [];
    // A pin or spacer parallel to the spinning part and wholly inside its radius is bolted to it.
    if (
      otherAxis &&
      Math.abs(dot(subject.part.fit.axis, otherAxis.axis)) >= PARALLEL &&
      lineDistance(otherAxis.center, subject.part.fit.center, subject.part.fit.axis) +
        otherAxis.radius <=
        subject.part.fit.radius
    )
      return [];
    return [
      {
        kind: "collision",
        problem: true,
        summary: `${subject.side.name} runs into ${other.side.name}: they share ${cubicInches(overlap.volume)} where they are modeled, so it cannot turn as drawn.`,
        occurrences: [
          { occurrenceId: subject.side.occurrenceId, name: subject.side.name },
          { occurrenceId: other.side.occurrenceId, name: other.side.name },
        ],
      },
    ];
  });
};

/**
 * Analysis over recognized parts. Deterministic: findings follow occurrence order. A finding is a
 * `problem` only when every part involved was recognized; a trace that runs into parts the
 * analysis cannot read is reported as untraced instead, so it never invents a broken drive.
 */
export const analyzeCadDrivetrain = (
  parts: readonly CadDrivetrainPart[],
): CadDrivetrainFinding[] => {
  const findings: CadDrivetrainFinding[] = [];
  const shafts = parts.filter(ofKind("shaft"));
  const motors = parts.filter(ofKind("motor"));
  const rollers = parts.filter(ofKind("roller"));
  const gears = parts.filter(ofKind("gear"));
  const wheels = parts.filter(ofKind("gear", "pulley", "sprocket"));
  const gearboxes = parts.filter(ofKind("gearbox"));
  const bearings = parts.filter(ofKind("bearing"));
  const controllers = parts.filter(ofKind("controller"));
  const loops = parts.filter(ofKind("loop"));

  const coaxial = (a: CadDrivetrainPart, b: CadDrivetrainPart, gap: number) =>
    coaxialAxes(a.fit, b.fit, gap);

  // Rotating groups: a shaft or roller with the wheels and rollers on it, and a motor with its
  // gearbox stack and the shaft, pinion, or sprocket at its output. Bearings support a group but
  // do not join it.
  const parent = new Map(parts.map((part) => [part.occurrenceId, part.occurrenceId]));
  const find = (id: string): string => {
    const up = parent.get(id)!;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const join = (a: CadDrivetrainPart, b: CadDrivetrainPart) =>
    parent.set(find(a.occurrenceId), find(b.occurrenceId));
  for (const carrier of [...shafts, ...rollers])
    for (const part of [...wheels, ...rollers, ...shafts])
      if (part !== carrier && coaxial(carrier, part, 0.002)) join(carrier, part);
  const stack = [...motors, ...gearboxes];
  for (const driver of stack)
    for (const part of [...wheels, ...shafts, ...gearboxes])
      if (part !== driver && coaxial(driver, part, 0.03)) join(driver, part);

  const groupOf = (part: CadDrivetrainPart) => find(part.occurrenceId);
  const members = new Map<string, CadDrivetrainPart[]>();
  for (const part of parts)
    if (part.role.kind !== "bearing" && part.role.kind !== "loop")
      members.set(groupOf(part), [...(members.get(groupOf(part)) ?? []), part]);
  const label = (group: string) => {
    const list = members.get(group) ?? [];
    const named =
      list.find((part) => part.role.kind === "shaft") ??
      list.find((part) => part.role.kind === "roller") ??
      list[0];
    return named?.name ?? "an unrecognized part";
  };

  // Shafts that sit inside one another carry duplicate geometry.
  for (let i = 0; i < shafts.length; i++)
    for (let j = i + 1; j < shafts.length; j++) {
      const a = shafts[i]!;
      const b = shafts[j]!;
      if (!coaxial(a, b, -0.005)) continue;
      const overlap =
        a.fit.halfLength +
        b.fit.halfLength -
        Math.abs(dot(sub(b.fit.center, a.fit.center), a.fit.axis));
      if (overlap < 0.01) continue;
      findings.push({
        kind: "stacked-shafts",
        problem: true,
        summary: `${a.name} and ${b.name} occupy the same axis for ${inches(overlap)}: one shaft is modeled inside the other.`,
        occurrences: [ref(a), ref(b)],
      });
    }

  interface Link {
    readonly from: string;
    readonly to: string;
    readonly ratio: number;
    readonly text: string;
  }
  const links: Link[] = [];
  // Links run both ways; each direction names its driving wheel first ("7T to 40T gears").
  const connect = (
    a: RoleOf<"gear" | "pulley" | "sprocket">,
    b: RoleOf<"gear" | "pulley" | "sprocket">,
    via: string,
  ) => {
    links.push({
      from: groupOf(a),
      to: groupOf(b),
      ratio: b.role.teeth / a.role.teeth,
      text: `${a.role.teeth}T to ${b.role.teeth}T ${via}`,
    });
    links.push({
      from: groupOf(b),
      to: groupOf(a),
      ratio: a.role.teeth / b.role.teeth,
      text: `${b.role.teeth}T to ${a.role.teeth}T ${via}`,
    });
  };

  // Gear meshes: parallel axes, faces in line, and the same diametral pitch.
  for (let i = 0; i < gears.length; i++)
    for (let j = i + 1; j < gears.length; j++) {
      const a = gears[i]!;
      const b = gears[j]!;
      if (groupOf(a) === groupOf(b) || Math.abs(dot(a.fit.axis, b.fit.axis)) < PARALLEL) continue;
      const pitch = a.role.diametralPitch ?? b.role.diametralPitch;
      if (
        !pitch ||
        (a.role.diametralPitch &&
          b.role.diametralPitch &&
          a.role.diametralPitch !== b.role.diametralPitch)
      )
        continue;
      const ideal = ((a.role.meshTeeth + b.role.meshTeeth) / (2 * pitch)) * INCH;
      const actual = lineDistance(b.fit.center, a.fit.center, a.fit.axis);
      const error = actual - ideal;
      if (Math.abs(error) > 0.15 * ideal) continue;
      const faceGap =
        Math.abs(dot(sub(b.fit.center, a.fit.center), a.fit.axis)) -
        a.fit.halfLength -
        b.fit.halfLength;
      if (faceGap > UNRELATED_AXIAL_GAP) continue;
      const pair = `the ${a.role.teeth}T ${a.name} and ${b.role.teeth}T ${b.name}`;
      const stage = ratio(
        Math.max(a.role.teeth, b.role.teeth) / Math.min(a.role.teeth, b.role.teeth),
      );
      const spacing = error >= -MESH_TOO_CLOSE && error <= MESH_TOO_FAR;
      const both =
        partLabel(a.name) === partLabel(b.name)
          ? `the two ${partLabel(a.name)}s`
          : `${partPhrase(a.name)} and ${partPhrase(b.name)}`;
      const miss = `their faces miss each other by ${inches(faceGap)} along the shaft`;
      const off = `${inches(Math.abs(error))} too ${error < 0 ? "close and will bind" : "far apart and will skip"}`;
      const center = `move one shaft so the centers are ${inches(ideal)} apart`;
      const gearPair =
        a.role.teeth === b.role.teeth
          ? `Two ${a.role.teeth}T gears`
          : `${a.role.teeth}T and ${b.role.teeth}T gears`;
      findings.push({
        kind: "gear-mesh",
        problem: !spacing || faceGap > 0,
        // A pair can be off in both directions at once; each error gets its own fix.
        ...(faceGap > 0
          ? {
              comment: spacing
                ? {
                    title: `${gearPair} miss each other`,
                    body: `${upperFirst(both)} are at mesh distance, but ${miss}, so they don't mesh. Move one gear along its shaft so the faces line up.`,
                  }
                : {
                    title: `${gearPair} do not mesh`,
                    body: `${upperFirst(both)} are ${inches(actual)} apart, but these ${pitch} DP gears need ${inches(ideal)}, and ${miss}, so they don't mesh. Move one gear along its shaft so the faces line up, and ${center}.`,
                  },
            }
          : spacing
            ? {}
            : {
                comment: {
                  title: `${gearPair} are too ${error < 0 ? "close" : "far apart"}`,
                  body: `${upperFirst(both)} are ${inches(actual)} apart, but these ${pitch} DP gears need ${inches(ideal)}. They are ${off}. The stage is ${stage}. ${upperFirst(center)}.`,
                },
              }),
        summary:
          faceGap > 0
            ? spacing
              ? `${pair} are at mesh distance but ${miss}, so they do not mesh.`
              : `${pair} are ${inches(actual)} apart, where ${pitch} DP needs ${inches(ideal)}, and ${miss}, so they do not mesh.`
            : spacing
              ? `${pair} mesh at ${inches(actual)} center distance (${inches(ideal)} exact for ${pitch} DP), a ${stage} stage.`
              : `${pair} are ${inches(actual)} apart; ${pitch} DP needs ${inches(ideal)}. They are ${off}. The stage would be ${stage}.`,
        occurrences: [ref(a), ref(b)],
      });
      if (faceGap <= 0) connect(a, b, "gears");
    }

  // Belts and chains: wheels whose axes are normal to the loop's plane and sit inside it.
  for (const loop of loops) {
    // A loop is flat: its smallest spread is the plane normal, its largest the span.
    const [span, cross, width] = loop.fit.candidates;
    const origin = loop.fit.boxCenter;
    const along = (p: Vector3) => dot(sub(p, origin), span.axis);
    const across = (p: Vector3) => dot(sub(p, origin), cross.axis);
    const noun = loop.role.wraps;
    const wrapped = wheels.filter((wheel): wheel is RoleOf<"pulley" | "sprocket"> => {
      if (wheel.role.kind !== loop.role.wraps || Math.abs(dot(wheel.fit.axis, width.axis)) < 0.98)
        return false;
      const offset = Math.abs(dot(sub(wheel.fit.center, origin), width.axis));
      return (
        offset <= width.halfLength + wheel.fit.halfLength &&
        Math.abs(along(wheel.fit.center)) <= span.halfLength &&
        Math.abs(across(wheel.fit.center)) <= cross.halfLength
      );
    });
    const length = loop.role.teeth * loop.role.pitchMm;
    const bare = [-span.halfLength, span.halfLength].filter(
      (end) =>
        !wrapped.some(
          (wheel) => Math.abs(along(wheel.fit.center) - end) <= wheel.fit.radius + 0.006,
        ),
    ).length;
    if (wrapped.length < 2 || bare > 0) {
      const loopWord = noun === "sprocket" ? "chain" : "belt";
      findings.push({
        kind: "loop",
        problem: true,
        comment:
          wrapped.length === 0
            ? {
                title: `${upperFirst(partLabel(loop.name))} has no ${noun}s`,
                body: `${upperFirst(partPhrase(loop.name))} (${Number(length.toFixed(1))} mm) has no ${noun}s, so nothing turns it and it drives nothing. Add a ${noun} at each end, or remove the ${loopWord} if it is left over, then check its length against the centers.`,
              }
            : {
                title: `${upperFirst(partLabel(loop.name))} has no ${noun} at ${bare === 2 ? "either end" : "one end"}`,
                body: `${upperFirst(partPhrase(loop.name))} has no ${noun} at ${bare === 2 ? "either end" : "one end"}; it wraps only ${partList(wrapped.map((wheel) => wheel.name))}. Add a ${noun} at the bare end${bare === 2 ? "s" : ""}, then check the ${loopWord}'s length against the centers.`,
              },
        summary:
          wrapped.length === 0
            ? `${loop.name} (${Number(length.toFixed(1))} mm) wraps no recognized ${noun}: nothing turns it and it drives nothing.`
            : `${loop.name} (${Number(length.toFixed(1))} mm) has no ${noun} at ${bare === 2 ? "either end" : "one end"} of its loop; it wraps only ${names(wrapped)}.`,
        occurrences: [ref(loop), ...wrapped.map(ref)],
      });
      continue;
    }
    // An idler or tensioner changes the path, so a loop around more than two wheels is not measured.
    if (wrapped.length > 2) {
      findings.push({
        kind: "loop-length",
        problem: false,
        summary: `${loop.name} wraps ${names(wrapped)}, so its length was not checked.`,
        occurrences: [ref(loop), ...wrapped.map(ref)],
      });
      // Every wheel on the loop turns with it, whichever drives.
      for (const wheel of wrapped.slice(1))
        connect(wrapped[0]!, wheel, noun === "sprocket" ? "chain" : "belt");
      continue;
    }
    const [a, b] = [wrapped[0]!, wrapped[wrapped.length - 1]!];
    const centers = Math.abs(along(b.fit.center) - along(a.fit.center));
    const ra = (a.role.teeth * loop.role.pitchMm) / (2 * Math.PI) / 1000;
    const rb = (b.role.teeth * loop.role.pitchMm) / (2 * Math.PI) / 1000;
    const needed = (2 * centers + Math.PI * (ra + rb) + (ra - rb) ** 2 / centers) * 1000;
    const error = needed - length;
    // Chains take up up to a link of slack; belts must match closely.
    const chain = noun === "sprocket";
    const fits = Math.abs(error) <= (chain ? loop.role.pitchMm : 1.5);
    const mismatch = chain
      ? error > 0
        ? `it is ${(error / loop.role.pitchMm).toFixed(1)} links short`
        : `it has ${(-error / loop.role.pitchMm).toFixed(1)} links of slack, so it needs a tensioner or a ${inches(-error / 2000)} longer center distance`
      : `it is ${Math.abs(error).toFixed(1)} mm too ${error > 0 ? "short" : "long"}; move a pulley ${inches(Math.abs(error) / 2000)} or pick another belt`;
    findings.push({
      kind: "loop-length",
      // Chain slack is a lead: a tensioner the check cannot see may take it up.
      problem: !fits && !(chain && error < 0),
      summary: fits
        ? `${loop.name} wraps ${a.name} and ${b.name} at ${inches(centers)} centers; its length matches.`
        : `${loop.name} is ${Number(length.toFixed(1))} mm, but ${a.name} and ${b.name} at ${inches(centers)} centers need about ${needed.toFixed(0)} mm: ${mismatch}.`,
      occurrences: [ref(loop), ref(a), ref(b)],
    });
    connect(a, b, chain ? "chain" : "belt");
  }

  // Motor mounts: a motor bolts to its plate by the face its shaft comes out of. A controller on
  // the axis in front of that face (a SPARK Flex docked on the wrong end) sits between the motor
  // and its mount, so nothing holds the motor.
  for (const motor of motors) {
    const output = (members.get(groupOf(motor)) ?? []).filter(
      (part) => part !== motor && part.role.kind !== "gearbox",
    );
    const side = output.reduce(
      (sum, part) => sum + dot(sub(part.fit.center, motor.fit.center), motor.fit.axis),
      0,
    );
    if (output.length === 0 || Math.abs(side) < 1e-6) continue;
    const forward = Math.sign(side);
    const inFront = controllers.filter((controller) => {
      if (
        lineDistance(controller.fit.center, motor.fit.center, motor.fit.axis) >
        0.5 * motor.fit.radius
      )
        return false;
      const offset = forward * dot(sub(controller.fit.center, motor.fit.center), motor.fit.axis);
      return offset > 0 && offset <= motor.fit.halfLength + controller.fit.halfLength + 0.01;
    });
    if (inFront.length === 0) continue;
    const several = inFront.length > 1;
    findings.push({
      kind: "motor-mount",
      problem: true,
      comment: {
        body: `${upperFirst(partList(inFront.map((controller) => controller.name)))} ${several ? "sit" : "sits"} in front of ${partPhrase(motor.name)}, on the side its shaft comes out of. That puts ${several ? "them" : "it"} between the motor face and the plate the motor bolts to, so the motor is not held. Controllers that dock to a motor go on the back. Move the controller to the back of the motor so the motor face bolts to its plate.`,
      },
      summary: `${names(inFront)} sits in front of ${motor.name}, on the side its shaft comes out of. That puts it between the motor face and whatever the motor bolts to, so the motor is not held. Controllers that dock to a motor go on the back.`,
      occurrences: [ref(motor), ...inFront.map(ref)],
    });
  }

  // Bearings: every shaft outside a motor's own stack needs at least one.
  const motorGroups = new Set(motors.map(groupOf));
  for (const shaft of shafts) {
    if (motorGroups.has(groupOf(shaft))) continue;
    const group = members.get(groupOf(shaft)) ?? [];
    if (group.some((part) => bearings.some((bearing) => coaxial(part, bearing, 0)))) continue;
    const carried = group.filter((part) => part !== shaft && part.role.kind !== "shaft");
    findings.push({
      kind: "shaft-support",
      problem: true,
      summary: `No recognized bearing sits on ${shaft.name}${carried.length > 0 ? `, which carries ${names(carried)}` : ""}, so nothing holds the shaft in place.`,
      occurrences: [ref(shaft), ...carried.map(ref)],
    });
  }

  // Power: breadth-first from each motor through meshes, belts, and chains. The path is a fact,
  // not a problem: an arm's last gear drives the arm itself, which is not a recognized part. A
  // leaf on a recognized shaft is a confirmed dead end; anywhere else the next part may simply be
  // unrecognized, which makes the unpowered-roller finding below uncertain.
  const reached = new Set<string>();
  // Shafts where a traced drive ends, for the unpowered draft to point at.
  const stopped = new Set<string>();
  let untraced = false;
  const traces = new Map<
    string,
    {
      motors: CadDrivetrainPart[];
      summary: string;
      occurrences: CadDrivetrainFinding["occurrences"];
    }
  >();
  for (const motor of motors) {
    const start = groupOf(motor);
    const reduction = (members.get(start) ?? [])
      .filter(ofKind("gearbox"))
      .reduce((product, gearbox) => product * gearbox.role.ratio, 1);
    const visited = new Map<string, { parent: string | null; ratio: number; via: string }>([
      [start, { parent: null, ratio: reduction, via: "" }],
    ]);
    const queue = [start];
    while (queue.length > 0) {
      const group = queue.shift()!;
      const here = visited.get(group)!;
      for (const link of links)
        if (link.from === group && !visited.has(link.to)) {
          visited.set(link.to, { parent: group, ratio: here.ratio * link.ratio, via: link.text });
          queue.push(link.to);
        }
    }
    for (const group of visited.keys()) reached.add(group);
    const output = (members.get(start) ?? []).filter(
      (part) => part !== motor && part.role.kind !== "gearbox",
    );
    if (visited.size === 1 && output.length === 0) {
      untraced = true;
      findings.push({
        kind: "power-path",
        problem: false,
        summary: `Could not trace ${motor.name}: no recognized gear, pulley, sprocket, or shaft sits at its output. Check its drive by eye.`,
        occurrences: [ref(motor)],
      });
      continue;
    }
    const parents = new Set([...visited.values()].map((entry) => entry.parent));
    const stops: string[] = [];
    for (const [group] of visited) {
      if (parents.has(group) || group === start) continue;
      const list = members.get(group) ?? [];
      if (list.some((part) => part.role.kind === "roller")) continue;
      if (list.some((part) => part.role.kind === "shaft")) {
        stops.push(label(group));
        stopped.add(label(group));
      } else untraced = true;
    }
    const steps = [...visited.entries()]
      .filter(([group]) => group !== start)
      .map(([group, entry]) => `${label(group)} at ${ratio(entry.ratio)} (${entry.via})`);
    const drivenRollers = rollers.filter((roller) => visited.has(groupOf(roller)));
    const summary = [
      `${reduction > 1 ? `through a ${ratio(reduction)} planetary, ` : ""}turns ${steps.length > 0 ? steps.join(", ") : names(output)}.`,
      stops.length > 0
        ? `Power stops at ${stops.join(" and ")}: nothing else on ${stops.length > 1 ? "them" : "it"} drives another recognized part.`
        : "",
      rollers.length > 0 ? `${drivenRollers.length} of ${rollers.length} rollers are driven.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // Motors that drive one gear train (two motors on a gearbox) are reported together.
    const key = [...visited.keys()].sort().join(" ");
    const prior = traces.get(key);
    if (prior) prior.motors.push(motor);
    else
      traces.set(key, {
        motors: [motor],
        summary,
        occurrences: [...visited.keys()].flatMap((group) =>
          (members.get(group) ?? []).filter((part) => part.role.kind !== "motor").map(ref),
        ),
      });
  }
  for (const trace of traces.values())
    findings.push({
      kind: "power-path",
      problem: false,
      summary: `${names(trace.motors)} ${trace.summary}`,
      occurrences: [...trace.motors.map(ref), ...trace.occurrences],
    });
  const unpowered = rollers.filter((roller) => !reached.has(groupOf(roller)));
  // A roller left out while others are driven may be an idler.
  const unpoweredProblem = !untraced && unpowered.length === rollers.length;
  const rollerWord = unpowered.every((roller) => /wheel/i.test(roller.name)) ? "wheel" : "roller";
  // "None of the 3 rollers is driven", not their CAD names: the draft's targets point at them.
  const which = unpowered.length > 1 ? `${unpowered.length} ${rollerWord}s` : rollerWord;
  const them = unpowered.length > 1 ? `the ${rollerWord}s` : `the ${rollerWord}`;
  const source = motors.length > 1 ? "the motors" : "the motor";
  const where = [...stopped];
  const unpoweredBody =
    where.length > 0
      ? `${unpowered.length > 1 ? `None of the ${which} is` : `The ${which} is not`} driven: power from ${source} stops at ${partList(where)}, and no gear, belt, or chain carries it on to ${them}. Add a gear or belt stage from ${where.length === 1 ? partPhrase(where[0]!) : "one of those shafts"} to ${them}.`
      : `${unpowered.length > 1 ? `None of the ${which} is` : `The ${which} is not`} driven: nothing in the model carries power from ${source} to ${unpowered.length > 1 ? "them" : "it"}. Add a gear or belt stage from ${source} to ${them}.`;
  if (motors.length > 0 && unpowered.length > 0)
    findings.push({
      kind: "unpowered",
      problem: unpoweredProblem,
      ...(unpoweredProblem
        ? { comment: { title: `Motor does not reach ${them}`, body: unpoweredBody } }
        : {}),
      summary: untraced
        ? `No traced motor reaches ${names(unpowered)}, but some drives could not be traced, so check whether one of those drives them.`
        : `No motor reaches ${names(unpowered)}: the gears, belts, and chains as modeled do not connect ${unpowered.length > 1 ? "them" : "it"} to a motor.`,
      occurrences: unpowered.map(ref),
    });
  return findings;
};
