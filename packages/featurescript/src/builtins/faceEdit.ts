import {
  chainHistory,
  historyOf,
  imagesOf,
  loosestTolerance,
  topology,
  type History,
} from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import {
  seamEdges,
  shapeKind,
  ShapeSet,
  subShapes,
  toList,
  xyz,
  type Oc,
  type Shape,
} from "../geometry/occt.ts";
import { distance } from "../geometry/Query.ts";

/**
 * Shape-level direct editing on OpenCascade: deleting, offsetting, moving and replacing faces of a
 * solid with the neighbors healing around the change, plus the small geometric tests these need
 * (normals, tangency, adjacency). The builtins in `faces.ts` turn results into model updates.
 */

/** Volume of a solid (or compound of solids), in cubic meters. */
export function volumeOf(oc: Oc, shape: Shape): number {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass();
}

/** A face's surface type without the `GeomAbs_` prefix: `Plane`, `Cylinder`, `BSplineSurface`... */
export const surfaceType = (oc: Oc, face: Shape): string =>
  String(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true).GetType()).replace("GeomAbs_", "");

/** The face's outward unit normal at (u, v), following its orientation. */
function normalAtUV(oc: Oc, face: Shape, u: number, v: number): Vec3 {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const du = surface.DN(u, v, 1, 0);
  const dv = surface.DN(u, v, 0, 1);
  const n = du.Crossed(dv);
  const length = n.Magnitude() || 1;
  const sign = String(face.Orientation()) === "TopAbs_REVERSED" ? -1 : 1;
  return [(sign * n.X()) / length, (sign * n.Y()) / length, (sign * n.Z()) / length];
}

/**
 * The point on `face`'s surface (not just the face) nearest `point`, the face's outward unit normal
 * there, and how far away it is.
 */
export function normalNear(
  oc: Oc,
  face: Shape,
  point: Vec3,
): { normal: Vec3; nearest: Vec3; distance: number } {
  const projector = new oc.GeomAPI_ProjectPointOnSurf(
    new oc.gp_Pnt(...point),
    oc.BRep_Tool.Surface(oc.TopoDS.Face(face)),
  );
  if (!projector.IsDone() || projector.NbPoints() === 0)
    return { normal: [0, 0, 0], nearest: point, distance: Number.POSITIVE_INFINITY };
  const { U, V } = projector.LowerDistanceParameters();
  return {
    normal: normalAtUV(oc, face, U, V),
    nearest: xyz(projector.NearestPoint()),
    distance: projector.LowerDistance(),
  };
}

/** True when `point` is on the side of `face`'s surface its outward normal points to. */
function inFrontOf(oc: Oc, face: Shape, point: Vec3): boolean {
  const { normal, nearest } = normalNear(oc, face, point);
  return (
    (point[0] - nearest[0]) * normal[0] +
      (point[1] - nearest[1]) * normal[1] +
      (point[2] - nearest[2]) * normal[2] >
    0
  );
}

/** Points along an edge: its ends and middle, or `count` evenly spaced ones. */
export function edgePoints(oc: Oc, edge: Shape, count = 3): Vec3[] {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
  return Array.from({ length: count }, (_, i) => xyz(curve.Value(a + ((b - a) * i) / (count - 1))));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, by: number): Vec3 => [a[0] * by, a[1] * by, a[2] * by];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Normals within this angle (about 0.06 degrees) count as tangent. */
const TANGENT_COSINE = Math.cos(1e-3);

/** True when two faces meet smoothly (same normal) all along their shared `edge`. */
export function tangentAlong(oc: Oc, a: Shape, b: Shape, edge: Shape): boolean {
  return edgePoints(oc, edge, 5).every(
    (point) =>
      dot(normalNear(oc, a, point).normal, normalNear(oc, b, point).normal) > TANGENT_COSINE,
  );
}

/** Edges each face bounds, keyed by edge, for adjacency. Seams appear once per face. */
function edgeFaces(oc: Oc, faces: readonly Shape[]): ShapeSet<Shape[]> {
  const map = new ShapeSet<Shape[]>(oc);
  for (const face of faces)
    for (const edge of subShapes(oc, face, "EDGE")) map.set(edge, [...(map.get(edge) ?? []), face]);
  return map;
}

/** The faces of `solid` sharing an edge with any of `faces`, other than `faces` themselves. */
export function adjacentFaces(oc: Oc, solid: Shape, faces: readonly Shape[]): Shape[] {
  const chosen = new ShapeSet<true>(oc);
  for (const face of faces) chosen.set(face, true);
  const edges = new ShapeSet<true>(oc);
  for (const face of faces) for (const edge of subShapes(oc, face, "EDGE")) edges.set(edge, true);
  return subShapes(oc, solid, "FACE").filter(
    (face) => !chosen.has(face) && subShapes(oc, face, "EDGE").some((edge) => edges.has(edge)),
  );
}

/** Pairs of (selected face, neighbor, shared edge) around `faces` in `body`. */
function boundary(oc: Oc, body: Shape, faces: readonly Shape[]) {
  const selected = new ShapeSet<true>(oc);
  for (const face of faces) selected.set(face, true);
  const incidence = edgeFaces(oc, subShapes(oc, body, "FACE"));
  return faces.flatMap((face) =>
    subShapes(oc, face, "EDGE").flatMap((edge) =>
      (incidence.get(edge) ?? [])
        .filter((other) => !selected.has(other))
        .map((neighbor) => ({ face, neighbor, edge })),
    ),
  );
}

/**
 * Fillet faces next to `faces` in `body`, the ones `includeFillet` deletes along with them: blend
 * surfaces (cylinders, tori, spheres) tangent to a selected face along one edge and to another face
 * along a different one, like a rolling-ball blend between two faces. A rod's wall under a domed
 * end is tangent to the dome but meets its base at a sharp edge, so it isn't one. Unverified:
 * Onshape recognizes blends with Parasolid's own blend detection, which may accept other shapes.
 */
export function adjacentFillets(oc: Oc, body: Shape, faces: readonly Shape[]): Shape[] {
  const fillets = new ShapeSet<true>(oc);
  for (const { face, neighbor, edge } of boundary(oc, body, faces))
    if (
      !fillets.has(neighbor) &&
      ["Cylinder", "Torus", "Sphere"].includes(surfaceType(oc, neighbor)) &&
      tangentAlong(oc, face, neighbor, edge) &&
      boundary(oc, body, [neighbor]).some(
        (other) =>
          !other.edge.IsSame(edge) &&
          !other.neighbor.IsSame(face) &&
          tangentAlong(oc, neighbor, other.neighbor, other.edge),
      )
    )
      fillets.set(neighbor, true);
  return subShapes(oc, body, "FACE").filter((face) => fillets.has(face));
}

/** The faces a fillet face rolls between: its neighbors in `body` it meets tangentially. */
export function springFaces(oc: Oc, body: Shape, fillet: Shape): Shape[] {
  const springs = new ShapeSet<true>(oc);
  for (const { neighbor, edge } of boundary(oc, body, [fillet]))
    if (tangentAlong(oc, fillet, neighbor, edge)) springs.set(neighbor, true);
  return subShapes(oc, body, "FACE").filter((face) => springs.has(face));
}

/** `faces` plus every face of `body` reachable from them across tangent edges. */
export function tangentChain(oc: Oc, body: Shape, faces: readonly Shape[]): Shape[] {
  const chain = new ShapeSet<true>(oc);
  const queue = [...faces];
  for (const face of faces) chain.set(face, true);
  while (queue.length) {
    const face = queue.pop()!;
    for (const { neighbor, edge } of boundary(oc, body, [face]))
      if (!chain.has(neighbor) && tangentAlong(oc, face, neighbor, edge)) {
        chain.set(neighbor, true);
        queue.push(neighbor);
      }
  }
  return subShapes(oc, body, "FACE").filter((face) => chain.has(face));
}

/** True when every edge two of `faces` share joins them tangentially, like a fillet and its wall. */
export function smoothSheet(oc: Oc, faces: readonly Shape[]): boolean {
  const incidence = edgeFaces(oc, faces);
  return faces.every((face) =>
    subShapes(oc, face, "EDGE").every((edge) =>
      (incidence.get(edge) ?? []).every(
        (other) => other.IsSame(face) || tangentAlong(oc, face, other, edge),
      ),
    ),
  );
}

/** Groups faces that share edges, transitively. */
export function connectedGroups(oc: Oc, faces: readonly Shape[]): Shape[][] {
  const incidence = edgeFaces(oc, faces);
  const group = new ShapeSet<number>(oc);
  const groups: Shape[][] = [];
  for (const start of faces) {
    if (group.has(start)) continue;
    const members: Shape[] = [];
    const queue = [start];
    group.set(start, groups.length);
    while (queue.length) {
      const face = queue.pop()!;
      members.push(face);
      for (const edge of subShapes(oc, face, "EDGE"))
        for (const other of incidence.get(edge) ?? [])
          if (!group.has(other)) {
            group.set(other, groups.length);
            queue.push(other);
          }
    }
    groups.push(faces.filter((face) => members.some((member) => member.IsSame(face))));
  }
  return groups;
}

/** A shell of `faces` as they are (sharing their edges), for a sheet body. */
export function shellOf(oc: Oc, faces: readonly Shape[]): Shape {
  const shell = new oc.TopoDS_Shell();
  const builder = new oc.TopoDS_Builder();
  builder.MakeShell(shell);
  for (const face of faces) builder.Add(shell, face);
  return shell;
}

/** A copy of `shape` sharing no topology or geometry with it. */
export function copyShape(oc: Oc, shape: Shape): Shape {
  return new oc.BRepBuilderAPI_Transform(shape, new oc.gp_Trsf(), true, false).Shape();
}

/** A compound of shapes. */
export function compoundOf(oc: Oc, shapes: readonly Shape[]): Shape {
  const result = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(result);
  for (const shape of shapes) builder.Add(result, shape);
  return result;
}

/**
 * A cylinder's or sphere's radius at `face`, and +1 when the face's outward normal points away from
 * its axis or center (convex) or -1 when toward it; null for other surfaces.
 */
function roundness(oc: Oc, face: Shape): { radius: number; outward: 1 | -1 } | null {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const type = String(surface.GetType());
  if (type !== "GeomAbs_Cylinder" && type !== "GeomAbs_Sphere") return null;
  const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  const [u, v] = [(UMin + UMax) / 2, (VMin + VMax) / 2];
  const point = xyz(surface.Value(u, v));
  // The axis point (or center) nearest the face point.
  const center: Vec3 = (() => {
    if (type === "GeomAbs_Sphere") return xyz(surface.Sphere().Location());
    const axis = surface.Cylinder().Axis();
    const origin = xyz(axis.Location());
    const d = xyz(axis.Direction());
    const along = dot([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], d);
    return [origin[0] + along * d[0], origin[1] + along * d[1], origin[2] + along * d[2]];
  })();
  const radial: Vec3 = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  return {
    radius: Math.hypot(...radial),
    outward: dot(normalAtUV(oc, face, u, v), radial) > 0 ? 1 : -1,
  };
}

/**
 * True when offsetting `face` by `distance` along its outward normal takes it through a center of
 * curvature: a cylinder or sphere through its axis or center, or any other face where a principal
 * radius of curvature on the side it moves toward is no more than the distance (a torus's tube, a
 * blend's spine). OpenCascade returns a face on the far side, or one of no area, instead of failing.
 */
export function offsetCollapses(oc: Oc, face: Shape, distance: number): boolean {
  return collapseRadius(oc, face, distance) !== null;
}

/**
 * The radius of curvature an offset of `face` by `distance` passes through (see
 * {@link offsetCollapses}), the smallest where there are several, in meters; null when it doesn't.
 */
export function collapseRadius(oc: Oc, face: Shape, distance: number): number | null {
  const round = roundness(oc, face);
  if (round) return round.radius + round.outward * distance <= 1e-9 ? round.radius : null;
  if (surfaceType(oc, face) === "Plane") return null;
  // An offset multiplies each principal radius 1 / |k| by 1 - distance * k.
  const radii = curvatures(oc, face)
    .filter((k) => 1 - distance * k <= 1e-9)
    .map((k) => 1 / Math.abs(k));
  return radii.length ? Math.min(...radii) : null;
}

/**
 * The principal curvatures of `face` at a 5 x 5 grid of its parameters, where those points lie on
 * the face; positive where it bends toward its outward normal (concave), so a convex sphere's are
 * -1 / radius. From the fundamental forms: the roots of (EG - F^2) k^2 - (EN - 2FM + GL) k +
 * (LN - M^2).
 */
function curvatures(oc: Oc, face: Shape): number[] {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  const steps = [1, 2, 3, 4, 5].map((i) => i / 6);
  return steps.flatMap((a) =>
    steps.flatMap((b) => {
      const [u, v] = [UMin + a * (UMax - UMin), VMin + b * (VMax - VMin)];
      const probe = new oc.BRepBuilderAPI_MakeVertex(surface.Value(u, v)).Vertex();
      if (distance(oc, probe, face) > 1e-7) return [];
      const d = (nu: number, nv: number) => xyz(surface.DN(u, v, nu, nv));
      const [su, sv] = [d(1, 0), d(0, 1)];
      const n = normalAtUV(oc, face, u, v);
      const [e, f, g] = [dot(su, su), dot(su, sv), dot(sv, sv)];
      const [l, m, nn] = [dot(d(2, 0), n), dot(d(1, 1), n), dot(d(0, 2), n)];
      const [qa, qb, qc] = [e * g - f * f, e * nn - 2 * f * m + g * l, l * nn - m * m];
      if (qa <= 0) return [];
      const root = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc));
      return [(qb + root) / (2 * qa), (qb - root) / (2 * qa)];
    }),
  );
}

/**
 * `face` offset `distance` along its outward normal, keeping its extent (an offset plane is the same
 * size; an offset cylinder keeps its angle and height). Planes move, and cylinders and spheres whose
 * face spans a whole rectangle of their parameters are rebuilt with the new radius, so their edges
 * stay lines and circles; other faces take OpenCascade's offset, whose edges are approximated. Null
 * when the offset collapses the face.
 */
export function offsetFace(oc: Oc, face: Shape, distance: number): Shape | null {
  if (offsetCollapses(oc, face, distance)) return null;
  const topoFace = oc.TopoDS.Face(face);
  const surface = new oc.BRepAdaptor_Surface(topoFace, true);
  const type = String(surface.GetType());
  const reversed = String(face.Orientation()) === "TopAbs_REVERSED";
  if (type === "GeomAbs_Plane") {
    const n = xyz(surface.Plane().Axis().Direction()).map((c) => (reversed ? -c : c) * distance);
    const shift = new oc.gp_Trsf();
    shift.SetTranslation(new oc.gp_Vec(n[0]!, n[1]!, n[2]!));
    return new oc.BRepBuilderAPI_Transform(face, shift, true, false).Shape();
  }
  const round = roundness(oc, face);
  if (round) {
    const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(topoFace);
    const radius = round.radius + round.outward * distance;
    const rebuilt =
      type === "GeomAbs_Cylinder"
        ? new oc.BRepBuilderAPI_MakeFace(
            new oc.gp_Cylinder(surface.Cylinder().Position(), radius),
            UMin,
            UMax,
            VMin,
            VMax,
          ).Face()
        : new oc.BRepBuilderAPI_MakeFace(
            new oc.gp_Sphere(surface.Sphere().Position(), radius),
            UMin,
            UMax,
            VMin,
            VMax,
          ).Face();
    // Only a face covering its whole parameter rectangle is that rectangle: the same area scaled.
    const area = (shape: Shape) => {
      const props = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(shape, props, false, false);
      return props.Mass();
    };
    const scale =
      type === "GeomAbs_Cylinder" ? radius / round.radius : (radius / round.radius) ** 2;
    if (Math.abs(area(rebuilt) - area(face) * scale) <= 1e-9 * area(rebuilt))
      return reversed ? rebuilt.Reversed() : rebuilt;
  }
  try {
    const offset = new oc.BRepOffsetAPI_MakeOffsetShape();
    // OpenCascade offsets along the surface's normal; a reversed face's outward normal is opposite.
    offset.PerformBySimple(face, reversed ? -distance : distance);
    if (!offset.IsDone()) return null;
    return subShapes(oc, offset.Shape(), "FACE")[0] ?? null;
  } catch {
    return null;
  }
}

/** True when `moved` lies on `face`'s surface with the same normal: moving there changes nothing. */
export function sameSurface(oc: Oc, face: Shape, moved: Shape): boolean {
  const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(moved));
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(moved), true);
  return [0.2, 0.5, 0.8].every((s) =>
    [0.2, 0.5, 0.8].every((t) => {
      const [u, v] = [UMin + s * (UMax - UMin), VMin + t * (VMax - VMin)];
      const near = normalNear(oc, face, xyz(surface.Value(u, v)));
      return near.distance < 1e-7 && dot(near.normal, normalAtUV(oc, moved, u, v)) > TANGENT_COSINE;
    }),
  );
}

/**
 * `face` grown by `reach` across its surface in every direction the surface allows (not around
 * a periodic direction), or null when OpenCascade can't extend this surface.
 */
function extendFace(oc: Oc, face: Shape, reach: number): Shape | null {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const u = !surface.IsUPeriodic();
  const v = !surface.IsVPeriodic();
  if (!u && !v) return face;
  try {
    const extended = new oc.TopoDS_Face();
    oc.BRepLib.ExtendFace(oc.TopoDS.Face(face), reach, u, u, v, v, extended);
    return extended.IsNull() ? null : extended;
  } catch {
    return null;
  }
}

/** A face of a solid and where it goes. */
export interface FaceChange {
  /** Oriented as the solid holds it (from exploring the solid), so its normal points out. */
  readonly face: Shape;
  /**
   * The face on its new surface (any extent; it's extended here), oriented so its normal points out
   * of the result, or null to delete it.
   */
  readonly moved: Shape | null;
  /**
   * Where one of the face's edges ends up when the face moves, or null when that isn't known. A
   * split between two moved faces is kept (`mergeFaces: false`) by walling off their regions
   * along it.
   */
  readonly carry?: (edge: Shape) => Shape | null;
}

export type Rebuilt =
  | {
      readonly ok: true;
      readonly shape: Shape;
      /** Moved faces map to their faces on the new surface; neighbors to their grown or trimmed selves. */
      readonly history: History;
    }
  | {
      readonly ok: false;
      /** Surface types of neighbors OpenCascade couldn't extend; healing may have needed them. */
      readonly unextended: readonly string[];
      /** Set when the request itself can't be matched, as the message to stop the run with. */
      readonly unsupported?: string;
    };

/**
 * True when `cell` lies on the side `face`'s outward normal points to, judged across `piece`: a face
 * of `cell` on `face`'s surface, oriented as `cell` holds it (its normal points out of `cell`).
 */
function onNormalSide(oc: Oc, piece: Shape, face: Shape): boolean {
  const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(piece));
  const [u, v] = [(UMin + UMax) / 2, (VMin + VMax) / 2];
  const point = xyz(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(piece), true).Value(u, v));
  return dot(normalAtUV(oc, piece, u, v), normalNear(oc, face, point).normal) < 0;
}

/** A region a face change sweeps through, added to the solid or removed from it. */
export interface Region {
  readonly cell: Shape;
  readonly add: boolean;
  /** Pieces of the cell on a moved face's new surface, by change index. */
  readonly targetFaces: readonly { readonly index: number; readonly face: Shape }[];
  /** Pieces of the cell on the changed faces themselves. */
  readonly changedFaces: readonly Shape[];
  /** The changes that sweep this cell. */
  readonly changes: readonly number[];
}

/**
 * The regions that deleting or moving faces of `solid` sweeps through, with the neighbors that
 * bound them; see {@link rebuildSolid}.
 */
export function sweptRegions(
  oc: Oc,
  solid: Shape,
  changes: readonly FaceChange[],
  /** Extra faces that only divide cells, such as walls keeping a split between moved faces. */
  walls: readonly Shape[] = [],
):
  | {
      readonly ok: true;
      readonly regions: readonly Region[];
      readonly neighbors: readonly Shape[];
      readonly unextended: readonly string[];
    }
  | { readonly ok: false; readonly unextended: readonly string[] } {
  const neighbors = adjacentFaces(
    oc,
    solid,
    changes.map((change) => change.face),
  );
  const bounds = new oc.Bnd_Box();
  oc.BRepBndLib.Add(solid, bounds, false);
  for (const change of changes) if (change.moved) oc.BRepBndLib.Add(change.moved, bounds, false);
  const size = Math.sqrt(bounds.SquareExtent());
  bounds.Enlarge(size * 0.25 + 1e-4);
  const box = new oc.BRepPrimAPI_MakeBox(
    new oc.gp_Pnt(bounds.GetXMin(), bounds.GetYMin(), bounds.GetZMin()),
    new oc.gp_Pnt(bounds.GetXMax(), bounds.GetYMax(), bounds.GetZMax()),
  ).Shape();
  const reach = 3 * size + 1e-3;
  const unextended: string[] = [];
  const grown = (face: Shape) => {
    const extended = extendFace(oc, face, reach);
    if (!extended) unextended.push(surfaceType(oc, face));
    return extended ?? face;
  };
  const targets = changes.map((change) => (change.moved ? grown(change.moved) : null));
  const extensions = neighbors.map(grown);

  const splitter = new oc.BRepAlgoAPI_Splitter();
  splitter.SetNonDestructive(true);
  splitter.SetArguments(toList(oc, [box]));
  splitter.SetTools(
    toList(oc, [
      ...extensions,
      ...targets.filter((target): target is Shape => target !== null),
      ...changes.map((change) => change.face),
      ...walls,
    ]),
  );
  splitter.Build(new oc.Message_ProgressRange());
  if (splitter.HasErrors()) return { ok: false, unextended };

  // Each piece of the split knows what it came from: the box, changed faces, or new surfaces (one
  // template can be the new surface of several faces).
  type Origin = { readonly kind: "box" | "face" | "target"; readonly index: number };
  const origin = new ShapeSet<Origin[]>(oc);
  const mark = (shape: Shape, value: Origin) => {
    for (const image of imagesOf(historyOf(oc, splitter), shape))
      origin.set(image, [...(origin.get(image) ?? []), value]);
  };
  targets.forEach((target, index) => target && mark(target, { kind: "target", index }));
  changes.forEach((change, index) => mark(change.face, { kind: "face", index }));
  for (const face of subShapes(oc, box, "FACE")) mark(face, { kind: "box", index: -1 });

  const covered = new Set<number>();
  const regions: Region[] = [];
  for (const cell of subShapes(oc, splitter.Shape(), "SOLID")) {
    // Per change: whether the cell is on the empty side of the old face, and of the new one.
    const sides = new Map<number, { old?: boolean; new?: boolean }>();
    const targetFaces: { index: number; face: Shape }[] = [];
    const changedFaces: Shape[] = [];
    let walled = false;
    for (const piece of subShapes(oc, cell, "FACE"))
      for (const from of origin.get(piece) ?? []) {
        if (from.kind === "box") {
          walled = true;
          continue;
        }
        const change = changes[from.index]!;
        const side = sides.get(from.index) ?? {};
        if (from.kind === "face") {
          side.old = onNormalSide(oc, piece, change.face);
          changedFaces.push(piece);
        } else {
          side.new = onNormalSide(oc, piece, change.moved!);
          targetFaces.push({ index: from.index, face: piece });
        }
        sides.set(from.index, side);
      }
    if (walled) continue;
    // A cell that touches only one of a moved face's old and new surfaces (a hole moved clear of
    // itself) is judged against the other surface by its centre.
    let centre: Vec3 | undefined;
    const judged = (face: Shape) => {
      if (!centre) {
        const props = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(cell, props, false, false, false);
        centre = xyz(props.CentreOfMass());
      }
      return inFrontOf(oc, face, centre);
    };
    const decisions = [...sides].flatMap(([index, side]) => {
      const change = changes[index]!;
      if (!change.moved) return side.old === undefined ? [] : [{ index, add: side.old }];
      const wasEmpty = side.old ?? judged(change.face);
      const isEmpty = side.new ?? judged(change.moved);
      return wasEmpty === isEmpty ? [] : [{ index, add: wasEmpty }];
    });
    if (decisions.length === 0) continue;
    if (decisions.some((decision) => decision.add !== decisions[0]!.add))
      return { ok: false, unextended };
    for (const { index } of decisions) covered.add(index);
    // The cell belongs to the changes whose old faces it touches (a change judged sweeping only by
    // its surface may be a coplanar neighbor's), or, touching none, to all that sweep it. A
    // coincident new surface of a change it doesn't belong to isn't its face here.
    const touching = decisions.filter((decision) => sides.get(decision.index)?.old !== undefined);
    const swept = (touching.length ? touching : decisions).map((decision) => decision.index);
    regions.push({
      cell,
      add: decisions[0]!.add,
      targetFaces: targetFaces.filter((target) => swept.includes(target.index)),
      changedFaces,
      changes: swept,
    });
  }
  if (changes.some((_, index) => !covered.has(index))) return { ok: false, unextended };
  return { ok: true, regions, neighbors, unextended };
}

/**
 * Deletes or moves faces of `solid` and lets the neighboring faces grow or shrink along their own
 * surfaces to close the body again, the way Parasolid's local operations heal.
 *
 * A box around everything is cut by the changed faces, their new surfaces and the neighbors' extended
 * surfaces. A cell that doesn't reach the box's walls is swept by a move when it touches the old or
 * new surface and lies on the empty side of one and the material side of the other (where an old
 * and a new hole overlap stays empty): it's added if it was empty, removed if it was material. A
 * deleted face's cells are the gaps its neighbors close over, added or removed by the side of the
 * face they're on. Every changed face must be swept and every neighbor must survive, or nothing
 * heals the way Parasolid would, and this fails.
 */
export function rebuildSolid(
  oc: Oc,
  solid: Shape,
  changes: readonly FaceChange[],
  /**
   * `mergeFaces: false` keeps each moved face apart from the faces around it that share its new
   * surface: other moved faces and unmoved ones it lands flush with.
   */
  options: { readonly mergeFaces?: boolean } = {},
): Rebuilt {
  const cannotKeep: Rebuilt = {
    ok: false,
    unextended: [],
    unsupported:
      "Keeping the edges between moved faces (mergeFaces false) is not supported locally yet for this move.",
  };
  const walls: Shape[] = [];
  // Pairs of moved faces split from each other on one surface, to check they're still apart.
  const splitPairs: [Shape, Shape][] = [];
  if (options.mergeFaces === false) {
    // A split between two moved faces moves with them; a wall through the old edge and the new
    // one keeps their regions, and so their new faces, apart.
    const moved = new ShapeSet<FaceChange>(oc);
    for (const change of changes) if (change.moved) moved.set(change.face, change);
    for (const edge of redundancies(oc, solid).filter((shape) => shapeKind(shape) === "EDGE")) {
      const owners = subShapes(oc, solid, "FACE").filter((face) =>
        subShapes(oc, face, "EDGE").some((e) => e.IsSame(edge)),
      );
      const [a, b] = owners.map((face) => moved.get(face));
      if (owners.length !== 2 || !a || !b) continue;
      splitPairs.push([a.face, b.face]);
      const carried = a.carry?.(edge) ?? null;
      if (!carried) return cannotKeep;
      const wall = wallBetween(oc, edge, carried, [solid, carried]);
      if (wall === null) return cannotKeep;
      if (wall !== "NONE") walls.push(wall);
    }
  }
  const swept = sweptRegions(oc, solid, changes, walls);
  if (!swept.ok) return swept;
  const { regions, unextended } = swept;
  // Without merging, a moved face's new faces stay apart from faces of other changes and from
  // faces no change made.
  const keepApart =
    options.mergeFaces === false
      ? (shape: Shape, history: History) => {
          const owner = new ShapeSet<readonly number[]>(oc);
          for (const region of regions)
            for (const { face } of region.targetFaces)
              for (const image of imagesOf(history, face)) owner.set(image, region.changes);
          const incidence = edgeFaces(oc, subShapes(oc, shape, "FACE"));
          return subShapes(oc, shape, "EDGE").filter((edge) => {
            const faces = incidence.get(edge) ?? [];
            if (faces.length !== 2) return false;
            const [a, b] = faces.map((face) => owner.get(face));
            if (!a || !b) return Boolean(a || b);
            return !a.some((index) => b.includes(index));
          });
        }
      : undefined;
  const changed = fillAndCut(
    oc,
    solid,
    regions.filter((region) => region.add).map((region) => region.cell),
    regions.filter((region) => !region.add).map((region) => region.cell),
    keepApart,
  );
  if (!changed) return { ok: false, unextended };
  const { shape, history } = changed;

  // A deleted face's neighbors close the gap, so each must survive: if one vanishes, the "heal"
  // removed the feature it belonged to (a boss whose side alone was deleted). A moved face may
  // sweep a neighbor away (a step raised flush loses its riser).
  const result = new ShapeSet<true>(oc);
  for (const face of subShapes(oc, shape, "FACE")) result.set(face, true);
  const survives = (face: Shape) => imagesOf(history, face).some((image) => result.has(image));
  const healed = adjacentFaces(
    oc,
    solid,
    changes.filter((change) => !change.moved).map((change) => change.face),
  );
  if (
    subShapes(oc, shape, "SOLID").length === 0 ||
    !healed.every(survives) ||
    !new oc.BRepCheck_Analyzer(shape, true, false).IsValid()
  )
    return { ok: false, unextended };

  // A moved face continues as the faces its new surface left in the result.
  const continued = new ShapeSet<Shape[]>(oc);
  for (const region of regions)
    for (const { index, face } of region.targetFaces) {
      const images = imagesOf(history, face).filter((image) => result.has(image));
      const from = changes[index]!.face;
      continued.set(from, [...(continued.get(from) ?? []), ...images]);
    }
  // A wall that didn't divide the swept region leaves the halves as one face, or a stray edge
  // inside a face; neither is what Parasolid makes, so stop instead.
  if (
    splitPairs.some(([a, b]) =>
      (continued.get(a) ?? []).some((face) => (continued.get(b) ?? []).some((f) => f.IsSame(face))),
    ) ||
    subShapes(oc, shape, "FACE").some((face) =>
      subShapes(oc, face, "EDGE").some((edge) => String(edge.Orientation()) === "TopAbs_INTERNAL"),
    )
  )
    return cannotKeep;
  return {
    ok: true,
    shape,
    history: {
      deleted: (s) => !continued.has(s) && history.deleted(s),
      modified: (s) => continued.get(s) ?? history.modified(s),
      generated: (s) => history.generated(s),
    },
  };
}

/**
 * `solid` with `added` fused on and then `removed` cut away, each step tidied (see {@link tidied}),
 * and the history of both steps; null when a boolean fails. `keep` names more edges of a step's
 * result to leave unmerged, given that result and the history so far.
 */
export function fillAndCut(
  oc: Oc,
  solid: Shape,
  added: readonly Shape[],
  removed: readonly Shape[],
  keep?: (shape: Shape, history: History) => Shape[],
): { shape: Shape; history: History } | null {
  let shape = solid;
  let history: History = { deleted: () => false, modified: () => [], generated: () => [] };
  for (const [algorithm, tools] of [
    [new oc.BRepAlgoAPI_Fuse(), added],
    [new oc.BRepAlgoAPI_Cut(), removed],
  ] as const) {
    if (tools.length === 0) continue;
    algorithm.SetNonDestructive(true);
    algorithm.SetArguments(toList(oc, [shape]));
    algorithm.SetTools(toList(oc, tools));
    algorithm.Build(new oc.Message_ProgressRange());
    if (algorithm.HasErrors()) return null;
    const before = history;
    const step = tidied(oc, algorithm, [shape], (result, raw) =>
      keep ? keep(result, chainHistory(before, raw)) : [],
    );
    if (!step) return null;
    shape = step.shape;
    history = chainHistory(history, step.history);
  }
  return { shape, history };
}

/**
 * What a built boolean made, tidied the way Parasolid tidies: faces left split on one surface and
 * edges split on one curve are merged, except where the operation's `inputs` were already split
 * (a face split on purpose stays split) and any edges or vertices `keep` names. Without anything to
 * keep, OpenCascade's own simplification runs with its exact history; otherwise UnifySameDomain
 * keeps those shapes and its history is found by geometry (it copies every shape it touches).
 * Cylinder seams that split a rim arc then move to a vertex the rim has (see {@link seatSeams}).
 */
export function tidied(
  oc: Oc,
  algorithm: InstanceType<Oc["BRepAlgoAPI_BuilderAlgo"]>,
  inputs: readonly Shape[],
  keep: (shape: Shape, history: History) => Shape[] = () => [],
): { shape: Shape; history: History } | null {
  const raw = algorithm.Shape();
  const rawHistory = historyOf(oc, algorithm);
  const present = new ShapeSet<true>(oc);
  for (const kind of ["EDGE", "VERTEX"] as const)
    for (const shape of subShapes(oc, raw, kind)) present.set(shape, true);
  const kept = [
    ...inputs.flatMap((input) =>
      redundancies(oc, input).flatMap((shape) => imagesOf(rawHistory, shape)),
    ),
    ...keep(raw, rawHistory),
  ].filter((shape) => present.has(shape));
  let done: { shape: Shape; history: History } | null;
  if (kept.length === 0) {
    algorithm.SimplifyResult(true, true, 1e-9);
    done = { shape: algorithm.Shape(), history: historyOf(oc, algorithm) };
  } else {
    const unified = unifyKeeping(oc, raw, kept);
    done = unified && { shape: unified.shape, history: chainHistory(rawHistory, unified.history) };
  }
  const seated = done && seatSeams(oc, done.shape, inputs);
  return seated && done
    ? { shape: seated.shape, history: chainHistory(done.history, seated.history) }
    : done;
}

/** What `sameDomain` compares: a face's surface type, and for a plane its point and outward normal. */
interface Domain {
  readonly face: Shape;
  readonly type: string;
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3 } | null;
}

function domainOf(oc: Oc, face: Shape): Domain {
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const type = String(surface.GetType()).replace("GeomAbs_", "");
  if (type !== "Plane") return { face, type, plane: null };
  const plane = surface.Plane();
  const sign = String(face.Orientation()) === "TopAbs_REVERSED" ? -1 : 1;
  const n = xyz(plane.Axis().Direction());
  return {
    face,
    type,
    plane: { origin: xyz(plane.Location()), normal: [n[0] * sign, n[1] * sign, n[2] * sign] },
  };
}

/** True when two faces lie on one surface and face the same way. */
function sameDomain(oc: Oc, a: Domain, b: Domain): boolean {
  if (a.type !== b.type) return false;
  if (a.plane && b.plane) {
    const offset: Vec3 = [
      b.plane.origin[0] - a.plane.origin[0],
      b.plane.origin[1] - a.plane.origin[1],
      b.plane.origin[2] - a.plane.origin[2],
    ];
    return (
      dot(a.plane.normal, b.plane.normal) > TANGENT_COSINE &&
      Math.abs(dot(offset, a.plane.normal)) < 1e-7
    );
  }
  return sameSurface(oc, a.face, b.face);
}

/** True when edges `a` and `b`, meeting at a vertex, lie on one line or one circle. */
function sameCurve(oc: Oc, a: Shape, b: Shape): boolean {
  const curve = (edge: Shape) => new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [p, q] = [curve(a), curve(b)];
  const type = String(p.GetType());
  if (type !== String(q.GetType())) return false;
  if (type === "GeomAbs_Line") {
    // Two lines through one vertex are one line when they run the same way.
    const direction = (line: typeof p) => {
      const d = line.EvalD1(line.FirstParameter()).D1;
      const length = d.Magnitude() || 1;
      return [d.X() / length, d.Y() / length, d.Z() / length] as const;
    };
    return Math.abs(Math.abs(dot(direction(p), direction(q))) - 1) < 1e-9;
  }
  if (type === "GeomAbs_Circle") {
    const [c, d] = [p.Circle(), q.Circle()];
    const [m, n] = [xyz(c.Location()), xyz(d.Location())];
    return (
      Math.hypot(m[0] - n[0], m[1] - n[1], m[2] - n[2]) < 1e-7 &&
      Math.abs(c.Radius() - d.Radius()) < 1e-7 &&
      Math.abs(Math.abs(dot(xyz(c.Axis().Direction()), xyz(d.Axis().Direction()))) - 1) < 1e-9
    );
  }
  return false;
}

/**
 * Vertices of `shape` that only mark where OpenCascade starts a circle: a vertex joining two arcs
 * of one circle at the circle's parameter origin. Parasolid's full circle has no vertex, so these
 * aren't splits to keep. (While a closed face's seam still ends there, OpenCascade needs the
 * vertex, so a split circle on a whole cylinder keeps one more vertex and edge than Parasolid.)
 */
function seamJoints(oc: Oc, shape: Shape): Shape[] {
  // A closed face's own seam edge also ends there; it isn't an edge Parasolid has.
  const seams = seamEdges(oc, shape);
  const atVertex = new ShapeSet<Shape[]>(oc);
  for (const edge of subShapes(oc, shape, "EDGE"))
    if (!seams.has(edge) && !oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)))
      for (const vertex of subShapes(oc, edge, "VERTEX"))
        atVertex.set(vertex, [...(atVertex.get(vertex) ?? []), edge]);
  return subShapes(oc, shape, "VERTEX").filter((vertex) => {
    const meeting = atVertex.get(vertex) ?? [];
    if (meeting.length !== 2 || !sameCurve(oc, meeting[0]!, meeting[1]!)) return false;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(meeting[0]!));
    if (String(curve.GetType()) !== "GeomAbs_Circle") return false;
    const at = oc.BRep_Tool.Parameter(oc.TopoDS.Vertex(vertex), oc.TopoDS.Edge(meeting[0]!));
    const turn = 2 * Math.PI;
    return Math.abs(at - turn * Math.round(at / turn)) < 1e-9;
  });
}

/**
 * Splits `shape` already has that a merge would undo: edges between two faces on one surface (a
 * face split on purpose) and vertices joining two edges on one line or circle (an edge split on
 * purpose).
 */
export function redundancies(oc: Oc, shape: Shape): Shape[] {
  // One pass over the faces: each edge's faces, and seams (planes have none).
  const incidence = new ShapeSet<Domain[]>(oc);
  const seams = new ShapeSet<true>(oc);
  for (const face of subShapes(oc, shape, "FACE")) {
    const domain = domainOf(oc, face);
    for (const edge of subShapes(oc, face, "EDGE")) {
      incidence.set(edge, [...(incidence.get(edge) ?? []), domain]);
      if (!domain.plane && oc.BRep_Tool.IsClosed(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face)))
        seams.set(edge, true);
    }
  }
  const edges = subShapes(oc, shape, "EDGE").filter(
    (edge) => !seams.has(edge) && !oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)),
  );
  const split = edges.filter((edge) => {
    const [a, b, more] = incidence.get(edge) ?? [];
    return a && b && !more && sameDomain(oc, a, b);
  });
  const atVertex = new ShapeSet<Shape[]>(oc);
  for (const edge of edges)
    for (const vertex of subShapes(oc, edge, "VERTEX"))
      atVertex.set(vertex, [...(atVertex.get(vertex) ?? []), edge]);
  const artifacts = new ShapeSet<true>(oc);
  for (const joint of seamJoints(oc, shape)) artifacts.set(joint, true);
  const joints = subShapes(oc, shape, "VERTEX").filter((vertex) => {
    const meeting = atVertex.get(vertex) ?? [];
    return (
      meeting.length === 2 && !artifacts.has(vertex) && sameCurve(oc, meeting[0]!, meeting[1]!)
    );
  });
  return [...split, ...joints];
}

/** `face`'s coarse mesh as triangles in its parameters, largest first; null when it won't mesh. */
function coarseTriangles(
  oc: Oc,
  face: Shape,
): { area: number; corners: (readonly [number, number])[] }[] | null {
  const topoFace = oc.TopoDS.Face(face);
  // Meshing first, as the preview does: a face without a mesh has no triangulation handle at all.
  const mesher = new oc.BRepMesh_IncrementalMesh(face, 0.1, true, 0.5, false);
  mesher.delete();
  const triangulation = oc.BRep_Tool.Triangulation(topoFace, new oc.TopLoc_Location(), 0);
  // A face the mesher can't handle (one turned inside out) has no triangulation at all.
  if (!triangulation || triangulation.isNull() || !triangulation.HasUVNodes()) return null;
  const triangles: { area: number; corners: (readonly [number, number])[] }[] = [];
  for (let t = 1; t <= triangulation.NbTriangles(); t++) {
    const triangle = triangulation.Triangle(t);
    const corners = [1, 2, 3].map((k) => {
      const node = triangulation.UVNode(triangle.Value(k));
      return [node.X(), node.Y()] as const;
    });
    const [a, b, c] = corners;
    const area = Math.abs((b![0] - a![0]) * (c![1] - a![1]) - (c![0] - a![0]) * (b![1] - a![1]));
    triangles.push({ area, corners });
  }
  return triangles.sort((a, b) => b.area - a.area);
}

/**
 * Up to `count` points spread over `face`: the middles of its coarse mesh's largest triangles that
 * really lie on it (a coarse triangle on a thin face can reach across a rim). Empty when it won't
 * mesh (a face turned inside out).
 */
export function facePoints(oc: Oc, face: Shape, count = 5): Vec3[] {
  const triangles = coarseTriangles(oc, face);
  if (!triangles) return [];
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const points: Vec3[] = [];
  for (const [u, v] of meshCandidates(triangles).slice(0, 12 * count)) {
    const point = xyz(surface.Value(u, v));
    const probe = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();
    if (distance(oc, probe, face) < 1e-7) points.push(point);
    if (points.length === count) break;
  }
  return points;
}

/**
 * Points of a face's parameters from its coarse mesh: each triangle's middle (largest first), the
 * middles of its edges (inner ones run down a strip's center line), then points nearer its corners.
 */
function meshCandidates(
  triangles: readonly { corners: readonly (readonly [number, number])[] }[],
): [number, number][] {
  const middle = (points: readonly (readonly [number, number])[]) =>
    [0, 1].map((i) => points.reduce((sum, p) => sum + p[i]!, 0) / points.length) as [
      number,
      number,
    ];
  return [
    ...triangles.map(({ corners }) => middle(corners)),
    ...triangles.flatMap(({ corners }) =>
      corners.map((corner, k) => middle([corner, corners[(k + 1) % 3]!])),
    ),
    ...triangles.flatMap(({ corners }) => {
      const [u, v] = middle(corners);
      return corners.map(
        ([cu, cv]) => [u + (2 / 3) * (cu - u), v + (2 / 3) * (cv - v)] as [number, number],
      );
    }),
  ];
}

/**
 * A point strictly inside `face`, on its surface, from its coarse mesh: each triangle's middle
 * (largest first), the middles of its edges (inner ones run down a strip's center line), then
 * points nearer its corners, keeping only those really on the face away from its edges (a coarse
 * triangle on a thin face can reach across a rim, its chord cutting into the hole beside it). The
 * first such point, or with `deepest` the one farthest from the face's edges. Null when none is.
 */
export function interiorPoint(oc: Oc, face: Shape, deepest = false): Vec3 | null {
  const triangles = coarseTriangles(oc, face);
  if (!triangles) return null;
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const rim = compoundOf(oc, subShapes(oc, face, "EDGE"));
  // How far the point at (u, v) is from the face's edges, when it's on the face.
  const clearance = (u: number, v: number): { point: Vec3; clear: number } | null => {
    const point = xyz(surface.Value(u, v));
    const probe = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();
    if (distance(oc, probe, face) >= 1e-7) return null;
    const clear = distance(oc, probe, rim);
    return clear > 1e-7 ? { point, clear } : null;
  };
  let best: { point: Vec3; clear: number } | null = null;
  for (const [u, v] of meshCandidates(triangles)) {
    const found = clearance(u, v);
    if (!found) continue;
    if (!deepest) return found.point;
    if (!best || found.clear > best.clear) best = found;
  }
  return best?.point ?? null;
}

/**
 * Merges same-surface faces and same-curve edges of `shape` except across `keep` (edges and
 * vertices). UnifySameDomain copies what it returns, so the history maps each face to the result
 * face containing a point inside it, and each edge and vertex to the one through its middle.
 * Merging never splits, so every shape maps to at most one.
 */
function unifyKeeping(
  oc: Oc,
  shape: Shape,
  keep: readonly Shape[],
): { shape: Shape; history: History } | null {
  const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
  for (const kept of keep) unify.KeepShape(kept);
  try {
    unify.Build();
  } catch {
    return null;
  }
  const result = unify.Shape();
  const located = (kind: "FACE" | "EDGE" | "VERTEX") =>
    subShapes(oc, result, kind).map((candidate) => {
      const box = new oc.Bnd_Box();
      oc.BRepBndLib.Add(candidate, box, false);
      box.Enlarge(1e-6);
      return { shape: candidate, box };
    });
  const image = new ShapeSet<Shape | null>(oc);
  for (const kind of ["FACE", "EDGE", "VERTEX"] as const) {
    const candidates = located(kind);
    const same = new ShapeSet<true>(oc);
    for (const { shape: candidate } of candidates) same.set(candidate, true);
    for (const old of subShapes(oc, shape, kind)) {
      if (same.has(old)) continue;
      const at =
        kind === "FACE"
          ? interiorPoint(oc, old)
          : kind === "EDGE"
            ? edgePoints(oc, old, 3)[1]!
            : xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(old)));
      if (!at) {
        image.set(old, null);
        continue;
      }
      const point = new oc.gp_Pnt(...at);
      const probe = new oc.BRepBuilderAPI_MakeVertex(point).Vertex();
      const found = candidates.find(
        ({ shape: candidate, box }) => !box.IsOut(point) && distance(oc, probe, candidate) < 1e-7,
      );
      image.set(old, found?.shape ?? null);
    }
  }
  return {
    shape: result,
    history: {
      deleted: (old) => image.has(old) && image.get(old) === null,
      modified: (old) => {
        const found = image.get(old);
        return found ? [found] : [];
      },
      generated: () => [],
    },
  };
}

/** Edges `face` bounds twice: OpenCascade's seam, where a periodic surface's parameter wraps. */
function faceSeams(oc: Oc, face: Shape): ShapeSet<true> {
  const uses = new ShapeSet<number>(oc);
  for (
    const explorer = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    explorer.More();
    explorer.Next()
  )
    uses.set(explorer.Current(), (uses.get(explorer.Current()) ?? 0) + 1);
  const seams = new ShapeSet<true>(oc);
  for (const edge of subShapes(oc, face, "EDGE")) if (uses.get(edge) === 2) seams.set(edge, true);
  return seams;
}

/**
 * For each of `faces` (cylinders of `solid`) whose seam splits a rim arc (a seam vertex where the
 * only other edges are two pieces of one circle), a point the seam can move through instead: the
 * far end of one of those pieces, a vertex the rim has anyway and keeps after the move. One pass
 * over `solid`'s edges.
 */
function seamTargets(
  oc: Oc,
  solid: Shape,
  faces: readonly Shape[],
): { face: Shape; through: Vec3 }[] {
  const atVertex = new ShapeSet<Shape[]>(oc);
  for (const edge of subShapes(oc, solid, "EDGE"))
    if (!oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)))
      for (const vertex of subShapes(oc, edge, "VERTEX"))
        atVertex.set(vertex, [...(atVertex.get(vertex) ?? []), edge]);
  return faces.flatMap((face) => {
    const seams = faceSeams(oc, face);
    const splits = subShapes(oc, face, "EDGE")
      .filter((edge) => seams.has(edge))
      .flatMap((seam) => subShapes(oc, seam, "VERTEX"))
      .flatMap((vertex) => {
        const meeting = (atVertex.get(vertex) ?? []).filter((edge) => !seams.has(edge));
        if (meeting.length !== 2 || surfaceCurve(oc, meeting[0]!) !== "Circle") return [];
        if (!sameCurve(oc, meeting[0]!, meeting[1]!)) return [];
        const ends = meeting.flatMap((arc) =>
          subShapes(oc, arc, "VERTEX").filter((end) => !end.IsSame(vertex)),
        );
        // Both pieces ending at one vertex (a circle split once) would join into a closed edge
        // with that vertex alone on it, which isn't reported: the split's own vertex would vanish.
        return ends.length === 2 && ends[0]!.IsSame(ends[1]!) ? [] : ends;
      });
    const end = splits[0];
    return end ? [{ face, through: xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(end))) }] : [];
  });
}

const surfaceCurve = (oc: Oc, edge: Shape): string =>
  String(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)).GetType()).replace("GeomAbs_", "");

/** `solid` with cylinder `face`'s seam moved to run through `through`; see {@link moveSeams}. */
export function moveSeam(
  oc: Oc,
  solid: Shape,
  face: Shape,
  through: Vec3,
): { shape: Shape; history: History } | null {
  return moveSeams(oc, solid, [{ face, through }]);
}

/**
 * `solid` with each cylinder `face`'s seam moved to run through its `through` point (off the
 * axis), and the history; null when OpenCascade can't. A general fuse with copies of the faces
 * whose parameters start there gives each face its copy's surface (the first arguments win where
 * faces coincide), and UnifySameDomain rejoins the pieces with the seams where those surfaces
 * start. Each copy is trimmed to its face, so it can't cut through material elsewhere on the
 * cylinder.
 */
function moveSeams(
  oc: Oc,
  solid: Shape,
  moves: readonly { face: Shape; through: Vec3 }[],
): { shape: Shape; history: History } | null {
  if (shapeKind(solid) !== "SOLID") return null;
  try {
    const copies = moves.map(({ face, through }) => {
      if (surfaceType(oc, face) !== "Cylinder") return null;
      const cylinder = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true).Cylinder();
      const position = cylinder.Position();
      const axis = xyz(position.Direction());
      const from = xyz(position.XDirection());
      const offset = sub(through, xyz(position.Location()));
      const toward = sub(offset, scale(axis, dot(offset, axis)));
      const angle = Math.atan2(dot(cross(from, toward), axis), dot(from, toward));
      const turned = position.Rotated(
        new oc.gp_Ax1(position.Location(), position.Direction()),
        angle,
      );
      const { VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
      const pad = (VMax - VMin) / 10;
      const whole = new oc.BRepBuilderAPI_MakeFace(
        new oc.gp_Cylinder(turned, cylinder.Radius()),
        0,
        2 * Math.PI,
        VMin - pad,
        VMax + pad,
      ).Face();
      const common = new oc.BRepAlgoAPI_Common();
      common.SetNonDestructive(true);
      common.SetArguments(toList(oc, [whole]));
      common.SetTools(toList(oc, [face]));
      common.Build(new oc.Message_ProgressRange());
      return common.HasErrors() ? null : common.Shape();
    });
    if (copies.some((copy) => copy === null)) return null;
    const fuse = new oc.BRepAlgoAPI_BuilderAlgo();
    fuse.SetNonDestructive(true);
    fuse.SetArguments(toList(oc, [...copies.filter((copy) => copy !== null), solid]));
    fuse.Build(new oc.Message_ProgressRange());
    if (fuse.HasErrors()) return null;
    const solids = subShapes(oc, fuse.Shape(), "SOLID");
    if (solids.length !== 1) return null;
    const raw = solids[0]!;
    const rawHistory = historyOf(oc, fuse);
    const present = new ShapeSet<true>(oc);
    for (const kind of ["EDGE", "VERTEX"] as const)
      for (const shape of subShapes(oc, raw, kind)) present.set(shape, true);
    const kept = redundancies(oc, solid)
      .flatMap((shape) => imagesOf(rawHistory, shape))
      .filter((shape) => present.has(shape));
    const unified = unifyKeeping(oc, raw, kept);
    if (!unified || !new oc.BRepCheck_Analyzer(unified.shape, true, false).IsValid()) return null;
    if (Math.abs(volumeOf(oc, unified.shape) - volumeOf(oc, solid)) > 1e-9 * volumeOf(oc, solid))
      return null;
    return { shape: unified.shape, history: chainHistory(rawHistory, unified.history) };
  } catch {
    return null;
  }
}

/**
 * True when one of `edges` runs along `face`'s seam or ends on it, which OpenCascade's fillet and
 * chamfer can't take. An edge OpenCascade left closed on the face though it bounds it once (a cut
 * along the seam) counts; a full circle's one vertex is always on a seam, and that's fine.
 */
export function touchesSeam(oc: Oc, face: Shape, edges: readonly Shape[]): boolean {
  const onSeam = new ShapeSet<true>(oc);
  const seams = faceSeams(oc, face);
  for (const edge of subShapes(oc, face, "EDGE"))
    if (seams.has(edge))
      for (const vertex of subShapes(oc, edge, "VERTEX")) onSeam.set(vertex, true);
  return edges.some(
    (edge) =>
      oc.BRep_Tool.IsClosed(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face)) ||
      (!oc.BRep_Tool.IsClosed(edge) &&
        subShapes(oc, edge, "VERTEX").some((vertex) => onSeam.has(vertex))),
  );
}

/**
 * `solid` with each cylinder seam that touches `edges` (see {@link touchesSeam}) moved to another
 * vertex of its face clear of them, and the history; null when nothing touches or a seam has
 * nowhere to go (every vertex of the face is on `edges`, or a move would add a vertex).
 */
export function seamsClear(
  oc: Oc,
  solid: Shape,
  edges: readonly Shape[],
): { shape: Shape; history: History } | null {
  let current = solid;
  let targets = edges;
  let history: History | null = null;
  for (let moves = 0; moves < 8; moves++) {
    const face = subShapes(oc, current, "FACE").find(
      (candidate) =>
        surfaceType(oc, candidate) === "Cylinder" && touchesSeam(oc, candidate, targets),
    );
    if (!face) return history && { shape: current, history };
    const blocked = new ShapeSet<true>(oc);
    for (const edge of targets)
      for (const vertex of subShapes(oc, edge, "VERTEX")) blocked.set(vertex, true);
    const seams = faceSeams(oc, face);
    for (const edge of subShapes(oc, face, "EDGE"))
      if (seams.has(edge))
        for (const vertex of subShapes(oc, edge, "VERTEX")) blocked.set(vertex, true);
    let moved: { shape: Shape; history: History } | null = null;
    const vertices = topology(oc, current).vertices.length;
    for (const vertex of subShapes(oc, face, "VERTEX").filter((v) => !blocked.has(v))) {
      const candidate = moveSeam(
        oc,
        current,
        face,
        xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex))),
      );
      // A seam meeting the far rim mid-arc splits it with a vertex Onshape doesn't have.
      if (!candidate || topology(oc, candidate.shape).vertices.length > vertices) continue;
      const after = targets.flatMap((edge) => imagesOf(candidate.history, edge));
      if (imagesOf(candidate.history, face).some((image) => touchesSeam(oc, image, after)))
        continue;
      moved = candidate;
      break;
    }
    if (!moved) return null;
    const step = moved.history;
    targets = targets.flatMap((edge) => imagesOf(step, edge));
    current = moved.shape;
    history = history ? chainHistory(history, step) : step;
  }
  return null;
}

/**
 * `shape`'s solids with each cylinder seam that splits a rim arc moved through a vertex that rim
 * has anyway, the way Parasolid's seamless cylinder has no vertex there; null when none moved. Only
 * cylinder faces that aren't faces of the operation's `inputs` (ones it made or changed) move, all
 * in one go, so a face no operation touches keeps its seam and later operations can't change its
 * ids. The moves are kept only when they leave fewer vertices (both rims may have vertices a seam
 * can't line up with). Cones keep their seams: the bindings can't build a cone face to move one with.
 */
export function seatSeams(
  oc: Oc,
  shape: Shape,
  inputs: readonly Shape[],
): { shape: Shape; history: History } | null {
  const solids = shapeKind(shape) === "SOLID" ? [shape] : subShapes(oc, shape, "SOLID");
  // Only plain solids or compounds of them, so rebuilding the compound loses nothing.
  if (
    solids.reduce((count, solid) => count + subShapes(oc, solid, "FACE").length, 0) !==
    subShapes(oc, shape, "FACE").length
  )
    return null;
  const untouched = new ShapeSet<true>(oc);
  for (const input of inputs)
    for (const face of subShapes(oc, input, "FACE")) untouched.set(face, true);
  let history: History | null = null;
  const seated = solids.map((solid) => {
    const touched = subShapes(oc, solid, "FACE").filter(
      (face) => !untouched.has(face) && surfaceType(oc, face) === "Cylinder",
    );
    const moves = touched.length ? seamTargets(oc, solid, touched) : [];
    if (moves.length === 0) return solid;
    const moved = moveSeams(oc, solid, moves);
    if (!moved) return solid;
    if (topology(oc, moved.shape).vertices.length >= topology(oc, solid).vertices.length)
      return solid;
    history = history ? chainHistory(history, moved.history) : moved.history;
    return moved.shape;
  });
  if (!history) return null;
  return { shape: shapeKind(shape) === "SOLID" ? seated[0]! : compoundOf(oc, seated), history };
}

/**
 * A face dividing the region a split edge sweeps from `edge` to `moved`: the plane both lie in
 * when they're coplanar lines (a slide, or a turn about an axis square to that plane), as large as
 * `around`; otherwise the ruled face between them. "NONE" when they coincide (the halves turn about
 * the split itself, so their regions already part there); null when no face can be made.
 */
function wallBetween(
  oc: Oc,
  edge: Shape,
  moved: Shape,
  around: readonly Shape[],
): Shape | "NONE" | null {
  const line = (shape: Shape) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(shape));
    if (String(curve.GetType()) !== "GeomAbs_Line") return null;
    const d = curve.EvalD1(curve.FirstParameter());
    const length = d.D1.Magnitude() || 1;
    const direction: Vec3 = [d.D1.X() / length, d.D1.Y() / length, d.D1.Z() / length];
    return { point: xyz(d.Point), direction };
  };
  const [p, q] = [line(edge), line(moved)];
  if (!p || !q) return ruledFace(oc, edge, moved);
  const cross = (u: Vec3, v: Vec3): Vec3 => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const gap: Vec3 = [q.point[0] - p.point[0], q.point[1] - p.point[1], q.point[2] - p.point[2]];
  let normal = cross(p.direction, q.direction);
  if (Math.hypot(...normal) < 1e-9) normal = cross(p.direction, gap);
  const size = Math.hypot(...normal);
  if (size < 1e-12) return "NONE";
  const unit: Vec3 = [normal[0] / size, normal[1] / size, normal[2] / size];
  if (Math.abs(dot(gap, unit)) > 1e-9) return ruledFace(oc, edge, moved);
  return planeAround(oc, { origin: p.point, normal: unit }, around);
}

/** The ruled face between two edges, such as an edge and where it moved; null if it can't be made. */
function ruledFace(oc: Oc, from: Shape, to: Shape): Shape | null {
  try {
    const loft = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    for (const edge of [from, to])
      loft.AddWire(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(edge)).Wire());
    loft.Build(new oc.Message_ProgressRange());
    return loft.IsDone() ? (subShapes(oc, loft.Shape(), "FACE")[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * A square face on `plane` big enough to cross all of `shapes`, centered where their middle
 * projects onto it: a plane cut as an unbounded plane, wherever its origin is.
 */
export function planeAround(
  oc: Oc,
  plane: { readonly origin: Vec3; readonly normal: Vec3 },
  shapes: readonly Shape[],
): Shape {
  const bounds = new oc.Bnd_Box();
  for (const shape of shapes) oc.BRepBndLib.Add(shape, bounds, false);
  const middle: Vec3 = bounds.IsVoid()
    ? plane.origin
    : [
        (bounds.GetXMin() + bounds.GetXMax()) / 2,
        (bounds.GetYMin() + bounds.GetYMax()) / 2,
        (bounds.GetZMin() + bounds.GetZMax()) / 2,
      ];
  const n = plane.normal;
  const off = dot(
    [middle[0] - plane.origin[0], middle[1] - plane.origin[1], middle[2] - plane.origin[2]],
    n,
  );
  const center: Vec3 = [middle[0] - off * n[0], middle[1] - off * n[1], middle[2] - off * n[2]];
  const size = 4 * (bounds.IsVoid() ? 1 : Math.sqrt(bounds.SquareExtent())) + 1e-3;
  return new oc.BRepBuilderAPI_MakeFace(
    new oc.gp_Pln(new oc.gp_Pnt(...center), new oc.gp_Dir(...n)),
    -size / 2,
    size / 2,
    -size / 2,
    size / 2,
  ).Face();
}

/**
 * The wall closing a thickened face along one of its edges, from `a` (on the inner surface) to
 * `b` (its counterpart on the outer one): an annulus between two concentric full circles, a flat
 * strip when the pair lies in a plane, else the ruled face between them. Null if none can be made.
 */
function wallAlong(oc: Oc, a: Shape, b: Shape): Shape | null {
  const closed = (edge: Shape) => oc.BRep_Tool.IsClosed(oc.TopoDS.Edge(edge));
  const wireOf = (...edges: Shape[]) => {
    const wire = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of edges) wire.Add(oc.TopoDS.Edge(edge));
    return wire.IsDone() ? wire.Wire() : null;
  };
  if (closed(a) && closed(b)) {
    const [wa, wb] = [wireOf(a), wireOf(b)];
    if (!wa || !wb) return null;
    const flat = (wire: Shape) => new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(wire), true);
    const [fa, fb] = [flat(wa), flat(wb)];
    if (!fa.IsDone() || !fb.IsDone()) return ruledFace(oc, a, b);
    const area = (face: Shape) => {
      const props = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(face, props, false, false);
      return props.Mass();
    };
    const [outer, hole, holeEdge] = area(fa.Face()) > area(fb.Face()) ? [fa, wb, b] : [fb, wa, a];
    // Both circles must lie in the outer one's plane for a flat ring.
    if (edgePoints(oc, holeEdge, 5).some((p) => normalNear(oc, outer.Face(), p).distance > 1e-7))
      return ruledFace(oc, a, b);
    // The hole must run against the outer circle; the ring's area says which way it does.
    const expected = Math.abs(area(fa.Face()) - area(fb.Face()));
    for (const sense of [hole.Reversed(), hole]) {
      const ring = new oc.BRepBuilderAPI_MakeFace(outer.Face());
      ring.Add(oc.TopoDS.Wire(sense));
      if (ring.IsDone() && Math.abs(area(ring.Face()) - expected) <= 1e-9 * expected)
        return ring.Face();
    }
    return null;
  }
  if (closed(a) || closed(b)) return null;
  const ends = (edge: Shape) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    return [xyz(curve.Value(curve.FirstParameter())), xyz(curve.Value(curve.LastParameter()))];
  };
  const [[a0, a1], [b0, b1]] = [ends(a), ends(b)];
  const far = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  // Pair each end of `a` with the nearer end of `b`.
  const [c0, c1] =
    far(a0!, b0!) + far(a1!, b1!) <= far(a0!, b1!) + far(a1!, b0!) ? [b0!, b1!] : [b1!, b0!];
  const line = (p: Vec3, q: Vec3) =>
    new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(...p), new oc.gp_Pnt(...q)).Edge();
  const wire = wireOf(a, line(a1!, c1), b, line(c0, a0!));
  const strip = wire && new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(wire), true);
  return strip?.IsDone() ? strip.Face() : ruledFace(oc, a, b);
}

/**
 * The solid `face` sweeps from `back` behind it to `front` in front of it, along its normals:
 * between the face's two offsets (analytic for planes, cylinders and spheres), closed along each
 * of its edges by {@link wallAlong} (no slit across a whole cylinder's ends). Null when an offset,
 * a wall or the closed solid can't be made.
 */
export function thickenFace(oc: Oc, face: Shape, front: number, back: number): Shape | null {
  try {
    return thickened(oc, face, front, back);
  } catch {
    return null;
  }
}

function thickened(oc: Oc, face: Shape, front: number, back: number): Shape | null {
  const inner = back ? offsetFace(oc, face, -back) : copyShape(oc, face);
  const outer = front ? offsetFace(oc, face, front) : copyShape(oc, face);
  if (!inner || !outer) return null;
  const seams = seamEdges(oc, face);
  const walls: Shape[] = [];
  for (const edge of subShapes(oc, face, "EDGE")) {
    if (seams.has(edge) || oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge))) continue;
    const middle = edgePoints(oc, edge, 3)[1]!;
    const n = normalNear(oc, face, middle).normal;
    // The edge's counterpart on an offset face: the one through its middle moved along the normal.
    const on = (offset: Shape, by: number) => {
      const point: Vec3 = [middle[0] + n[0] * by, middle[1] + n[1] * by, middle[2] + n[2] * by];
      const probe = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();
      return subShapes(oc, offset, "EDGE").find((e) => distance(oc, probe, e) < 1e-7);
    };
    const [a, b] = [on(inner, -back), on(outer, front)];
    const wall = a && b ? wallAlong(oc, a, b) : null;
    if (!wall) return null;
    walls.push(wall);
  }
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  // The inner face bounds the solid from behind, so it faces back.
  for (const piece of [inner.Reversed(), outer, ...walls]) sewing.Add(piece);
  sewing.Perform(new oc.Message_ProgressRange());
  const shell = subShapes(oc, sewing.SewedShape(), "SHELL")[0];
  if (!shell) return null;
  // Sewing joins the faces but leaves each facing as it was made; ShapeFix turns them consistently
  // outward.
  const fix = new oc.ShapeFix_Solid();
  const solid = fix.SolidFromShell(oc.TopoDS.Shell(shell));
  return new oc.BRepCheck_Analyzer(solid, true, false).IsValid() && volumeOf(oc, solid) > 0
    ? solid
    : null;
}

/**
 * Why a shrink has no result: walls deeper than half the body's thickness everywhere leave nothing
 * inside, which Onshape fails too.
 */
export type Shrink = "no cavity";

/**
 * `solid` offset `by` along its outward normals as a whole (negative shrinks it), the faces meeting
 * at sharp edges as Parasolid's offsets do; null when it can't be built right. OpenCascade's offset
 * goes wrong in ways its own check passes (faces turned inside out, 1 mm tolerances on a thin slab,
 * a corner rounded), so it's held to the definition (see {@link offsetCheck}) and, when it fails,
 * built again by the face rebuild with every face moved. "no cavity" when walls that deep leave
 * nothing inside.
 */
function offsetSolid(oc: Oc, solid: Shape, by: number): Shape | Shrink | null {
  const made = kernelOffset(oc, solid, by);
  const judged = made && offsetCheck(oc, solid, made, by);
  if (judged !== null && judged !== "wrong") return judged;
  const changes = subShapes(oc, solid, "FACE").map((face) => ({
    face,
    moved: offsetFace(oc, face, by),
  }));
  if (changes.some((change) => !change.moved)) return null;
  const rebuilt = rebuildSolid(
    oc,
    solid,
    changes.flatMap(({ face, moved }) => (moved ? [{ face, moved }] : [])),
  );
  const again = rebuilt.ok ? offsetCheck(oc, solid, rebuilt.shape, by) : null;
  return again === "wrong" ? null : again;
}

/** OpenCascade's offset of `solid` by `by` with intersected joins, as a solid; null if it fails. */
function kernelOffset(oc: Oc, solid: Shape, by: number): Shape | null {
  try {
    const offset = new oc.BRepOffsetAPI_MakeOffsetShape();
    offset.PerformByJoin(
      solid,
      by,
      1e-7,
      oc.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      oc.GeomAbs_JoinType.GeomAbs_Intersection,
      false,
      new oc.Message_ProgressRange(),
    );
    if (!offset.IsDone()) return null;
    const made = offset.Shape();
    // A body with curved faces comes back as a shell.
    const shell = subShapes(oc, made, "SHELL")[0];
    return (
      subShapes(oc, made, "SOLID")[0] ??
      (shell ? new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell)).Solid() : null)
    );
  } catch {
    return null;
  }
}

/** `shape` (one solid) oriented outward when it then passes the full check within `tolerance`. */
function orientedValid(oc: Oc, shape: Shape, tolerance: number): Shape | null {
  const solids = subShapes(oc, shape, "SOLID");
  if (solids.length !== 1) return null;
  oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(solids[0]!));
  return new oc.BRepCheck_Analyzer(solids[0]!, true, false).IsValid() &&
    loosestTolerance(oc, solids[0]!) <= tolerance
    ? solids[0]!
    : null;
}

/** How near a point must be to lie on a surface, or how much nearer than a wall's thickness. */
const OFFSET_TOLERANCE = 1e-6;

/**
 * The loosest tolerance a shell, offset or thicken may leave beyond its input's own, in meters.
 * The face rebuild leaves 1.5e-7, OpenCascade's offsets 1e-6, and 1.01e-5 where they meet lofted
 * (B-spline) faces. OpenCascade also glues edges a wall's thickness apart with tolerances of 0.05
 * to 0.5 mm that its check passes: across a slot, at a cone's closed tip, along a rib.
 */
export const TIGHT_TOLERANCE = 2e-5;

/** A face prepared for offset checks: its box grown by a margin, and its plane when it's flat. */
interface Reach {
  readonly face: Shape;
  readonly box: InstanceType<Oc["Bnd_Box"]>;
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3 } | null;
}

function reaches(oc: Oc, faces: readonly Shape[], margin: number): Reach[] {
  return faces.map((face) => {
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(face, box, false);
    box.Enlarge(margin);
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
    if (String(surface.GetType()) !== "GeomAbs_Plane") return { face, box, plane: null };
    // The plane's own axis can point either way (a left-handed frame); the derivatives can't.
    const { UMin, VMin } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
    const origin = xyz(surface.Plane().Location());
    return { face, box, plane: { origin, normal: normalAtUV(oc, face, UMin, VMin) } };
  });
}

/** Signed distance from `point` to the whole surface of `reach`'s face, positive outward. */
function surfaceGap(oc: Oc, reach: Reach, point: Vec3): number {
  if (reach.plane) return dot(sub(point, reach.plane.origin), reach.plane.normal);
  const { normal, nearest, distance: gap } = normalNear(oc, reach.face, point);
  return dot(sub(point, nearest), normal) < 0 ? -gap : gap;
}

/** True when all of `points` lie `at` (signed, outward positive) from one of `sources`' surfaces. */
function offsetOfOne(oc: Oc, sources: readonly Reach[], points: readonly Vec3[], at: number) {
  const first = new oc.gp_Pnt(...points[0]!);
  return sources.some(
    (source) =>
      !source.box.IsOut(first) &&
      points.every((point) => Math.abs(surfaceGap(oc, source, point) - at) <= OFFSET_TOLERANCE),
  );
}

/** True when one of `points` is nearer than `depth` to one of `walls`: a wall thinner than that. */
function thinWall(oc: Oc, walls: readonly Reach[], points: readonly Vec3[], depth: number) {
  return points.some((point) => nearWall(oc, walls, point, depth));
}

/** True when `point` is nearer than `depth` to one of `walls`. */
function nearWall(oc: Oc, walls: readonly Reach[], point: Vec3, depth: number): boolean {
  const at = new oc.gp_Pnt(...point);
  const probe = new oc.BRepBuilderAPI_MakeVertex(at).Vertex();
  return walls.some((wall) => {
    if (wall.box.IsOut(at)) return false;
    // A face is no nearer than its plane.
    const plane = wall.plane;
    if (plane && Math.abs(dot(sub(point, plane.origin), plane.normal)) >= depth - OFFSET_TOLERANCE)
      return false;
    return distance(oc, probe, wall.face) < depth - OFFSET_TOLERANCE;
  });
}

/**
 * True when cone `face` runs through its tip into the other half of the double cone, where the
 * cone offset past its tip (a cavity that closes short of a narrow opening) touches itself at a
 * point. Each end of the face's span lies on the same side of the axis as the other unless it
 * does.
 */
function throughApex(oc: Oc, face: Shape): boolean {
  if (surfaceType(oc, face) !== "Cone") return false;
  const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
  const { UMin, VMin, VMax } = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
  // Away from the axis at `v`: from the axis (midway across the cone) to the surface.
  const radial = (v: number): Vec3 => {
    const [near, far] = [xyz(surface.Value(UMin, v)), xyz(surface.Value(UMin + Math.PI, v))];
    return sub(near, scale([near[0] + far[0], near[1] + far[1], near[2] + far[2]], 0.5));
  };
  return dot(radial(VMin), radial(VMax)) < 0;
}

/** True when `point` lies on one of `faces` (within the offset tolerance). */
function onAny(oc: Oc, faces: readonly Reach[], point: Vec3): boolean {
  const at = new oc.gp_Pnt(...point);
  const probe = new oc.BRepBuilderAPI_MakeVertex(at).Vertex();
  return faces.some(
    (face) =>
      !face.box.IsOut(at) &&
      !(
        face.plane &&
        Math.abs(dot(sub(point, face.plane.origin), face.plane.normal)) > OFFSET_TOLERANCE
      ) &&
      distance(oc, probe, face.face) <= OFFSET_TOLERANCE,
  );
}

/**
 * The first of `sources` whose offset by `by` is missing from `made` (faces of the offset): a point
 * spread over it moved `by` along its normal is still |by| from every source face, so the offset's
 * boundary must pass through it, and doesn't. Where a neighbour is nearer (a thin wall, a step
 * shorter than the walls are thick) the face's offset is consumed, which is fine.
 */
function missingOffset(
  oc: Oc,
  sources: readonly Reach[],
  made: readonly Reach[],
  by: number,
): Shape | null {
  const depth = Math.abs(by);
  for (const source of sources)
    for (const point of facePoints(oc, source.face)) {
      const normal = source.plane?.normal ?? normalNear(oc, source.face, point).normal;
      const moved = sub(point, scale(normal, -by));
      if (!thinWall(oc, sources, [moved], depth) && !onAny(oc, made, moved)) return source.face;
    }
  return null;
}

/**
 * Whether `made` is `solid` offset `by` (negative inward) with sharp joins, as Parasolid's offsets
 * meet: points spread over each of its faces lie exactly `by` from one face's surface of `solid`
 * (its surface, not the body's boundary: past a concave edge a sharp join is up to |by| sqrt 2 from
 * that), none is nearer than |by| to any face of `solid` (no wall thinner than that), every face
 * of `solid` whose offset has room is there, and its tolerances are tight. Inward, every point too
 * near (or no point to probe: faces turned inside out), or no volume, is "no cavity"; anything else
 * off is "wrong". A right one comes back oriented.
 */
function offsetCheck(oc: Oc, solid: Shape, made: Shape, by: number): Shape | Shrink | "wrong" {
  try {
    if (by < 0 && volumeOf(oc, made) <= 0) return "no cavity";
    const depth = Math.abs(by);
    const sources = reaches(oc, subShapes(oc, solid, "FACE"), depth + OFFSET_TOLERANCE);
    const probes = subShapes(oc, made, "FACE").map((face) => {
      const points = facePoints(oc, face);
      const near = points.filter((point) => nearWall(oc, sources, point, depth)).length;
      return { points, thin: points.length === 0 || near > 0, crossed: near === points.length };
    });
    // Nothing left inside only when every point of every face is too near (or can't be probed):
    // one face of an offset gone wrong at a collapsed blend can't show that.
    if (by < 0 && probes.every(({ crossed }) => crossed)) return "no cavity";
    if (probes.some(({ points, thin }) => thin || !offsetOfOne(oc, sources, points, by)))
      return "wrong";
    if (subShapes(oc, made, "FACE").some((face) => throughApex(oc, face))) return "wrong";
    if (missingOffset(oc, sources, reaches(oc, subShapes(oc, made, "FACE"), OFFSET_TOLERANCE), by))
      return "wrong";
    return (
      orientedValid(oc, made, Math.max(TIGHT_TOLERANCE, loosestTolerance(oc, solid))) ?? "wrong"
    );
  } catch {
    return "wrong";
  }
}

/**
 * True when some point inside `solid` lies deeper than `depth` from all of `walls` (its faces the
 * shell keeps): room for a cavity. Searched from points spread over the walls, stepping in along
 * each normal while still inside `solid`. An offset gone wrong (a cone pushed up to its tip, a
 * collapsed blend) can look as if nothing is left inside, which Onshape only fails when it's so.
 */
function cavityFits(oc: Oc, solid: Shape, walls: readonly Shape[], depth: number): boolean {
  const boundary = compoundOf(oc, subShapes(oc, solid, "SHELL"));
  const kept = compoundOf(oc, walls);
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(solid, box, false);
  const span = box.CornerMin().Distance(box.CornerMax());
  for (const wall of walls)
    for (const point of facePoints(oc, wall, 3)) {
      const normal = normalNear(oc, wall, point).normal;
      for (const step of [1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24]) {
        if (step * depth > span) break;
        const at = sub(point, scale(normal, step * depth));
        const inside = insideBy(oc, boundary, at);
        if (inside === null) continue;
        if (inside < 0) break;
        const probe = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...at)).Vertex();
        if (distance(oc, probe, kept) > depth + OFFSET_TOLERANCE) return true;
      }
    }
  return false;
}

/**
 * How far `point` is inside `boundary` (a solid's shells), negative outside: by the outward
 * normal of the face nearest it. Null when the nearest point is on an edge, where that's unclear.
 */
function insideBy(oc: Oc, boundary: Shape, point: Vec3): number | null {
  const extrema = new oc.BRepExtrema_DistShapeShape();
  extrema.LoadS1(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex());
  extrema.LoadS2(boundary);
  extrema.Perform(new oc.Message_ProgressRange());
  if (!extrema.IsDone() || extrema.NbSolution() === 0) return null;
  for (let n = 1; n <= extrema.NbSolution(); n++) {
    const support = extrema.SupportOnShape2(n);
    if (shapeKind(support) !== "FACE") continue;
    const nearest = xyz(extrema.PointOnShape2(n));
    const { normal } = normalNear(oc, support, nearest);
    return dot(sub(point, nearest), normal) < 0 ? extrema.Value() : -extrema.Value();
  }
  return null;
}

/**
 * Whether `result` is `body` shelled `thickness` thick (negative inward) open at `removed`, with
 * sharp joins: each face lies on the surface of one of `body`'s faces (a kept face, or the rim in a
 * removed face's plane) or is a sharp-join offset of a kept face no nearer than the thickness to any
 * (see {@link offsetCheck}), and the tolerances are tight. OpenCascade's own shell rounds concave
 * joins with cylinders about the edges, which are no face's offset. "wrong" when it isn't such a
 * shell; otherwise the first kept face whose offset is nowhere in it (`consumed`), or null. A face
 * between a convex and a concave edge only shifts (a step's riser runs on below the step), but one
 * whose offset is gone is on a feature, or faces a gap, narrower than two walls.
 */
export function shellCheck(
  oc: Oc,
  body: Shape,
  removed: readonly Shape[],
  thickness: number,
  result: Shape,
): "wrong" | { readonly consumed: Shape | null } {
  const depth = Math.abs(thickness);
  if (loosestTolerance(oc, result) > Math.max(TIGHT_TOLERANCE, loosestTolerance(oc, body)))
    return "wrong";
  const all = reaches(oc, subShapes(oc, body, "FACE"), depth + OFFSET_TOLERANCE);
  const kept = all.filter(({ face }) => !removed.some((gone) => gone.IsSame(face)));
  const made = reaches(oc, subShapes(oc, result, "FACE"), OFFSET_TOLERANCE);
  const points = made.map(({ face }) => facePoints(oc, face));
  const shaped = made.every(({ face }, i) => {
    const at = points[i]!;
    if (at.length === 0 || throughApex(oc, face)) return false;
    if (offsetOfOne(oc, all, at, 0)) return true;
    return offsetOfOne(oc, kept, at, thickness) && !thinWall(oc, kept, at, depth);
  });
  if (!shaped || missingOffset(oc, kept, made, thickness)) return "wrong";
  const consumed = kept.find(
    (source) =>
      !made.some(
        ({ box }, i) =>
          !box.IsOut(source.box) &&
          points[i]!.every(
            (point) => Math.abs(surfaceGap(oc, source, point) - thickness) <= OFFSET_TOLERANCE,
          ),
      ),
  );
  return { consumed: consumed?.face ?? null };
}

/**
 * `solid` shelled to walls `thickness` thick (negative inward, positive outward, as std passes
 * it), open where `removed` faces were and hollow when none are. Inward, the cavity is the solid
 * with each removed face pushed out two walls past its place by the face rebuild, then offset
 * inward, so the inner walls run along their own surfaces through the opening; it's cut from the
 * solid. Outward, the kept faces are offset out (the rim stays on the removed faces' planes) and
 * the solid, its removed faces pushed out, is cut from that. Null when a step can't be built
 * right; "no cavity" when inward walls that thick leave no room anywhere (Onshape fails then too).
 */
export function shellSolid(
  oc: Oc,
  solid: Shape,
  removed: readonly Shape[],
  thickness: number,
): { shape: Shape; history: History } | Shrink | null {
  const t = Math.abs(thickness);
  // "no cavity" only when no point of the body is deeper than the walls from the faces it keeps.
  const noCavity = () =>
    cavityFits(
      oc,
      solid,
      subShapes(oc, solid, "FACE").filter((face) => !removed.some((gone) => gone.IsSame(face))),
      t,
    )
      ? null
      : ("no cavity" as const);
  // `of` with each removed face (found on it by `surface`) moved out by `by`.
  const opened = (of: Shape, surface: (face: Shape) => Shape | null, by: number) => {
    if (removed.length === 0) return { shape: of, history: null };
    const changes = removed.map((face) => {
      const target = surface(face);
      const own = target && subShapes(oc, of, "FACE").find((f) => sameSurface(oc, f, target));
      const moved = own && offsetFace(oc, own, by);
      return own && moved ? { face: own, moved } : null;
    });
    if (changes.some((change) => change === null)) return null;
    const pushed = rebuildSolid(
      oc,
      of,
      changes.filter((change) => change !== null),
    );
    return pushed.ok ? { shape: pushed.shape, history: pushed.history } : null;
  };
  if (thickness < 0) {
    // The removed faces go out first, so a plate thinner than two walls doesn't fold up across
    // its thickness; the cavity then reaches `t` past the opening.
    const pushed = opened(solid, (face) => face, 2 * t);
    const offset = pushed && offsetSolid(oc, pushed.shape, thickness);
    if (offset === "no cavity") return noCavity();
    // Else the whole body offset in first and its opening pushed out (OpenCascade's offset of an
    // enclosure with rounded edges pushed open comes back with a face running off to infinity).
    const cavity =
      offset ??
      (() => {
        if (removed.length === 0) return null;
        const inner = offsetSolid(oc, solid, thickness);
        if (!inner || inner === "no cavity") return null;
        return opened(inner, (face) => offsetFace(oc, face, thickness), 2 * t)?.shape ?? null;
      })();
    const cut = cavity && fillAndCut(oc, solid, [], [cavity]);
    if (!cut) return null;
    // Walls as thick as the body under the opening leave the cavity outside it.
    return volumeOf(oc, cut.shape) < volumeOf(oc, solid) * (1 - 1e-9) ? cut : noCavity();
  }
  const kept = subShapes(oc, solid, "FACE").filter(
    (face) => !removed.some((gone) => gone.IsSame(face)),
  );
  const outer = removed.length
    ? (() => {
        const changes = kept.map((face) => ({ face, moved: offsetFace(oc, face, t) }));
        if (changes.some((change) => !change.moved)) return null;
        const grown = rebuildSolid(oc, solid, changes);
        return grown.ok ? grown.shape : null;
      })()
    : offsetSolid(oc, solid, t);
  if (outer === "no cavity") return null;
  const cavity = outer && opened(solid, (face) => face, t);
  if (!outer || !cavity) return null;
  const cut = fillAndCut(oc, outer, [], [cavity.shape]);
  if (!cut) return null;
  // The solid's own faces end up inside, through the cavity.
  return {
    shape: cut.shape,
    history: cavity.history ? chainHistory(cavity.history, cut.history) : cut.history,
  };
}

/**
 * `solid` without `faces`, the gap closed by flat faces: one per outer boundary loop, with the
 * loops inside it on its plane as holes. Null when a loop isn't planar. Kept faces stay the same
 * shapes, so their ids carry over unchanged.
 */
export function capSolid(oc: Oc, solid: Shape, faces: readonly Shape[]): Shape | null {
  const removed = new ShapeSet<true>(oc);
  for (const face of faces) removed.set(face, true);
  const kept = subShapes(oc, solid, "FACE").filter((face) => !removed.has(face));
  const incidence = edgeFaces(oc, kept);
  const shell = shellOf(oc, kept);
  const seams = seamEdges(oc, shell);
  const free = subShapes(oc, shell, "EDGE").filter(
    (edge) =>
      (incidence.get(edge) ?? []).length === 1 &&
      !seams.has(edge) &&
      !oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge)),
  );
  const loops: { edges: Shape[]; wire: Shape; face: Shape; area: number }[] = [];
  for (const edges of edgeLoops(oc, free)) {
    const wire = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of edges) wire.Add(oc.TopoDS.Edge(edge));
    if (!wire.IsDone()) return null;
    const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true);
    if (!face.IsDone()) return null;
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face.Face(), props, false, false);
    loops.push({ edges, wire: wire.Wire(), face: face.Face(), area: props.Mass() });
  }
  // A loop lying inside another's flat face (same plane) is a hole in that cap; nesting alternates
  // caps and holes, so one cap per outer loop.
  const containers = loops.map((loop) => {
    const probe = new oc.BRepBuilderAPI_MakeVertex(
      new oc.gp_Pnt(...edgePoints(oc, loop.edges[0]!, 3)[1]!),
    ).Vertex();
    return loops
      .filter((other) => other !== loop && other.area > loop.area)
      .filter((other) => distance(oc, probe, other.face) < 1e-7)
      .sort((a, b) => a.area - b.area);
  });
  const caps: Shape[] = [];
  loops.forEach((loop, i) => {
    if (containers[i]!.length % 2 === 1) return;
    const holes = loops.filter(
      (_, j) => containers[j]!.length === containers[i]!.length + 1 && containers[j]![0] === loop,
    );
    let cap = loop.face;
    if (holes.length) {
      const holed = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Face(loop.face));
      for (const hole of holes) holed.Add(oc.TopoDS.Wire(hole.wire));
      // The holes' wires must run against the outer one; ShapeFix sets their orientation.
      const fix = new oc.ShapeFix_Face(holed.Face());
      fix.Perform(new oc.Message_ProgressRange());
      cap = fix.Face();
    }
    // In a closed shell each edge runs opposite ways in its two faces; the wire alone doesn't
    // say which way round the cap faces.
    const sense = (face: Shape) =>
      String(
        subShapes(oc, face, "EDGE")
          .find((edge) => edge.IsSame(loop.edges[0]!))
          ?.Orientation(),
      );
    const neighbor = incidence.get(loop.edges[0]!)?.[0];
    caps.push(neighbor && sense(neighbor) === sense(cap) ? cap.Reversed() : cap);
  });
  if (caps.length === 0) return null;
  const capped = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shellOf(oc, [...kept, ...caps])));
  if (!capped.IsDone()) return null;
  const result = capped.Solid();
  oc.BRepLib.OrientClosedSolid(result);
  return new oc.BRepCheck_Analyzer(result, true, false).IsValid() ? result : null;
}

/** Splits edges into closed loops, each in order end to end. */
function edgeLoops(oc: Oc, edges: readonly Shape[]): Shape[][] {
  const remaining = [...edges];
  const loops: Shape[][] = [];
  const ends = (edge: Shape) => subShapes(oc, edge, "VERTEX");
  while (remaining.length) {
    const loop = remaining.splice(0, 1);
    for (;;) {
      const tips = ends(loop.at(-1)!);
      const next = remaining.findIndex((edge) =>
        ends(edge).some((vertex) => tips.some((tip) => tip.IsSame(vertex))),
      );
      if (next < 0) break;
      loop.push(...remaining.splice(next, 1));
    }
    loops.push(loop);
  }
  return loops;
}

/** History of an operation that dropped `removed` and kept everything else as it was. */
export function removalHistory(oc: Oc, removed: readonly Shape[]): History {
  const gone = new ShapeSet<true>(oc);
  for (const shape of removed) gone.set(shape, true);
  return { deleted: (shape) => gone.has(shape), modified: () => [], generated: () => [] };
}

/** Flat faces covering where `shapes` (faces) lie on one plane, merged where they overlap or touch. */
export function mergedPlanarFaces(oc: Oc, faces: readonly Shape[]): Shape[] {
  if (faces.length <= 1) return [...faces];
  const fuse = new oc.BRepAlgoAPI_Fuse();
  fuse.SetNonDestructive(true);
  fuse.SetArguments(toList(oc, [faces[0]!]));
  fuse.SetTools(toList(oc, faces.slice(1)));
  fuse.Build(new oc.Message_ProgressRange());
  if (fuse.HasErrors()) return [];
  fuse.SimplifyResult(true, true, 1e-9);
  return subShapes(oc, fuse.Shape(), "FACE");
}
