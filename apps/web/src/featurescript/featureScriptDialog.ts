import type { FeatureScriptInputKind } from "@cadsense/contracts";

import { randomUUID } from "../lib/utils";

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

/** A click on the model: where it landed, and the clicked face's unit normal, toward the viewer. */
export interface PickHit {
  readonly point: ModelPoint;
  readonly normal: ModelPoint;
}

const millimeters = (meters: number) => String(+(meters * 1000).toFixed(4));

/** The faces the preview draws: the base's and earlier features', not sketch regions or planes. */
const DRAWN_FACES =
  "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";

/**
 * The query for faces picked in the preview: the drawn face nearest each point. A click lands on
 * the tessellation, which can sit tens of microns off a curved face, so `qContainsPoint` would miss
 * it. Points are in meters; the expression is in millimeters.
 */
export function pickExpression(points: readonly ModelPoint[]): string {
  const queries = points.map(
    (point) =>
      `qClosestTo(${DRAWN_FACES}, vector(${point.map(millimeters).join(", ")}) * millimeter)`,
  );
  return queries.length === 1 ? queries[0]! : `qUnion([${queries.join(", ")}])`;
}

/**
 * What a click in the preview gives a query input, read from its "Filter": the nearest face, a
 * point (a mate connector at the click, or its vertex where only vertices are allowed), or nothing
 * for filters a click can't satisfy (edges, whole bodies). No filter takes faces.
 */
export function pickKind(
  filter: string | null,
):
  | { readonly kind: "face" }
  | { readonly kind: "point"; readonly entity: "BODY" | "VERTEX" }
  | null {
  if (filter === null) return { kind: "face" };
  if (/FACE|PLANE|CYLINDER|CONE|SPHERE|TORUS|ALLOWS_DIRECTION|ALLOWS_AXIS/.test(filter))
    return { kind: "face" };
  if (/MATE_CONNECTOR|ALLOWS_VERTEX/.test(filter)) return { kind: "point", entity: "BODY" };
  if (/VERTEX/.test(filter)) return { kind: "point", entity: "VERTEX" };
  return null;
}

/** The query for points picked in the preview, which the server makes into mate connectors. */
export function pointExpression(ids: readonly string[], entity: "BODY" | "VERTEX"): string {
  const queries = ids.map(
    (id) => `qCreatedBy(makeId("Picked") + ${JSON.stringify(id)}, EntityType.${entity})`,
  );
  return queries.length === 1 ? queries[0]! : `qUnion([${queries.join(", ")}])`;
}

/** A fresh id for a picked point. */
export const newPickId = () => `p${randomUUID().replaceAll("-", "").slice(0, 16)}`;

/**
 * A list input's value: each item a map of the inner inputs it sets. The runtime fills the rest
 * with their defaults, as Onshape's dialog does for a new item.
 */
export function listExpression(items: readonly Readonly<Record<string, string>>[]): string {
  const item = (parameters: Readonly<Record<string, string>>) => {
    const entries = Object.entries(parameters);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([id, expression]) => `${JSON.stringify(id)} : ${expression}`).join(", ")} }`;
  };
  return `[${items.map(item).join(", ")}]`;
}
