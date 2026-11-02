// Shop rules of thumb an agent would apply to a part:
// what a hole diameter probably means and which stock to cut from.
import {
  METERS_PER_INCH,
  type Countersink,
  type HoleGroup,
  type PartAnalysis,
  type Vec3,
} from "./analysis";

export type Units = "in" | "mm";

/** Decimal inches the way drawings print them: .375, 1.500. */
export const formatInch = (meters: number, places = 3) => {
  const text = (meters / METERS_PER_INCH).toFixed(places);
  return text.startsWith("0.") ? text.slice(1) : text;
};

/** Fractions for the shop floor when the value lands on a 1/64, otherwise decimals. */
export const formatFraction = (meters: number) => {
  const inches = meters / METERS_PER_INCH;
  const sixtyFourths = Math.round(inches * 64);
  if (Math.abs(sixtyFourths / 64 - inches) > 0.0005) return `${formatInch(meters)}"`;
  const whole = Math.floor(sixtyFourths / 64);
  let numerator = sixtyFourths % 64;
  let denominator = 64;
  while (numerator > 0 && numerator % 2 === 0) {
    numerator /= 2;
    denominator /= 2;
  }
  if (numerator === 0) return `${whole}"`;
  return whole > 0 ? `${whole}-${numerator}/${denominator}"` : `${numerator}/${denominator}"`;
};

/** A dimension in the sheet's units, without a unit mark (the sheet states its units). */
export const formatLength = (meters: number, units: Units, places = 3) =>
  units === "mm" ? (meters * 1000).toFixed(places - 1) : formatInch(meters, places);

/** A size in running text, with its unit: 1-1/2" in inches, 38.1 mm in millimeters. */
export const formatSize = (meters: number, units: Units) =>
  units === "mm" ? `${(meters * 1000).toFixed(1)} mm` : formatFraction(meters);

/** " mm" after millimeter numbers in running text; inch numbers go bare, as drawings print them. */
export const unitSuffix = (units: Units) => (units === "mm" ? " mm" : "");

/** A dimension in running text: .375 in inches, 9.53 mm in millimeters. */
const measure = (meters: number, units: Units, places = 3) =>
  `${formatLength(meters, units, places)}${unitSuffix(units)}`;

/** Tolerances for the title block and operations, per units. */
export const TOLERANCES = {
  in: { two: ".XX  ±.01", three: ".XXX ±.005", face: "±.005", edges: ".010-.020" },
  mm: { two: "X.X  ±0.25", three: "X.XX ±0.13", face: "±0.13", edges: "0.25-0.50 MM" },
} as const satisfies Record<Units, Record<string, string>>;

/** One way to read a modeled hole. The first option is the default guess. */
export interface HoleReading {
  /** Stable across units, so a confirmed choice survives a units switch. */
  readonly id: string;
  readonly label: string;
  /** What the callout names: a thread, a hex, or the modeled diameter. */
  readonly callout: string;
  /** Tap drill or drill size the shop uses. */
  readonly drill: string;
  readonly tap: string | null;
}

interface HoleRule {
  readonly diameterIn: number;
  readonly readings: readonly {
    readonly label: string;
    readonly callout: string;
    /** Drill name; its size follows in the sheet's units. */
    readonly drill: string;
    /** Null for metric drills, whose name is their size. */
    readonly drillIn: number | null;
    readonly tap: string | null;
  }[];
}

// Tap drills and clearance holes FRC shops actually see. Onshape's Hole feature models
// tapped holes at the tap drill diameter, so a .159 hole is usually a 10-32 tap.
const HOLE_RULES: readonly HoleRule[] = [
  {
    diameterIn: 0.1065,
    readings: [
      { label: "6-32 tap", callout: "6-32 UNC", drill: "#36", drillIn: 0.1065, tap: "6-32" },
    ],
  },
  {
    diameterIn: 0.136,
    readings: [
      { label: "8-32 tap", callout: "8-32 UNC", drill: "#29", drillIn: 0.136, tap: "8-32" },
    ],
  },
  {
    diameterIn: 0.1495,
    readings: [
      { label: "10-24 tap", callout: "10-24 UNC", drill: "#25", drillIn: 0.1495, tap: "10-24" },
    ],
  },
  {
    diameterIn: 0.159,
    readings: [
      { label: "10-32 tap", callout: "10-32 UNF", drill: "#21", drillIn: 0.159, tap: "10-32" },
    ],
  },
  {
    diameterIn: 0.19,
    readings: [{ label: "#10 close fit", callout: "", drill: "#11", drillIn: 0.191, tap: null }],
  },
  {
    diameterIn: 0.196,
    readings: [{ label: "#10 clearance", callout: "", drill: "#9", drillIn: 0.196, tap: null }],
  },
  {
    diameterIn: 0.201,
    readings: [
      { label: "1/4-20 tap", callout: "1/4-20 UNC", drill: "#7", drillIn: 0.201, tap: "1/4-20" },
      { label: "#10 free clearance", callout: "", drill: "#7", drillIn: 0.201, tap: null },
    ],
  },
  {
    diameterIn: 0.209,
    readings: [
      { label: "#10 loose clearance", callout: "", drill: "#4", drillIn: 0.209, tap: null },
    ],
  },
  {
    diameterIn: 0.257,
    readings: [{ label: "1/4 clearance", callout: "", drill: "F", drillIn: 0.257, tap: null }],
  },
  {
    diameterIn: 0.0984,
    readings: [{ label: "M3 tap", callout: "M3x0.5", drill: "2.5 mm", drillIn: null, tap: "M3" }],
  },
  {
    diameterIn: 0.1299,
    readings: [{ label: "M4 tap", callout: "M4x0.7", drill: "3.3 mm", drillIn: null, tap: "M4" }],
  },
  {
    diameterIn: 0.1654,
    readings: [{ label: "M5 tap", callout: "M5x0.8", drill: "4.2 mm", drillIn: null, tap: "M5" }],
  },
];

// Hex bores are broached to the shaft's nominal size; the model carries a little clearance.
const STANDARD_HEX_IN = [0.25, 0.375, 0.5, 0.625, 0.75, 1.125];

/**
 * "1/2"" for a hex bore near a stock hex size (sold in inches), else its modeled across-flats
 * size in the sheet's units.
 */
const hexSize = (flats: number, units: Units) => {
  const nominal = STANDARD_HEX_IN.find(
    (size) => flats / METERS_PER_INCH - size > -0.002 && flats / METERS_PER_INCH - size < 0.012,
  );
  if (nominal) return formatFraction(nominal * METERS_PER_INCH);
  return units === "mm" ? measure(flats, units) : `${formatInch(flats)}"`;
};

/**
 * Readings for a hole, best guess first. A through hole is a clearance hole unless the user
 * says otherwise: .201 through a tube or plate wall is the #10 free fit far more often than a
 * 1/4-20 tap, and a wrong tap scraps the part. Blind holes keep the tap first.
 */
export const holeReadings = (group: HoleGroup, units: Units): HoleReading[] => {
  const diameter = `Ø${formatLength(group.diameter, units)}`;
  if (group.hex) {
    const size = hexSize(group.diameter, units);
    return [
      {
        id: "hex",
        label: `${size} hex broach`,
        // Inch drawings drop the inch mark; a millimeter drawing keeps it on an inch size.
        callout: `${units === "in" ? size.replace('"', "") : size} HEX`,
        drill: `Ø${measure(group.diameter, units)}, broach ${size} hex`,
        tap: null,
      },
    ];
  }
  const inches = group.diameter / METERS_PER_INCH;
  const rule = HOLE_RULES.find((candidate) => Math.abs(candidate.diameterIn - inches) < 0.0015);
  const plain: HoleReading = {
    id: "plain",
    label: `Plain ${diameter} hole`,
    callout: diameter,
    drill: `Ø${measure(group.diameter, units)}`,
    tap: null,
  };
  const known = (rule?.readings ?? []).map(
    (reading): HoleReading => ({
      id: reading.label,
      label: reading.label,
      // Clearance callouts print the modeled size, not the rule's nominal one.
      callout: reading.tap ? reading.callout : diameter,
      drill:
        reading.drillIn === null
          ? reading.drill
          : `${reading.drill} (${measure(reading.drillIn * METERS_PER_INCH, units)})`,
      tap: reading.tap,
    }),
  );
  const preferClearance = group.depth === null;
  return [
    ...known.sort((a, b) =>
      preferClearance ? Number(a.tap !== null) - Number(b.tap !== null) : 0,
    ),
    plain,
  ];
};

/**
 * Callout text for a hole group, e.g. "10-32 UNF ↧.50 BOTH ENDS". `toward` is the direction to
 * the viewer of the view the callout sits in; a countersink on the side away from the viewer
 * says FAR SIDE. Without a view, sides are named from where the drill enters. A BOTH ENDS pair
 * has each countersink at its own entry, so it names no side.
 */
export const holeCallout = (
  group: HoleGroup,
  reading: HoleReading,
  units: Units,
  toward?: Vec3,
) => {
  const count = group.bothEnds ? "" : group.holes.length > 1 ? `${group.holes.length}X ` : "";
  const depth = group.depth === null ? "THRU" : `↧${formatLength(group.depth, units, 2)}`;
  const sink = (countersink: Countersink) =>
    `⌵Ø${formatLength(countersink.diameter, units)}×${countersink.angle.toFixed(0)}°`;
  const { countersink: entry, farCountersink: exit } = group;
  // The drill enters on the viewer's side when it travels away from the viewer.
  const direction = group.holes[0]?.direction;
  const entryNear =
    !toward || !direction || group.bothEnds
      ? true
      : direction[0] * toward[0] + direction[1] * toward[1] + direction[2] * toward[2] < 0;
  const sinks =
    entry && exit && sink(entry) === sink(exit)
      ? ` ${sink(entry)} BOTH SIDES`
      : [
          ...(entry ? [`${sink(entry)}${entryNear ? "" : " FAR SIDE"}`] : []),
          ...(exit ? [`${sink(exit)}${entryNear ? " FAR SIDE" : ""}`] : []),
        ]
          .map((text) => ` ${text}`)
          .join("");
  const where = group.bothEnds ? " BOTH ENDS" : "";
  return `${count}${reading.callout} ${depth}${sinks}${where}`;
};

const STANDARD_ROUND_IN = [
  0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2,
];
const STANDARD_PLATE_IN = [0.0625, 0.09, 0.125, 0.1875, 0.25, 0.375, 0.5];

export interface Stock {
  readonly description: string;
  readonly note: string | null;
}

/** Stock sizes print in the inches they are sold by; lengths to cut follow the sheet's units. */
export const stockFor = (part: PartAnalysis, material: string, units: Units): Stock => {
  const { shape } = part;
  if (/3d print|pla|petg|onyx|nylon|tpu/i.test(material)) {
    return { description: `3D print (${material})`, note: null };
  }
  if (shape.kind === "turned") {
    const od = shape.diameter / METERS_PER_INCH;
    const exact = STANDARD_ROUND_IN.find((size) => Math.abs(size - od) < 0.002);
    const next = STANDARD_ROUND_IN.find((size) => size > od);
    const cut = shape.length + METERS_PER_INCH / 16;
    if (exact) {
      return {
        description: `${formatFraction(exact * METERS_PER_INCH)} round bar, cut ${formatSize(cut, units)} long`,
        note: "OD is stock size, no turning needed",
      };
    }
    return {
      description: `${next ? formatFraction(next * METERS_PER_INCH) : "oversize"} round bar, cut ${formatSize(cut, units)} long`,
      note: `Turn OD to Ø${measure(shape.diameter, units)}`,
    };
  }
  if (shape.kind === "roundTube") {
    return {
      description: `${formatFraction(shape.diameter)} OD × ${formatInch(shape.wall)}" wall round tube, cut ${formatSize(shape.length + METERS_PER_INCH / 16, units)} long`,
      note: "Face both ends to length",
    };
  }
  if (shape.kind === "hex") {
    const flats = shape.flats / METERS_PER_INCH;
    const size = STANDARD_HEX_IN.find((candidate) => Math.abs(candidate - flats) < 0.01);
    // Rounded hex keeps its corners inside a circle only a little larger than the flats.
    const rounded = part.frame.size[1] / shape.flats < 1.12;
    const cut = shape.length + METERS_PER_INCH / 16;
    return {
      description: `${size ? formatFraction(size * METERS_PER_INCH) : `${formatInch(shape.flats)}"`} ${rounded ? "rounded hex" : "hex"} stock, cut ${formatSize(cut, units)} long`,
      note: size ? null : "Not a standard hex size",
    };
  }
  if (shape.kind === "tube") {
    return {
      description: `${formatFraction(shape.width)} × ${formatFraction(shape.height)} tube, cut ${formatSize(shape.length, units)} long`,
      note: "Square both ends after cutting",
    };
  }
  if (shape.kind === "plate") {
    const t = shape.thickness / METERS_PER_INCH;
    const exact = STANDARD_PLATE_IN.find((size) => Math.abs(size - t) < 0.003);
    return {
      description: `${exact ? formatFraction(exact * METERS_PER_INCH) : `${formatInch(shape.thickness)}"`} plate`,
      note: exact
        ? "Router or waterjet from sheet"
        : "Not a standard plate thickness, face to size",
    };
  }
  const [a, b, c] = part.frame.size;
  return {
    description: `Block ${formatLength(a, units)} × ${formatLength(b, units)} × ${formatLength(c, units)}${unitSuffix(units)}`,
    note: "Mill from bar",
  };
};

/**
 * Plain warnings for what the analysis found but could not dimension, so a sheet never looks
 * complete when it is not.
 */
export const unresolvedNotes = (part: PartAnalysis, units: Units): string[] => [
  ...part.unresolved.holes.map(
    ({ diameter, count }) =>
      `${count} Ø${measure(diameter, units)} ${count > 1 ? "holes have" : "hole has"} no bottom or exit in the model and ${count > 1 ? "are" : "is"} not dimensioned. Check the model.`,
  ),
  ...(part.unresolved.crossFeatures > 0
    ? [
        `${part.unresolved.crossFeatures} closed ${part.unresolved.crossFeatures > 1 ? "edges" : "edge"} on the round surface (likely cross holes) not dimensioned. Check the model.`,
      ]
    : []),
  ...(part.unresolved.profile
    ? [
        "The shaft has diameters or shapes (tapers, fillets, splines) not dimensioned here. Check the model.",
      ]
    : []),
];

export { isBoughtPart } from "@cadsense/shared/cadDrawing";
