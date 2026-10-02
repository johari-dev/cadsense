import type { BuiltinCall } from "../runtime/Interpreter.ts";
import { STD_PREFIX } from "../runtime/Modules.ts";
import { FsMap, FsTagged, type FsValue, type TypeDef } from "../runtime/Value.ts";

/** A type or enum declared in a std module, for builtins that build std values (queries, enums). */
export function stdType(call: BuiltinCall, file: string, name: string): TypeDef {
  const module = call.interpreter.loader.load(`${STD_PREFIX}${file}`);
  const slot = module.own
    .get(name)
    ?.find((entry) => entry.kind === "type" || entry.kind === "enum");
  if (!slot || (slot.kind !== "type" && slot.kind !== "enum"))
    return call.unsupported(`std ${file} has no type ${name}.`);
  return slot.def;
}

/** `EnumName.MEMBER` from a std module. */
export const stdEnum = (
  call: BuiltinCall,
  file: string,
  enumName: string,
  member: string,
): FsTagged => new FsTagged(stdType(call, file, enumName), member);

/** A map tagged with a std type, e.g. a `Query`. */
export const stdTagged = (
  call: BuiltinCall,
  file: string,
  typeName: string,
  entries: Iterable<readonly [FsValue, FsValue]>,
): FsTagged => new FsTagged(stdType(call, file, typeName), FsMap.fromEntries(entries));

/** A top-level std constant, e.g. `meter`. */
export const stdValue = (call: BuiltinCall, file: string, name: string): FsValue =>
  call.interpreter.topLevelValue(call.interpreter.loader.load(`${STD_PREFIX}${file}`), name);

/** `n * meter`, built the way std's units produce it. */
export function length(call: BuiltinCall, meters: number): FsTagged {
  const meter = stdValue(call, "units.fs", "meter") as FsTagged;
  return new FsTagged(meter.tag, (meter.value as FsMap).set("value", meters));
}

/** A `Vector` of lengths in meters, like `vector(x, y, z) * meter`. */
export const lengthVector = (
  call: BuiltinCall,
  [x, y, z]: readonly [number, number, number],
): FsTagged =>
  new FsTagged(stdType(call, "vector.fs", "Vector"), [
    length(call, x),
    length(call, y),
    length(call, z),
  ]);

/** A unitless `Vector`. */
export const unitVector = (call: BuiltinCall, v: readonly number[]): FsTagged =>
  new FsTagged(stdType(call, "vector.fs", "Vector"), [...v]);

/** Raises the error map std's builtins throw: `{ "message" : ErrorStringEnum.<name> }`. */
export const regenError = (call: BuiltinCall, name: string): never =>
  call.raise(
    FsMap.fromEntries([
      ["message", stdEnum(call, "errorstringenum.gen.fs", "ErrorStringEnum", name)],
    ]),
  );

type Vec3 = readonly [number, number, number];

/** A `ValueWithUnits` with one of std's unit constants, e.g. `AREA_UNITS`. */
export function quantity(
  call: BuiltinCall,
  value: number,
  units: "LENGTH_UNITS" | "AREA_UNITS" | "VOLUME_UNITS" | "ANGLE_UNITS",
): FsTagged {
  const meter = stdValue(call, "units.fs", "meter") as FsTagged;
  return new FsTagged(
    meter.tag,
    FsMap.fromEntries([
      ["value", value],
      ["unit", stdValue(call, "units.fs", units)],
    ]),
  );
}

/** std's `Line`: origin (lengths) and unit direction. */
export const stdLine = (call: BuiltinCall, origin: Vec3, direction: Vec3): FsTagged =>
  stdTagged(call, "curveGeometry.fs", "Line", [
    ["origin", lengthVector(call, origin)],
    ["direction", unitVector(call, direction)],
  ]);

/** std's `CoordSystem`. */
export const stdCoordSystem = (
  call: BuiltinCall,
  origin: Vec3,
  xAxis: Vec3,
  zAxis: Vec3,
): FsTagged =>
  stdTagged(call, "coordSystem.fs", "CoordSystem", [
    ["origin", lengthVector(call, origin)],
    ["xAxis", unitVector(call, xAxis)],
    ["zAxis", unitVector(call, zAxis)],
  ]);

/** std's `Plane`. */
export const stdPlane = (call: BuiltinCall, origin: Vec3, normal: Vec3, x: Vec3): FsTagged =>
  stdTagged(call, "surfaceGeometry.fs", "Plane", [
    ["origin", lengthVector(call, origin)],
    ["normal", unitVector(call, normal)],
    ["x", unitVector(call, x)],
  ]);
