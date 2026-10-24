// Shop rules of thumb an agent would apply to a part:
// what a hole diameter probably means, which stock to cut from, and in what order to make it.
import { METERS_PER_INCH, isShaft, type HoleGroup, type PartAnalysis } from "./analysis";

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

export const formatLength = (meters: number, units: Units, places = 3) =>
  units === "mm" ? (meters * 1000).toFixed(places - 1) : formatInch(meters, places);

/** One way to read a modeled hole. The first option is the default guess. */
export interface HoleReading {
  readonly id: string;
  readonly label: string;
  readonly callout: string;
  /** Tap drill or drill size the shop uses. */
  readonly drill: string;
  readonly tap: string | null;
}

interface HoleRule {
  readonly diameterIn: number;
  readonly readings: readonly Omit<HoleReading, "id">[];
}

// Tap drills and clearance holes FRC shops actually see. Onshape's Hole feature models
// tapped holes at the tap drill diameter, so a .159 hole is usually a 10-32 tap.
const HOLE_RULES: readonly HoleRule[] = [
  {
    diameterIn: 0.1065,
    readings: [{ label: "6-32 tap", callout: "6-32 UNC", drill: "#36 (.1065)", tap: "6-32" }],
  },
  {
    diameterIn: 0.136,
    readings: [{ label: "8-32 tap", callout: "8-32 UNC", drill: "#29 (.136)", tap: "8-32" }],
  },
  {
    diameterIn: 0.1495,
    readings: [{ label: "10-24 tap", callout: "10-24 UNC", drill: "#25 (.1495)", tap: "10-24" }],
  },
  {
    diameterIn: 0.159,
    readings: [{ label: "10-32 tap", callout: "10-32 UNF", drill: "#21 (.159)", tap: "10-32" }],
  },
  {
    diameterIn: 0.19,
    readings: [{ label: "#10 close fit", callout: "Ø.190", drill: "#11 (.191)", tap: null }],
  },
  {
    diameterIn: 0.196,
    readings: [{ label: "#10 clearance", callout: "Ø.196", drill: "#9 (.196)", tap: null }],
  },
  {
    diameterIn: 0.201,
    readings: [
      { label: "1/4-20 tap", callout: "1/4-20 UNC", drill: "#7 (.201)", tap: "1/4-20" },
      { label: "#10 free clearance", callout: "Ø.201", drill: "#7 (.201)", tap: null },
    ],
  },
  {
    diameterIn: 0.209,
    readings: [{ label: "#10 loose clearance", callout: "Ø.209", drill: "#4 (.209)", tap: null }],
  },
  {
    diameterIn: 0.257,
    readings: [{ label: "1/4 clearance", callout: "Ø.257", drill: "F (.257)", tap: null }],
  },
  {
    diameterIn: 0.0984,
    readings: [{ label: "M3 tap", callout: "M3x0.5", drill: "2.5 mm", tap: "M3" }],
  },
  {
    diameterIn: 0.1299,
    readings: [{ label: "M4 tap", callout: "M4x0.7", drill: "3.3 mm", tap: "M4" }],
  },
  {
    diameterIn: 0.1654,
    readings: [{ label: "M5 tap", callout: "M5x0.8", drill: "4.2 mm", tap: "M5" }],
  },
];

/** Readings for a hole, best guess first. A bore through a turned part is a clearance hole. */
export const holeReadings = (group: HoleGroup, part?: PartAnalysis): HoleReading[] => {
  const inches = group.diameter / METERS_PER_INCH;
  const rule = HOLE_RULES.find((candidate) => Math.abs(candidate.diameterIn - inches) < 0.0015);
  const plain: Omit<HoleReading, "id"> = {
    label: `Plain Ø${formatInch(group.diameter)} hole`,
    callout: `Ø${formatInch(group.diameter)}`,
    drill: `Ø${formatInch(group.diameter)}`,
    tap: null,
  };
  const preferClearance = group.depth === null && part !== undefined && isShaft(part.shape);
  const known = [...(rule?.readings ?? [])].sort((a, b) =>
    preferClearance ? Number(a.tap !== null) - Number(b.tap !== null) : 0,
  );
  // Clearance callouts print the modeled size, not the rule's nominal one.
  return [...known, plain].map((reading) => ({
    ...reading,
    callout: reading.tap ? reading.callout : `Ø${formatInch(group.diameter)}`,
    id: reading.label,
  }));
};

/** Callout text for a hole group, e.g. "10-32 UNF ↧.50 BOTH ENDS". */
export const holeCallout = (group: HoleGroup, reading: HoleReading, units: Units) => {
  const count = group.bothEnds ? "" : group.holes.length > 1 ? `${group.holes.length}X ` : "";
  const depth =
    group.depth === null ? "THRU" : `↧${formatLength(group.depth, units, units === "mm" ? 2 : 2)}`;
  const where = group.bothEnds ? " BOTH ENDS" : "";
  return `${count}${reading.callout} ${depth}${where}`;
};

const STANDARD_ROUND_IN = [
  0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2,
];
const STANDARD_HEX_IN = [0.25, 0.375, 0.5, 0.625, 0.75, 1.125];
const STANDARD_PLATE_IN = [0.0625, 0.09, 0.125, 0.1875, 0.25, 0.375, 0.5];

export interface Stock {
  readonly description: string;
  readonly note: string | null;
}

export const stockFor = (part: PartAnalysis, material: string): Stock => {
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
        description: `${formatFraction(exact * METERS_PER_INCH)} round bar, cut ${formatFraction(cut)} long`,
        note: "OD is stock size, no turning needed",
      };
    }
    return {
      description: `${next ? formatFraction(next * METERS_PER_INCH) : "oversize"} round bar, cut ${formatFraction(cut)} long`,
      note: `Turn OD to Ø${formatInch(shape.diameter)}`,
    };
  }
  if (shape.kind === "hex") {
    const flats = shape.flats / METERS_PER_INCH;
    const size = STANDARD_HEX_IN.find((candidate) => Math.abs(candidate - flats) < 0.01);
    // Rounded hex keeps its corners inside a circle only a little larger than the flats.
    const rounded = part.frame.size[1] / shape.flats < 1.12;
    const cut = shape.length + METERS_PER_INCH / 16;
    return {
      description: `${size ? formatFraction(size * METERS_PER_INCH) : `${formatInch(shape.flats)}"`} ${rounded ? "rounded hex" : "hex"} stock, cut ${formatFraction(cut)} long`,
      note: size ? null : "Not a standard hex size",
    };
  }
  if (shape.kind === "tube") {
    return {
      description: `${formatFraction(shape.width)} × ${formatFraction(shape.height)} tube, cut ${formatFraction(shape.length)} long`,
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
    description: `Block ${formatInch(a)} × ${formatInch(b)} × ${formatInch(c)}`,
    note: "Mill from bar",
  };
};

export interface Operation {
  readonly machine: string;
  readonly title: string;
  readonly detail: string;
  /** Hole group this step makes, so its view can highlight it. */
  readonly holeKey: string | null;
}

export const operationsFor = (
  part: PartAnalysis,
  material: string,
  readings: ReadonlyMap<string, HoleReading>,
): Operation[] => {
  const stock = stockFor(part, material);
  if (stock.description.startsWith("3D print")) {
    return [
      {
        machine: "Printer",
        title: "Print",
        detail: `${material}. Holes printed undersize, ream to size.`,
        holeKey: null,
      },
      ...part.holes.map((group) => ({
        machine: "Bench",
        title: `Clean up ${(readings.get(group.key) ?? holeReadings(group, part)[0]!).label}`,
        detail: `Drill ${readings.get(group.key)?.drill ?? "to size"}${group.depth === null ? " through" : ""}`,
        holeKey: group.key,
      })),
    ];
  }
  const ops: Operation[] = [];
  if (isShaft(part.shape)) {
    ops.push({ machine: "Saw", title: "Cut stock", detail: stock.description, holeKey: null });
    ops.push({
      machine: "Lathe",
      title: "Face to length",
      detail: `Face both ends to ${formatInch(part.shape.length)} ±.005${stock.note?.startsWith("Turn") ? `. ${stock.note}` : ""}`,
      holeKey: null,
    });
  } else if (part.shape.kind === "tube") {
    ops.push({ machine: "Saw", title: "Cut to length", detail: stock.description, holeKey: null });
  } else if (part.shape.kind === "plate") {
    // Router plates are cut from a DXF; plain through holes come with the outline.
    const routed = part.holes
      .filter((group) => group.depth === null)
      .reduce((sum, group) => sum + group.holes.length, 0);
    ops.push({
      machine: "Router",
      title: "Cut from DXF",
      detail: `${stock.description}, outline${routed ? ` and ${routed} through holes` : ""}`,
      holeKey: null,
    });
  } else {
    ops.push({ machine: "Mill", title: "Cut outline", detail: stock.description, holeKey: null });
  }
  for (const group of part.holes) {
    const reading = readings.get(group.key) ?? holeReadings(group, part)[0]!;
    if (part.shape.kind === "plate" && group.depth === null && !reading.tap) continue;
    const machine = isShaft(part.shape)
      ? "Lathe"
      : part.shape.kind === "plate"
        ? "Router"
        : part.shape.kind === "tube"
          ? "Drill press"
          : "Mill";
    const depth =
      group.depth === null
        ? part.shape.kind === "tube"
          ? "through both walls"
          : "through"
        : `${formatInch(group.depth, 2)} deep`;
    const ends = group.bothEnds
      ? ", flip and repeat"
      : group.holes.length > 1
        ? `, ${group.holes.length} places`
        : "";
    ops.push({
      machine,
      title: isShaft(part.shape) ? "Center drill and drill" : `Drill ${group.holes.length}X`,
      detail: `${reading.drill} ${depth}${ends}`,
      holeKey: group.key,
    });
    if (reading.tap) {
      ops.push({
        machine: "Bench",
        title: `Tap ${reading.tap}`,
        detail: `${group.depth === null ? "Through" : `${formatInch(group.depth * 0.85, 2)} full thread min`}${ends}`,
        holeKey: group.key,
      });
    }
  }
  ops.push({ machine: "Bench", title: "Deburr", detail: "Break all sharp edges", holeKey: null });
  return ops;
};

export { isBoughtPart } from "@cadsense/shared/cadDrawing";
