import type {
  CadCommentTarget,
  CadCommentRenderWork,
  CadCommentRenderHit,
} from "@cadsense/contracts";
import {
  locateCadCommentPoints,
  cadCommentWorldPoint,
  cadCommentVisible,
  cadCommentCameraUp,
} from "./CadCommentGeometry";
import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { CadCameraPose } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
const isCadCameraPose = Schema.is(CadCameraPose);
import * as THREE from "three";
import { createCadSceneBudget, measureCadGeometry } from "@cadsense/shared/cadSceneBudget";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_CAD_APPEARANCE, type CadAppearance } from "./CadAppearance";
import { prepareCadMaterials } from "./CadMaterials";
import { createCadOutline, supportsCadOutline } from "./CadOutline";
import {
  buildCadSceneModel,
  CAD_CAMERA_FOV,
  CadRendererError,
  disposeCadObjects,
  resolveCadCamera,
  type CadSceneModel,
  type ResolvedCadCamera,
} from "./CadSceneModel";

export { CadRendererError } from "./CadSceneModel";
export interface CadSceneRendererOptions {
  readonly cacheScenes?: boolean;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly onInteractionEnd?: (pose: ResolvedCadCamera) => void;
  readonly onUnavailable?: (error: CadRendererError) => void;
  readonly onFrame?: (milliseconds: number) => void;
  readonly onContextLost?: () => void;
}

/** One on-demand renderer. Hosts own scheduling, retries, retention, and presentation policy. */
export const createCadSceneRenderer = (options: CadSceneRendererOptions) => {
  const { canvas } = options;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    throw new CadRendererError("renderer-unavailable");
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(DEFAULT_CAD_APPEARANCE.background);
  const outline = createCadOutline(renderer);
  const scene = new THREE.Scene();
  const commentMarkers = new THREE.Group();
  const markerScene = new THREE.Scene();
  markerScene.add(commentMarkers);
  const clearCommentMarkers = () => {
    for (const o of [...commentMarkers.children]) {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        if (!Array.isArray(o.material)) o.material.dispose();
      }
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
      commentMarkers.remove(o);
    }
  };
  const ambient = new THREE.HemisphereLight(0xffffff, 0x89939f, 1.5);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, -4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  fill.position.set(-3, 2, 1);
  scene.add(fill);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.PerspectiveCamera(
    CAD_CAMERA_FOV,
    1,
    0.001,
    1000,
  );
  camera.up.set(0, 0, 1);
  const controls =
    "convertToBlob" in canvas
      ? null
      : new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(
          camera.clone(),
          canvas,
        );
  const target = new THREE.Vector3();
  if (controls) {
    controls.enabled = false;
    controls.enableDamping = false;
    controls.autoRotate = false;
  }
  let model: CadSceneModel | null = null;
  let outlineSupported = false;
  const outlineBounds = new THREE.Vector3();
  const cachedScenes = new Map<
    string,
    {
      manifest: CadSnapshotManifest;
      model: CadSceneModel;
      prototypes: THREE.Object3D[];
      bytes: number;
      outlineSupported: boolean;
    }
  >();
  let activeSnapshot: string | null = null;
  let generation = 0;
  let frameRevision = 0;
  let disposed = false;
  let lost = false;
  let applying = false;
  let width = 1,
    height = 1;
  let view: CadViewState | null = null;
  let reviewOccurrence: string | null = null;
  const reviewHidden = new Set<string>();
  let focusOffset = { x: 0, y: 0 };
  const reviewVisibility = () => {
    if (!model || !reviewOccurrence) return;
    for (const [id, entry] of model.objects) {
      if (id === reviewOccurrence) entry.object.visible = true;
      else if (reviewHidden.has(id)) entry.object.visible = false;
    }
  };

  let appearance = DEFAULT_CAD_APPEARANCE;
  let animationFrame: number | null = null;
  let interactive = false;
  const cancelTransition = () => {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (controls) controls.enabled = interactive && !lost && !disposed;
  };
  const assertAvailable = () => {
    if (disposed || lost || renderer.getContext().isContextLost())
      throw new CadRendererError("renderer-unavailable");
  };
  const render = () => {
    assertAvailable();
    const start = options.onFrame ? performance.now() : 0;
    renderer.render(scene, camera);
    if (model && outlineSupported)
      outline.render(scene, camera, model.bounds.getSize(outlineBounds).length());
    if (commentMarkers.children.length) {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(markerScene, camera);
      renderer.autoClear = autoClear;
    }
    options.onFrame?.(performance.now() - start);
  };
  const pose = (): ResolvedCadCamera => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [target.x, target.y, target.z],
    up: [camera.up.x, camera.up.y, camera.up.z],
    projection: camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective",
    zoom: camera.zoom,
  });
  const changed = () => {
    if (!applying && !disposed && !lost) {
      if (controls) {
        const navigation = controls.object;
        const direction = camera.position.clone().sub(target).normalize();
        const nextDirection = navigation.position.clone().sub(controls.target).normalize();
        // Panning/zooming must not roll a displayed capture or exact pole view.
        if (direction.distanceTo(nextDirection) > 1e-5) {
          camera.up.set(0, 0, 1);
          camera.position.copy(navigation.position);
        } else {
          camera.position
            .copy(direction)
            .multiplyScalar(navigation.position.distanceTo(controls.target))
            .add(controls.target);
          navigation.position.copy(camera.position);
        }
        camera.zoom = navigation.zoom;
        target.copy(controls.target);
        camera.lookAt(target);
        camera.updateProjectionMatrix();
      }
      frameRevision++;
      render();
      if (controls) controls.object.matrix.copy(camera.matrix);
    }
  };
  const ended = () => {
    if (controls?.enabled && !applying && !lost && !disposed) options.onInteractionEnd?.(pose());
  };
  controls?.addEventListener("start", cancelTransition);
  controls?.addEventListener("change", changed);
  controls?.addEventListener("end", ended);
  const contextLost = (event: Event) => {
    cancelTransition();
    event.preventDefault();
    lost = true;
    options.onContextLost?.();
    if (controls) controls.enabled = false;
    options.onUnavailable?.(new CadRendererError("renderer-unavailable"));
  };
  canvas.addEventListener("webglcontextlost", contextLost);
  const configureCamera = (resolved: ResolvedCadCamera, synchronizeControls = true) => {
    const distance = new THREE.Vector3(...resolved.position).distanceTo(
      new THREE.Vector3(...resolved.target),
    );
    const size = model?.bounds.getSize(new THREE.Vector3()).length() ?? 1;
    const centerDistance =
      model && !model.bounds.isEmpty()
        ? model.bounds
            .getCenter(new THREE.Vector3())
            .distanceTo(new THREE.Vector3(...resolved.position))
        : distance;
    const far = Math.max(centerDistance + size * 3, distance * 2, 1);
    const near = Math.max(Math.min(distance * 0.001, 0.01), 1e-7);
    if (resolved.projection === "orthographic") {
      const halfHeight = Math.max(
        distance * Math.tan(THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2)),
        1e-7,
      );
      camera = new THREE.OrthographicCamera(
        (-halfHeight * width) / height,
        (halfHeight * width) / height,
        halfHeight,
        -halfHeight,
        near,
        far,
      );
    } else camera = new THREE.PerspectiveCamera(CAD_CAMERA_FOV, width / height, near, far);
    camera.position.fromArray(resolved.position);
    camera.up.fromArray(resolved.up);
    camera.zoom = resolved.zoom;
    camera.lookAt(new THREE.Vector3(...resolved.target));
    if (focusOffset.x || focusOffset.y)
      camera.setViewOffset(width, height, focusOffset.x, focusOffset.y, width, height);
    camera.updateProjectionMatrix();
    target.fromArray(resolved.target);
    if (controls && synchronizeControls) {
      // Display up determines image roll; navigation always uses the same world-Z limits.
      camera.updateMatrixWorld();
      controls.object = camera.clone();
      controls.object.up.set(0, 0, 1);
      controls.target.copy(target);
    }
  };
  const applyFrame = (state: CadViewState, synchronizeControls = true): ResolvedCadCamera => {
    assertAvailable();
    if (!model) throw new CadRendererError("invalid-view");
    clearCommentMarkers();
    const bounds = model.apply(state);
    reviewVisibility();
    const resolved = resolveCadCamera(state.camera, bounds, width / height);
    applying = true;
    try {
      configureCamera(resolved, synchronizeControls);
      frameRevision++;
      view = state;
      render();
    } finally {
      applying = false;
    }
    return pose();
  };
  const apply = (state: CadViewState) => {
    cancelTransition();
    return applyFrame(state);
  };
  const transition = (state: CadViewState, duration?: number) => {
    cancelTransition();
    assertAvailable();
    if (!model || !view || (duration !== undefined && duration <= 0)) {
      applyFrame(state);
      return;
    }
    const from = pose();
    const explosion = view.explosion;
    const to = resolveCadCamera(state.camera, model.apply(state), width / height);
    const fromTarget = new THREE.Vector3(...from.target);
    const toTarget = new THREE.Vector3(...to.target);
    const fromDistance = new THREE.Vector3(...from.position).distanceTo(fromTarget);
    const toDistance = new THREE.Vector3(...to.position).distanceTo(toTarget);
    const fromRotation = camera.quaternion.clone();
    const toRotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        new THREE.Vector3(...to.position),
        toTarget,
        new THREE.Vector3(...to.up),
      ),
    );
    // Match the PoC's camera and explosion timing, retaining exact orbital interpolation.
    const settleDuration = duration ?? (state.explosion !== explosion ? 260 : 280);
    const started = performance.now();
    if (controls) controls.enabled = false;
    const frame = (now: number) => {
      animationFrame = null;
      if (disposed || lost) return;
      const progress = Math.min(1, Math.max(0, (now - started) / settleDuration));
      if (progress === 1) {
        applyFrame(state);
        if (controls) controls.enabled = interactive;
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      const target = fromTarget.clone().lerp(toTarget, eased);
      const rotation = fromRotation.clone().slerp(toRotation, eased);
      const position = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(rotation)
        .multiplyScalar(THREE.MathUtils.lerp(fromDistance, toDistance, eased))
        .add(target);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
      applyFrame(
        {
          ...state,
          explosion: THREE.MathUtils.lerp(explosion, state.explosion, eased),
          camera: {
            kind: "pose",
            fit: null,
            pose: {
              position: [position.x, position.y, position.z],
              target: [target.x, target.y, target.z],
              up: [up.x, up.y, up.z],
              projection: to.projection,
              zoom: THREE.MathUtils.lerp(from.zoom, to.zoom, eased),
            },
          },
        },
        false,
      );
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
  };
  const load = async (
    manifest: CadSnapshotManifest,
    readAsset: (sha256: string) => Promise<ArrayBuffer>,
  ) => {
    assertAvailable();
    cancelTransition();
    const token = ++generation;
    const cached = cachedScenes.get(manifest.snapshotId);
    if (cached) {
      cachedScenes.delete(manifest.snapshotId);
      cachedScenes.set(manifest.snapshotId, cached);
      const sameScene = activeSnapshot === manifest.snapshotId;
      if (!sameScene) {
        if (model) scene.remove(model.group);
        model = cached.model;
        outlineSupported = cached.outlineSupported;
        scene.add(model.group);
        reviewOccurrence = null;
        reviewHidden.clear();
        focusOffset = { x: 0, y: 0 };
        clearCommentMarkers();
        view = null;
        activeSnapshot = manifest.snapshotId;
      }
      return sameScene;
    }
    const loaded = new Map<string, THREE.Object3D>();
    const assetsByHash = new Map<string, THREE.Object3D>();
    const complexities = new Map<string, ReturnType<typeof measureCadGeometry>>();
    const ownedScenes: THREE.Object3D[] = [];
    let decodedBytes = manifest.nodes.length * 4096;
    let candidate: CadSceneModel | null = null;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith("blob:") && !url.startsWith("data:"))
        throw new CadRendererError("invalid-snapshot");
      return url;
    });
    const loader = new GLTFLoader(manager);
    const partsByKey = new Map(manifest.parts.map((part) => [part.geometryKey, part]));
    const appearancesByHash = new Map<
      string,
      Array<Parameters<typeof prepareCadMaterials>[1][number]>
    >();
    for (const asset of manifest.assets) {
      const appearances = appearancesByHash.get(asset.sha256) ?? [];
      appearances.push(partsByKey.get(asset.geometryKey)?.metadata?.appearance ?? null);
      appearancesByHash.set(asset.sha256, appearances);
    }
    try {
      const budget = createCadSceneBudget(manifest.nodes);
      for (const asset of manifest.assets) {
        assertAvailable();
        if (token !== generation) throw new CadRendererError("superseded");
        let prototype = assetsByHash.get(asset.sha256);
        if (!prototype) {
          const bytes = await readAsset(asset.sha256);
          const complexity = measureCadGeometry(new Uint8Array(bytes));
          decodedBytes = budget.add(asset, complexity).decodedBytes;
          complexities.set(asset.sha256, complexity);
          assertAvailable();
          if (token !== generation) throw new CadRendererError("superseded");
          const parsed = await loader.parseAsync(bytes, "");
          ownedScenes.push(...parsed.scenes);
          prototype = parsed.scene;
          const definitions: ReadonlyArray<{
            pbrMetallicRoughness?: { roughnessFactor?: number };
          }> = parsed.parser?.json.materials ?? [];
          const defaultFinish = new Set<THREE.Material>();
          parsed.parser?.associations.forEach((association, object) => {
            if (
              object instanceof THREE.Material &&
              association.materials !== undefined &&
              definitions[association.materials]?.pbrMetallicRoughness?.roughnessFactor ===
                undefined
            )
              defaultFinish.add(object);
          });
          prepareCadMaterials(prototype, appearancesByHash.get(asset.sha256) ?? [], defaultFinish);
          assetsByHash.set(asset.sha256, prototype);
        } else decodedBytes = budget.add(asset, complexities.get(asset.sha256)!).decodedBytes;
        loaded.set(asset.geometryKey, prototype);
      }
      assertAvailable();
      if (token !== generation) throw new CadRendererError("superseded");
      candidate = buildCadSceneModel(manifest, loaded);
      // No partially loaded object enters the displayed scene.
      const previous = model;
      if (previous) scene.remove(previous.group);
      scene.add(candidate.group);
      model = candidate;
      outlineSupported = ownedScenes.every(supportsCadOutline);
      cachedScenes.set(manifest.snapshotId, {
        manifest,
        model: candidate,
        prototypes: ownedScenes,
        bytes: decodedBytes,
        outlineSupported,
      });
      activeSnapshot = manifest.snapshotId;
      let total = [...cachedScenes.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const [id, entry] of cachedScenes) {
        if (cachedScenes.size <= (options.cacheScenes ? 3 : 1) && total <= 256 * 1024 * 1024) break;
        if (id === activeSnapshot) continue;
        cachedScenes.delete(id);
        total -= entry.bytes;
        disposeCadObjects(entry.prototypes);
      }
      reviewOccurrence = null;
      reviewHidden.clear();
      focusOffset = { x: 0, y: 0 };
      clearCommentMarkers();
      view = null;
      return false;
    } catch (error) {
      disposeCadObjects(ownedScenes);
      if (error instanceof CadRendererError) throw error;
      throw new CadRendererError("invalid-snapshot");
    }
  };
  const capture = async (): Promise<Blob> => {
    assertAvailable();
    if (!model || !view) throw new CadRendererError("invalid-view");
    const token = generation,
      revision = frameRevision;
    render();
    let blob: Blob | null;
    try {
      blob =
        "convertToBlob" in canvas
          ? await canvas.convertToBlob({ type: "image/png" })
          : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } catch {
      throw new CadRendererError("capture-failed");
    }
    assertAvailable();
    if (token !== generation || revision !== frameRevision)
      throw new CadRendererError("superseded");
    if (!blob) throw new CadRendererError("capture-failed");
    return blob;
  };
  return {
    cameraPose: pose,
    commentFraming: () => ({ ...focusOffset }),
    restoreCommentFraming: (offset: { x: number; y: number }) => {
      focusOffset = { ...offset };
      configureCamera(pose());
      if (view) render();
    },
    commentProjection: (t: CadCommentTarget) => {
      if (!model) return null;
      const entry = model.objects.get(t.occurrenceId);
      if (!entry) return null;
      const point =
        t.kind === "point"
          ? cadCommentWorldPoint(model, t.occurrenceId, t.point)
          : new THREE.Box3().setFromObject(entry.object).getCenter(new THREE.Vector3());
      if (!point) return null;
      const projected = point.clone().project(camera);
      return {
        x: ((projected.x + 1) * width) / 2,
        y: ((1 - projected.y) * height) / 2,
        visible: projected.z >= -1 && projected.z <= 1,
        occluded: !entry.object.visible || !cadCommentVisible(model, camera, point),
      };
    },
    endCommentReview: () => {
      cancelTransition();
      reviewOccurrence = null;
      reviewHidden.clear();
      if (model && view) {
        model.apply(view);
        render();
      }
    },
    focusComment: (
      t: CadCommentTarget,
      safe: { width: number; height: number; centerX: number; centerY: number },
      reducedMotion: boolean,
    ) => {
      cancelTransition();
      if (!model || !view) return "Location unavailable";
      model.apply(view);
      reviewHidden.clear();
      reviewOccurrence = t.occurrenceId;
      const entry = model.objects.get(t.occurrenceId);
      if (!entry) return "Location unavailable";
      const wasHidden = !entry.object.visible;
      entry.object.visible = true;
      const bounds = new THREE.Box3().setFromObject(entry.object),
        size = bounds.getSize(new THREE.Vector3()).length();
      const point =
        t.kind === "point"
          ? cadCommentWorldPoint(model, t.occurrenceId, t.point)
          : bounds.getCenter(new THREE.Vector3());
      if (!point) return "Location unavailable";
      const radius =
        t.kind === "part"
          ? bounds.getBoundingSphere(new THREE.Sphere()).radius
          : Math.max(size * 0.35, 0.001);
      const angle = Math.atan(
        Math.tan(Math.PI / 8) * Math.min(safe.height / height, safe.width / height),
      );
      const distance = (Math.max(radius, 1e-6) / Math.sin(Math.max(angle, 0.01))) * 1.15;
      const direction = camera.position.clone().sub(target).normalize();
      const rayHits = (d: THREE.Vector3) => {
        const origin = point.clone().addScaledVector(d, distance);
        const ray = new THREE.Raycaster(
          origin,
          point.clone().sub(origin).normalize(),
          0,
          distance - Math.max(1e-7, size * 1e-5),
        );
        return [...model!.objects].filter(
          ([, e]) => e.object.visible && ray.intersectObject(e.object, true).length,
        );
      };
      let blockers = rayHits(direction);
      for (const d of [
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, -1, 1).normalize(),
        new THREE.Vector3(-1, 1, 1).normalize(),
        new THREE.Vector3(0, 0, -1),
      ]) {
        if (!blockers.length) break;
        const hits = rayHits(d);
        if (hits.length < blockers.length) {
          direction.copy(d);
          blockers = hits;
        }
      }
      for (const [id, e] of blockers)
        if (id !== t.occurrenceId) {
          reviewHidden.add(id);
          e.object.visible = false;
        }
      focusOffset = { x: width / 2 - safe.centerX, y: height / 2 - safe.centerY };
      const from = pose(),
        eye = point.clone().addScaledVector(direction, distance),
        started = performance.now();
      const move = (now: number) => {
        animationFrame = null;
        const fraction = reducedMotion ? 1 : Math.min(1, (now - started) / 280),
          eased = 1 - (1 - fraction) ** 3;
        const position = new THREE.Vector3(...from.position).lerp(eye, eased),
          aim = new THREE.Vector3(...from.target).lerp(point, eased);
        applying = true;
        configureCamera({
          ...from,
          position: [position.x, position.y, position.z],
          target: [aim.x, aim.y, aim.z],
          zoom: 1,
        });
        applying = false;
        render();
        if (fraction < 1) animationFrame = requestAnimationFrame(move);
      };
      if (controls) controls.enabled = interactive;
      move(started);
      return blockers.some(([id]) => id === t.occurrenceId)
        ? "Target is occluded by its own geometry; orbit to inspect"
        : reviewHidden.size
          ? "Blocking parts temporarily hidden"
          : wasHidden
            ? "Target temporarily revealed"
            : "";
    },
    commentWork: (work: CadCommentRenderWork): CadCommentRenderHit[] => {
      assertAvailable();
      clearCommentMarkers();
      if (!model || !view) throw new CadRendererError("invalid-view");
      focusOffset = { x: 0, y: 0 };
      if (work.kind === "locate") {
        const hits = locateCadCommentPoints(model, camera, work.picks, width, height);
        for (const hit of hits) {
          if (hit.point && hit.occurrenceId) {
            const point = cadCommentWorldPoint(model, hit.occurrenceId, hit.point);
            if (point) {
              const radius = point.distanceTo(camera.position) * 0.008;
              const marker = new THREE.Mesh(
                new THREE.SphereGeometry(radius, 12, 8),
                new THREE.MeshBasicMaterial({ color: 0xffd866, depthTest: false }),
              );
              marker.position.copy(point);
              marker.renderOrder = 100;
              commentMarkers.add(marker);
            }
          }
        }
        render();
        return hits;
      }
      const currentModel = model;
      const targets = work.targets.map((t) => ({
        ...t,
        world: cadCommentWorldPoint(currentModel, t.occurrenceId, t.point),
      }));
      const bounds = new THREE.Box3();
      for (const [id, entry] of model.objects) {
        entry.object.visible = targets.some((t) => t.occurrenceId === id);
        if (entry.object.visible) bounds.union(new THREE.Box3().setFromObject(entry.object));
      }
      if (bounds.isEmpty())
        return targets.map((t) => ({
          pickKey: t.candidateId,
          reason: "geometry-unavailable",
          occurrenceId: t.occurrenceId,
          point: null,
          normal: null,
        }));
      const center = bounds.getCenter(new THREE.Vector3()),
        radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-6);
      const distance =
        (radius / Math.sin(Math.atan(Math.tan(Math.PI / 8) * Math.min(1, width / height)))) * 1.2;
      const directions = [
        new THREE.Vector3(-1, 1, 1),
        new THREE.Vector3(1, 1, 1),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(-1, -1, 0.4),
        new THREE.Vector3(1, -1, -1),
      ];
      const originalDirection = camera.position.clone().sub(target).normalize();
      let best =
          directions.find((d) => Math.abs(d.clone().normalize().dot(originalDirection)) < 0.94) ??
          directions[0]!,
        score = -1;
      const orient = (d: THREE.Vector3) => {
        const inspectionPose = {
          ...pose(),
          position: center.clone().addScaledVector(d.clone().normalize(), distance).toArray() as [
            number,
            number,
            number,
          ],
          target: center.toArray() as [number, number, number],
          up: cadCommentCameraUp(d),
          zoom: 1,
        };
        if (!isCadCameraPose(inspectionPose)) throw new CadRendererError("invalid-view");
        configureCamera(inspectionPose);
      };
      for (const direction of directions) {
        if (direction.clone().normalize().dot(originalDirection) > 0.94) continue;
        orient(direction);
        const n = targets.filter(
          (t) => t.world && cadCommentVisible(currentModel, camera, t.world),
        ).length;
        if (n > score) {
          score = n;
          best = direction;
        }
      }
      orient(best);
      const hits = targets.map((t, index): CadCommentRenderHit => {
        const visible = t.world && cadCommentVisible(currentModel, camera, t.world);
        if (t.world) {
          const marker = new THREE.Mesh(
            new THREE.SphereGeometry(radius * 0.035, 12, 8),
            new THREE.MeshBasicMaterial({ color: visible ? 0xffd866 : 0xff6262, depthTest: false }),
          );
          marker.position.copy(t.world);
          marker.renderOrder = 100;
          commentMarkers.add(marker);
          const labelCanvas = new OffscreenCanvas(64, 64),
            context = labelCanvas.getContext("2d");
          if (context) {
            context.fillStyle = visible ? "#ffd866" : "#ff6262";
            context.beginPath();
            context.arc(32, 32, 29, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = "#171717";
            context.font = "bold 36px sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(String(index + 1), 32, 33);
            const texture = new THREE.CanvasTexture(labelCanvas),
              sprite = new THREE.Sprite(
                new THREE.SpriteMaterial({ map: texture, depthTest: false }),
              );
            sprite.position.copy(t.world);
            sprite.scale.setScalar(radius * 0.13);
            sprite.renderOrder = 101;
            commentMarkers.add(sprite);
          }
        }
        return {
          pickKey: t.candidateId,
          reason: visible ? "visible" : "occluded",
          occurrenceId: t.occurrenceId,
          point: t.point,
          normal: null,
        };
      });
      render();
      return hits;
    },
    cachedManifest: (snapshotId: string) => cachedScenes.get(snapshotId)?.manifest ?? null,
    suspend: () => {
      cancelTransition();
      generation++;
      interactive = false;
      if (controls) {
        controls.enabled = false;
        controls.disconnect();
      }
    },
    resume: () => {
      assertAvailable();
      if (controls && !("convertToBlob" in canvas)) controls.connect(canvas);
    },
    load,
    apply,
    transition,
    capture,
    setAppearance: (next: CadAppearance) => {
      assertAvailable();
      if (next.background === appearance.background && next.dark === appearance.dark) return;
      appearance = next;
      renderer.setClearColor(next.background);
      ambient.intensity = next.dark ? 1.5 : 1.25;
      fill.intensity = next.dark ? 1 : 0.8;
      frameRevision++;
      if (view) render();
    },
    resize: (nextWidth: number, nextHeight: number, pixelRatio = 1) => {
      assertAvailable();
      if (
        ![nextWidth, nextHeight, pixelRatio].every((value) => Number.isFinite(value) && value > 0)
      )
        throw new CadRendererError("invalid-view");
      const currentPose = pose();
      width = nextWidth;
      height = nextHeight;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      frameRevision++;
      applying = true;
      try {
        configureCamera(currentPose, animationFrame === null);
        if (view) render();
      } finally {
        applying = false;
      }
    },
    setInteractive: (enabled: boolean) => {
      assertAvailable();
      interactive = enabled;
      if (controls) controls.enabled = enabled && animationFrame === null;
      else if (enabled) throw new CadRendererError("invalid-view");
    },
    dispose: () => {
      cancelTransition();
      if (disposed) return;
      clearCommentMarkers();
      outline.dispose();
      disposed = true;
      generation++;
      canvas.removeEventListener("webglcontextlost", contextLost);
      controls?.removeEventListener("start", cancelTransition);
      controls?.removeEventListener("change", changed);
      controls?.removeEventListener("end", ended);
      controls?.dispose();
      for (const entry of cachedScenes.values()) disposeCadObjects(entry.prototypes);
      cachedScenes.clear();
      model = null;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
export type CadSceneRenderer = ReturnType<typeof createCadSceneRenderer>;
