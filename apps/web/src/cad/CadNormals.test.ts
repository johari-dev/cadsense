import { describe, expect, it } from "vite-plus/test";
import * as THREE from "three";
import { creaseCadNormals } from "./CadNormals";

// Ways the crease step can fail, one test each:
// 1. Flat faces that share vertices with perpendicular walls keep averaged, tilted normals.
// 2. Curved surfaces get split at every facet and render faceted.
// 3. A flat face's fan keeps one vertex per corner instead of sharing, bloating memory.
// 4. Meshes whose normals already respect creases are rewritten anyway (wasted load time).
// 5. Primitives that share one position buffer (one per 3MF color) end up with broken indices,
//    or a color seam on one flat face shades differently on each side.
// 6. Zero-area triangles produce NaN normals.
// 7. Geometry with attributes the step does not carry (UVs) is rewritten and loses them.

/** An indexed unit cube with 8 shared corners and averaged normals, like the old 3MF converter. */
const smoothedCube = () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  // prettier-ignore
  const index = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
};

/** An open cylinder wall with `segments` facets around and shared seam vertices. */
const cylinder = (segments: number) => {
  const geometry = new THREE.CylinderGeometry(1, 1, 2, segments, 1, true);
  geometry.deleteAttribute("uv");
  return geometry;
};

const faceNormal = (geometry: THREE.BufferGeometry, triangle: number) => {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex()!;
  const [a, b, c] = [0, 1, 2].map((k) =>
    new THREE.Vector3().fromBufferAttribute(position, index.getX(triangle * 3 + k)),
  );
  return new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
};
const cornerNormal = (geometry: THREE.BufferGeometry, corner: number) =>
  new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("normal"),
    geometry.getIndex()!.getX(corner),
  );
const meshOf = (geometry: THREE.BufferGeometry) =>
  new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());

describe("CAD crease normals", () => {
  it("gives every corner of a flat face that face's normal", () => {
    const geometry = smoothedCube();
    creaseCadNormals(meshOf(geometry));
    for (let corner = 0; corner < 36; corner++)
      expect(
        cornerNormal(geometry, corner).dot(faceNormal(geometry, Math.floor(corner / 3))),
      ).toBeCloseTo(1, 5);
  });

  it("keeps curved surfaces smooth and shares their vertices", () => {
    const geometry = cylinder(36);
    const vertices = geometry.getAttribute("position").count;
    // Average across the 10 degree facet edges, as the converter did.
    geometry.computeVertexNormals();
    const averaged = geometry.getAttribute("normal");
    expect(creaseCadNormals(meshOf(geometry))).toEqual({ rewritten: 0 });
    expect(geometry.getAttribute("position").count).toBe(vertices);
    expect(geometry.getAttribute("normal")).toBe(averaged);
  });

  it("smooths a curved surface it does rewrite", () => {
    // A cylinder wall plus a flat cap ring that shares its top vertices, normals averaged
    // across the 90 degree rim like the old converter.
    const wall = cylinder(36);
    const position = wall.getAttribute("position");
    const index = Array.from(wall.getIndex()!.array);
    const top = Array.from({ length: 37 }, (_, i) => i);
    const center = position.count;
    const cap = top.slice(0, 36).flatMap((i) => [center, i, top[i + 1]!]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([...position.array, 0, 1, 0], 3),
    );
    geometry.setIndex([...index, ...cap]);
    geometry.computeVertexNormals();
    expect(creaseCadNormals(meshOf(geometry))).toEqual({ rewritten: 1 });
    // Wall corners stay horizontal and lean toward the neighboring facet (area weighting puts
    // them 3 to 7 degrees off their own), except on the UV seam, whose vertices were never
    // shared. Cap corners are flat.
    const rewritten = geometry.getAttribute("position");
    for (let corner = 0; corner < geometry.getIndex()!.count; corner++) {
      const normal = cornerNormal(geometry, corner);
      const angle = normal.angleTo(faceNormal(geometry, Math.floor(corner / 3)));
      const vertex = geometry.getIndex()!.getX(corner);
      if (corner >= index.length) expect(angle).toBeLessThan(1e-4);
      else {
        expect(normal.y).toBeCloseTo(0, 5);
        if (Math.abs(rewritten.getX(vertex)) > 1e-4) {
          expect(angle).toBeGreaterThan(THREE.MathUtils.degToRad(2));
          expect(angle).toBeLessThan(THREE.MathUtils.degToRad(8));
        }
      }
    }
  });

  it("shares one vertex per flat face corner and stays indexed", () => {
    const geometry = smoothedCube();
    expect(creaseCadNormals(meshOf(geometry))).toEqual({ rewritten: 1 });
    expect(geometry.getIndex()?.count).toBe(36);
    expect(geometry.getAttribute("position").count).toBe(24);
    expect(geometry.getAttribute("normal").count).toBe(24);
  });

  it("leaves meshes whose normals already respect creases untouched", () => {
    const geometry = new THREE.BoxGeometry();
    geometry.deleteAttribute("uv");
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    expect(creaseCadNormals(meshOf(geometry))).toEqual({ rewritten: 0 });
    expect(geometry.getAttribute("position")).toBe(position);
    expect(geometry.getAttribute("normal")).toBe(normal);
  });

  it("rewrites primitives that share one position buffer together", () => {
    const shared = smoothedCube();
    const index = shared.getIndex()!.array;
    // Two colors: the bottom face (z = 0) and the other five faces, each its own primitive.
    const bottom = new THREE.BufferGeometry();
    const rest = new THREE.BufferGeometry();
    for (const [geometry, range] of [
      [bottom, [0, 6]],
      [rest, [6, 36]],
    ] as const) {
      geometry.setAttribute("position", shared.getAttribute("position"));
      geometry.setAttribute("normal", shared.getAttribute("normal"));
      geometry.setIndex(Array.from(index.slice(range[0], range[1])));
    }
    const root = new THREE.Group();
    root.add(meshOf(bottom), meshOf(rest));
    expect(creaseCadNormals(root)).toEqual({ rewritten: 2 });
    expect(bottom.getAttribute("position")).toBe(rest.getAttribute("position"));
    expect(bottom.getAttribute("normal")).toBe(rest.getAttribute("normal"));
    for (const [geometry, triangles] of [
      [bottom, 2],
      [rest, 10],
    ] as const)
      for (let corner = 0; corner < triangles * 3; corner++)
        expect(
          cornerNormal(geometry, corner).dot(faceNormal(geometry, Math.floor(corner / 3))),
        ).toBeCloseTo(1, 5);
  });

  it("joins a color seam that runs across one flat face", () => {
    // A square split into two triangles of different colors, sharing the diagonal.
    const positions = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3);
    // Tilted normals, as if a wall had been averaged in.
    const normals = new THREE.Float32BufferAttribute(
      [0.8, 0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6],
      3,
    );
    const halves = [
      [0, 1, 2],
      [0, 2, 3],
    ].map((triangle) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", positions);
      geometry.setAttribute("normal", normals);
      geometry.setIndex(triangle);
      return geometry;
    });
    const root = new THREE.Group();
    for (const half of halves) root.add(meshOf(half));
    creaseCadNormals(root);
    expect(halves[0]!.getAttribute("position").count).toBe(4);
    expect(halves[0]!.getIndex()!.getX(0)).toBe(halves[1]!.getIndex()!.getX(0));
    expect(cornerNormal(halves[0]!, 0).toArray()).toEqual([0, 0, 1]);
  });

  it("never writes NaN normals for zero-area triangles", () => {
    const geometry = smoothedCube();
    const index = Array.from(geometry.getIndex()!.array);
    // A sliver whose corners are collinear.
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([...geometry.getAttribute("position").array, 0.5, 0, 0], 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute([...geometry.getAttribute("normal").array, 0, 0, 1], 3),
    );
    geometry.setIndex([...index, 0, 8, 1]);
    creaseCadNormals(meshOf(geometry));
    expect(Array.from(geometry.getAttribute("normal").array).every(Number.isFinite)).toBe(true);
  });

  it("skips geometry with attributes it does not carry", () => {
    const geometry = smoothedCube();
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(16), 2));
    const normal = geometry.getAttribute("normal");
    expect(creaseCadNormals(meshOf(geometry))).toEqual({ rewritten: 0 });
    expect(geometry.getAttribute("normal")).toBe(normal);
  });
});
