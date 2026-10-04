import { ordered, type Entity, type GeometryState } from "./Model.ts";
import type { Oc } from "./occt.ts";

/** Triangles of one body split by material, in meters, flat-shaded (three vertices per triangle). */
export interface BodyMesh {
  readonly bodyId: string;
  readonly name: string;
  /** Material index to triangle data: 0 is the plain material, 1 the highlight. */
  readonly groups: readonly {
    readonly material: 0 | 1;
    readonly positions: Float32Array;
    readonly normals: Float32Array;
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

/** Meshes every body {@link isDrawnBody} accepts. */
export function tessellate(
  oc: Oc,
  state: GeometryState,
  options: TessellateOptions = {},
): BodyMesh[] {
  const deflection = options.deflection ?? 5e-5;
  return ordered(state, (body) => isDrawnBody(state, body)).map((body) => {
    const mesher = new oc.BRepMesh_IncrementalMesh(body.shape, deflection, false, 0.35, false);
    mesher.delete();
    const buckets: [number[], number[]][] = [
      [[], []],
      [[], []],
    ];
    for (const face of ordered(
      state,
      (entity) => entity.body === body.id && entity.type === "FACE",
    )) {
      const location = new oc.TopLoc_Location();
      const triangulation = oc.BRep_Tool.Triangulation(oc.TopoDS.Face(face.shape), location, 0);
      if (triangulation.isNull()) continue;
      const transform = location.Transformation();
      const reversed = String(face.shape.Orientation()) === "TopAbs_REVERSED";
      const [positions, normals] = buckets[options.highlight?.(face) ? 1 : 0]!;
      const node = (i: number) => {
        const p = triangulation.Node(i).Transformed(transform);
        return [p.X(), p.Y(), p.Z()] as const;
      };
      for (let t = 1; t <= triangulation.NbTriangles(); t++) {
        const triangle = triangulation.Triangle(t);
        const [n1, n2, n3] = [triangle.Value(1), triangle.Value(2), triangle.Value(3)];
        type Point = readonly [number, number, number];
        const corners: [Point, Point, Point] = reversed
          ? [node(n1), node(n3), node(n2)]
          : [node(n1), node(n2), node(n3)];
        const [a, b, c] = corners;
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const n = [
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        ];
        const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        for (const corner of corners) {
          positions.push(corner[0]!, corner[1]!, corner[2]!);
          normals.push(n[0]! / length, n[1]! / length, n[2]! / length);
        }
      }
    }
    return {
      bodyId: body.id,
      name: `${body.createdBy.join(".")} (${body.id})`,
      groups: buckets.flatMap(([positions, normals], material) =>
        positions.length
          ? [
              {
                material: material as 0 | 1,
                positions: new Float32Array(positions),
                normals: new Float32Array(normals),
              },
            ]
          : [],
      ),
    };
  });
}
