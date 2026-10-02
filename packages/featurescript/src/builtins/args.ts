import type { BuiltinCall } from "../runtime/Interpreter.ts";
import { ModelContext } from "../runtime/ModelContext.ts";
import { FsBuiltin, FsMap, untag, type FsArray, type FsValue } from "../runtime/Value.ts";

/** Argument readers for builtins. Each raises a catchable FeatureScript error on a bad argument. */
export const number = (call: BuiltinCall, value: FsValue, what: string): number => {
  const v = untag(value);
  if (typeof v !== "number") call.fail(`${what} must be a number.`);
  return v;
};
export const integer = (
  call: BuiltinCall,
  value: FsValue,
  what: string,
  min = Number.NEGATIVE_INFINITY,
): number => {
  const v = number(call, value, what);
  if (!Number.isInteger(v) || v < min)
    call.fail(
      `${what} must be an integer${min > Number.NEGATIVE_INFINITY ? ` of at least ${min}` : ""}.`,
    );
  return v;
};
export const string = (call: BuiltinCall, value: FsValue, what: string): string => {
  const v = untag(value);
  if (typeof v !== "string") call.fail(`${what} must be a string.`);
  return v;
};
export const array = (call: BuiltinCall, value: FsValue, what: string): FsArray => {
  const v = untag(value);
  if (!Array.isArray(v)) call.fail(`${what} must be an array.`);
  return v as FsArray;
};
export const map = (call: BuiltinCall, value: FsValue, what: string): FsMap => {
  const v = untag(value);
  if (!(v instanceof FsMap)) call.fail(`${what} must be a map.`);
  return v;
};
export const context = (call: BuiltinCall, value: FsValue): ModelContext => {
  const v = untag(value);
  if (!(v instanceof FsBuiltin) || !(v.native instanceof ModelContext))
    call.fail("Expected a Context.");
  return v.native;
};
/** A finite-or-infinite number result; FeatureScript has no NaN. */
export const real = (call: BuiltinCall, value: number, what: string): number => {
  if (Number.isNaN(value)) call.fail(`${what} is not a number.`);
  return value;
};
