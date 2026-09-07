import { describe, expect, it } from "vite-plus/test";
import * as THREE from "three";
import { prepareCadMaterials } from "./CadMaterials";

const appearance = { color: { red: 64, green: 64, blue: 64 }, opacity: 255 };
const scene = (colors: THREE.Color[]) => {
  const root = new THREE.Group();
  for (const color of colors)
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color })));
  return root;
};
const material = (root: THREE.Group, index: number) => {
  const mesh = root.children[index];
  if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.MeshStandardMaterial))
    throw new Error("Expected standard material");
  return mesh.material;
};

describe("Onshape CAD materials", () => {
  it("decodes exported display RGB for both the part and its individual face colors", () => {
    const root = scene([
      new THREE.Color(64 / 255, 64 / 255, 64 / 255),
      new THREE.Color(0, 114 / 255, 206 / 255),
    ]);
    prepareCadMaterials(root, [appearance]);
    expect(material(root, 0).color.getHex()).toBe(0x404040);
    expect(material(root, 1).color.getHex()).toBe(0x0072ce);
  });
  it("does not decode already-linear exports, missing metadata, or unrelated base colors", () => {
    for (const [color, metadata] of [
      [new THREE.Color(0x404040), appearance],
      [new THREE.Color(0.25, 0.25, 0.25), null],
      [new THREE.Color(0.8, 0.1, 0.2), appearance],
    ] as const) {
      const root = scene([color.clone()]);
      prepareCadMaterials(root, [metadata]);
      expect(material(root, 0).color).toEqual(color);
    }
  });
  it("converts shared materials only once and keeps transparency intact", () => {
    const root = scene([new THREE.Color(64 / 255, 64 / 255, 64 / 255)]);
    const m = material(root, 0);
    m.opacity = 0.4;
    m.transparent = true;
    root.add(root.children[0]!.clone());
    prepareCadMaterials(root, [appearance]);
    expect(m.color.getHex()).toBe(0x404040);
    expect(m.opacity).toBe(0.4);
    expect(m.transparent).toBe(true);
    prepareCadMaterials(root, [appearance]);
    expect(m.color.getHex()).toBe(0x404040);
  });
  it("finds base-color evidence after face overrides and missing metadata for a shared asset", () => {
    const root = scene([
      new THREE.Color(0, 114 / 255, 206 / 255),
      new THREE.Color(64 / 255, 64 / 255, 64 / 255),
    ]);
    prepareCadMaterials(root, [null, appearance]);
    expect(material(root, 0).color.getHex()).toBe(0x0072ce);
    expect(material(root, 1).color.getHex()).toBe(0x404040);
  });
  it("preserves authored matte finishes and only supplies an explicitly omitted finish", () => {
    const root = scene([
      new THREE.Color(64 / 255, 64 / 255, 64 / 255),
      new THREE.Color(0.7, 0.7, 0.7),
    ]);
    prepareCadMaterials(root, [appearance], new Set([material(root, 1)]));
    expect(material(root, 0).roughness).toBe(1);
    expect(material(root, 1).roughness).toBe(0.4);
  });
  it("does not infer color encoding from endpoint colors or textured factors", () => {
    for (const color of [
      new THREE.Color(0, 0, 0),
      new THREE.Color(1, 1, 1),
      new THREE.Color(1, 0, 0),
    ]) {
      const root = scene([color.clone(), new THREE.Color(0.5, 0.25, 0.75)]);
      prepareCadMaterials(root, [
        { color: { red: color.r * 255, green: color.g * 255, blue: color.b * 255 }, opacity: 255 },
      ]);
      expect(material(root, 1).color).toEqual(new THREE.Color(0.5, 0.25, 0.75));
    }
    const root = scene([new THREE.Color(64 / 255, 64 / 255, 64 / 255)]);
    material(root, 0).map = new THREE.Texture();
    prepareCadMaterials(root, [appearance]);
    expect(material(root, 0).color.r).toBe(64 / 255);
  });
});
