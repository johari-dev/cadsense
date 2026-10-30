import init from "replicad-opencascadejs";

/**
 * OpenCascade (WASM) access. Geometry is kept in meters, the unit std passes to builtins, so builtins
 * never convert; OpenCascade's 1e-7 confusion tolerance is 0.1 µm at that scale.
 *
 * WASM objects are not freed: a preview worker is short-lived and recycled, and freeing shapes that
 * the topology registry still references would corrupt it.
 */
export type Oc = Awaited<ReturnType<typeof init>>;
export type Shape = InstanceType<Oc["TopoDS_Shape"]>;
type ShapeList = InstanceType<Oc["NCollection_List_TopoDS_Shape"]>;

let loading: Promise<Oc> | undefined;
/** Instantiates OpenCascade once per process (~100 ms warm, ~0.5 GB of WASM memory). */
export const loadOcct = (): Promise<Oc> => (loading ??= init());

export type ShapeKind = "SOLID" | "SHELL" | "FACE" | "WIRE" | "EDGE" | "VERTEX" | "COMPOUND";

/** Identity-keyed set of shapes. `IsSame` ignores orientation, like OpenCascade's shape maps. */
export class ShapeSet<T> {
  private readonly buckets = new Map<number, { shape: Shape; value: T }[]>();
  private readonly oc: Oc;
  constructor(oc: Oc) {
    this.oc = oc;
  }
  private hash(shape: Shape) {
    return this.oc.ReplicadShapeHasher.HashCode(shape, 2 ** 31 - 1);
  }
  get(shape: Shape): T | undefined {
    return this.buckets.get(this.hash(shape))?.find((entry) => entry.shape.IsSame(shape))?.value;
  }
  has(shape: Shape) {
    return this.get(shape) !== undefined;
  }
  set(shape: Shape, value: T) {
    const hash = this.hash(shape);
    const bucket = this.buckets.get(hash) ?? [];
    const existing = bucket.find((entry) => entry.shape.IsSame(shape));
    if (existing) existing.value = value;
    else bucket.push({ shape, value });
    this.buckets.set(hash, bucket);
  }
}

/** Unique sub-shapes of `kind` in `shape`, in exploration order. */
export function subShapes(oc: Oc, shape: Shape, kind: ShapeKind): Shape[] {
  const seen = new ShapeSet<true>(oc);
  const out: Shape[] = [];
  for (
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[`TopAbs_${kind}`]);
    explorer.More();
    explorer.Next()
  ) {
    const current = explorer.Current();
    if (seen.has(current)) continue;
    seen.set(current, true);
    out.push(current);
  }
  return out;
}

/** Copies an OpenCascade shape list into an array (the binding has no iterator). */
export function fromList(oc: Oc, list: ShapeList): Shape[] {
  const copy = new oc.NCollection_List_TopoDS_Shape(list);
  const out: Shape[] = [];
  while (!copy.IsEmpty()) {
    out.push(copy.First());
    copy.RemoveFirst();
  }
  return out;
}

export function toList(oc: Oc, shapes: readonly Shape[]): ShapeList {
  const list = new oc.NCollection_List_TopoDS_Shape();
  for (const shape of shapes) list.Append(shape);
  return list;
}

export const shapeKind = (shape: Shape): ShapeKind => {
  const name = String(shape.ShapeType()).replace("TopAbs_", "");
  return name as ShapeKind;
};

/** Edges that appear twice in one face (cylinder seams). Onshape's kernel has no such edges. */
export function seamEdges(oc: Oc, shape: Shape): ShapeSet<true> {
  const seams = new ShapeSet<true>(oc);
  for (const face of subShapes(oc, shape, "FACE"))
    for (const edge of subShapes(oc, face, "EDGE"))
      if (oc.BRep_Tool.IsClosed(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face))) seams.set(edge, true);
  return seams;
}

/** Point coordinates as a plain tuple. */
export const xyz = (
  point: InstanceType<Oc["gp_Pnt"]> | InstanceType<Oc["gp_Dir"]> | InstanceType<Oc["gp_Vec"]>,
): [number, number, number] => [point.X(), point.Y(), point.Z()];
