import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly onInteractionEnd?: (pose: ResolvedCadCamera) => void;
  readonly onUnavailable?: (error: CadRendererError) => void;
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
  renderer.setClearColor(0xf1f3f5);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x89939f, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(3, -4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.2);
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
      : new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(camera, canvas);
  const target = controls?.target ?? new THREE.Vector3();
  if (controls) {
    controls.enabled = false;
    controls.enableDamping = false;
    controls.autoRotate = false;
  }
  let model: CadSceneModel | null = null;
  let prototypes: THREE.Object3D[] = [];
  let generation = 0;
  let frameRevision = 0;
  let disposed = false;
  let lost = false;
  let applying = false;
  let width = 1,
    height = 1;
  let view: CadViewState | null = null;
  const assertAvailable = () => {
    if (disposed || lost || renderer.getContext().isContextLost())
      throw new CadRendererError("renderer-unavailable");
  };
  const render = () => {
    assertAvailable();
    renderer.render(scene, camera);
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
      frameRevision++;
      render();
    }
  };
  const ended = () => {
    if (controls?.enabled && !applying && !lost && !disposed) options.onInteractionEnd?.(pose());
  };
  controls?.addEventListener("change", changed);
  controls?.addEventListener("end", ended);
  const contextLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    if (controls) controls.enabled = false;
    options.onUnavailable?.(new CadRendererError("renderer-unavailable"));
  };
  canvas.addEventListener("webglcontextlost", contextLost);
  const configureCamera = (resolved: ResolvedCadCamera) => {
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
    if (controls) {
      controls.object = camera;
      controls.update();
    }
  };
  const apply = (state: CadViewState): ResolvedCadCamera => {
    assertAvailable();
    if (!model) throw new CadRendererError("invalid-view");
    const bounds = model.apply(state);
    const resolved = resolveCadCamera(state.camera, bounds, width / height);
    applying = true;
    try {
      configureCamera(resolved);
      frameRevision++;
      view = state;
      render();
    } finally {
      applying = false;
    }
    return pose();
  };
  const load = async (
    manifest: CadSnapshotManifest,
    readAsset: (sha256: string) => Promise<ArrayBuffer>,
  ) => {
    assertAvailable();
    const token = ++generation;
    const loaded = new Map<string, THREE.Object3D>();
    const assetsByHash = new Map<string, THREE.Object3D>();
    const ownedScenes: THREE.Object3D[] = [];
    let candidate: CadSceneModel | null = null;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith("blob:") && !url.startsWith("data:"))
        throw new CadRendererError("invalid-snapshot");
      return url;
    });
    const loader = new GLTFLoader(manager);
    try {
      for (const asset of manifest.assets) {
        assertAvailable();
        if (token !== generation) throw new CadRendererError("superseded");
        let prototype = assetsByHash.get(asset.sha256);
        if (!prototype) {
          const bytes = await readAsset(asset.sha256);
          assertAvailable();
          if (token !== generation) throw new CadRendererError("superseded");
          const parsed = await loader.parseAsync(bytes, "");
          ownedScenes.push(...parsed.scenes);
          prototype = parsed.scene;
          assetsByHash.set(asset.sha256, prototype);
        }
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
      disposeCadObjects(prototypes);
      prototypes = ownedScenes;
      view = null;
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
    load,
    apply,
    capture,
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
        configureCamera(currentPose);
        if (view) render();
      } finally {
        applying = false;
      }
    },
    setInteractive: (enabled: boolean) => {
      assertAvailable();
      if (controls) controls.enabled = enabled;
      else if (enabled) throw new CadRendererError("invalid-view");
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation++;
      canvas.removeEventListener("webglcontextlost", contextLost);
      controls?.removeEventListener("change", changed);
      controls?.removeEventListener("end", ended);
      controls?.dispose();
      disposeCadObjects(prototypes);
      prototypes = [];
      model = null;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
export type CadSceneRenderer = ReturnType<typeof createCadSceneRenderer>;
