import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";
import { bodyNode, edgeMiddle, faceProbe, isOutline, isPickable } from "./featureScriptScene";

/**
 * What a click in the preview can pick, and the outline it snaps to. Ways this goes wrong: the
 * red overlay of a rolled-back error body is hit, and the face query made from it lands on some
 * other face of the model; an overlay's own outline or a child of it is hit; the model's meshes
 * stop being pickable; a click on one of a body's meshes (one per material) doesn't find the
 * body's outline beside it, or finds another body's; the red error lines count as outline; a hit
 * triangle's face or a snapped segment's edge is read from the wrong list or index, or a GLB
 * without them (or with something else there) gives a point that isn't one.
 */
describe("isPickable", () => {
  it("takes the model's meshes and skips anything under an overlay node", () => {
    const model = new THREE.Mesh();
    const overlay = new THREE.Group();
    overlay.userData = { overlay: true };
    const overlayMesh = new THREE.Mesh();
    overlay.add(overlayMesh);
    const scene = new THREE.Group();
    scene.add(model, overlay);
    expect(isPickable(model)).toBe(true);
    expect(isPickable(overlayMesh)).toBe(false);
    expect(isPickable(new THREE.LineSegments())).toBe(false);
  });
});

describe("bodyNode and isOutline", () => {
  // As GLTFLoader builds a GLB body node: a group of one object per primitive, or the one mesh.
  const outlineMaterial = () => {
    const material = new THREE.LineBasicMaterial();
    material.userData = { outline: true };
    return material;
  };
  const body = (id: string) => {
    const node = new THREE.Group();
    node.userData = { body: id };
    const faces = new THREE.Mesh();
    const highlighted = new THREE.Mesh();
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), outlineMaterial());
    const vertices = new THREE.Points(new THREE.BufferGeometry(), outlineMaterial());
    node.add(faces, highlighted, edges, vertices);
    return { node, faces, highlighted, edges, vertices };
  };

  it("finds the body a mesh belongs to, beside its outline", () => {
    const a = body("JHD");
    const b = body("JKD");
    const scene = new THREE.Group();
    scene.add(a.node, b.node);
    expect(bodyNode(a.highlighted)).toBe(a.node);
    expect(bodyNode(b.faces)).toBe(b.node);
    // One primitive: the mesh is the node.
    const single = new THREE.Mesh();
    single.userData = { body: "JMD" };
    scene.add(single);
    expect(bodyNode(single)).toBe(single);
    expect(bodyNode(new THREE.Mesh())).toBeNull();
  });

  it("takes a body's outline lines and points, not error lines or meshes", () => {
    const { edges, vertices, faces } = body("JHD");
    expect(isOutline(edges)).toBe(true);
    expect(isOutline(vertices)).toBe(true);
    expect(isOutline(faces)).toBe(false);
    expect(
      isOutline(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())),
    ).toBe(false);
  });
});

describe("faceProbe and edgeMiddle", () => {
  // As GLTFLoader builds a body: `_FACE` and `_EDGE` become `_face` and `_edge` attributes, the
  // node's extras its userData.
  const indexed = (name: string, values: readonly number[]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(values), 1));
    return geometry;
  };
  const body = () => {
    const node = new THREE.Group();
    node.userData = {
      body: "JHD",
      faces: [[0.01, 0.02, 0.03], null, [0.04]],
      edges: [[0.1, 0, 0]],
    };
    // Vertices 0 and 1 on face 0, vertex 2 on face 1, vertex 3 on face 2.
    const faces = new THREE.Mesh(indexed("_face", [0, 0, 1, 2]));
    const lines = new THREE.LineSegments(indexed("_edge", [0, 0]));
    node.add(faces, lines);
    return { node, faces, lines };
  };

  it("reads the probe of the face a vertex is on, and the middle of a segment end's edge", () => {
    const { faces, lines } = body();
    expect(faceProbe(faces, 1)).toEqual([0.01, 0.02, 0.03]);
    expect(edgeMiddle(lines, 1)).toEqual([0.1, 0, 0]);
  });

  it("gives null for a face with no probe, or no point there, or no data at all", () => {
    const { faces } = body();
    expect(faceProbe(faces, 2)).toBeNull();
    expect(faceProbe(faces, 3)).toBeNull();
    expect(faceProbe(new THREE.Mesh(), 0)).toBeNull();
    // A mesh outside any body.
    expect(faceProbe(new THREE.Mesh(indexed("_face", [0])), 0)).toBeNull();
  });
});
