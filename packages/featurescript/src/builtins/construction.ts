import { addBodies } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import type { Oc, Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { FsValue } from "../runtime/Value.ts";
import { map } from "./args.ts";
import { idOf, kernel, magnitude, normalized, vector } from "./geometryArgs.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Construction geometry (planes and points) and primitive solids std builds directly. */

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
