import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";
import { buildCadSceneModel } from "./CadSceneModel";

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
