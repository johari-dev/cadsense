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
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2((pick.x / width) * 2 - 1, 1 - (pick.y / height) * 2),
      camera,
    );
    const hit = cadVisibleIntersections(model, ray)[0];
    if (!hit) return failure("no-hit");
    if (cadHitIsTransparent(hit)) return failure("transparent-hit");
    const owner = visible.find(([, entry]) => {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node === entry.object) return true;
        node = node.parent;
      }
      return false;
    });
    if (!owner) return failure("no-hit");
    if (owner[0] !== pick.intendedOccurrenceId)
      return { ...failure("occurrence-mismatch"), occurrenceId: owner[0] };
    const inverse = owner[1].object.matrixWorld.clone().invert();
    const point = hit.point.clone().applyMatrix4(inverse);
    const normal = hit.face?.normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(inverse))
      .normalize();
    return {
      pickKey: pick.pickKey,
      reason: "candidate",
      occurrenceId: owner[0],
      point: [point.x, point.y, point.z],
      normal: normal ? [normal.x, normal.y, normal.z] : null,
    };
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
  const ray = new THREE.Raycaster(
    origin,
    point.clone().sub(origin).normalize(),
    0,
    Math.max(
      0,
      distance - Math.max(1e-7, model.bounds.getSize(new THREE.Vector3()).length() * 1e-5),
    ),
  );
  if (cadVisibleIntersections(model, ray).length) return false;
  // A previously located target may have become translucent since its capture.
  ray.far = distance + Math.max(1e-7, model.bounds.getSize(new THREE.Vector3()).length() * 1e-5);
  return !cadVisibleIntersections(model, ray).some(cadHitIsTransparent);
};
