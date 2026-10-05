import type { EnvironmentId } from "@cadsense/contracts";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { useAssetUrl } from "../assets/assetUrls";
import { observeCadAppearance } from "../cad/CadAppearance";
import { CAD_CAMERA_FOV } from "../cad/CadSceneModel";
import { cn } from "../lib/utils";
import type { ModelPoint, PickHit } from "./featureScriptDialog";

/** The renderer's view toward the model, matching the iso PNGs agents get. */
const ISO = new THREE.Vector3(1, 1, 1).normalize();
const PICK_COLOR = 0x60a5fa;
const EDGE_ANGLE_DEGREES = 25;

export interface FeatureScriptViewportProps {
  readonly environmentId: EnvironmentId;
  /** GLB attachment ids from the panel preview: meters, Z up, feature faces in material 1. */
  readonly after: string | null;
  readonly before: string | null;
  readonly show: "after" | "before";
  /** Grey the model out, for the last good run shown under a failure. */
  readonly stale: boolean;
  readonly picking: boolean;
  /** The model was clicked while picking; `add` when shift was held. */
  readonly onPick: (hit: PickHit, add: boolean) => void;
  readonly picks: readonly ModelPoint[];
  /** Bumped to fit the camera to the model again. */
  readonly fitRequest: number;
  /** A model couldn't be fetched or read (pruned, say); the view keeps what it had. */
  readonly onLoadFailed: (attachmentId: string) => void;
}

/** Loads one model attachment into the view once its URL is signed. */
function ModelSlot(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly load: (url: string) => void;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
    fileName: "preview.glb",
    mimeType: "model/gltf-binary",
  });
  const loadRef = useRef(props.load);
  loadRef.current = props.load;
  useEffect(() => {
    if (url) loadRef.current(url);
  }, [url]);
  return null;
}

/**
 * The file panel's model view. Draws only when something changes (orbiting, a new model, a
 * resize), never in a loop. A new run's model replaces the old one once it has loaded, and the
 * camera stays where the person left it.
 */
export function FeatureScriptViewport(props: FeatureScriptViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the model loaders below mount only once the view exists, since child
  // effects run before this component's own.
  const [view, setView] = useState<View | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const onPickRef = useRef(props.onPick);
  onPickRef.current = props.onPick;
  const pickingRef = useRef(props.picking);
  pickingRef.current = props.picking;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Each view owns its canvas, so releasing its WebGL context on the way out can't break the
    // next view (React mounts effects twice in development).
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full outline-none";
    canvas.setAttribute("aria-label", "FeatureScript preview model");
    container.append(canvas);
    let created: View;
    try {
      created = createView(canvas, {
        picking: () => pickingRef.current,
        onPick: (hit, add) => onPickRef.current(hit, add),
      });
    } catch {
      canvas.remove();
      setUnavailable(true);
      return;
    }
    setView(created);
    const resize = new ResizeObserver(() =>
      created.resize(container.clientWidth, container.clientHeight),
    );
    resize.observe(container);
    const stopAppearance = observeCadAppearance((appearance) =>
      created.setBackground(appearance.background),
    );
    return () => {
      resize.disconnect();
      stopAppearance();
      created.dispose();
      canvas.remove();
      setView(null);
    };
  }, []);

  useEffect(() => {
    if (props.after === null) view?.setModel("after", null);
  }, [view, props.after]);
  useEffect(() => {
    if (props.before === null) view?.setModel("before", null);
  }, [view, props.before]);
  useEffect(() => view?.show(props.show), [view, props.show]);
  useEffect(() => view?.setPicks(props.picks), [view, props.picks]);
  useEffect(() => {
    if (props.fitRequest > 0) view?.fit();
  }, [view, props.fitRequest]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0",
        props.picking ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
        props.stale && "opacity-40 grayscale",
      )}
    >
      {unavailable ? (
        <p className="flex h-full items-center justify-center px-8 text-center text-xs text-muted-foreground">
          The 3D preview needs WebGL, which isn't available here.
        </p>
      ) : null}
      {view && props.after ? (
        <ModelSlot
          environmentId={props.environmentId}
          attachmentId={props.after}
          load={(url) =>
            void view.load("after", url).then((loaded) => {
              if (!loaded && props.after) props.onLoadFailed(props.after);
            })
          }
        />
      ) : null}
      {view && props.before ? (
        <ModelSlot
          environmentId={props.environmentId}
          attachmentId={props.before}
          load={(url) =>
            void view.load("before", url).then((loaded) => {
              if (!loaded && props.before) props.onLoadFailed(props.before);
            })
          }
        />
      ) : null}
    </div>
  );
}

type Slot = "after" | "before";
type View = ReturnType<typeof createView>;

/** The three.js side of the viewport, kept out of React. */
function createView(
  canvas: HTMLCanvasElement,
  pick: {
    readonly picking: () => boolean;
    readonly onPick: (hit: PickHit, add: boolean) => void;
  },
) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x89939f, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, -4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  fill.position.set(-3, 2, 1);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(CAD_CAMERA_FOV, 1, 1e-4, 100);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  const markers = new THREE.Group();
  markers.renderOrder = 1;
  scene.add(markers);
  const models: Record<Slot, THREE.Group | null> = { after: null, before: null };
  const loading: Record<Slot, string | null> = { after: null, before: null };
  let shown: Slot = "after";
  let picks: readonly ModelPoint[] = [];
  /** Until the person moves the camera, it stays fitted to the model as the panel resizes. */
  let autoFit = true;
  let fitted = false;
  let disposed = false;
  let frame = 0;

  const render = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed) renderer.render(scene, camera);
    });
  };
  controls.addEventListener("change", render);
  controls.addEventListener("start", () => {
    autoFit = false;
  });

  const bounds = () => {
    const box = new THREE.Box3();
    for (const model of [models.after, models.before]) if (model) box.expandByObject(model);
    return box;
  };
  const fit = () => {
    const box = bounds();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-4);
    // The narrower of the two fields of view decides, so a tall panel doesn't crop the sides.
    const halfVertical = THREE.MathUtils.degToRad(CAD_CAMERA_FOV / 2);
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect);
    const distance = (radius * 1.05) / Math.sin(Math.min(halfVertical, halfHorizontal));
    camera.position.copy(center).addScaledVector(ISO, distance);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    fitted = true;
    render();
  };

  const disposeObject = (object: THREE.Object3D) =>
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        for (const material of [child.material].flat()) material.dispose();
      }
    });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1d2126 });

  const setModel = (slot: Slot, model: THREE.Group | null) => {
    // Clearing a slot also cancels its pending load, so an older run's model can't come back.
    if (model === null) loading[slot] = null;
    const previous = models[slot];
    if (previous) {
      scene.remove(previous);
      disposeObject(previous);
    }
    models[slot] = model;
    if (model) {
      model.visible = slot === shown;
      scene.add(model);
      if (!fitted) fit();
    }
    // Marker size follows the model's.
    drawPicks();
  };

  /** Picked points as dots drawn over the model. */
  function drawPicks() {
    for (const marker of markers.children) disposeObject(marker);
    markers.clear();
    const size = Math.max(bounds().getSize(new THREE.Vector3()).length(), 1e-3) * 0.008;
    for (const point of picks) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(size, 16, 12),
        new THREE.MeshBasicMaterial({ color: PICK_COLOR, depthTest: false }),
      );
      marker.position.set(...point);
      markers.add(marker);
    }
    render();
  }

  const loader = new GLTFLoader();
  /**
   * Loads a model into `slot`; false when it's gone or broken, which leaves the slot as it was.
   * A load overtaken by a newer one (or a cleared slot) is dropped and counts as loaded.
   */
  const load = async (slot: Slot, url: string): Promise<boolean> => {
    loading[slot] = url;
    let gltf;
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      gltf = await loader.parseAsync(await response.arrayBuffer(), "");
    } catch {
      return false;
    }
    // A newer run's model may have been asked for meanwhile.
    if (disposed || loading[slot] !== url) {
      disposeObject(gltf.scene);
      return true;
    }
    gltf.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const material of [child.material].flat()) material.side = THREE.DoubleSide;
      child.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(child.geometry, EDGE_ANGLE_DEGREES),
          edgeMaterial.clone(),
        ),
      );
    });
    setModel(slot, gltf.scene);
    return true;
  };

  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = down;
    down = null;
    // A drag orbits; only a click picks.
    if (
      !start ||
      !pick.picking() ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
    )
      return;
    const model = models[shown];
    if (!model) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster
      .intersectObject(model, true)
      .find((intersection) => intersection.object instanceof THREE.Mesh);
    if (!hit) return;
    // The clicked face's normal, turned toward the camera: the side the person clicked on.
    const normal = (hit.face?.normal.clone() ?? raycaster.ray.direction.clone().negate())
      .transformDirection(hit.object.matrixWorld)
      .normalize();
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    pick.onPick(
      { point: [hit.point.x, hit.point.y, hit.point.z], normal: [normal.x, normal.y, normal.z] },
      event.shiftKey,
    );
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  return {
    load,
    setModel,
    fit: () => {
      autoFit = true;
      fit();
    },
    show: (slot: Slot) => {
      shown = slot;
      if (models.after) models.after.visible = slot === "after";
      if (models.before) models.before.visible = slot === "before";
      render();
    },
    setPicks: (points: readonly ModelPoint[]) => {
      picks = points;
      drawPicks();
    },
    setBackground: (color: number) => {
      renderer.setClearColor(color);
      render();
    },
    resize: (width: number, height: number) => {
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (autoFit && fitted) fit();
      render();
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      for (const object of [models.after, models.before, markers])
        if (object) disposeObject(object);
      edgeMaterial.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts and drop the oldest, which could be the CAD viewer's.
      renderer.forceContextLoss();
    },
  };
}
