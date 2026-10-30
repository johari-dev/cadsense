import { ordered, type Entity, type GeometryState } from "./Model.ts";
import type { Oc } from "./occt.ts";

/**
 * Triangles of one body split by material, in meters. Each face's vertices appear once, shared by
 * its triangles through `indices`, with normals smoothed within the face and not across its edges.
 */
export interface BodyMesh {
  readonly bodyId: string;
  readonly name: string;
  /** Material index to triangle data: 0 is the plain material, 1 the highlight. */
  readonly groups: readonly {
    readonly material: 0 | 1;
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    /** Three vertex indices per triangle, wound counterclockwise seen from outside. */
    readonly indices: Uint32Array;
  }[];
}

export interface TessellateOptions {
  /** Faces drawn in the highlight material, e.g. the ones the previewed feature created. */
  readonly highlight?: (face: Entity) => boolean;
  /** Linear deflection in meters. Default 0.05 mm. */
  readonly deflection?: number;
}

/**
 * Whether a preview draws `body`: solids and sheets. Wire and point bodies have no faces to draw,
 * and sketch regions and construction planes aren't drawn as surfaces (they'd hide what's under
 * them).
 */
export const isDrawnBody = (state: GeometryState, body: Entity): boolean =>
  body.type === "BODY" &&
  !body.construction &&
  (body.bodyType === "SOLID" ||
    (body.bodyType === "SHEET" &&
      !ordered(state, (entity) => entity.body === body.id && entity.type === "FACE").every(
        (face) => face.sketch !== null,
      )));

/** One material's growing share of a body's mesh. */
interface Bucket {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertices: number;
  triangles: number;
}
const bucket = (): Bucket => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  vertices: 0,
  triangles: 0,
});
/** `array` with room for `length` entries, doubled when it grows, keeping its contents. */
function room<T extends Float32Array | Uint32Array>(array: T, length: number): T {
  if (array.length >= length) return array;
  const grown = new (array.constructor as new (length: number) => T)(
    Math.max(length, array.length * 2),
  );
  grown.set(array);
  return grown;
}

/**
 * Meshes every body {@link isDrawnBody} accepts. OpenCascade objects made per vertex and triangle
 * are freed as soon as they're read, so meshing doesn't grow the WASM heap by the triangle count.
 */
export function tessellate(
  oc: Oc,
  state: GeometryState,
  options: TessellateOptions = {},
): BodyMesh[] {
  const deflection = options.deflection ?? 5e-5;
  return ordered(state, (body) => isDrawnBody(state, body)).map((body) => {
    const mesher = new oc.BRepMesh_IncrementalMesh(body.shape, deflection, false, 0.35, false);
    mesher.delete();
    const buckets: [Bucket, Bucket] = [bucket(), bucket()];
    for (const face of ordered(
      state,
      (entity) => entity.body === body.id && entity.type === "FACE",
    )) {
      const location = new oc.TopLoc_Location();
      const topoFace = oc.TopoDS.Face(face.shape);
      const triangulation = oc.BRep_Tool.Triangulation(topoFace, location, 0);
      topoFace.delete();
      if (triangulation.isNull()) {
        triangulation.delete();
        location.delete();
        continue;
      }
      // The location's 3x4 matrix, row by row; null when it doesn't move anything.
      const matrix = location.IsIdentity()
        ? null
        : (() => {
            const transform = location.Transformation();
            return [1, 2, 3].flatMap((row) =>
              [1, 2, 3, 4].map((column) => transform.Value(row, column)),
            );
          })();
      location.delete();
      const reversed = String(face.shape.Orientation()) === "TopAbs_REVERSED";
      const target = buckets[options.highlight?.(face) ? 1 : 0];
      const nodes = triangulation.NbNodes();
      const count = triangulation.NbTriangles();
      const first = target.vertices;
      target.positions = room(target.positions, (first + nodes) * 3);
      target.normals = room(target.normals, (first + nodes) * 3);
      target.indices = room(target.indices, (target.triangles + count) * 3);
      const { positions, normals, indices } = target;
      for (let i = 0; i < nodes; i++) {
        const node = triangulation.Node(i + 1);
        const [x, y, z] = [node.X(), node.Y(), node.Z()];
        node.delete();
        const o = (first + i) * 3;
        if (matrix) {
          const m = matrix;
          positions[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
          positions[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
          positions[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
        } else {
          positions[o] = x;
          positions[o + 1] = y;
          positions[o + 2] = z;
        }
        normals[o] = normals[o + 1] = normals[o + 2] = 0;
      }
      for (let t = 0; t < count; t++) {
        const triangle = triangulation.Triangle(t + 1);
        // A reversed face's triangles are wound against its outward side.
        const a = first + triangle.Value(1) - 1;
        const b = first + triangle.Value(reversed ? 3 : 2) - 1;
        const c = first + triangle.Value(reversed ? 2 : 3) - 1;
        triangle.delete();
        const o = (target.triangles + t) * 3;
        indices[o] = a;
        indices[o + 1] = b;
        indices[o + 2] = c;
        // Each corner gathers the triangle's area-weighted normal; normalized below.
        const ux = positions[b * 3]! - positions[a * 3]!;
        const uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
        const uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
        const vx = positions[c * 3]! - positions[a * 3]!;
        const vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!;
        const vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const corner of [a, b, c]) {
          normals[corner * 3] = normals[corner * 3]! + nx;
          normals[corner * 3 + 1] = normals[corner * 3 + 1]! + ny;
          normals[corner * 3 + 2] = normals[corner * 3 + 2]! + nz;
        }
      }
      triangulation.delete();
      for (let i = first; i < first + nodes; i++) {
        const o = i * 3;
        const length = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!) || 1;
        normals[o] = normals[o]! / length;
        normals[o + 1] = normals[o + 1]! / length;
        normals[o + 2] = normals[o + 2]! / length;
      }
      target.vertices += nodes;
      target.triangles += count;
    }
    return {
      bodyId: body.id,
      name: `${body.createdBy.join(".")} (${body.id})`,
      groups: buckets.flatMap((group, material) =>
        group.triangles > 0
          ? [
              {
                material: material as 0 | 1,
                positions: group.positions.slice(0, group.vertices * 3),
                normals: group.normals.slice(0, group.vertices * 3),
                indices: group.indices.slice(0, group.triangles * 3),
              },
            ]
          : [],
      ),
    };
  });
}
