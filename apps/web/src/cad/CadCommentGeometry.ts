import type { CadCommentRenderHit, CadCommentRenderWork } from "@cadsense/contracts";
import * as THREE from "three";
import type { CadSceneModel } from "./CadSceneModel";

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
    const hit = ray.intersectObjects(
      visible.map(([, entry]) => entry.object),
      true,
    )[0];
    if (!hit) return failure("no-hit");
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
  return (
    ray.intersectObjects(
      [...model.objects.values()].filter((e) => e.object.visible).map((e) => e.object),
      true,
    ).length === 0
  );
};
