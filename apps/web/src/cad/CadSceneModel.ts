import { CadCameraPose, CadViewState, type CadSnapshotManifest } from "@cadsense/contracts";
import { indexCadSnapshot } from "@cadsense/shared/cadScene";
import * as Schema from "effect/Schema";
import * as THREE from "three";

export type ResolvedCadCamera = typeof CadCameraPose.Type;
export const CAD_CAMERA_FOV = 45;
const decodeView = Schema.decodeUnknownSync(CadViewState);
export class CadRendererError extends Error {
  readonly _tag = "CadRendererError";
  constructor(
    readonly reason:
      | "renderer-unavailable"
      | "invalid-view"
      | "invalid-snapshot"
      | "superseded"
      | "renderer-busy"
      | "capture-failed",
  ) {
    super(`CAD ${reason}`);
  }
}

/** GLTF hierarchy clones share immutable geometry, materials, and texture buffers. */
export const buildCadSceneModel = (
  manifest: CadSnapshotManifest,
  prototypes: ReadonlyMap<string, THREE.Object3D>,
) => {
  const group = new THREE.Group();
  const index = indexCadSnapshot(manifest);
  const objects = new Map<
    string,
    { object: THREE.Group; base: THREE.Matrix4; bounds: THREE.Box3; offset: THREE.Vector3 }
  >();
  const bounds = new THREE.Box3();
  for (const node of manifest.nodes) {
    if (node.sourcePartKey === null || node.suppressed) continue;
    const prototype = prototypes.get(node.sourcePartKey);
    if (!prototype) throw new CadRendererError("invalid-snapshot");
    const object = new THREE.Group();
    object.name = node.id;
    object.matrixAutoUpdate = false;
    // Matrix4.fromArray takes column-major storage; Onshape supplies row-major values.
    const base = new THREE.Matrix4().fromArray(node.transform).transpose();
    object.matrix.copy(base);
    object.add(prototype.clone(true));
    group.add(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (
      !box.isEmpty() &&
      [...box.min.toArray(), ...box.max.toArray()].some((value) => !Number.isFinite(value))
    )
      throw new CadRendererError("invalid-snapshot");
    bounds.union(box);
    objects.set(node.id, { object, base, bounds: box, offset: new THREE.Vector3() });
  }
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const scale = bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length();
  for (const [id, entry] of objects) {
    entry.offset.copy(entry.bounds.getCenter(new THREE.Vector3())).sub(center);
    if (entry.offset.lengthSq() < 1e-20) {
      // Coincident occurrence centers still separate reproducibly; identity determines direction.
      const seed = Number.parseInt(id.slice(0, 8), 16);
      const angle = (seed / 0xffffffff) * Math.PI * 2;
      entry.offset.set(Math.cos(angle), Math.sin(angle), ((seed % 997) / 996) * 2 - 1);
    }
    entry.offset.normalize().multiplyScalar(scale * 0.45);
  }
  const apply = (input: CadViewState) => {
    let state: CadViewState;
    try {
      state = decodeView(input);
    } catch {
      throw new CadRendererError("invalid-view");
    }
    if (state.snapshotId !== manifest.snapshotId || state.rootId !== manifest.rootId)
      throw new CadRendererError("invalid-view");
    const ids = [
      ...Object.keys(state.visibility),
      ...state.isolatedOccurrenceIds,
      ...(state.camera.fit ?? []),
    ];
    if (ids.some((id) => !index.nodes.has(id))) throw new CadRendererError("invalid-view");
    const visible = index.visible(state);
    const selected = state.camera.fit?.length ? index.subtree(state.camera.fit) : null;
    const fitBounds = new THREE.Box3();
    const visibleBounds = new THREE.Box3();
    for (const [id, entry] of objects) {
      entry.object.visible = visible.get(id) ?? false;
      entry.object.matrix.copy(entry.base);
      const offset = entry.offset.clone().multiplyScalar(state.explosion);
      entry.object.matrix.elements[12]! += offset.x;
      entry.object.matrix.elements[13]! += offset.y;
      entry.object.matrix.elements[14]! += offset.z;
      if (entry.object.visible) {
        const box = entry.bounds.clone().translate(offset);
        visibleBounds.union(box);
        if (selected === null || selected.has(id)) fitBounds.union(box);
      }
    }
    group.updateMatrixWorld(true);
    // All-hidden/empty fits remain deterministic and never produce NaN camera positions.
    return fitBounds.isEmpty()
      ? visibleBounds.isEmpty()
        ? bounds.clone()
        : visibleBounds
      : fitBounds;
  };
  return { group, bounds, objects, apply };
};
export type CadSceneModel = ReturnType<typeof buildCadSceneModel>;

const directions = {
  isometric: [1, -1, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
} satisfies Record<string, [number, number, number]>;
/** Orthographic base height is derived from eye-target distance, making pose+zoom self-contained. */
export const resolveCadCamera = (
  camera: CadViewState["camera"],
  bounds: THREE.Box3,
  aspect: number,
): ResolvedCadCamera => {
  if (camera.kind === "pose" && camera.fit === null) return camera.pose;
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(
    bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length() / 2,
    1e-6,
  );
  const direction =
    camera.kind === "preset"
      ? new THREE.Vector3(...directions[camera.preset])
      : new THREE.Vector3(...camera.pose.position).sub(new THREE.Vector3(...camera.pose.target));
  const halfFov = THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2);
  const limitingAngle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect));
  const distance = (radius * 1.1) / Math.sin(limitingAngle);
  const position = direction.normalize().multiplyScalar(distance).add(center);
  const up =
    camera.kind === "pose"
      ? camera.pose.up
      : camera.preset === "top"
        ? ([0, 1, 0] as const)
        : camera.preset === "bottom"
          ? ([0, -1, 0] as const)
          : ([0, 0, 1] as const);
  return {
    position: [position.x, position.y, position.z],
    target: [center.x, center.y, center.z],
    up,
    projection: camera.kind === "pose" ? camera.pose.projection : "perspective",
    zoom: 1,
  };
};

/** Resources are shared across occurrences and disposed exactly once per resident snapshot. */
export const disposeCadObjects = (roots: Iterable<THREE.Object3D>) => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<ImageBitmap>();
  for (const root of roots)
    root.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Line ||
        object instanceof THREE.Points
      ) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
      }
    });
  for (const material of materials)
    for (const value of Object.values(material))
      if (value instanceof THREE.Texture) textures.add(value);
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    for (const candidate of Array.isArray(image) ? image : [image])
      if (typeof ImageBitmap !== "undefined" && candidate instanceof ImageBitmap)
        images.add(candidate);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
};
