import * as THREE from "three";

import type { ModelPoint } from "./featureScriptDialog";
import {
  arcPoint,
  handlePoint,
  type DrawnManipulator,
  type HandlePart,
} from "./featureScriptManipulators";

/**
 * The three.js side of a feature's manipulators, as the mock draws them: an amber arrow for a
 * linear manipulator and a flip, a red, green and blue triad with a white middle for a 3D one, and
 * an amber arc with a handle at its end for an angular one. Handles are built in pixels and scaled
 * to the view at each render ({@link scaleHandle}), so they stay one size on screen; they draw over
 * the model, as Onshape's do.
 */

const AMBER = 0xfac940;
const AXIS_COLORS = { x: 0xf87171, y: 0x4ade80, z: 0x60a5fa } as const;
const INFO = 0x60a5fa;
const GHOST = 0x9ca3af;
/** In pixels. */
const ARROW = 64;
const HEAD = 14;
const SHAFT_RADIUS = 1.75;
const HEAD_RADIUS = 5.5;
/** How near a handle a press grabs it. */
const HIT_RADIUS = 8;
const MIDDLE_RADIUS = 5;
const ARC_HANDLE_RADIUS = 6;
const ARC_SEGMENTS = 64;
/** Above the model's edges (1) and error overlay (2). */
const RENDER_ORDER = 3;

/** One grabbable part of a drawn handle: the invisible mesh a press hits, and where tests grab. */
export interface HandleHit {
  readonly part: HandlePart;
  readonly mesh: THREE.Mesh;
  /** Where to grab it, in the handle's pixels from its anchor. */
  readonly grab: THREE.Vector3;
}

/** A manipulator as drawn: its root (at the handle point, in pixels), its arc, and its parts. */
export interface DrawnHandle {
  readonly manipulator: DrawnManipulator;
  readonly root: THREE.Group;
  /** An angular manipulator's arc and radial lines, in model space; null for the others. */
  readonly arc: THREE.Line | null;
  readonly hits: readonly HandleHit[];
}

const overlay = (color: number) =>
  new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });

const UP = new THREE.Vector3(0, 1, 0);

/** An arrow from the origin along `direction`, `length` pixels long, and its hit mesh. */
function arrow(
  direction: ModelPoint,
  color: number,
  part: HandlePart,
  length = ARROW,
): { readonly group: THREE.Group; readonly hit: HandleHit } {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, length - HEAD, 8),
    overlay(color),
  );
  shaft.position.y = (length - HEAD) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(HEAD_RADIUS, HEAD, 16), overlay(color));
  head.position.y = length - HEAD / 2;
  const hit = new THREE.Mesh(
    new THREE.CylinderGeometry(HIT_RADIUS, HIT_RADIUS, length, 8),
    new THREE.MeshBasicMaterial(),
  );
  hit.position.y = length / 2;
  hit.visible = false;
  group.add(shaft, head, hit);
  group.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...direction).normalize());
  return {
    group,
    hit: {
      part,
      mesh: hit,
      grab: new THREE.Vector3(0, length * 0.7, 0).applyQuaternion(group.quaternion),
    },
  };
}

function sphere(radius: number, color: number) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), overlay(color));
}

/** The arc of an angular manipulator from angle zero to `angle`, with its radial lines. */
function arcPoints(
  manipulator: Extract<DrawnManipulator, { type: "ANGULAR" }>,
  from: number,
  to: number,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const steps = Math.max(2, Math.ceil((ARC_SEGMENTS * Math.abs(to - from)) / (2 * Math.PI)));
  for (let i = 0; i <= steps; i++)
    points.push(new THREE.Vector3(...arcPoint(manipulator, from + ((to - from) * i) / steps)));
  return points;
}

/** The axis's point nearest an angular manipulator's handle: where its radial lines start. */
function hub(manipulator: Extract<DrawnManipulator, { type: "ANGULAR" }>): THREE.Vector3 {
  const origin = new THREE.Vector3(...manipulator.axisOrigin);
  const axis = new THREE.Vector3(...manipulator.axisDirection);
  const arm = new THREE.Vector3(...manipulator.rotationOrigin).sub(origin);
  return origin.addScaledVector(axis, arm.dot(axis));
}

/** An angular manipulator's arc to `angle` and the radial lines bounding it, in model space. */
export function arcGeometry(
  manipulator: Extract<DrawnManipulator, { type: "ANGULAR" }>,
  angle: number,
): THREE.BufferGeometry {
  const center = hub(manipulator);
  return new THREE.BufferGeometry().setFromPoints([
    center,
    ...arcPoints(manipulator, 0, angle),
    center,
  ]);
}

/** Builds the handle for `manipulator`, its root at the handle point. */
export function buildHandle(manipulator: DrawnManipulator): DrawnHandle {
  const root = new THREE.Group();
  root.position.set(...handlePoint(manipulator));
  const hits: HandleHit[] = [];
  let arc: THREE.Line | null = null;
  switch (manipulator.type) {
    case "LINEAR_1D": {
      // The arrow points away from the base, as the offset runs.
      const sign = manipulator.offset < 0 ? -1 : 1;
      const { group, hit } = arrow(
        [
          manipulator.direction[0] * sign,
          manipulator.direction[1] * sign,
          manipulator.direction[2] * sign,
        ],
        AMBER,
        "axis",
      );
      root.add(group);
      hits.push(hit);
      break;
    }
    case "LINEAR_3D": {
      for (const part of ["x", "y", "z"] as const) {
        const direction: ModelPoint = [
          part === "x" ? 1 : 0,
          part === "y" ? 1 : 0,
          part === "z" ? 1 : 0,
        ];
        const { group, hit } = arrow(direction, AXIS_COLORS[part], part);
        root.add(group);
        hits.push(hit);
      }
      const middle = sphere(MIDDLE_RADIUS, 0xffffff);
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(HIT_RADIUS + 2, 12, 8),
        new THREE.MeshBasicMaterial(),
      );
      hit.visible = false;
      root.add(middle, hit);
      hits.push({ part: "center", mesh: hit, grab: new THREE.Vector3() });
      break;
    }
    case "ANGULAR": {
      arc = new THREE.Line(
        arcGeometry(manipulator, manipulator.angle),
        new THREE.LineBasicMaterial({ color: AMBER, depthTest: false, transparent: true }),
      );
      arc.renderOrder = RENDER_ORDER;
      const handle = sphere(ARC_HANDLE_RADIUS, AMBER);
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(HIT_RADIUS + 3, 12, 8),
        new THREE.MeshBasicMaterial(),
      );
      hit.visible = false;
      root.add(handle, hit);
      hits.push({ part: "arc", mesh: hit, grab: new THREE.Vector3() });
      break;
    }
    case "FLIP": {
      const { group, hit } = arrow(manipulator.shown, AMBER, "flip", ARROW * 0.75);
      root.add(group, sphere(3, AMBER));
      hits.push(hit);
      break;
    }
  }
  root.traverse((child) => {
    child.renderOrder = RENDER_ORDER;
  });
  return { manipulator, root, arc, hits };
}

/** Sizes `handle` so a pixel of it is `worldPerPixel` of model, as seen now. */
export function scaleHandle(handle: DrawnHandle, worldPerPixel: number) {
  handle.root.scale.setScalar(worldPerPixel);
  handle.root.updateMatrixWorld(true);
}

/**
 * While a handle is dragged: the dashed proxy from where it was to where it is (an arc for an
 * angular manipulator), and a grey dot where it started.
 */
export function dragProxy(
  manipulator: DrawnManipulator,
  value: { readonly at: ModelPoint; readonly angle: number | null },
  worldPerPixel: number,
): THREE.Group {
  const group = new THREE.Group();
  const start = new THREE.Vector3(...handlePoint(manipulator));
  const points =
    manipulator.type === "ANGULAR" && value.angle !== null
      ? arcPoints(manipulator, manipulator.angle, value.angle)
      : [start, new THREE.Vector3(...value.at)];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineDashedMaterial({
      color: INFO,
      dashSize: 6 * worldPerPixel,
      gapSize: 5 * worldPerPixel,
      depthTest: false,
      transparent: true,
    }),
  );
  line.computeLineDistances();
  const ghost = sphere(4 * worldPerPixel, GHOST);
  ghost.position.copy(start);
  group.add(line, ghost);
  group.traverse((child) => {
    child.renderOrder = RENDER_ORDER;
  });
  return group;
}

/** Dims every part of `handle` but the one dragged, or undims them all for null. */
export function focusHandle(handle: DrawnHandle, part: HandlePart | null) {
  const dragged = part === null ? null : handle.hits.find((hit) => hit.part === part);
  handle.root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.visible) return;
    // A part's meshes share its hit mesh's parent (an arrow's group), or are the root's own.
    const own =
      dragged === null ||
      dragged === undefined ||
      child.parent === dragged.mesh.parent ||
      (dragged.mesh.parent === handle.root && child.parent === handle.root);
    for (const material of [child.material].flat()) material.opacity = own ? 1 : 0.3;
  });
}

/** Frees the GPU side of `object` and everything under it. */
export function disposeHandle(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      for (const material of [child.material].flat()) material.dispose();
    }
  });
}
