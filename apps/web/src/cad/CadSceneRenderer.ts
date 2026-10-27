import {
  COMMENT_FOCUS_AGENT_VIEW,
  COMMENT_FOCUS_CLIPPED,
  COMMENT_FOCUS_UNAVAILABLE,
} from "./cadCommentFocus";
import type {
  CadCommentTarget,
  CadCommentRenderWork,
  CadCommentRenderHit,
} from "@cadsense/contracts";
import {
  locateCadCommentPoints,
  cadVisibleIntersections,
  cadCommentWorldPoint,
  cadCommentVisible,
  cadCommentCameraUp,
  cadCommentInspectionDirections,
} from "./CadCommentGeometry";
import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import { CAD_CAPTURE_SIZE, CadCameraPose } from "@cadsense/contracts";
import { revealCadOccurrences } from "@cadsense/shared/cadScene";
import * as Schema from "effect/Schema";
const isCadCameraPose = Schema.is(CadCameraPose);
import * as THREE from "three";
import {
  CAD_SCENE_LIMITS,
  createCadSceneBudget,
  measureCadGeometry,
} from "@cadsense/shared/cadSceneBudget";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { prefetchCadAssets } from "./CadAssetPrefetch";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_CAD_APPEARANCE, type CadAppearance } from "./CadAppearance";
import { prepareCadMaterials } from "./CadMaterials";
import { creaseCadNormals } from "./CadNormals";
import { createCadOutline, supportsCadOutline } from "./CadOutline";
import {
  buildCadSceneModel,
  cadFitDistance,
  CAD_CAMERA_FOV,
  CAD_CONTEXT_LAYER,
  CAD_HIGHLIGHT_LAYER,
  CadRendererError,
  disposeCadObjects,
  resolveCadCamera,
  type CadSceneModel,
  type ResolvedCadCamera,
} from "./CadSceneModel";

export { CadRendererError } from "./CadSceneModel";
/** Parts in front of a reviewed target stay faintly visible for context. */
const REVIEW_GHOST_OPACITY = 0.15;
// Comment reviews mute the parts outside an isolation instead of hiding them.
const REVIEW_APPLY = { fadeIsolatedOut: true } as const;
/**
 * Overlay chrome along the viewport's edges, in CSS pixels: the chips along the top, the toolbar
 * along the bottom, and an open comments card (plus clearance) along the right.
 */
export type CadFrameInsets = {
  readonly top: number;
  readonly bottom: number;
  readonly right: number;
};
// A right inset that would leave less than this free is dropped: a narrow panel's comments card
// takes the full width and frames focus below itself instead.
const MIN_FREE_WIDTH = 240;
// A comment focus fills this much of the free area with the parts in focus.
const FOCUS_FILL = 0.8;
// A chosen camera pose survives small viewport changes; past this ratio in either dimension
// (maximizing or restoring the panel) the view refits so the model stays whole and centered.
const REFIT_RATIO = 1.25;
/**
 * The interactive viewport's backdrop: a cool lift at the top falling to just above the themed
 * background at the bottom, so the canvas reads as its own space against the app chrome.
 * Captures keep the flat themed color.
 */
const createBackdrop = (background: number, dark: boolean) => {
  const steps = 64;
  const data = new Uint8Array(steps * 4);
  const channels = [(background >> 16) & 0xff, (background >> 8) & 0xff, background & 0xff];
  // On the default #171717 this runs from #24262a at the top to #1a1b1d at the bottom: lighter
  // and cooler than the chat column at every height, so dark plates keep their outline.
  const lift = dark ? [13, 15, 19] : [6, 6, 8];
  const base = dark ? [3, 4, 6] : null;
  for (let row = 0; row < steps; row++) {
    // Rows run bottom to top; ease so most of the lift sits in the upper half.
    const t = (row / (steps - 1)) ** 1.4;
    channels.forEach((value, channel) => {
      const bottom = base ? value + base[channel]! : value * 0.94;
      data[row * 4 + channel] = Math.round(
        Math.min(255, bottom + (value + lift[channel]! - bottom) * t),
      );
    });
    data[row * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, 1, steps);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};
/** A sky/ground ambient, a key from the upper right front, and a low fill from the back left. */
const CAD_LIGHTS = {
  keyDirection: [3, -4, 5],
  fillDirection: [-3, 2, 1],
  dark: { ambient: 1.5, key: 2.2, fill: 1 },
  light: { ambient: 1.25, key: 2.2, fill: 0.8 },
} as const;
/**
 * Every CAD frame (viewer, captures, thumbnails) passes through one tone curve on luminance,
 * applied by scaling all three channels alike so part colors keep the hue and saturation of their
 * Onshape appearance. Exposure sets the overall level; luminance below TONE_KNEE then passes
 * through unchanged, so black anodized parts stay near-black, and only highlights above it roll
 * off smoothly toward TONE_CEILING. Key-lit aluminum (#e8 untouched) lands near #b7 so it does
 * not outshine the chat or swallow yellow pins, and front faces stay near #a0. Overlays (backdrop,
 * outlines, comment markers) and faded context are not tone mapped.
 */
const TONE_EXPOSURE = 0.85;
const TONE_KNEE = 0.33;
const TONE_CEILING = 0.5;
const IDENTITY_TONE_MAPPING = "vec3 CustomToneMapping( vec3 color ) { return color; }";
if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(IDENTITY_TONE_MAPPING))
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    IDENTITY_TONE_MAPPING,
    `vec3 CustomToneMapping( vec3 color ) {
      vec3 exposed = toneMappingExposure * color;
      float luminance = dot( exposed, vec3( 0.2126, 0.7152, 0.0722 ) );
      if ( luminance <= ${TONE_KNEE.toFixed(4)} ) return exposed;
      float range = ${(TONE_CEILING - TONE_KNEE).toFixed(4)};
      float mapped = ${TONE_KNEE.toFixed(4)} + range * ( 1.0 - exp( -( luminance - ${TONE_KNEE.toFixed(4)} ) / range ) );
      return saturate( exposed * ( mapped / luminance ) );
    }`,
  );
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
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
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
  const ambient = new THREE.HemisphereLight(0xffffff, 0x89939f, CAD_LIGHTS.dark.ambient);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, CAD_LIGHTS.dark.key);
  key.position.set(...CAD_LIGHTS.keyDirection);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, CAD_LIGHTS.dark.fill);
  fill.position.set(...CAD_LIGHTS.fillDirection);
  scene.add(fill);
  for (const light of [ambient, key, fill]) light.layers.enable(CAD_CONTEXT_LAYER);
  let backdrop = createBackdrop(DEFAULT_CAD_APPEARANCE.background, DEFAULT_CAD_APPEARANCE.dark);
  // Faded context draws as one quiet, neutral layer: a depth-only pass keeps just the nearest
  // context surface at each pixel, so overlapping parts never stack into fog, then that surface
  // is shaded once at low opacity behind or around the solid parts in focus.
  const contextDepth = new THREE.MeshBasicMaterial({ colorWrite: false });
  // Outside the tone curve and without edges, so context sits well below the parts in focus:
  // about a third of a focused light part's brightness, while its shading still shows where the
  // focus sits in the assembly.
  const contextSurface = new THREE.MeshLambertMaterial({
    color: 0x9aa0a8,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    toneMapped: false,
  });
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
  const frameListeners = new Set<() => void>();
  let disposed = false;
  let lost = false;
  let applying = false;
  let width = 1,
    height = 1;
  let view: CadViewState | null = null;
  // While a comment is selected, maps the user's view to the displayed one. Camera edits and
  // saves keep flowing through it; closing the review restores the user's view.
  let review: ((state: CadViewState) => CadViewState) | null = null;
  const displayed = (state: CadViewState) => (review ? review(state) : state);
  let focusOffset = { x: 0, y: 0 };
  // Null for capture renderers, whose fits keep the sphere framing agent captures expect.
  let insets: CadFrameInsets | null = null;
  /** The viewport area clear of overlay chrome, in CSS pixels from the top-left corner. */
  const freeArea = () => {
    if (!insets) return null;
    const right = width - insets.right >= MIN_FREE_WIDTH ? insets.right : 0;
    const top = Math.min(insets.top, height * 0.3),
      bottom = Math.min(insets.bottom, height * 0.3);
    return { left: 0, top, width: width - right, height: height - top - bottom };
  };
  /** The free area as shares of the viewport, for box fits. */
  const fitArea = () => {
    const area = freeArea();
    return area ? { width: area.width / width, height: area.height / height } : undefined;
  };
  /** The view offset that puts the image center in the middle of the free area. */
  const freeOffset = () => {
    const area = freeArea();
    return area
      ? {
          x: width / 2 - (area.left + area.width / 2),
          y: height / 2 - (area.top + area.height / 2),
        }
      : { x: 0, y: 0 };
  };
  /** Narrows the area a comment card leaves free to the part also clear of other chrome. */
  const clearOfChrome = (safe: {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  }) => {
    const area = freeArea();
    if (!area) return safe;
    const left = Math.max(safe.centerX - safe.width / 2, area.left),
      right = Math.min(safe.centerX + safe.width / 2, area.left + area.width),
      top = Math.max(safe.centerY - safe.height / 2, area.top),
      bottom = Math.min(safe.centerY + safe.height / 2, area.top + area.height);
    if (right - left < 120 || bottom - top < 120) return safe;
    return {
      width: right - left,
      height: bottom - top,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    };
  };
  // Whether the camera shows a fit (a preset, or a refit after a large resize) rather than a
  // pose someone chose, the viewport size that framing was made for, and the bounds it fit.
  let fitted = false;
  let framedSize = { width: 1, height: 1 };
  let fitBounds: THREE.Box3 | null = null;

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
  /** Draws faded context over the solid parts (see contextDepth). */
  const drawContext = (eye: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const layers = eye.layers.mask;
    try {
      scene.background = null;
      renderer.autoClear = false;
      eye.layers.set(CAD_CONTEXT_LAYER);
      scene.overrideMaterial = contextDepth;
      renderer.render(scene, eye);
      scene.overrideMaterial = contextSurface;
      renderer.render(scene, eye);
    } finally {
      scene.overrideMaterial = null;
      scene.background = background;
      renderer.autoClear = autoClear;
      eye.layers.mask = layers;
    }
  };
  /**
   * Draws the model, its outline, and any faded context from `eye`, without comment markers or
   * frame callbacks. Captures pass `withBackdrop: false` to keep the flat themed background.
   */
  const drawScene = (
    eye: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    withBackdrop = true,
  ) => {
    renderer.clippingPlanes = model?.clippingPlanes() ?? [];
    scene.background = withBackdrop ? backdrop : null;
    renderer.render(scene, eye);
    // The outline's opaque normal pass would draw cut-open or ghosted parts as solid shells.
    // Faded context is on its own layer, so only the parts in focus get edges.
    if (model && outlineSupported && !model.clippingPlanes().length && !model.hasGhosts())
      outline.render(
        scene,
        eye,
        model.bounds.getSize(outlineBounds).length(),
        model.hasHighlight() ? CAD_HIGHLIGHT_LAYER : undefined,
      );
    if (model?.hasFaded()) drawContext(eye);
  };
  const render = (withBackdrop = true) => {
    assertAvailable();
    const start = options.onFrame ? performance.now() : 0;
    drawScene(camera, withBackdrop);
    if (commentMarkers.children.length) {
      const autoClear = renderer.autoClear;
      const clippingPlanes = renderer.clippingPlanes;
      renderer.autoClear = false;
      renderer.clippingPlanes = [];
      try {
        renderer.clearDepth();
        renderer.render(markerScene, camera);
      } finally {
        renderer.autoClear = autoClear;
        renderer.clippingPlanes = clippingPlanes;
      }
    }
    options.onFrame?.(performance.now() - start);
    for (const listener of frameListeners) listener();
  };
  const pose = (): ResolvedCadCamera => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [target.x, target.y, target.z],
    up: [camera.up.x, camera.up.y, camera.up.z],
    projection: camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective",
    zoom: camera.zoom,
  });
  // Whether the camera moved since the pointer went down. A plain click moves nothing and
  // must not save the camera (it would save a comment focus close-up as the user's view).
  let movedSinceStart = false;
  const interactionStarted = () => {
    movedSinceStart = false;
    cancelTransition();
  };
  const changed = () => {
    if (!applying && !disposed && !lost) {
      movedSinceStart = true;
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
      fitted = false;
      framedSize = { width, height };
      frameRevision++;
      render();
      if (controls) controls.object.matrix.copy(camera.matrix);
    }
  };
  const ended = () => {
    if (movedSinceStart && controls?.enabled && !applying && !lost && !disposed)
      options.onInteractionEnd?.(pose());
  };
  controls?.addEventListener("start", interactionStarted);
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
  /** Builds a camera for `resolved` with clip planes sized to the loaded model. */
  const createCamera = (resolved: ResolvedCadCamera) => {
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
    let created: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (resolved.projection === "orthographic") {
      const halfHeight = Math.max(
        distance * Math.tan(THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2)),
        1e-7,
      );
      created = new THREE.OrthographicCamera(
        (-halfHeight * width) / height,
        (halfHeight * width) / height,
        halfHeight,
        -halfHeight,
        near,
        far,
      );
    } else created = new THREE.PerspectiveCamera(CAD_CAMERA_FOV, width / height, near, far);
    created.position.fromArray(resolved.position);
    created.up.fromArray(resolved.up);
    created.zoom = resolved.zoom;
    created.lookAt(new THREE.Vector3(...resolved.target));
    created.updateProjectionMatrix();
    return created;
  };
  const configureCamera = (resolved: ResolvedCadCamera, synchronizeControls = true) => {
    camera = createCamera(resolved);
    if (focusOffset.x || focusOffset.y)
      camera.setViewOffset(width, height, focusOffset.x, focusOffset.y, width, height);
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
    const bounds = model.apply(displayed(state), review ? REVIEW_APPLY : undefined);
    const resolved = resolveCadCamera(state.camera, bounds, width / height, fitArea());
    fitted = review === null && !(state.camera.kind === "pose" && state.camera.fit === null);
    // A fit is made for the free area, so it centers there.
    if (fitted) focusOffset = freeOffset();
    framedSize = { width, height };
    fitBounds = bounds;
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
    const to = resolveCadCamera(
      state.camera,
      model.apply(displayed(state), review ? REVIEW_APPLY : undefined),
      width / height,
      fitArea(),
    );
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
        review = null;
        focusOffset = freeOffset();
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
    const prefetched = prefetchCadAssets(
      manifest.assets,
      readAsset,
      () => token === generation && !disposed && !lost,
    );
    try {
      const budget = createCadSceneBudget(manifest.nodes);
      for (const asset of manifest.assets) {
        assertAvailable();
        if (token !== generation) throw new CadRendererError("superseded");
        let prototype = assetsByHash.get(asset.sha256);
        if (!prototype) {
          const bytes = await prefetched.read(asset.sha256);
          assertAvailable();
          if (token !== generation) throw new CadRendererError("superseded");
          const complexity = measureCadGeometry(new Uint8Array(bytes));
          decodedBytes = budget.add(asset, complexity).decodedBytes;
          complexities.set(asset.sha256, complexity);
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
          creaseCadNormals(prototype);
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
        // Match scene admission: a supported assembly must not exceed the entire warm-cache
        // budget by itself. Still bound aggregate CPU/GPU estimates and retain at most three scenes.
        if (
          cachedScenes.size <= (options.cacheScenes ? 3 : 1) &&
          total <= CAD_SCENE_LIMITS.decodedBytes
        )
          break;
        if (id === activeSnapshot) continue;
        cachedScenes.delete(id);
        total -= entry.bytes;
        entry.model.dispose();
        disposeCadObjects(entry.prototypes);
      }
      review = null;
      focusOffset = freeOffset();
      clearCommentMarkers();
      view = null;
      return false;
    } catch (error) {
      candidate?.dispose();
      disposeCadObjects(ownedScenes);
      if (error instanceof CadRendererError) throw error;
      throw new CadRendererError("invalid-snapshot");
    } finally {
      prefetched.dispose();
    }
  };
  const capture = async (): Promise<Blob> => {
    assertAvailable();
    if (!model || !view) throw new CadRendererError("invalid-view");
    const token = generation,
      revision = frameRevision;
    render(false);
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
  /**
   * Snapshots every shown part from a fitted isometric camera, for project thumbnails that must
   * not depend on where the user left the camera. Encoding copies the drawing buffer before this
   * returns to the event loop, so the live frame is redrawn before the browser can present the
   * overview.
   */
  const captureOverview = async (): Promise<Blob> => {
    assertAvailable();
    if (!model || !view) throw new CadRendererError("invalid-view");
    const overview = createCamera(
      resolveCadCamera(
        { kind: "preset", preset: "isometric", fit: [] },
        model.visibleBounds(),
        width / height,
      ),
    );
    drawScene(overview, false);
    let encoded: Promise<Blob | null>;
    try {
      encoded =
        "convertToBlob" in canvas
          ? canvas.convertToBlob({ type: "image/png" })
          : new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } finally {
      render();
    }
    const blob = await encoded.catch(() => null);
    if (!blob) throw new CadRendererError("capture-failed");
    return blob;
  };
  // Camera and framing from before the current comment review began, so leaving the focus
  // can return to them.
  let reviewStart: {
    pose: ResolvedCadCamera;
    offset: { x: number; y: number };
    fitted: boolean;
  } | null = null;
  const beginCommentReview = () => {
    if (!reviewStart) reviewStart = { pose: pose(), offset: { ...focusOffset }, fitted };
    fitted = false;
  };
  /**
   * The fit the current view's camera makes for the free area, seen from `from`'s direction
   * when the view holds a pose.
   */
  const refitPose = (from: ResolvedCadCamera) =>
    model && view
      ? resolveCadCamera(
          view.camera.kind === "pose"
            ? { kind: "pose", pose: from, fit: view.camera.fit ?? [] }
            : view.camera,
          fitBounds ?? model.visibleBounds(),
          width / height,
          fitArea(),
        )
      : from;
  /** Eases the camera to `to` and the comment framing offset to `offset`, then calls `done`. */
  const easeCameraTo = (
    to: ResolvedCadCamera,
    offset: { x: number; y: number },
    reducedMotion: boolean,
    done?: () => void,
  ) => {
    const from = pose();
    const fromOffset = { ...focusOffset };
    const started = performance.now();
    const move = (now: number) => {
      animationFrame = null;
      if (disposed || lost) return;
      const fraction = reducedMotion ? 1 : Math.min(1, (now - started) / 280),
        eased = 1 - (1 - fraction) ** 3;
      focusOffset = {
        x: THREE.MathUtils.lerp(fromOffset.x, offset.x, eased),
        y: THREE.MathUtils.lerp(fromOffset.y, offset.y, eased),
      };
      const position = new THREE.Vector3(...from.position).lerp(
          new THREE.Vector3(...to.position),
          eased,
        ),
        aim = new THREE.Vector3(...from.target).lerp(new THREE.Vector3(...to.target), eased),
        roll = new THREE.Vector3(...from.up).lerp(new THREE.Vector3(...to.up), eased);
      if (roll.lengthSq() < 1e-12) roll.fromArray(to.up);
      applying = true;
      configureCamera({
        ...to,
        position: [position.x, position.y, position.z],
        target: [aim.x, aim.y, aim.z],
        up:
          Math.abs(position.clone().sub(aim).normalize().dot(roll.normalize())) > 0.99
            ? cadCommentCameraUp(position.clone().sub(aim))
            : [roll.x, roll.y, roll.z],
        zoom: THREE.MathUtils.lerp(from.zoom, to.zoom, eased),
      });
      applying = false;
      render();
      if (fraction < 1) animationFrame = requestAnimationFrame(move);
      else done?.();
    };
    if (controls) controls.enabled = interactive;
    move(started);
  };
  /**
   * Ends a comment review and restores the view's own visibility. With `returnCamera`, the
   * camera also eases back to where it was before the review began (refit for the chrome now
   * around the viewport if it was a fit); without it, the camera stays and recenters in the
   * free area.
   */
  const endCommentReview = (returnCamera?: { reducedMotion: boolean }) => {
    cancelTransition();
    review = null;
    const start = reviewStart;
    reviewStart = null;
    if (model && view) {
      fitBounds = model.apply(view);
      if (start && !returnCamera && insets) {
        focusOffset = freeOffset();
        configureCamera(pose());
      }
      render();
    }
    if (returnCamera && start && model && view) {
      easeCameraTo(
        start.fitted ? refitPose(start.pose) : start.pose,
        insets ? freeOffset() : start.offset,
        returnCamera.reducedMotion,
      );
      fitted = start.fitted;
    }
  };
  /**
   * The shared end of a comment focus. Faded context in a line of sight to the parts in focus is
   * hidden so it cannot haze over them, then the camera eases from `from` to look at `point`.
   */
  const finishCommentFocus = ({
    loaded,
    base,
    from,
    eye,
    point,
    up,
    zoom,
    safe,
    reducedMotion,
    orthographic,
  }: {
    loaded: CadSceneModel;
    base: CadViewState;
    from: ResolvedCadCamera;
    eye: THREE.Vector3;
    point: THREE.Vector3;
    up: THREE.Vector3;
    zoom: number;
    safe: { width: number; height: number; centerX: number; centerY: number };
    reducedMotion: boolean;
    orthographic: boolean;
  }) => {
    // Faded context between the camera and the parts in focus would haze over them, so any
    // faded part crossing a line of sight stays hidden; the rest stays faded around the focus.
    const sightOrigin = (sample: THREE.Vector3) =>
      orthographic ? sample.clone().add(eye.clone().sub(point)) : eye;
    const sights = [...loaded.objects]
      .filter(([id, e]) => e.object.visible && !loaded.isFaded(id))
      .slice(0, 64)
      .flatMap(([, e]) => {
        const box = new THREE.Box3().setFromObject(e.object);
        const middle = box.getCenter(new THREE.Vector3());
        return [
          middle,
          ...[0, 1, 2, 3, 4, 5, 6, 7].map((corner) =>
            new THREE.Vector3(
              corner & 1 ? box.max.x : box.min.x,
              corner & 2 ? box.max.y : box.min.y,
              corner & 4 ? box.max.z : box.min.z,
            ).lerp(middle, 0.5),
          ),
        ];
      });
    const occluding: string[] = [];
    for (const [id, e] of loaded.objects) {
      if (!e.object.visible || !loaded.isFaded(id)) continue;
      const box = new THREE.Box3().setFromObject(e.object);
      const hit = new THREE.Vector3();
      if (
        sights.some((sample) => {
          const origin = sightOrigin(sample);
          const ray = new THREE.Ray(origin, sample.clone().sub(origin).normalize());
          return (
            ray.intersectBox(box, hit) !== null &&
            hit.distanceTo(origin) < origin.distanceTo(sample)
          );
        })
      )
        occluding.push(id);
    }
    if (review && occluding.length) {
      const framed = review;
      review = (state) => {
        const next = framed(state);
        return {
          ...next,
          visibility: {
            ...next.visibility,
            ...Object.fromEntries(occluding.map((id) => [id, false])),
          },
        };
      };
      loaded.apply(review(base), REVIEW_APPLY);
    }
    focusOffset = { x: width / 2 - safe.centerX, y: height / 2 - safe.centerY };
    const started = performance.now();
    const move = (now: number) => {
      animationFrame = null;
      const fraction = reducedMotion ? 1 : Math.min(1, (now - started) / 280),
        eased = 1 - (1 - fraction) ** 3;
      const position = new THREE.Vector3(...from.position).lerp(eye, eased),
        aim = new THREE.Vector3(...from.target).lerp(point, eased),
        roll = new THREE.Vector3(...from.up).lerp(up, eased);
      if (roll.lengthSq() < 1e-12) roll.copy(up);
      applying = true;
      configureCamera({
        ...from,
        position: [position.x, position.y, position.z],
        target: [aim.x, aim.y, aim.z],
        up:
          Math.abs(position.clone().sub(aim).normalize().dot(roll.normalize())) > 0.99
            ? cadCommentCameraUp(position.clone().sub(aim))
            : [roll.x, roll.y, roll.z],
        zoom: THREE.MathUtils.lerp(from.zoom, zoom, eased),
      });
      applying = false;
      render();
      if (fraction < 1) animationFrame = requestAnimationFrame(move);
    };
    if (controls) controls.enabled = interactive;
    move(started);
  };

  return {
    cameraPose: pose,
    subscribeFrames: (listener: () => void) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
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
        // A reviewed view hides unrelated parts; their markers would point at empty space.
        visible: projected.z >= -1 && projected.z <= 1 && (review === null || entry.object.visible),
      };
    },
    endCommentReview,
    /**
     * Whether a viewport point (CSS pixels) lands on empty space: nothing but background or
     * faded and ghosted context, so clicking there leaves the focused comment.
     */
    isEmptyAt: (x: number, y: number) => {
      if (!model) return true;
      const loaded = model;
      camera.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), camera);
      return !cadVisibleIntersections(loaded, ray).some((hit) => {
        let node: THREE.Object3D | null = hit.object;
        while (node && loaded.objects.get(node.name)?.object !== node) node = node.parent;
        if (!node || loaded.isFaded(node.name)) return false;
        const material =
          hit.object instanceof THREE.Mesh
            ? Array.isArray(hit.object.material)
              ? hit.object.material[hit.face?.materialIndex ?? 0]
              : hit.object.material
            : null;
        return (material?.opacity ?? 1) > REVIEW_GHOST_OPACITY;
      });
    },
    /**
     * Frames a comment target outside the card. A point replays the agent capture it was located
     * in, because locating proved it visible there. Other targets are revealed, and the parts in
     * front of them are ghosted. Returns the notice the card shows.
     */
    focusComment: (
      t: CadCommentTarget,
      cardArea: { width: number; height: number; centerX: number; centerY: number },
      reducedMotion: boolean,
      capture?: CadViewState,
    ) => {
      cancelTransition();
      const safe = clearOfChrome(cardArea);
      if (!model || !view) return COMMENT_FOCUS_UNAVAILABLE;
      beginCommentReview();
      const loaded = model,
        base = view;
      const fail = (reason: string) => {
        endCommentReview();
        return reason;
      };
      const entry = loaded.objects.get(t.occurrenceId);
      if (!entry) return fail(COMMENT_FOCUS_UNAVAILABLE);
      review = null;
      loaded.apply(base);
      const wasHidden = !entry.object.visible;
      const agent =
        t.kind === "point" && capture?.camera.kind === "pose" ? capture.camera.pose : null;
      let replayed = false;
      if (capture && agent) {
        const replay = (state: CadViewState): CadViewState => ({
          ...capture,
          rootId: state.rootId,
          snapshotId: state.snapshotId,
          revision: state.revision,
          camera: state.camera,
        });
        try {
          loaded.apply(replay(base), REVIEW_APPLY);
          review = replay;
          replayed = true;
        } catch (error) {
          // A capture naming occurrences this model lacks falls back to revealing the target.
          if (!(error instanceof CadRendererError)) throw error;
        }
      }
      if (!review) {
        const revealed = (state: CadViewState): CadViewState => ({
          ...state,
          visibility: revealCadOccurrences(loaded.index, state, [t.occurrenceId]),
          isolatedOccurrenceIds: state.isolatedOccurrenceIds.length
            ? [...new Set([...state.isolatedOccurrenceIds, t.occurrenceId])]
            : [],
        });
        review = revealed;
        loaded.apply(revealed(base), REVIEW_APPLY);
      }
      const bounds = new THREE.Box3().setFromObject(entry.object),
        size = bounds.getSize(new THREE.Vector3()).length();
      const point =
        t.kind === "point"
          ? cadCommentWorldPoint(loaded, t.occurrenceId, t.point)
          : bounds.getCenter(new THREE.Vector3());
      if (!point) return fail(COMMENT_FOCUS_UNAVAILABLE);
      if (loaded.isClipped(point)) return fail(COMMENT_FOCUS_CLIPPED);
      const from = pose();
      let eye: THREE.Vector3, up: THREE.Vector3, zoom: number, notice: string;
      if (agent && replayed) {
        const agentEye = new THREE.Vector3(...agent.position);
        // Orthographic captures see along their direction, so keep that line through the point.
        eye =
          agent.projection === "orthographic"
            ? point.clone().addScaledVector(
                agentEye
                  .clone()
                  .sub(new THREE.Vector3(...agent.target))
                  .normalize(),
                agentEye.distanceTo(point),
              )
            : agentEye;
        up = new THREE.Vector3(...agent.up);
        // Fit the capture's frame inside the area the card leaves uncovered.
        zoom =
          agent.zoom *
          Math.min(
            safe.height / height,
            (safe.width * CAD_CAPTURE_SIZE.height) / (CAD_CAPTURE_SIZE.width * height),
          );
        // Move in from the agent's direction until the target part and a margin of its
        // neighbors (a cube 1.5 times its diagonal) fill the free area, so the part reads as the
        // subject; never move further out than the agent's own framing.
        {
          const orthographic = agent.projection === "orthographic";
          const along = eye.clone().sub(point);
          const reach = along.length();
          const tangent = Math.tan(THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2));
          const needed = cadFitDistance(
            new THREE.Box3().setFromCenterAndSize(
              bounds.getCenter(new THREE.Vector3()),
              new THREE.Vector3().setScalar(Math.max(size * 1.5, 1e-6)),
            ),
            point,
            along,
            up,
            {
              x: (tangent * safe.width * FOCUS_FILL) / height,
              y: (tangent * safe.height * FOCUS_FILL) / height,
            },
            orthographic,
          );
          // Perspective zoom narrows the field like moving in; orthographic zoom scales extents.
          if (needed > 0 && needed < reach / zoom) {
            if (orthographic) zoom = reach / needed;
            else {
              eye = point.clone().addScaledVector(along.normalize(), needed);
              zoom = 1;
            }
          }
        }
        notice = COMMENT_FOCUS_AGENT_VIEW;
      } else {
        const radius =
          t.kind === "part"
            ? bounds.getBoundingSphere(new THREE.Sphere()).radius
            : Math.max(size * 0.35, 0.001);
        const angle = Math.atan(
          Math.tan(Math.PI / 8) * Math.min(safe.height / height, safe.width / height),
        );
        const distance = (Math.max(radius, 1e-6) / Math.sin(Math.max(angle, 0.01))) * 1.15;
        // A whole part is seen through any of its surface, so rays also aim across its bounds.
        const center = bounds.getCenter(new THREE.Vector3());
        const samples =
          t.kind === "part"
            ? [
                point,
                ...[0, 1, 2, 3, 4, 5, 6, 7].map((corner) =>
                  new THREE.Vector3(
                    corner & 1 ? bounds.max.x : bounds.min.x,
                    corner & 2 ? bounds.max.y : bounds.min.y,
                    corner & 4 ? bounds.max.z : bounds.min.z,
                  ).lerp(center, 0.5),
                ),
              ]
            : [point];
        const rayHits = (d: THREE.Vector3) => {
          const hits = new Set<string>();
          for (const sample of samples) {
            const origin = sample.clone().addScaledVector(d, distance);
            const ray = new THREE.Raycaster(
              origin,
              sample.clone().sub(origin).normalize(),
              0,
              distance - Math.max(1e-7, size * 1e-5),
            );
            for (const [id, e] of loaded.objects)
              if (
                e.object.visible &&
                // Faded context does not block the view, just as when it was hidden.
                !loaded.isFaded(id) &&
                (t.kind === "point" || id !== t.occurrenceId) &&
                ray.intersectObject(e.object, true).some((hit) => !loaded.isClipped(hit.point))
              )
                hits.add(id);
          }
          return hits;
        };
        const direction = camera.position.clone().sub(target).normalize();
        let blockers = rayHits(direction);
        // Ghosting makes a whole part readable from the current angle. A point needs an angle
        // where its own part does not cover it.
        for (const d of [
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, -1, 1).normalize(),
          new THREE.Vector3(-1, 1, 1).normalize(),
          new THREE.Vector3(0, 0, -1),
        ]) {
          if (t.kind === "part" || !blockers.size) break;
          const hits = rayHits(d);
          if (hits.size < blockers.size) {
            direction.copy(d);
            blockers = hits;
          }
        }
        const ghosted = [...blockers].filter((id) => id !== t.occurrenceId);
        if (ghosted.length) {
          const revealed = review;
          review = (state) => {
            const next = revealed(state);
            return {
              ...next,
              ghost: {
                occurrenceIds: [
                  ...new Set([...(next.ghost?.occurrenceIds ?? []), ...ghosted]),
                ].slice(0, 256),
                opacity: Math.min(next.ghost?.opacity ?? 1, REVIEW_GHOST_OPACITY),
              },
            };
          };
          loaded.apply(review(base), REVIEW_APPLY);
        }
        up = new THREE.Vector3(...from.up);
        // A whole part fills the free area by its box, which frames long or flat parts closer
        // than its sphere.
        const tangent = Math.tan(THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2));
        eye = point.clone().addScaledVector(
          direction,
          t.kind === "part"
            ? Math.max(
                cadFitDistance(
                  bounds,
                  point,
                  direction,
                  up,
                  {
                    x: (tangent * safe.width * FOCUS_FILL) / height,
                    y: (tangent * safe.height * FOCUS_FILL) / height,
                  },
                  false,
                ),
                size * 0.05,
              )
            : distance,
        );
        zoom = 1;
        notice = blockers.has(t.occurrenceId)
          ? "Target is occluded by its own geometry; orbit to inspect"
          : ghosted.length
            ? "Blocking parts ghosted"
            : wasHidden
              ? "Target temporarily revealed"
              : "";
      }
      finishCommentFocus({
        loaded,
        base,
        from,
        eye,
        point,
        up,
        zoom,
        safe,
        reducedMotion,
        orthographic: !!agent && replayed && agent.projection === "orthographic",
      });
      return notice;
    },
    /**
     * Frames every location of a multi-location comment in one view outside the card, from the
     * current viewing direction. The locations are revealed like a single part target.
     */
    focusCommentTargets: (
      targets: readonly CadCommentTarget[],
      cardArea: { width: number; height: number; centerX: number; centerY: number },
      reducedMotion: boolean,
    ) => {
      cancelTransition();
      const safe = clearOfChrome(cardArea);
      if (!model || !view) return COMMENT_FOCUS_UNAVAILABLE;
      beginCommentReview();
      const loaded = model,
        base = view;
      const ids = [...new Set(targets.map((t) => t.occurrenceId))];
      if (!ids.length || ids.some((id) => !loaded.objects.has(id))) {
        endCommentReview();
        return COMMENT_FOCUS_UNAVAILABLE;
      }
      review = null;
      loaded.apply(base);
      const wasHidden = ids.some((id) => !loaded.objects.get(id)?.object.visible);
      const revealed = (state: CadViewState): CadViewState => ({
        ...state,
        visibility: revealCadOccurrences(loaded.index, state, ids),
        isolatedOccurrenceIds: state.isolatedOccurrenceIds.length
          ? [...new Set([...state.isolatedOccurrenceIds, ...ids])]
          : [],
      });
      review = revealed;
      loaded.apply(revealed(base), REVIEW_APPLY);
      // Points get some room around them, scaled to their part, so close points still show
      // where they sit; whole parts are framed by their bounds.
      const box = new THREE.Box3();
      for (const t of targets) {
        const entry = loaded.objects.get(t.occurrenceId);
        if (!entry) continue;
        const part = new THREE.Box3().setFromObject(entry.object);
        if (t.kind !== "point") {
          box.union(part);
          continue;
        }
        const point = cadCommentWorldPoint(loaded, t.occurrenceId, t.point);
        if (!point) continue;
        const margin = Math.max(part.getSize(new THREE.Vector3()).length() * 0.2, 0.001);
        box.union(
          new THREE.Box3().setFromCenterAndSize(point, new THREE.Vector3().setScalar(margin * 2)),
        );
      }
      if (box.isEmpty()) {
        endCommentReview();
        return COMMENT_FOCUS_UNAVAILABLE;
      }
      const center = box.getCenter(new THREE.Vector3());
      const direction = camera.position.clone().sub(target).normalize();
      const from = pose();
      const up = new THREE.Vector3(...from.up);
      const tangent = Math.tan(THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2));
      const distance = Math.max(
        cadFitDistance(
          box,
          center,
          direction,
          up,
          {
            x: (tangent * safe.width * FOCUS_FILL) / height,
            y: (tangent * safe.height * FOCUS_FILL) / height,
          },
          false,
        ),
        box.getSize(new THREE.Vector3()).length() * 0.05,
        1e-6,
      );
      finishCommentFocus({
        loaded,
        base,
        from,
        eye: center.clone().addScaledVector(direction, distance),
        point: center,
        up,
        zoom: 1,
        safe,
        reducedMotion,
        orthographic: false,
      });
      return wasHidden ? "Locations temporarily revealed" : "";
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
                new THREE.MeshBasicMaterial({
                  color: 0xffd866,
                  depthTest: false,
                  toneMapped: false,
                }),
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
      const isTargetVisible = (t: (typeof targets)[number]) =>
        currentModel.objects.get(t.occurrenceId)?.object.visible &&
        t.world &&
        cadCommentVisible(currentModel, camera, t.world);
      const bounds = new THREE.Box3();
      for (const [id, entry] of model.objects) {
        if (targets.some((t) => t.occurrenceId === id))
          bounds.union(new THREE.Box3().setFromObject(entry.object));
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
      const originalDirection = camera.position.clone().sub(target).normalize();
      const directions = cadCommentInspectionDirections(originalDirection);
      let best = directions[0]!,
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
        orient(direction);
        const n = targets.filter(isTargetVisible).length;
        if (n > score) {
          score = n;
          best = direction;
        }
      }
      orient(best);
      const hits = targets.map((t, index): CadCommentRenderHit => {
        const visible = isTargetVisible(t);
        if (t.world) {
          const marker = new THREE.Mesh(
            new THREE.SphereGeometry(radius * 0.035, 12, 8),
            new THREE.MeshBasicMaterial({
              color: visible ? 0xffd866 : 0xff6262,
              depthTest: false,
              toneMapped: false,
            }),
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
                new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }),
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
    displayedManifest: () =>
      activeSnapshot === null ? null : (cachedScenes.get(activeSnapshot)?.manifest ?? null),
    cancelLoad: () => {
      generation++;
    },
    suspend: () => {
      cancelTransition();
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
    captureOverview,
    setAppearance: (next: CadAppearance) => {
      assertAvailable();
      if (next.background === appearance.background && next.dark === appearance.dark) return;
      appearance = next;
      renderer.setClearColor(next.background);
      backdrop.dispose();
      backdrop = createBackdrop(next.background, next.dark);
      const lights = next.dark ? CAD_LIGHTS.dark : CAD_LIGHTS.light;
      ambient.intensity = lights.ambient;
      key.intensity = lights.key;
      fill.intensity = lights.fill;
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
      // A comment review keeps the pose it flew to; otherwise fits follow the viewport, and a
      // chosen pose refits once the viewport has grown or shrunk a lot since it was framed.
      const resized = Math.max(
        Math.abs(Math.log(width / framedSize.width)),
        Math.abs(Math.log(height / framedSize.height)),
      );
      const shown = view,
        loaded = model;
      const refit =
        loaded !== null &&
        shown !== null &&
        animationFrame === null &&
        review === null &&
        reviewStart === null &&
        (fitted || resized > Math.log(REFIT_RATIO));
      applying = true;
      try {
        if (refit) {
          focusOffset = freeOffset();
          configureCamera(refitPose(currentPose));
          fitted = true;
          framedSize = { width, height };
        } else configureCamera(currentPose, animationFrame === null);
        if (view) render();
      } finally {
        applying = false;
      }
    },
    /**
     * Keeps fits and comment focus clear of overlay chrome along the viewport's edges. Outside a
     * comment review, the model eases into the new free area: a fit refits, a chosen pose keeps
     * its camera and recenters. Capture renderers never call this and keep sphere fits.
     */
    setFrameInsets: (next: CadFrameInsets, options: { reducedMotion: boolean }) => {
      const changed = JSON.stringify(next) !== JSON.stringify(insets);
      insets = next;
      if (!changed || !model || !view || review || reviewStart || animationFrame !== null) return;
      const current = pose();
      easeCameraTo(fitted ? refitPose(current) : current, freeOffset(), options.reducedMotion);
    },
    /**
     * Eases to a tight fit of every shown part, seen from the current direction, inside the free
     * area. Outside a comment review the result is reported like the end of an orbit, so the
     * host saves it as the user's view.
     */
    fit: ({ reducedMotion }: { reducedMotion: boolean }) => {
      assertAvailable();
      cancelTransition();
      if (!model || !view) return;
      const current = pose();
      const to = resolveCadCamera(
        { kind: "pose", pose: current, fit: [] },
        model.visibleBounds(),
        width / height,
        fitArea(),
      );
      const reviewing = review !== null;
      easeCameraTo(to, reviewing ? focusOffset : freeOffset(), reducedMotion, () => {
        framedSize = { width, height };
        if (!reviewing && !disposed && !lost) options.onInteractionEnd?.(pose());
      });
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
      backdrop.dispose();
      contextDepth.dispose();
      contextSurface.dispose();
      disposed = true;
      frameListeners.clear();
      generation++;
      canvas.removeEventListener("webglcontextlost", contextLost);
      controls?.removeEventListener("start", interactionStarted);
      controls?.removeEventListener("change", changed);
      controls?.removeEventListener("end", ended);
      controls?.dispose();
      for (const entry of cachedScenes.values()) {
        entry.model.dispose();
        disposeCadObjects(entry.prototypes);
      }
      cachedScenes.clear();
      model = null;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
export type CadSceneRenderer = ReturnType<typeof createCadSceneRenderer>;
