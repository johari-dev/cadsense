import { evaluateQuery } from "../geometry/Query.ts";
import type { Entity } from "../geometry/Model.ts";
import type { Vec2, Vec3 } from "../geometry/Sketch.ts";
import type { Oc } from "../geometry/occt.ts";
import type { BuiltinCall } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { context } from "./args.ts";
import { stdEnum, stdTagged } from "./std.ts";

/** Argument helpers shared by the geometry builtins. Lengths arrive in meters, plain or as `ValueWithUnits`. */

/** The context's model and kernel; a runtime without a kernel stops here. */
export const kernel = (call: BuiltinCall, ctx: FsValue): { model: ModelContext; oc: Oc } => {
  const model = context(call, ctx);
  if (!model.oc)
    return call.unsupported(
      "Geometry needs the OpenCascade kernel; create the runtime with FeatureScriptRuntime.withGeometry().",
    );
  return { model, oc: model.oc };
};

/** A number, or the SI magnitude of a `ValueWithUnits`. */
export const magnitude = (call: BuiltinCall, value: FsValue, what: string): number => {
  const v = untag(value);
  if (typeof v === "number") return v;
  if (v instanceof FsMap && typeof v.getField("value") === "number")
    return v.getField("value") as number;
  return call.fail(`${what} must be a number or a length.`);
};
export const vector = <N extends 2 | 3>(
  call: BuiltinCall,
  value: FsValue,
  size: N,
  what: string,
): N extends 2 ? Vec2 : Vec3 => {
  const items = untag(value);
  if (!Array.isArray(items) || items.length !== size)
    return call.fail(`${what} must be a ${size}D vector.`);
  return (items as FsArray).map((item) => magnitude(call, item, what)) as unknown as N extends 2
    ? Vec2
    : Vec3;
};
export const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** A `Query` that names one entity. */
export const transient = (call: BuiltinCall, entity: Entity) =>
  stdTagged(call, "query.fs", "Query", [
    ["queryType", stdEnum(call, "query.fs", "QueryType", "TRANSIENT")],
    ["transientId", entity.id],
  ]);

export const resolve = (call: BuiltinCall, model: ModelContext, oc: Oc, query: FsValue): Entity[] =>
  evaluateQuery(
    { oc, state: model.geometry, fail: call.fail, unsupported: call.unsupported },
    query,
  );

export const idOf = (value: FsValue): readonly string[] =>
  (untag(value) as FsArray).map((part) => String(untag(part)));
