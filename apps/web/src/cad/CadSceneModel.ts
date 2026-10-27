import { CadCameraPose, CadViewState, type CadSnapshotManifest } from "@cadsense/contracts";
import { indexCadSnapshot } from "@cadsense/shared/cadScene";
import * as Schema from "effect/Schema";
import * as THREE from "three";
import { CadRendererError } from "./CadRendererError";
export { CadRendererError } from "./CadRendererError";

export type ResolvedCadCamera = typeof CadCameraPose.Type;
export const CAD_CAMERA_FOV = 45;
const decodeView = Schema.decodeUnknownSync(CadViewState);

export type CadApplyOptions = {
  /**
   * Comment reviews show the parts an isolation would hide as muted context instead of hiding
   * them, so the isolated part keeps its surroundings.
   */
  fadeIsolatedOut?: boolean;
};
/**
 * Faded context meshes render only on this layer. The renderer draws it as one quiet backdrop
 * after the solid parts; the main pass, outlines, and raycasts (all on layer 0) skip it.
 */
export const CAD_CONTEXT_LAYER = 1;
/** Highlighted meshes also render on this layer, so the renderer can draw their outline rim. */
export const CAD_HIGHLIGHT_LAYER = 2;
/**
 * The highlight for a selected or focused part: a blue far from the amber concern pins, mixed
 * into the part's own color (so multi-color parts keep their faces apart) with a little glow so
 * shadowed faces stay blue rather than navy.
 */
const HIGHLIGHT_COLOR = new THREE.Color(0x7dbbff);
const HIGHLIGHT_MIX = 0.7;
const HIGHLIGHT_GLOW = 0.15;

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
  let planes: THREE.Plane[] = [];
  // Bounds of every part the last applied view shows, ignoring any camera fit selection.
  let shownBounds = bounds.clone();
  const overrides = new Map<
    THREE.Mesh | THREE.Line | THREE.Points,
    { original: THREE.Material | THREE.Material[]; copies: THREE.Material[] }
  >();
  let materialStyle = "";
  // Parts the last applied view faded instead of hiding (see CadApplyOptions).
  let faded: ReadonlySet<string> = new Set();
  // Whether the last applied view ghosts any part to a translucent copy.
  let ghosting = false;
  // Whether the last applied view highlights any shown, unfaded part.
  let highlighting = false;
  const clearOverrides = () => {
    const disposed = new Set<THREE.Material>();
    for (const [object, entry] of overrides) {
      object.material = entry.original;
      for (const copy of entry.copies)
        if (!disposed.has(copy)) {
          disposed.add(copy);
          copy.dispose();
        }
    }
    overrides.clear();
    materialStyle = "";
  };
  const isClipped = (point: THREE.Vector3) =>
    planes.some((plane) => plane.distanceToPoint(point) < 0);
  const apply = (input: CadViewState, options?: CadApplyOptions) => {
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
      ...(state.highlightedOccurrenceIds ?? []),
      ...(state.ghost?.occurrenceIds ?? []),
      ...(state.camera.fit ?? []),
    ];
    if (ids.some((id) => !index.nodes.has(id))) throw new CadRendererError("invalid-view");
    const shown = index.visible(state);
    const fade = state.isolatedOccurrenceIds.length > 0 && options?.fadeIsolatedOut === true;
    // With fading on, everything the view shows without its isolation stays visible, and the
    // parts only the isolation hid are faded.
    const visible = fade ? index.visible({ ...state, isolatedOccurrenceIds: [] }) : shown;
    const fadedIds = new Set<string>();
    if (fade)
      for (const [id, isVisible] of visible) if (isVisible && !shown.get(id)) fadedIds.add(id);
    const nextStyle = JSON.stringify([
      state.highlightedOccurrenceIds ?? [],
      state.ghost ?? null,
      [...fadedIds],
    ]);
    const changedStyle = materialStyle !== nextStyle;
    if (changedStyle) {
      clearOverrides();
      materialStyle = nextStyle;
    }
    const styledMaterials = new Map<THREE.Material, Map<string, THREE.Material>>();
    planes = (state.sectionPlanes ?? []).map(
      (plane) => new THREE.Plane(new THREE.Vector3(...plane.normal), plane.constant),
    );
    const highlighted = index.subtree(state.highlightedOccurrenceIds ?? []);
    const ghosted = index.subtree(state.ghost?.occurrenceIds ?? []);
    const selected = state.camera.fit?.length ? index.subtree(state.camera.fit) : null;
    const fitBounds = new THREE.Box3();
    const visibleBounds = new THREE.Box3();
    for (const [id, entry] of objects) {
      entry.object.visible = visible.get(id) ?? false;
      const opacity = ghosted.has(id) ? state.ghost!.opacity : 1;
      if (changedStyle) {
        const faded = fadedIds.has(id),
          lit = highlighted.has(id) && !faded;
        entry.object.traverse((object) => {
          object.layers.set(faded ? CAD_CONTEXT_LAYER : 0);
          if (lit) object.layers.enable(CAD_HIGHLIGHT_LAYER);
        });
      }
      if (changedStyle && (highlighted.has(id) || opacity < 1))
        entry.object.traverse((object) => {
          if (
            !(
              object instanceof THREE.Mesh ||
              object instanceof THREE.Line ||
              object instanceof THREE.Points
            )
          )
            return;
          const original = object.material;
          const copies = (Array.isArray(original) ? original : [original]).map((material) => {
            const style = `${highlighted.has(id)}:${opacity}`;
            const variants = styledMaterials.get(material) ?? new Map<string, THREE.Material>();
            styledMaterials.set(material, variants);
            const existing = variants.get(style);
            if (existing) return existing;
            const copy = material.clone();
            variants.set(style, copy);
            if (highlighted.has(id) && "color" in copy && copy.color instanceof THREE.Color) {
              copy.color.lerp(HIGHLIGHT_COLOR, HIGHLIGHT_MIX);
              if ("emissive" in copy && copy.emissive instanceof THREE.Color)
                copy.emissive.copy(HIGHLIGHT_COLOR).multiplyScalar(HIGHLIGHT_GLOW);
            }
            if (opacity < 1) {
              copy.opacity = Math.min(copy.opacity, opacity);
              copy.transparent = true;
              copy.depthWrite = false;
            }
            return copy;
          });
          object.material = Array.isArray(original) ? copies : copies[0]!;
          overrides.set(object, { original, copies });
        });
      entry.object.matrix.copy(entry.base);
      const offset = entry.offset.clone().multiplyScalar(state.explosion);
      entry.object.matrix.elements[12]! += offset.x;
      entry.object.matrix.elements[13]! += offset.y;
      entry.object.matrix.elements[14]! += offset.z;
      // Faded parts are context only: they never widen framing or fit bounds.
      if (entry.object.visible && !fadedIds.has(id)) {
        const box = entry.bounds.clone().translate(offset);
        visibleBounds.union(box);
        if (selected === null || selected.has(id)) fitBounds.union(box);
      }
    }
    group.updateMatrixWorld(true);
    faded = fadedIds;
    ghosting = ghosted.size > 0;
    highlighting = [...highlighted].some(
      (id) => !fadedIds.has(id) && objects.get(id)?.object.visible,
    );
    shownBounds = visibleBounds.isEmpty() ? bounds.clone() : visibleBounds;
    // All-hidden/empty fits remain deterministic and never produce NaN camera positions.
    return fitBounds.isEmpty()
      ? visibleBounds.isEmpty()
        ? bounds.clone()
        : visibleBounds
      : fitBounds;
  };
  return {
    group,
    bounds,
    objects,
    index,
    apply,
    isClipped,
    clippingPlanes: () => planes,
    visibleBounds: () => shownBounds.clone(),
    /** Parts shown faded rather than hidden by the last applied view. */
    isFaded: (id: string) => faded.has(id),
    /** Whether the last applied view shows any faded context (see CAD_CONTEXT_LAYER). */
    hasFaded: () => faded.size > 0,
    /** Whether the last applied view highlights any shown part (see CAD_HIGHLIGHT_LAYER). */
    hasHighlight: () => highlighting,
    /** Whether the last applied view, including any review on top of it, ghosts parts. */
    hasGhosts: () => ghosting,
    dispose: clearOverrides,
  };
};
export type CadSceneModel = ReturnType<typeof buildCadSceneModel>;

/** Each view preset's eye direction from the model. The view cube's faces use the same table. */
export const CAD_VIEW_DIRECTIONS = {
  isometric: [1, -1, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
} as const satisfies Record<string, readonly [number, number, number]>;
/** The camera up a view preset uses: world Z, except looking straight down or up. */
export const cadPresetUp = (preset: keyof typeof CAD_VIEW_DIRECTIONS) =>
  preset === "top"
    ? ([0, 1, 0] as const)
    : preset === "bottom"
      ? ([0, -1, 0] as const)
      : ([0, 0, 1] as const);
/**
 * The eye distance from `center` along `direction` at which every corner of `box` projects within
 * `tangents` (the tangents of the half angles available across and up the image; orthographic
 * views use them as half extents per unit of distance). `up` sets the image roll.
 */
export const cadFitDistance = (
  box: THREE.Box3,
  center: THREE.Vector3,
  direction: THREE.Vector3,
  up: THREE.Vector3,
  tangents: { x: number; y: number },
  orthographic: boolean,
) => {
  const back = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(up, back);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0).cross(back);
  if (right.lengthSq() < 1e-12) right.set(0, 1, 0).cross(back);
  right.normalize();
  const top = new THREE.Vector3().crossVectors(back, right);
  const offset = new THREE.Vector3();
  let distance = 0;
  for (let corner = 0; corner < 8; corner++) {
    offset
      .set(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      )
      .sub(center);
    const z = orthographic ? 0 : offset.dot(back);
    distance = Math.max(
      distance,
      z + Math.abs(offset.dot(right)) / tangents.x,
      z + Math.abs(offset.dot(top)) / tangents.y,
    );
  }
  return distance;
};
/** How much of the free area a box fit fills, leaving a small margin around the model. */
const AREA_FILL = 0.9;
/**
 * Orthographic base height is derived from eye-target distance, making pose+zoom self-contained.
 * Without `area`, a fit encloses the bounds' sphere, as agent captures and thumbnails expect.
 * With `area` (the share of the viewport's width and height free of overlay chrome), it fits the
 * bounds' box into that area, which frames tall or flat models far more tightly.
 */
export const resolveCadCamera = (
  camera: CadViewState["camera"],
  bounds: THREE.Box3,
  aspect: number,
  area?: { width: number; height: number },
): ResolvedCadCamera => {
  if (camera.kind === "pose" && camera.fit === null) return camera.pose;
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(
    bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length() / 2,
    1e-6,
  );
  const direction =
    camera.kind === "preset"
      ? new THREE.Vector3(...CAD_VIEW_DIRECTIONS[camera.preset])
      : new THREE.Vector3(...camera.pose.position).sub(new THREE.Vector3(...camera.pose.target));
  const up = camera.kind === "pose" ? camera.pose.up : cadPresetUp(camera.preset);
  const projection = camera.kind === "pose" ? camera.pose.projection : "perspective";
  const halfFov = THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2);
  const distance =
    area && !bounds.isEmpty()
      ? Math.max(
          cadFitDistance(
            bounds,
            center,
            direction,
            new THREE.Vector3(...up),
            {
              x: Math.tan(halfFov) * aspect * area.width * AREA_FILL,
              y: Math.tan(halfFov) * area.height * AREA_FILL,
            },
            projection === "orthographic",
          ),
          // An orthographic eye still sits in front of everything it shows.
          projection === "orthographic" ? radius * 2 : 1e-6,
        )
      : (radius * 1.1) / Math.sin(Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect)));
  const position = direction.normalize().multiplyScalar(distance).add(center);
  return {
    position: [position.x, position.y, position.z],
    target: [center.x, center.y, center.z],
    up,
    projection,
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
