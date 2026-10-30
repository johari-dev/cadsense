import { addBodies, type GeometryState } from "./Model.ts";
import { ShapeSet, subShapes, toList, type Oc, type Shape } from "./occt.ts";

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

/** A sketch plane: origin plus orthonormal x and normal, in meters. */
export interface SketchPlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly x: Vec3;
}

export type SketchEntity =
  | {
      readonly kind: "line";
      readonly id: string;
      readonly start: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
    }
  | {
      readonly kind: "circle";
      readonly id: string;
      readonly center: Vec2;
      readonly radius: number;
      readonly construction: boolean;
    }
  | {
      readonly kind: "arc";
      readonly id: string;
      readonly start: Vec2;
      readonly mid: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
    }
  | {
      readonly kind: "point";
      readonly id: string;
      readonly position: Vec2;
      readonly construction: boolean;
    };

/** An unsolved sketch: entities in plane coordinates, added to the context by `solve`. */
export class Sketch {
  readonly id: readonly string[];
  readonly plane: SketchPlane;
  readonly entities: SketchEntity[] = [];
  solved = false;
  constructor(id: readonly string[], plane: SketchPlane) {
    this.id = id;
    this.plane = plane;
  }
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Plane coordinates to world. */
export function toWorld(plane: SketchPlane, [u, v]: Vec2): Vec3 {
  const y = cross(plane.normal, plane.x);
  return [0, 1, 2].map((i) => plane.origin[i]! + u * plane.x[i]! + v * y[i]!) as unknown as Vec3;
}

function edgeOf(
  oc: Oc,
  plane: SketchPlane,
  entity: Exclude<SketchEntity, { kind: "point" }>,
): Shape {
  const point = (p: Vec2) => new oc.gp_Pnt(...toWorld(plane, p));
  switch (entity.kind) {
    case "line":
      return new oc.BRepBuilderAPI_MakeEdge(point(entity.start), point(entity.end)).Edge();
    case "circle": {
      const axis = new oc.gp_Ax2(
        point(entity.center),
        new oc.gp_Dir(...plane.normal),
        new oc.gp_Dir(...plane.x),
      );
      return new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axis, entity.radius)).Edge();
    }
    case "arc": {
      const arc = new oc.GC_MakeArcOfCircle(
        point(entity.start),
        point(entity.mid),
        point(entity.end),
      ).Value();
      return new oc.BRepBuilderAPI_MakeEdge(arc).Edge();
    }
  }
}

function compound(oc: Oc, shapes: readonly Shape[]): Shape {
  const result = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(result);
  for (const shape of shapes) builder.Add(result, shape);
  return result;
}

/**
 * Onshape-style regions: the bounded faces that the sketch's curves cut out of the sketch plane.
 * Splits a plane face larger than the sketch by every curve and keeps faces that don't touch its rim.
 */
export function sketchRegions(
  oc: Oc,
  plane: SketchPlane,
  edges: readonly Shape[],
  extent: number,
): Shape[] {
  if (edges.length === 0) return [];
  const bound = extent * 4 + 1;
  const gpPlane = new oc.gp_Pln(
    new oc.gp_Ax3(
      new oc.gp_Pnt(...plane.origin),
      new oc.gp_Dir(...plane.normal),
      new oc.gp_Dir(...plane.x),
    ),
  );
  const sheet = new oc.BRepBuilderAPI_MakeFace(gpPlane, -bound, bound, -bound, bound).Face();
  const splitter = new oc.BRepAlgoAPI_Splitter();
  splitter.SetArguments(toList(oc, [sheet]));
  splitter.SetTools(toList(oc, edges));
  splitter.Build(new oc.Message_ProgressRange());
  if (splitter.HasErrors()) return [];
  // Faces reaching the sheet's rim are the unbounded outside, not regions.
  const touchesRim = (face: Shape) => {
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(face, box, false);
    const [x0, x1, y0, y1, z0, z1] = [
      box.GetXMin(),
      box.GetXMax(),
      box.GetYMin(),
      box.GetYMax(),
      box.GetZMin(),
      box.GetZMax(),
    ];
    const [ox, oy, oz] = plane.origin;
    return (
      Math.max(
        Math.abs(x0 - ox),
        Math.abs(x1 - ox),
        Math.abs(y0 - oy),
        Math.abs(y1 - oy),
        Math.abs(z0 - oz),
        Math.abs(z1 - oz),
      ) >
      bound * 0.99
    );
  };
  return subShapes(oc, splitter.Shape(), "FACE").filter((face) => !touchesRim(face));
}

/** Largest distance of any sketch geometry from the plane origin, for sizing the region sheet. */
function extentOf(sketch: Sketch): number {
  let extent = 0;
  const reach = ([u, v]: Vec2, pad = 0) => (extent = Math.max(extent, Math.hypot(u, v) + pad));
  for (const entity of sketch.entities) {
    if (entity.kind === "line") [entity.start, entity.end].forEach((point) => reach(point));
    else if (entity.kind === "circle") reach(entity.center, entity.radius);
    else if (entity.kind === "arc")
      [entity.start, entity.mid, entity.end].forEach((point) => reach(point));
    else reach(entity.position);
  }
  return extent;
}

/**
 * Adds a solved sketch to the context: one wire body with its curves (construction ones flagged)
 * and one sheet body with its regions, all created by the sketch's id.
 */
export function solveSketch(oc: Oc, state: GeometryState, sketch: Sketch): GeometryState {
  const curves = sketch.entities.filter(
    (entity): entity is Exclude<SketchEntity, { kind: "point" }> => entity.kind !== "point",
  );
  const edges = curves.map((entity) => ({ entity, edge: edgeOf(oc, sketch.plane, entity) }));
  const byEdge = new ShapeSet<Exclude<SketchEntity, { kind: "point" }>>(oc);
  for (const { entity, edge } of edges) byEdge.set(edge, entity);
  const sketchOrigin = (entityId: string | null) => ({ sketchId: sketch.id, entityId });
  const bodies = [];
  if (edges.length)
    bodies.push({
      shape: compound(
        oc,
        edges.map(({ edge }) => edge),
      ),
      bodyType: "WIRE" as const,
      createdBy: sketch.id,
      annotate: (shape: Shape, type: string) => {
        const entity = type === "EDGE" ? byEdge.get(shape) : undefined;
        return {
          sketch: sketchOrigin(entity?.id ?? null),
          construction: entity?.construction ?? false,
        };
      },
    });
  const regions = sketchRegions(
    oc,
    sketch.plane,
    edges.filter(({ entity }) => !entity.construction).map(({ edge }) => edge),
    extentOf(sketch),
  );
  if (regions.length)
    bodies.push({
      shape: compound(oc, regions),
      bodyType: "SHEET" as const,
      createdBy: sketch.id,
      annotate: () => ({ sketch: sketchOrigin(null) }),
    });
  for (const point of sketch.entities.filter((entity) => entity.kind === "point"))
    if (!point.construction)
      bodies.push({
        shape: new oc.BRepBuilderAPI_MakeVertex(
          new oc.gp_Pnt(...toWorld(sketch.plane, point.position)),
        ).Vertex(),
        bodyType: "POINT" as const,
        createdBy: sketch.id,
        annotate: () => ({ sketch: sketchOrigin(point.id) }),
      });
  sketch.solved = true;
  return addBodies(oc, state, bodies).state;
}
