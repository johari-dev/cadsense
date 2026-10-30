import { beforeAll, describe, expect, it } from "vite-plus/test";
import { toGlb } from "../src/geometry/Glb.ts";
import { addBodies, emptyGeometry, ordered } from "../src/geometry/Model.ts";
import { loadOcct, type Oc } from "../src/geometry/occt.ts";
import { tessellate, type BodyMesh } from "../src/geometry/Tessellate.ts";

/**
 * Preview meshes: each face's vertices once, shared by its triangles through indices. Failure modes:
 * a reversed face wound inward; normals averaged across an edge, so a box looks rounded; a curved
 * face left flat; indices off by one face's vertex count, or pointing into the other material's
 * group; a located shape (a STEP assembly part) drawn where its geometry sits before the location;
 * a GLB without a valid index accessor.
 */
let oc: Oc;
beforeAll(async () => {
  oc = await loadOcct();
});

type Vec = [number, number, number];
const vertex = (positions: Float32Array, i: number): Vec => [
  positions[i * 3]!,
  positions[i * 3 + 1]!,
  positions[i * 3 + 2]!,
];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Every triangle of a mesh, as corner positions and corner normals. */
function triangles(mesh: BodyMesh) {
  return mesh.groups.flatMap((group) => {
    const list = [];
    for (let t = 0; t < group.indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => group.indices[t + k]!);
      list.push({
        material: group.material,
        points: corners.map((i) => vertex(group.positions, i)) as [Vec, Vec, Vec],
        normals: corners.map((i) => vertex(group.normals, i)) as [Vec, Vec, Vec],
      });
    }
    return list;
  });
}

const meshOf = (shape: InstanceType<Oc["TopoDS_Shape"]>, highlightTop = false) => {
  const { state } = addBodies(oc, emptyGeometry, [
    { shape, bodyType: "SOLID", createdBy: ["Box"] },
  ]);
  const top = (face: { readonly shape: InstanceType<Oc["TopoDS_Shape"]> }) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face.shape, props, false, false);
    return props.CentreOfMass().Z() > 0.0099;
  };
  return { state, mesh: tessellate(oc, state, highlightTop ? { highlight: top } : {})[0]! };
};
const box = () => new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(0, 0, 0), 0.01, 0.02, 0.01).Shape();

describe("preview meshes", () => {
  it("winds every triangle outward and keeps a box's edges sharp", () => {
    const { mesh } = meshOf(box());
    const center: Vec = [0.005, 0.01, 0.005];
    let area = 0;
    for (const { points, normals } of triangles(mesh)) {
      const facing = cross(sub(points[1], points[0]), sub(points[2], points[0]));
      area += Math.hypot(...facing) / 2;
      const centroid: Vec = [0, 1, 2].map(
        (k) => (points[0][k]! + points[1][k]! + points[2][k]!) / 3,
      ) as Vec;
      expect(dot(facing, sub(centroid, center))).toBeGreaterThan(0);
      for (const normal of normals) {
        // A box face's vertices all carry that face's normal: one axis, unit length.
        expect(Math.max(...normal.map(Math.abs))).toBeCloseTo(1, 6);
        expect(dot(normal, facing)).toBeGreaterThan(0);
      }
    }
    // 2 * (10 * 20 + 10 * 10 + 20 * 10) mm^2: every face once, none lost to an offset bug.
    // Positions are 32-bit floats, good to about 1e-7 of their size.
    expect(area * 1e6).toBeCloseTo(1000, 3);
  });

  it("shares each vertex among a face's triangles, and smooths a curved face", () => {
    const cylinder = new oc.BRepPrimAPI_MakeCylinder(0.005, 0.02).Shape();
    const { mesh } = meshOf(cylinder);
    const group = mesh.groups[0]!;
    expect(group.positions.length / 3).toBeLessThan(group.indices.length / 2);
    for (const { points, normals } of triangles(mesh))
      for (const [k, point] of points.entries()) {
        const normal = normals[k]!;
        const side = Math.abs(normal[2]) < 0.5;
        // Side vertices point away from the axis; cap vertices straight up or down.
        if (side)
          expect(
            dot(normal, [point[0], point[1], 0]) / Math.hypot(point[0], point[1]),
          ).toBeGreaterThan(0.99);
        else expect(Math.abs(normal[2])).toBeCloseTo(1, 6);
      }
  });

  it("splits highlighted faces into their own group with their own indices", () => {
    const { mesh } = meshOf(box(), true);
    expect(mesh.groups.map((group) => group.material)).toEqual([0, 1]);
    for (const group of mesh.groups)
      expect(Math.max(...group.indices)).toBeLessThan(group.positions.length / 3);
    const highlighted = triangles(mesh).filter((t) => t.material === 1);
    expect(highlighted.length).toBe(2);
    for (const { points } of highlighted)
      for (const point of points) expect(point[2]).toBeCloseTo(0.01, 9);
  });

  it("draws a located shape where its location puts it", () => {
    const move = new oc.gp_Trsf();
    move.SetTranslation(new oc.gp_Vec(0.1, 0, 0));
    const located = box().Moved(new oc.TopLoc_Location(move), false);
    const { mesh } = meshOf(located);
    const xs = triangles(mesh).flatMap(({ points }) => points.map((point) => point[0]));
    expect(Math.min(...xs)).toBeCloseTo(0.1, 7);
    expect(Math.max(...xs)).toBeCloseTo(0.11, 7);
  });

  it("writes indexed primitives to the GLB", () => {
    const { mesh } = meshOf(box(), true);
    const glb = toGlb([mesh]);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
      meshes: { primitives: { indices: number; attributes: { POSITION: number } }[] }[];
      accessors: { count: number; componentType: number; bufferView: number; max?: number[] }[];
      bufferViews: { target?: number; byteOffset: number }[];
    };
    const primitives = json.meshes[0]!.primitives;
    expect(primitives).toHaveLength(2);
    for (const [i, primitive] of primitives.entries()) {
      const indices = json.accessors[primitive.indices]!;
      expect(indices.componentType).toBe(5125);
      expect(indices.count).toBe(mesh.groups[i]!.indices.length);
      expect(json.bufferViews[indices.bufferView]!.target).toBe(34963);
      expect(json.accessors[primitive.attributes.POSITION]!.count).toBe(
        mesh.groups[i]!.positions.length / 3,
      );
    }
    for (const bufferView of json.bufferViews) expect(bufferView.byteOffset % 4).toBe(0);
  });

  it("covers every drawn body in creation order", () => {
    const { state } = addBodies(oc, emptyGeometry, [
      { shape: box(), bodyType: "SOLID", createdBy: ["A"] },
      { shape: new oc.BRepPrimAPI_MakeSphere(0.003).Shape(), bodyType: "SOLID", createdBy: ["B"] },
    ]);
    const bodies = ordered(state, (entity) => entity.type === "BODY").map((body) => body.id);
    expect(tessellate(oc, state).map((mesh) => mesh.bodyId)).toEqual(bodies);
  });
});
