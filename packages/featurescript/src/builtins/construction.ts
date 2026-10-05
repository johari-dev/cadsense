import { addBodies, type Frame } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { untag, type FsValue } from "../runtime/Value.ts";
import { array, map, number } from "./args.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { stdCoordSystem } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Construction geometry (planes, points, mate connectors), fit splines, and primitive solids std builds directly. */

/** std's `Plane` value: origin, unit normal, unit x direction. */
export function planeOf(
  call: BuiltinCall,
  value: FsValue,
  what: string,
): { origin: Vec3; normal: Vec3; x: Vec3 } {
  const plane = map(call, value, what);
  return {
    origin: vector(call, plane.getField("origin"), 3, `${what}.origin`),
    normal: normalized(vector(call, plane.getField("normal"), 3, `${what}.normal`)),
    x: normalized(vector(call, plane.getField("x"), 3, `${what}.x`)),
  };
}

/** A rectangular face on `plane`, centered on its origin, `width` along x and `height` along y. */
export function planeFace(
  oc: Oc,
  plane: { origin: Vec3; normal: Vec3; x: Vec3 },
  width: number,
  height: number,
): Shape {
  const axes = new oc.gp_Ax3(
    new oc.gp_Pnt(...plane.origin),
    new oc.gp_Dir(...plane.normal),
    new oc.gp_Dir(...plane.x),
  );
  return new oc.BRepBuilderAPI_MakeFace(
    new oc.gp_Pln(axes),
    -width / 2,
    width / 2,
    -height / 2,
    height / 2,
  ).Face();
}

// std's construction plane feature falls back to 1 m when it has nothing to size the plane by.
const DEFAULT_PLANE_SIZE = 1;

export const CONSTRUCTION_BUILTINS = {
  opPlane: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const size = (field: string) =>
      definition.getField(field) === undefined
        ? DEFAULT_PLANE_SIZE
        : magnitude(call, definition.getField(field), field);
    const face = planeFace(
      oc,
      planeOf(call, definition.getField("plane"), "plane"),
      size("width"),
      size("height"),
    );
    model.geometry = addBodies(oc, model.geometry, [
      { shape: face, bodyType: "SHEET", createdBy: idOf(id), construction: true },
    ]).state;
    return undefined;
  },

  opPoint: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const point = vector(call, definition.getField("point"), 3, "point");
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...point)).Vertex();
    model.geometry = addBodies(oc, model.geometry, [
      { shape: vertex, bodyType: "POINT", createdBy: idOf(id), construction: true },
    ]).state;
    return undefined;
  },

  /**
   * A cubic spline through `points`, as a wire body with one edge. The parameter runs over [0, 1],
   * spaced by chord length unless `parameters` are given, so derivatives (lengths per unit parameter)
   * mean what std documents. A repeated first point closes it.
   */
  opFitSpline: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const field = (name: string) => definition.getField(name);
    if (field("start2ndDerivative") !== undefined || field("end2ndDerivative") !== undefined)
      return call.unsupported("opFitSpline second derivatives are not supported locally yet.");
    if (untag(field("hasTargetLength")) === true)
      return call.unsupported("opFitSpline with a target length is not supported locally yet.");
    let points = [...array(call, field("points"), "points")].map((point, i) =>
      vector(call, point, 3, `points[${i}]`),
    );
    const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
    const closed = points.length > 2 && same(points[0]!, points.at(-1)!);
    if (closed) points = points.slice(0, -1);
    if (points.length < 2) return call.fail("opFitSpline needs at least two points.");
    for (let i = 1; i < points.length; i++)
      if (same(points[i - 1]!, points[i]!))
        return call.fail(`opFitSpline points ${i - 1} and ${i} are the same.`);

    const given = field("parameters");
    const chords = points.map((point, i) =>
      i === 0 ? 0 : Math.hypot(...point.map((c, k) => c - points[i - 1]![k]!)),
    );
    const total = chords.reduce((sum, chord) => sum + chord, 0);
    let walked = 0;
    const parameters =
      given === undefined
        ? chords.map((chord) => (walked += chord) / total)
        : [...array(call, given, "parameters")].map((p, i) => number(call, p, `parameters[${i}]`));
    if (parameters.length !== points.length)
      return call.fail("opFitSpline needs one parameter per point.");

    const pointArray = new oc.NCollection_Array1_gp_Pnt(1, points.length);
    points.forEach((point, i) => pointArray.SetValue(i + 1, new oc.gp_Pnt(...point)));
    const interpolate = closed
      ? new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(pointArray), true, 1e-9)
      : (() => {
          const parameterArray = new oc.NCollection_Array1_double(1, points.length);
          parameters.forEach((p, i) => parameterArray.SetValue(i + 1, p));
          return new oc.GeomAPI_Interpolate(
            new oc.NCollection_HArray1_gp_Pnt(pointArray),
            new oc.NCollection_HArray1_double(parameterArray),
            false,
            1e-9,
          );
        })();

    // Derivatives by point index: the ends, and `derivatives` for points in between.
    const derivatives = new Map<number, Vec3>();
    const start = field("startDerivative");
    if (start !== undefined) derivatives.set(0, vector(call, start, 3, "startDerivative"));
    const end = field("endDerivative");
    if (end !== undefined && !closed)
      derivatives.set(points.length - 1, vector(call, end, 3, "endDerivative"));
    const inner = field("derivatives");
    if (inner !== undefined)
      for (const [key, derivative] of map(call, inner, "derivatives").entries()) {
        const index = number(call, key, "derivatives key");
        if (!Number.isInteger(index) || index < 1 || index > points.length - 2)
          return call.fail(`opFitSpline derivatives key ${index} is not an inner point.`);
        derivatives.set(index, vector(call, derivative, 3, `derivatives[${index}]`));
      }
    if (derivatives.size > 0) {
      const tangents = new oc.NCollection_Array1_gp_Vec(1, points.length);
      const flags = new oc.NCollection_Array1_bool(1, points.length);
      for (let i = 0; i < points.length; i++) {
        const derivative = derivatives.get(i);
        tangents.SetValue(i + 1, new oc.gp_Vec(...(derivative ?? [0, 0, 0])));
        flags.SetValue(i + 1, derivative !== undefined);
      }
      interpolate.Load(tangents, new oc.NCollection_HArray1_bool(flags), false);
    }
    interpolate.Perform();
    if (!interpolate.IsDone())
      return call.fail("opFitSpline couldn't fit a spline through the points.");
    const edge = new oc.BRepBuilderAPI_MakeEdge(interpolate.Curve()).Edge();
    const wire = new oc.BRepBuilderAPI_MakeWire(edge).Wire();
    model.geometry = addBodies(oc, model.geometry, [
      { shape: wire, bodyType: "WIRE", createdBy: idOf(id) },
    ]).state;
    return undefined;
  },

  /** A mate connector: a point body at `coordSystem`'s origin that carries the coordinate system. */
  opMateConnector: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const system = map(call, definition.getField("coordSystem"), "coordSystem");
    const frame: Frame = {
      origin: vector(call, system.getField("origin"), 3, "coordSystem.origin"),
      xAxis: normalized(vector(call, system.getField("xAxis"), 3, "coordSystem.xAxis")),
      zAxis: normalized(vector(call, system.getField("zAxis"), 3, "coordSystem.zAxis")),
    };
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...frame.origin)).Vertex();
    model.geometry = addBodies(oc, model.geometry, [
      { shape: vertex, bodyType: "MATE_CONNECTOR", createdBy: idOf(id), frame },
    ]).state;
    return undefined;
  },

  evMateConnector: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    const connector = resolve(call, model, oc, definition.getField("mateConnector")).find(
      (entity) => entity.frame !== undefined,
    );
    if (!connector?.frame) return call.fail("mateConnector resolves to no mate connector.");
    return stdCoordSystem(
      call,
      connector.frame.origin,
      connector.frame.xAxis,
      connector.frame.zAxis,
    );
  },

  opSphere: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const center = vector(call, definition.getField("center"), 3, "center");
    const radius = magnitude(call, definition.getField("radius"), "radius");
    if (!(radius > 0)) return call.fail("radius must be positive.");
    const sphere = new oc.BRepPrimAPI_MakeSphere(new oc.gp_Pnt(...center), radius).Shape();
    model.geometry = addBodies(oc, model.geometry, [
      { shape: sphere, bodyType: "SOLID", createdBy: idOf(id) },
    ]).state;
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
