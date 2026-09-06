import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import * as THREE from "three";
import { createCadSceneBudget, measureCadGeometry } from "@cadsense/shared/cadSceneBudget";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_CAD_APPEARANCE, type CadAppearance } from "./CadAppearance";
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
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(DEFAULT_CAD_APPEARANCE.background);
  const scene = new THREE.Scene();
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
  const cachedScenes = new Map<
    string,
    {
      manifest: CadSnapshotManifest;
      model: CadSceneModel;
      prototypes: THREE.Object3D[];
      bytes: number;
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
    const bounds = model.apply(state);
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
    // Larger moves get room to settle, without idle animation or overshoot.
    const travel = Math.max(
      fromRotation.angleTo(toRotation) / Math.PI,
      Math.abs(state.explosion - explosion),
      Math.min(1, Math.abs(toDistance - fromDistance) / Math.max(fromDistance, 1e-7)),
    );
    const settleDuration = duration ?? 360 + 200 * travel;
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
        scene.add(model.group);
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
      cachedScenes.set(manifest.snapshotId, {
        manifest,
        model: candidate,
        prototypes: ownedScenes,
        bytes: decodedBytes,
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
      disposed = true;
      generation++;
      canvas.removeEventListener("webglcontextlost", contextLost);
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
