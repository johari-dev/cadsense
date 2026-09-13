import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import * as THREE from "three";
import { describe, expect, it, vi } from "vite-plus/test";
import { buildCadSceneModel, disposeCadObjects, resolveCadCamera } from "./CadSceneModel";

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
const prototype = () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  const material = new THREE.MeshStandardMaterial({
    color: 0x35a76c,
    roughness: 0.2,
    metalness: 0.4,
  });
  return new THREE.Mesh(geometry, material);
};

describe("CAD scene model", () => {
  it("uses absolute row-major transforms without parent multiplication and shares source buffers/materials", () => {
    const source = prototype();
    const model = buildCadSceneModel(manifest, new Map([[id(9), source]]));
    model.apply(state);
    expect(model.objects.get(id(3))!.object.matrixWorld.elements[12]).toBe(2);
    expect(model.objects.get(id(4))!.object.matrixWorld.elements[12]).toBe(-2);
    const first = model.objects.get(id(3))!.object.children[0];
    const second = model.objects.get(id(4))!.object.children[0];
    expect(first).toBeInstanceOf(THREE.Mesh);
    if (!(first instanceof THREE.Mesh) || !(second instanceof THREE.Mesh))
      throw new Error("Expected mesh");
    expect(first.geometry).toBe(source.geometry);
    expect(second.geometry).toBe(source.geometry);
    expect(first.material).toBe(source.material);
    expect(second.material).toBe(source.material);
    expect(model.bounds.min.x).toBe(-2);
    expect(model.bounds.max.x).toBe(3);
  });
  it("shares subtree visibility/isolation semantics and cannot show suppressed geometry", () => {
    const model = buildCadSceneModel(manifest, new Map([[id(9), prototype()]]));
    model.apply({ ...state, visibility: { [id(2)]: false } });
    expect(model.objects.get(id(3))!.object.visible).toBe(false);
    expect(model.objects.get(id(4))!.object.visible).toBe(true);
    model.apply({ ...state, isolatedOccurrenceIds: [id(2)], visibility: { [id(5)]: true } });
    expect(model.objects.get(id(3))!.object.visible).toBe(true);
    expect(model.objects.get(id(4))!.object.visible).toBe(false);
    expect(model.objects.has(id(5))).toBe(false);
  });
  it("explosion is deterministic, nonaccumulating, and resets exactly", () => {
    const model = buildCadSceneModel(manifest, new Map([[id(9), prototype()]]));
    model.apply({ ...state, explosion: 1 });
    const exploded = [...model.objects.get(id(3))!.object.matrix.elements];
    expect(exploded[12]).toBeGreaterThan(2);
    model.apply({ ...state, explosion: 1 });
    expect(model.objects.get(id(3))!.object.matrix.elements).toEqual(exploded);
    model.apply(state);
    expect(model.objects.get(id(3))!.object.matrix.elements[12]).toBe(2);
  });
  it("fits selected assembly descendants and rejects unknown snapshot/occurrence references before changing objects", () => {
    const model = buildCadSceneModel(manifest, new Map([[id(9), prototype()]]));
    const bounds = model.apply({
      ...state,
      camera: { kind: "preset", preset: "front", fit: [id(2)] },
    });
    expect(bounds.min.x).toBe(2);
    expect(bounds.max.x).toBe(3);
    expect(() => model.apply({ ...state, rootId: id(88) })).toThrow("invalid-view");
    expect(() => model.apply({ ...state, visibility: { [id(88)]: false } })).toThrow(
      "invalid-view",
    );
    expect(model.objects.get(id(3))!.object.matrix.elements[12]).toBe(2);
  });
  it("fits all presets with valid Z-up orientation and frames portrait viewports further out", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    for (const preset of [
      "isometric",
      "front",
      "back",
      "left",
      "right",
      "top",
      "bottom",
    ] as const) {
      const pose = resolveCadCamera({ kind: "preset", preset, fit: [] }, bounds, 1);
      const direction = new THREE.Vector3(...pose.target).sub(new THREE.Vector3(...pose.position));
      expect(direction.cross(new THREE.Vector3(...pose.up)).length()).toBeGreaterThan(0);
      expect(pose.position.every(Number.isFinite)).toBe(true);
    }
    const normal = resolveCadCamera(state.camera, bounds, 1);
    const portrait = resolveCadCamera(state.camera, bounds, 0.4);
    expect(new THREE.Vector3(...portrait.position).length()).toBeGreaterThan(
      new THREE.Vector3(...normal.position).length(),
    );
  });
  it("preserves exact perspective and orthographic poses and has finite empty fit", () => {
    for (const projection of ["perspective", "orthographic"] as const) {
      const pose = {
        position: [4, -4, 4] as const,
        target: [0, 0, 0] as const,
        up: [0, 0, 1] as const,
        projection,
        zoom: 2,
      };
      expect(resolveCadCamera({ kind: "pose", pose, fit: null }, new THREE.Box3(), 1)).toEqual(
        pose,
      );
      expect(
        resolveCadCamera({ kind: "pose", pose, fit: [] }, new THREE.Box3(), 1).projection,
      ).toBe(projection);
    }
    expect(
      resolveCadCamera(state.camera, new THREE.Box3(), 1).position.every(Number.isFinite),
    ).toBe(true);
  });
  it("disposes shared geometry, materials, and textures once across cloned occurrences", () => {
    const source = prototype();
    source.material.map = new THREE.Texture();
    const geometryDispose = vi.spyOn(source.geometry, "dispose");
    const materialDispose = vi.spyOn(source.material, "dispose");
    const textureDispose = vi.spyOn(source.material.map, "dispose");
    disposeCadObjects([source, source.clone(), source.clone()]);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });
});

it("owns inspection materials per occurrence and per renderer, restores and disposes only copies", () => {
  const source = prototype();
  source.material.map = new THREE.Texture();
  const model = buildCadSceneModel(manifest, new Map([[id(9), source]]));
  const other = buildCadSceneModel(manifest, new Map([[id(9), source]]));
  const first = model.objects.get(id(3))!.object.children[0] as THREE.Mesh;
  const sibling = model.objects.get(id(4))!.object.children[0] as THREE.Mesh;
  const geometryDispose = vi.spyOn(source.geometry, "dispose");
  const sourceDispose = vi.spyOn(source.material, "dispose");
  const textureDispose = vi.spyOn(source.material.map, "dispose");
  model.apply({
    ...state,
    highlightedOccurrenceIds: [id(2)],
    ghost: { occurrenceIds: [id(3)], opacity: 0.2 },
  });
  const copy = first.material as THREE.MeshStandardMaterial;
  const copyDispose = vi.spyOn(copy, "dispose");
  expect(copy).not.toBe(source.material);
  expect(copy.color.getHex()).toBe(0xffbf36);
  expect(copy.opacity).toBe(0.2);
  expect(copy.depthWrite).toBe(false);
  expect(copy.map).toBe(source.material.map);
  expect(sibling.material).toBe(source.material);
  expect((other.objects.get(id(3))!.object.children[0] as THREE.Mesh).material).toBe(
    source.material,
  );
  model.apply({
    ...state,
    revision: 2,
    explosion: 1,
    highlightedOccurrenceIds: [id(2)],
    ghost: { occurrenceIds: [id(3)], opacity: 0.2 },
  });
  expect(first.material).toBe(copy);
  expect(copyDispose).not.toHaveBeenCalled();
  expect(source.material.opacity).toBe(1);
  expect(source.material.color.getHex()).toBe(0x35a76c);
  model.apply(state);
  expect(copyDispose).toHaveBeenCalledOnce();
  expect(first.material).toBe(source.material);
  expect(first.geometry).toBe(source.geometry);
  model.dispose();
  expect(sourceDispose).not.toHaveBeenCalled();
  expect(textureDispose).not.toHaveBeenCalled();
  expect(geometryDispose).not.toHaveBeenCalled();
});
