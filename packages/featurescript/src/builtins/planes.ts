import type { Vec3 } from "../geometry/Sketch.ts";
import type { BuiltinImpl } from "../runtime/Interpreter.ts";
import { map } from "./args.ts";
import { planeOf } from "./construction.ts";
import { stdPlane } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * The x axis Onshape gives a face's coordinate system, by the face's normal. Only the default
 * planes' orientations are known: a sketch on Top, Front or Right (or on any face facing the same
 * way) has that plane's x axis. Onshape doesn't document the rule for other normals.
 */
const CANONICAL_X: readonly { readonly normal: Vec3; readonly x: Vec3 }[] = [
  { normal: [0, 0, 1], x: [1, 0, 0] }, // Top
  { normal: [0, -1, 0], x: [1, 0, 0] }, // Front
  { normal: [1, 0, 0], x: [0, 1, 0] }, // Right
];

/** std's `TOLERANCE.zeroAngle`, in radians. */
const ZERO_ANGLE = 1e-11;

/** True when unit vectors `a` and `b` point the same way, as std's `parallelVectors` tests it. */
const sameDirection = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0 &&
  Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) <
    ZERO_ANGLE;

export const PLANE_BUILTINS = {
  /**
   * The plane of a face coplanar with `plane`: same origin and normal, canonical x axis. `newSketch`
   * uses it to orient a sketch on a face. Normals other than the default planes' stop the run.
   */
  alignCanonically: ([, args], call) => {
    const value = map(call, args, "definition").getField("plane");
    const { origin, normal } = planeOf(call, value, "plane");
    const canonical = CANONICAL_X.find((candidate) => sameDirection(candidate.normal, normal));
    if (!canonical)
      return call.unsupported(
        `alignCanonically is only supported locally for planes facing like Top, Front or Right (normal +Z, -Y or +X); this one's normal is (${normal.map((n) => Number(n.toFixed(6))).join(", ")}).`,
      );
    return stdPlane(call, origin, canonical.normal, canonical.x);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
