import type { Oc, Shape } from "../geometry/occt.ts";
import type { BuiltinCall } from "../runtime/Interpreter.ts";
import { regenError } from "./std.ts";

/**
 * `shape` if OpenCascade's checker (BRepCheck_Analyzer) accepts it; otherwise raises the
 * operation's std error, so a malformed result never reaches the model as if it had worked.
 */
export function requireValid<S extends Shape>(
  call: BuiltinCall,
  oc: Oc,
  shape: S,
  error: string,
): S {
  return new oc.BRepCheck_Analyzer(shape).IsValid() ? shape : regenError(call, error);
}
