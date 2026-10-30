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

/**
 * A click on the model: where it landed on the drawn triangles, the clicked face's unit normal
 * (toward the viewer) and its probe (a point inside it on its true surface, from the GLB; null
 * when the GLB has none), and the clicked body's edge (where on it, and its exact middle) and
 * vertex the click is on, if within a few pixels (see featureScriptSnap).
 */
export interface PickHit {
  readonly point: ModelPoint;
  readonly normal: ModelPoint;
  readonly face: ModelPoint | null;
  readonly edge: { readonly at: ModelPoint; readonly exact: ModelPoint } | null;
  readonly vertex: ModelPoint | null;
}

const millimeters = (meters: number) => String(+(meters * 1000).toFixed(4));
const at = (point: ModelPoint) => `vector(${point.map(millimeters).join(", ")}) * millimeter`;

/** The faces the preview draws: the base's and earlier features', not sketch regions or planes. */
const DRAWN_FACES =
  "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";
/**
 * The drawn faces nearest `point`, a point on one; nearest rather than containing, as a point off
 * the face by its rounding (or, for picks saved before probes, by the tessellation) would miss it.
 */
export const faceAt = (point: ModelPoint) => `qClosestTo(${DRAWN_FACES}, ${at(point)})`;
/**
 * The clicked face: the drawn face nearest its probe, or where several are (another part's face
 * covering some of it), the one nearest the clicked point. Not the face nearest the clicked point
 * alone: the drawn triangles sit up to the mesh's deflection inside a curved face, so a click by
 * its rim is nearer the face beyond it. Found by where it is, not by its id in the run the click
 * saw, so the pick holds when an earlier step or the base changes.
 */
const clickedFace = (hit: PickHit) =>
  `qClosestTo(${faceAt(hit.face ?? hit.point)}, ${at(hit.point)})`;

/**
 * The clicked part's edge or vertex at `exact`: an edge's middle on its curve, or a vertex, which
 * no other of its edges or vertices is at. Only the clicked part's, so a touching part's in the
 * same place (blocks stacked) isn't picked with it. The snap left out ones the clicked surface
 * hides.
 */
const ofPartAt = (hit: PickHit, type: "EDGE" | "VERTEX", exact: ModelPoint) =>
  `qClosestTo(qOwnedByBody(qOwnerBody(${clickedFace(hit)}), EntityType.${type}), ${at(exact)})`;

/**
 * What a click picks: the face it landed on, the edge it's on (or else the face), only an edge, a
 * vertex, or the part that owns the face. The model's construction planes aren't drawn yet; once
 * they are, plane inputs can take them here.
 */
export type PickKind = "face" | "faceOrEdge" | "edge" | "vertex" | "body";

/**
 * The query a click gives an input of `kind`, and where the pick is shown, or null when the click
 * isn't on what the input takes (off an edge for an edge, off a corner for a vertex), as Onshape
 * picks only what's under the cursor.
 */
export function pickQuery(
  kind: PickKind,
  hit: PickHit,
): { readonly query: string; readonly at: ModelPoint } | null {
  if ((kind === "edge" || kind === "faceOrEdge") && hit.edge)
    return { query: ofPartAt(hit, "EDGE", hit.edge.exact), at: hit.edge.at };
  if (kind === "vertex")
    return hit.vertex ? { query: ofPartAt(hit, "VERTEX", hit.vertex), at: hit.vertex } : null;
  if (kind === "body") return { query: `qOwnerBody(${clickedFace(hit)})`, at: hit.point };
  return kind === "edge" ? null : { query: clickedFace(hit), at: hit.point };
}

/** One query for several picks. */
export const unionQuery = (queries: readonly string[]) =>
  queries.length === 1 ? queries[0]! : `qUnion([${queries.join(", ")}])`;

const FACES = /FACE|PLANE|CYLINDER|CONE|SPHERE|TORUS|ALLOWS_DIRECTION|ALLOWS_AXIS/;
const EDGES = /EDGE|GeometryType\.(?:LINE|CIRCLE|ARC|OTHER_CURVE)|ALLOWS_DIRECTION|ALLOWS_AXIS/;

/**
 * What a click in the preview gives a query input, read from its "Filter": a face, an edge, either
 * (filters such as fillet's that take both, and axis and direction filters, which take linear
 * edges and cylinders or planes), a vertex, the clicked part, or a point (a mate connector at the
 * click, where connectors are allowed). No filter takes faces; filters a click can't satisfy
 * (wire or point bodies) get nothing.
 */
export function pickKind(
  filter: string | null,
): { readonly kind: PickKind } | { readonly kind: "point" } | null {
  if (filter === null) return { kind: "face" };
  const faces = FACES.test(filter);
  const edges = EDGES.test(filter);
  if (faces) return { kind: edges ? "faceOrEdge" : "face" };
  if (/MATE_CONNECTOR|ALLOWS_VERTEX/.test(filter)) return { kind: "point" };
  if (edges) return { kind: "edge" };
  if (/VERTEX/.test(filter)) return { kind: "vertex" };
  // A body filter: a click on a face gives its solid or sheet, not a wire or point body.
  if (
    /BODY/.test(filter) &&
    (!/BodyType\./.test(filter) || /BodyType\.(?:SOLID|SHEET)/.test(filter))
  )
    return { kind: "body" };
  return null;
}

/** The query for points picked in the preview, which the server makes into mate connectors. */
export function pointExpression(ids: readonly string[]): string {
  const queries = ids.map(
    (id) => `qCreatedBy(makeId("Picked") + ${JSON.stringify(id)}, EntityType.BODY)`,
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
