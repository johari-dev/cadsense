import * as THREE from "three";

import type { ModelPoint } from "./featureScriptDialog";

/**
 * Whether a click that hits `object` picks from the model: a mesh of the model, not one drawn over
 * it. The error overlay (entities a failed feature marked, gone from the model after its rollback)
 * comes from the GLB with `extras.overlay`, which three.js reads into `userData`; a face query made
 * from a click on it would land on some other face. Outlines and points aren't picked either.
 */
export function isPickable(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh)) return false;
  for (let at: THREE.Object3D | null = object; at; at = at.parent)
    if (at.userData.overlay === true) return false;
  return true;
}

/**
 * The GLB node of the body `object` is part of, which names it in `extras.body`: a group of one
 * object per primitive (faces by material, outline lines and points), or the mesh itself when the
 * body has just one. Null for anything outside a body.
 */
export function bodyNode(object: THREE.Object3D): THREE.Object3D | null {
  for (let at: THREE.Object3D | null = object; at; at = at.parent)
    if (typeof at.userData.body === "string") return at;
  return null;
}

/**
 * Whether `object` is part of a body's outline: its B-rep edges (lines) or vertices (points), in
 * the GLB's outline material, whose `extras.outline` three.js reads into the material's userData.
 */
export function isOutline(object: THREE.Object3D): object is THREE.LineSegments | THREE.Points {
  return (
    (object instanceof THREE.LineSegments || object instanceof THREE.Points) &&
    [object.material].flat().some((material) => material.userData.outline === true)
  );
}

const isModelPoint = (value: unknown): value is ModelPoint =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n: unknown) => typeof n === "number" && Number.isFinite(n));

/**
 * The point a body node lists (`extras[list]`) for vertex `vertex` of `object`, by the index its
 * `attribute` gives that vertex; null when the GLB has none there.
 */
function listed(
  object: THREE.Object3D,
  vertex: number,
  attribute: "_face" | "_edge",
  list: "faces" | "edges",
): ModelPoint | null {
  if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return null;
  const node = bodyNode(object);
  if (!node || !object.geometry.hasAttribute(attribute)) return null;
  const points: unknown = node.userData[list];
  const point: unknown = Array.isArray(points)
    ? points[object.geometry.getAttribute(attribute).getX(vertex)]
    : null;
  return isModelPoint(point) ? point : null;
}

/**
 * The probe of the face vertex `vertex` of `mesh` is on (a hit triangle's corner): a point inside
 * the face on its true surface (the GLB's `_FACE` and `extras.faces`), to name the face by.
 */
export const faceProbe = (mesh: THREE.Object3D, vertex: number) =>
  listed(mesh, vertex, "_face", "faces");

/**
 * The middle, on its true curve, of the edge that segment end `end` of `lines` draws (the GLB's
 * `_EDGE` and `extras.edges`), to name the edge by.
 */
export const edgeMiddle = (lines: THREE.Object3D, end: number) =>
  listed(lines, end, "_edge", "edges");
