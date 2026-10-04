import type { FeatureScriptInputKind } from "@cadsense/contracts";

/** Unit words a person may type after a number, and the std constant each means. */
const UNITS: Readonly<Partial<Record<FeatureScriptInputKind, Readonly<Record<string, string>>>>> = {
  length: {
    "": "millimeter",
    mm: "millimeter",
    cm: "centimeter",
    m: "meter",
    in: "inch",
    inch: "inch",
    ft: "foot",
    yd: "yard",
  },
  angle: { "": "degree", deg: "degree", "°": "degree", rad: "radian" },
};
const NUMBER = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)\s*([a-z°]*)\s*$/i;

/**
 * The FeatureScript expression for what a person typed into a dialog row, or null for an empty
 * field (the input goes back to its default). A number with no unit is in the unit the dialog shows
 * (millimeters, degrees); anything that isn't a number with a known unit is used as written.
 */
export function inputExpression(kind: FeatureScriptInputKind, text: string): string | null {
  if (text.trim() === "") return null;
  if (kind === "string") return JSON.stringify(text);
  const units = UNITS[kind];
  const match = NUMBER.exec(text);
  if (units && match) {
    const unit = units[match[2]!.toLowerCase()];
    if (unit) return `${match[1]} * ${unit}`;
  }
  if ((kind === "integer" || kind === "real") && match && match[2] === "") return match[1]!;
  return text.trim();
}

/** A point in the preview's model space: meters, Z up. */
export type ModelPoint = readonly [number, number, number];

const millimeters = (meters: number) => String(+(meters * 1000).toFixed(4));

/**
 * The query for faces picked in the preview: the base model's face nearest each point. A click lands
 * on the tessellation, which can sit tens of microns off a curved face, so `qContainsPoint` would
 * miss it. Points are in meters; the expression is in millimeters.
 */
export function pickExpression(points: readonly ModelPoint[]): string {
  const queries = points.map(
    (point) =>
      `qClosestTo(qCreatedBy(makeId("Base"), EntityType.FACE), vector(${point.map(millimeters).join(", ")}) * millimeter)`,
  );
  return queries.length === 1 ? queries[0]! : `qUnion([${queries.join(", ")}])`;
}
