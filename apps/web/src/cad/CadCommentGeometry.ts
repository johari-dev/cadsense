import type { CadCommentRenderHit, CadCommentRenderWork } from "@cadsense/contracts";
import * as THREE from "three";
import type { CadSceneModel } from "./CadSceneModel";

/** Keep camera roll well-defined even when an inspection looks along the Z axis. */
export const cadCommentCameraUp = (direction: THREE.Vector3): [number, number, number] =>
  Math.abs(direction.clone().normalize().z) > 0.99 ? [0, 1, 0] : [0, 0, 1];

/** Narrow openings need a nearby alternate view before trying broad assembly angles. */
export const cadCommentInspectionDirections = (original: THREE.Vector3): THREE.Vector3[] => {
  const direction = original.clone().normalize();
  const tangent = new THREE.Vector3(...cadCommentCameraUp(direction)).cross(direction).normalize();
  const other = direction.clone().cross(tangent).normalize();
  const nearby = [5, 10, 20].flatMap((degrees) =>
    [tangent, other, tangent.clone().negate(), other.clone().negate()].map((axis) =>
      direction.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(degrees)),
    ),
  );
  return [
    ...nearby,
    ...[
      new THREE.Vector3(-1, 1, 1),
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(-1, -1, 0.4),
      new THREE.Vector3(1, -1, -1),
    ]
      .map((d) => d.normalize())
      .filter((d) => d.dot(direction) < Math.cos(THREE.MathUtils.degToRad(5))),
  ];
};

/** Reject alpha-dependent surfaces rather than silently selecting an ambiguous layer. */
export const cadHitIsTransparent = (hit: THREE.Intersection) => {
  if (!(hit.object instanceof THREE.Mesh)) return true;
  const material = Array.isArray(hit.object.material)
    ? hit.object.material[hit.face?.materialIndex ?? 0]
    : hit.object.material;
  return (
    !material ||
    material.transparent ||
    material.alphaTest > 0 ||
    material.alphaHash ||
    (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0)
  );
};

export const cadVisibleIntersections = (model: CadSceneModel, ray: THREE.Raycaster) =>
  ray
    .intersectObjects(
      [...model.objects.values()]
        .filter((entry) => entry.object.visible)
        .map((entry) => entry.object),
      true,
    )
    .filter((hit) => !model.isClipped(hit.point));

/** How far a missed pick may move, in image pixels, and the spacing of the rings searched. */
export const CAD_COMMENT_SNAP_RADIUS = 64;
const SNAP_STEP = 2;

/** Image pixels in rings around a pick, nearest ring first, inside the image. */
function* snapPixels(x: number, y: number, width: number, height: number) {
  for (let radius = SNAP_STEP; radius <= CAD_COMMENT_SNAP_RADIUS; radius += SNAP_STEP) {
    const count = Math.max(8, Math.ceil((2 * Math.PI * radius) / SNAP_STEP));
    for (let index = 0; index < count; index++) {
      const angle = (2 * Math.PI * index) / count;
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (px >= 0 && px < width && py >= 0 && py < height) yield [px, py] as const;
    }
  }
}

/**
 * Turns image picks into candidate surface points. The nearest visible surface at the pixel wins;
 * a nearer part is never searched through. When the pick misses (empty space, a translucent
 * surface, or another part), nearby pixels are tried, nearest first, up to
 * CAD_COMMENT_SNAP_RADIUS, and a candidate found that way reports the `pixel` it came from. Each
 * nearby pixel is tested against the intended part alone first, so only pixels that land on it pay
 * for a raycast through the whole assembly.
 */
export const locateCadCommentPoints = (
  model: CadSceneModel,
  camera: THREE.Camera,
  picks: Extract<CadCommentRenderWork, { kind: "locate" }>["picks"],
  width: number,
  height: number,
): CadCommentRenderHit[] => {
  model.group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const visible = [...model.objects].filter(([, entry]) => entry.object.visible);
  const ray = new THREE.Raycaster();
  const aim = (x: number, y: number) =>
    ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), camera);
  const ownerOf = (hit: THREE.Intersection) =>
    visible.find(([, entry]) => {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node === entry.object) return true;
        node = node.parent;
      }
      return false;
    });
  /** The first visible surface at a pixel, classified the way a pick reports it. */
  const surfaceAt = (x: number, y: number) => {
    aim(x, y);
    const hit = cadVisibleIntersections(model, ray)[0];
    if (!hit) return { reason: "no-hit" } as const;
    if (cadHitIsTransparent(hit)) return { reason: "transparent-hit" } as const;
    const owner = ownerOf(hit);
    return owner ? ({ reason: "surface", hit, owner } as const) : ({ reason: "no-hit" } as const);
  };
  const candidate = (
    pickKey: string,
    hit: THREE.Intersection,
    owner: NonNullable<ReturnType<typeof ownerOf>>,
  ): CadCommentRenderHit => {
    const inverse = owner[1].object.matrixWorld.clone().invert();
    const point = hit.point.clone().applyMatrix4(inverse);
    const normal = hit.face?.normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(inverse))
      .normalize();
    return {
      pickKey,
      reason: "candidate",
      occurrenceId: owner[0],
      point: [point.x, point.y, point.z],
      normal: normal ? [normal.x, normal.y, normal.z] : null,
    };
  };
  return picks.map((pick) => {
    const failure = (reason: string): CadCommentRenderHit => ({
      pickKey: pick.pickKey,
      reason,
      occurrenceId: null,
      point: null,
      normal: null,
    });
    if (pick.x < 0 || pick.x >= width || pick.y < 0 || pick.y >= height)
      return failure("invalid-image-point");
    const exact = surfaceAt(pick.x, pick.y);
    if (exact.reason === "surface" && exact.owner[0] === pick.intendedOccurrenceId)
      return candidate(pick.pickKey, exact.hit, exact.owner);
    const missed =
      exact.reason === "surface"
        ? { ...failure("occurrence-mismatch"), occurrenceId: exact.owner[0] }
        : failure(exact.reason);
    const intended = model.objects.get(pick.intendedOccurrenceId);
    if (!intended?.object.visible) return missed;
    for (const [x, y] of snapPixels(pick.x, pick.y, width, height)) {
      aim(x, y);
      const onIntended = ray
        .intersectObject(intended.object, true)
        .some((hit) => !model.isClipped(hit.point));
      if (!onIntended) continue;
      const nearby = surfaceAt(x, y);
      if (nearby.reason === "surface" && nearby.owner[0] === pick.intendedOccurrenceId)
        return { ...candidate(pick.pickKey, nearby.hit, nearby.owner), pixel: [x, y] };
    }
    return missed;
  });
};

export const cadCommentWorldPoint = (
  model: CadSceneModel,
  occurrenceId: string,
  local: readonly number[],
) => {
  const entry = model.objects.get(occurrenceId);
  if (!entry) return null;
  return new THREE.Vector3(local[0], local[1], local[2]).applyMatrix4(entry.object.matrixWorld);
};

export const cadCommentVisible = (
  model: CadSceneModel,
  camera: THREE.Camera,
  point: THREE.Vector3,
) => {
  if (model.isClipped(point)) return false;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  if (camera instanceof THREE.OrthographicCamera) {
    const direction = camera.getWorldDirection(new THREE.Vector3());
    origin.copy(point).addScaledVector(direction, -point.clone().sub(origin).dot(direction));
  }
  const distance = origin.distanceTo(point);
  const epsilon = Math.max(1e-7, model.bounds.getSize(new THREE.Vector3()).length() * 1e-5);
  const ray = new THREE.Raycaster(
    origin,
    point.clone().sub(origin).normalize(),
    0,
    distance + epsilon,
  );
  // Include the target surface so newly translucent locations remain unverifiable.
  return !cadVisibleIntersections(model, ray).some(
    (hit) => hit.distance <= Math.max(0, distance - epsilon) || cadHitIsTransparent(hit),
  );
};

/** Height of a comment pin in CSS px; one- and two-character pins are round, so also their width. */
export const CAD_COMMENT_PIN_SIZE = 22;
/** A comment pin projected onto the viewport. Pinned pins (the focused comment's) never group. */
export interface CadCommentScreenPin {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly pinned: boolean;
}

/**
 * Groups pins that sit nearly on top of each other on screen, so the comments card can show one
 * count marker instead of an unreadable stack. Pins that merely touch or overlap a little stay
 * apart, so a cluster never hides comments that could be read. Grouping is transitive: a pin
 * close to any member joins the group. Returns indices into `pins`, each group and the list
 * ordered by first appearance. Runs on every orbit frame; with the few dozen pins a review has,
 * the pairwise pass is cheap.
 */
export const groupOverlappingCommentPins = (
  pins: readonly CadCommentScreenPin[],
  /** Closest two pins may come before they group: center distance for round pins. */
  minDistance = CAD_COMMENT_PIN_SIZE - 4,
): number[][] => {
  const parent = pins.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (let i = 0; i < pins.length; i++) {
    const a = pins[i]!;
    if (a.pinned) continue;
    for (let j = i + 1; j < pins.length; j++) {
      const b = pins[j]!;
      // Pins are horizontal capsules: a segment as long as the pill's flat part, inflated by
      // half the pin height. Distance runs between segments, which for round pins is between
      // their centers.
      const dx = Math.max(0, Math.abs(a.x - b.x) - (a.width + b.width) / 2 + CAD_COMMENT_PIN_SIZE);
      if (!b.pinned && Math.hypot(dx, a.y - b.y) < minDistance) {
        const [ra, rb] = [root(i), root(j)];
        // Keep the earliest index as the root, so groups list in input order.
        parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const groups = new Map<number, number[]>();
  pins.forEach((_, i) => {
    const key = root(i);
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  return [...groups.values()];
};
