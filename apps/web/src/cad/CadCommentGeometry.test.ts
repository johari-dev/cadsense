import { CadCameraPose, CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";
import { buildCadSceneModel } from "./CadSceneModel";

const isCadCameraPose = Schema.is(CadCameraPose);
const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const id = (n: number) => n.toString(16).padStart(64, "0");
const transform = (x: number, y = 0) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1];
const node = (n: number, parent: number | null, x: number, overrides = {}) => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  occurrencePath: [String(n)],
  instanceId: String(n),
  name: `Node ${n}`,
  kind: "part",
  suppressed: false,
  defaultVisible: true,
  transform: transform(x),
  sourcePartKey: id(9),
  ...overrides,
});
const manifest = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: id(1),
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: "https://cad.onshape.com",
    documentId: "111111111111111111111111",
    elementId: "222222222222222222222222",
    kind: "assembly",
    originalRevision: { kind: "m", id: "333333333333333333333333" },
    microversionId: "333333333333333333333333",
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [
    node(1, null, 0, { kind: "assembly", sourcePartKey: null }),
    node(2, 1, 100, { kind: "assembly", sourcePartKey: null }),
    node(3, 2, 2),
    node(4, 1, -2),
    node(5, 1, 0, { suppressed: true, sourcePartKey: null }),
  ],
  parts: [],
  assets: [],
  dependencies: [],
});
const state: CadViewState = {
  rootId: id(1),
  snapshotId: manifest.snapshotId,
  revision: 0,
  camera: { kind: "preset", preset: "isometric", fit: [] },
  visibility: {},
  isolatedOccurrenceIds: [],
  explosion: 0,
};
import {
  locateCadCommentPoints,
  cadCommentWorldPoint,
  cadCommentVisible,
  cadCommentCameraUp,
  cadCommentInspectionDirections,
} from "./CadCommentGeometry";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
const setup = (explosion = 0) => {
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.07, 16, 48),
    new THREE.MeshBasicMaterial(),
  );
  mesh.position.z = 0.1;
  source.add(mesh);
  const model = buildCadSceneModel(manifest, new Map([[id(9), source]]));
  model.apply({ ...state, explosion });
  const point = cadCommentWorldPoint(model, id(3), [0.3, 0, 0.17])!;
  const camera = new THREE.PerspectiveCamera(45, 1280 / 960, 0.001, 100);
  camera.position.copy(point).add(new THREE.Vector3(0, 0, 3));
  camera.lookAt(point);
  camera.updateMatrixWorld();
  return { model, camera, point };
};
const pick = (
  model: ReturnType<typeof setup>["model"],
  camera: THREE.Camera,
  point: THREE.Vector3,
  intended = id(3),
) => {
  const pixel = point.clone().project(camera);
  return locateCadCommentPoints(
    model,
    camera,
    [
      {
        pickKey: "p",
        intendedOccurrenceId: intended,
        x: (pixel.x + 1) * 640,
        y: (1 - pixel.y) * 480,
      },
    ],
    1280,
    960,
  )[0]!;
};
describe("CAD comment anchors", () => {
  it("finds alternate views into a narrow bore that broad assembly angles occlude", () => {
    const outline = new THREE.Shape();
    outline.absarc(0, 0, 1, 0, Math.PI * 2, false);
    const opening = new THREE.Path();
    opening.absarc(0, 0, 0.12, 0, Math.PI * 2, true);
    outline.holes.push(opening);
    const source = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    source.add(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(outline, { depth: 1, bevelEnabled: false, curveSegments: 48 }),
        material,
      ),
    );
    source.add(new THREE.Mesh(new THREE.CircleGeometry(0.12, 48), material));
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.1), material);
    bottom.position.z = -0.05;
    source.add(bottom);
    const model = buildCadSceneModel(manifest, new Map([[id(9), source]]));
    model.apply(state);
    model.objects.get(id(4))!.object.visible = false;
    const point = cadCommentWorldPoint(model, id(3), [0, 0, 0])!;
    const original = new THREE.Vector3(0, 0, 1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    const visible = (direction: THREE.Vector3) => {
      camera.position.copy(point).addScaledVector(direction, 3);
      camera.up.fromArray(cadCommentCameraUp(direction));
      camera.lookAt(point);
      camera.updateMatrixWorld();
      return cadCommentVisible(model, camera, point);
    };
    const directions = cadCommentInspectionDirections(original);
    expect(directions.every((d) => d.angleTo(original) >= THREE.MathUtils.degToRad(5) - 1e-8)).toBe(
      true,
    );
    expect(directions.filter((d) => d.angleTo(original) < 0.3).some(visible)).toBe(true);
    expect(directions.filter((d) => d.angleTo(original) >= 0.3).some(visible)).toBe(false);
  });
  it("stores source-part local coordinates through GLTF and explosion transforms", () => {
    const { model, camera, point } = setup(0.7);
    const hit = pick(model, camera, point);
    expect(hit.reason).toBe("candidate");
    expect(hit.point?.[0]).toBeCloseTo(0.3, 5);
    expect(hit.point?.[2]).toBeCloseTo(0.17, 5);
    model.apply(state);
    const restored = cadCommentWorldPoint(model, id(3), hit.point!)!;
    expect(restored.x).toBeCloseTo(2.3, 5);
    expect(restored.z).toBeCloseTo(0.17, 5);
  });
  it("does not select another instance or pretend the center of an opening is a surface", () => {
    const { model, camera, point } = setup();
    expect(pick(model, camera, point, id(4)).reason).toBe("occurrence-mismatch");
    const center = cadCommentWorldPoint(model, id(3), [0, 0, 0.1])!;
    camera.position.copy(center).add(new THREE.Vector3(0, 0, 3));
    camera.lookAt(center);
    camera.updateMatrixWorld();
    expect(pick(model, camera, center).reason).toBe("no-hit");
  });
  it("rejects out-of-image pixels and honors the nearest visible occluder", () => {
    const { model, camera, point } = setup();
    const front = model.objects.get(id(4))!.object;
    front.matrixAutoUpdate = true;
    front.position.set(2, 0, 1);
    front.updateMatrixWorld(true);
    expect(pick(model, camera, point).reason).toBe("occurrence-mismatch");
    front.visible = false;
    expect(pick(model, camera, point).reason).toBe("candidate");
    expect(
      locateCadCommentPoints(
        model,
        camera,
        [{ pickKey: "bad", intendedOccurrenceId: id(3), x: 1280, y: 0 }],
        1280,
        960,
      )[0]?.reason,
    ).toBe("invalid-image-point");
  });
  it("uses parallel occlusion rays in orthographic views", () => {
    const { model, point } = setup();
    const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.001, 100);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(cadCommentVisible(model, camera, point)).toBe(true);
  });
  it("reuses verified unchanged imports but separates changed source revisions and transforms", () => {
    const descriptor = cadCommentModelDescriptor(manifest);
    expect(
      cadCommentModelDescriptor({
        ...manifest,
        snapshotId: "another-import",
        createdAt: "2026-09-06T00:00:00Z",
        nodes: manifest.nodes.toReversed(),
      }),
    ).toBe(descriptor);
    expect(
      cadCommentModelDescriptor({
        ...manifest,
        root: { ...manifest.root, configuration: "changed" },
      }),
    ).not.toBe(descriptor);
    expect(
      cadCommentModelDescriptor({
        ...manifest,
        nodes: manifest.nodes.map((n) => ({ ...n, transform: transform(99) })),
      }),
    ).not.toBe(descriptor);
  });
});

it.each([
  [0, 0, 1],
  [0, 0, -1],
  [0.001, 0, 1],
  [-1, 1, 1],
])("keeps inspection camera up independent of viewing direction %j", (x, y, z) => {
  const direction = new THREE.Vector3(x, y, z);
  const pose = {
    position: direction.toArray(),
    target: [0, 0, 0],
    up: cadCommentCameraUp(direction),
    projection: "perspective",
    zoom: 1,
  };
  expect(isCadCameraPose(pose)).toBe(true);
});

it("clips front geometry from picking and refuses clipped or translucent comment locations", () => {
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const stacked = {
    ...manifest,
    nodes: [
      node(3, null, 0),
      node(4, null, 0, { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -2, 0, 0, 0, 1] }),
    ],
  };
  const model = buildCadSceneModel(decodeManifest(stacked), new Map([[id(9), box]]));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const picks = [{ pickKey: "p", x: 50, y: 50, intendedOccurrenceId: id(4) }];
  model.apply(state);
  expect(locateCadCommentPoints(model, camera, picks, 100, 100)[0]?.reason).toBe(
    "occurrence-mismatch",
  );
  model.apply({ ...state, sectionPlanes: [{ normal: [0, 0, -1], constant: -1 }] });
  const hit = locateCadCommentPoints(model, camera, picks, 100, 100)[0]!;
  expect(hit.reason).toBe("candidate");
  expect(hit.occurrenceId).toBe(id(4));
  expect(hit.point?.[2]).toBeCloseTo(0.5);
  expect(cadCommentVisible(model, camera, new THREE.Vector3(0, 0, 0.5))).toBe(false);
  expect(cadCommentVisible(model, camera, new THREE.Vector3(0, 0, -1.5))).toBe(true);
  model.apply({ ...state, ghost: { occurrenceIds: [id(3)], opacity: 0.2 } });
  expect(locateCadCommentPoints(model, camera, picks, 100, 100)[0]?.reason).toBe("transparent-hit");
  expect(cadCommentVisible(model, camera, new THREE.Vector3(0, 0, 0.5))).toBe(false);
  model.apply(state);
  expect(
    locateCadCommentPoints(
      model,
      camera,
      [{ ...picks[0]!, intendedOccurrenceId: id(3) }],
      100,
      100,
    )[0]?.reason,
  ).toBe("candidate");
});

it("evaluates sections in displayed world space after explosion", () => {
  const { model } = setup(1);
  const point = cadCommentWorldPoint(model, id(3), [0, 0, 0])!;
  model.apply({
    ...state,
    explosion: 1,
    sectionPlanes: [{ normal: [1, 0, 0], constant: -point.x - 0.01 }],
  });
  expect(model.isClipped(point)).toBe(true);
  expect(model.clippingPlanes()[0]!.distanceToPoint(point)).toBeCloseTo(-0.01);
});

it("accepts opaque source alpha while rejecting materials that render with alpha effects", () => {
  const { model, camera, point } = setup();
  try {
    model.objects.get(id(3))!.object.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material.opacity = 0.5;
    });
    expect(pick(model, camera, point).reason).toBe("candidate");
    expect(cadCommentVisible(model, camera, point)).toBe(true);
    model.objects.get(id(3))!.object.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material.transparent = true;
    });
    expect(pick(model, camera, point).reason).toBe("transparent-hit");
    expect(cadCommentVisible(model, camera, point)).toBe(false);
  } finally {
    model.dispose();
  }
});
