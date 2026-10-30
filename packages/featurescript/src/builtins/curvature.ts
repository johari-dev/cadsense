import type { Entity } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import { xyz, type Oc } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, FsTagged, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { cross, dot, EdgeWalk, isReversed, minus, reversedInFace, scaled, unit } from "./edges.ts";
import { kernel, magnitude, resolve, vector } from "./geometryArgs.ts";
import { stdCoordSystem, stdTagged, stdType, stdValue, unitVector } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Curvature and periodicity evaluators. Results are SI: curvatures in 1/m, as std's types say. */

interface Input {
  readonly model: ModelContext;
  readonly oc: Oc;
  readonly definition: FsMap;
}
const open = (call: BuiltinCall, ctx: FsValue, args: FsValue): Input => ({
  ...kernel(call, ctx),
  definition: map(call, args, "definition"),
});
function first(call: BuiltinCall, input: Input, field: string, type: Entity["type"]): Entity {
  const entity = resolve(call, input.model, input.oc, input.definition.getField(field)).find(
    (candidate) => candidate.type === type,
  );
  return entity ?? call.fail(`${field} resolves to no ${type.toLowerCase()}.`);
}

/** `value` meters^`power`, as std's units build it (curvature is meter^-1). */
function withMeters(call: BuiltinCall, value: number, power: number): FsTagged {
  const meter = stdValue(call, "units.fs", "meter") as FsTagged;
  return new FsTagged(
    meter.tag,
    FsMap.fromEntries([
      ["value", value],
      [
        "unit",
        new FsTagged(stdType(call, "units.fs", "UnitSpec"), FsMap.fromEntries([["meter", power]])),
      ],
    ]),
  );
}

/** std's `perpendicularVector`, for frames where the curve has no normal of its own. */
function perpendicular(call: BuiltinCall, v: Vec3): Vec3 {
  const result = call.interpreter.callFunction(stdValue(call, "vector.fs", "perpendicularVector"), [
    unitVector(call, v),
  ]);
  return (untag(result) as FsArray).map((c) => untag(c) as number) as unknown as Vec3;
}

/** The walk std's edge evaluators use: default orientation, or keeping `face` on the left. */
function edgeWalk(call: BuiltinCall, input: Input): EdgeWalk {
  const edge = first(call, input, "edge", "EDGE");
  if (input.definition.getField("face") === undefined)
    return new EdgeWalk(input.oc, edge.shape, isReversed(edge.shape), call.unsupported);
  const face = first(call, input, "face", "FACE");
  const inFace = reversedInFace(input.oc, face.shape, edge.shape);
  if (inFace === null) return call.fail("The face isn't adjacent to the edge.");
  return new EdgeWalk(input.oc, edge.shape, inFace, call.unsupported);
}
const parametersOf = (call: BuiltinCall, input: Input) =>
  array(call, input.definition.getField("parameters"), "parameters").map((t) =>
    magnitude(call, t, "parameter"),
  );
const byArcLength = (input: Input) =>
  untag(input.definition.getField("arcLengthParameterization")) !== false;

/**
 * The third derivative of a curve with respect to arc length, from its derivatives in its own
 * parameter (C', C'', C'''): d3C/ds3 = C''' u'^3 + 3 C'' u' u'' + C' u''', with u' = 1 / |C'|.
 */
function thirdArcDerivative(d1: Vec3, d2: Vec3, d3: Vec3): Vec3 {
  const speed = Math.hypot(...d1);
  const speed1 = dot(d1, d2) / speed;
  const speed2 = (dot(d2, d2) + dot(d1, d3)) / speed - dot(d1, d2) ** 2 / speed ** 3;
  const u1 = 1 / speed;
  const u2 = -speed1 / speed ** 3;
  const u3 = (-speed2 / speed ** 3 + (3 * speed1 ** 2) / speed ** 4) / speed;
  return [0, 1, 2].map(
    (i) => d3[i]! * u1 ** 3 + 3 * d2[i]! * u1 * u2 + d1[i]! * u3,
  ) as unknown as Vec3;
}

/**
 * Principal curvatures closer than this fraction of the mean curvature make a point umbilic. The
 * spread is a square root of a difference, so rounding leaves about sqrt(1e-16) of it.
 */
const UMBILIC = 1e-7;

export const CURVATURE_BUILTINS = {
  /**
   * Frenet frames along an edge: origin on it, Z its tangent (in the walk's direction), X its
   * normal toward the center of curvature (std's `perpendicularVector` of Z where it has none).
   */
  evEdgeCurvatures: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const walk = edgeWalk(call, input);
    const arcLength = byArcLength(input);
    return parametersOf(call, input).map((t) => {
      const result = walk.curve.EvalD2(walk.parameter(t, arcLength));
      const [d1, d2] = [xyz(result.D1), xyz(result.D2)];
      const speed = Math.hypot(...d1);
      const tangent = scaled(unit(d1), walk.reversed ? -1 : 1);
      const bend = minus(d2, scaled(d1, dot(d2, d1) / speed ** 2));
      const curvature = Math.hypot(...cross(d1, d2)) / speed ** 3;
      const normal =
        Math.hypot(...bend) > 1e-12 * Math.max(1, Math.hypot(...d2))
          ? unit(bend)
          : perpendicular(call, tangent);
      return stdTagged(call, "evaluate.fs", "EdgeCurvatureResult", [
        ["frame", stdCoordSystem(call, xyz(result.Point), normal, tangent)],
        ["curvature", withMeters(call, curvature, -1)],
      ]);
    });
  },
  /** The third derivative of the edge with respect to arc length (1/m^2), in the walk's direction. */
  evEdgeCurvatureDerivatives: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const walk = edgeWalk(call, input);
    const arcLength = byArcLength(input);
    return parametersOf(call, input).map((t) => {
      const result = walk.curve.EvalD3(walk.parameter(t, arcLength));
      const derivative = thirdArcDerivative(xyz(result.D1), xyz(result.D2), xyz(result.D3));
      // Walking backwards flips every odd derivative.
      return new FsTagged(
        stdType(call, "vector.fs", "Vector"),
        scaled(derivative, walk.reversed ? -1 : 1).map((c) => withMeters(call, c, -2)),
      );
    });
  },

  /**
   * Principal curvatures and directions at points of a face. std's sign: positive where the
   * radius of curvature points away from the face's outward normal (a ball), negative toward it (a
   * bore), which is the negative of the second fundamental form's.
   */
  evFaceCurvatures: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = first(call, input, "face", "FACE");
    const { oc } = input;
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face.shape));
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), true);
    return array(call, input.definition.getField("parameters"), "parameters").map((uv) => {
      const [s, t] = vector(call, uv, 2, "parameter");
      const r = surface.EvalD2(
        bounds.UMin + s * (bounds.UMax - bounds.UMin),
        bounds.VMin + t * (bounds.VMax - bounds.VMin),
      );
      const [su, sv] = [xyz(r.D1U), xyz(r.D1V)];
      const n = scaled(unit(cross(su, sv)), isReversed(face.shape) ? -1 : 1);
      const [e, f, g] = [dot(su, su), dot(su, sv), dot(sv, sv)];
      const [l, m, nn] = [dot(xyz(r.D2U), n), dot(xyz(r.D2UV), n), dot(xyz(r.D2V), n)];
      const area = e * g - f * f;
      const mean = (e * nn - 2 * f * m + g * l) / (2 * area);
      const gauss = (l * nn - m * m) / area;
      const rawSpread = Math.sqrt(Math.max(0, mean * mean - gauss));
      const umbilic = rawSpread <= UMBILIC * Math.max(1, Math.abs(mean));
      const spread = umbilic ? 0 : rawSpread;
      // Second-fundamental-form curvatures k; std's are -k, so std's minimum is the larger k.
      const direction = (k: number): Vec3 => {
        const rowA: [number, number] = [-(m - k * f), l - k * e];
        const rowB: [number, number] = [nn - k * g, -(m - k * f)];
        const [a, b] = Math.hypot(...rowA) >= Math.hypot(...rowB) ? rowA : rowB;
        return unit([0, 1, 2].map((i) => a * su[i]! + b * sv[i]!) as unknown as Vec3);
      };
      const minDirection = umbilic ? unit(su) : direction(mean + spread);
      const maxDirection = umbilic ? unit(cross(n, minDirection)) : direction(mean - spread);
      return stdTagged(call, "evaluate.fs", "FaceCurvatureResult", [
        ["minCurvature", withMeters(call, -(mean + spread), -1)],
        ["maxCurvature", withMeters(call, -(mean - spread), -1)],
        ["minDirection", unitVector(call, minDirection)],
        ["maxDirection", unitVector(call, maxDirection)],
      ]);
    });
  },

  /**
   * Whether a face wraps around in its primary (u) and secondary (v) directions: its surface is
   * periodic there and, unless `trimmed` is false, the face covers a whole period.
   */
  evFacePeriodicity: ([ctx, args], call) => {
    const input = open(call, ctx, args);
    const face = first(call, input, "face", "FACE");
    const { oc } = input;
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face.shape), false);
    const trimmed = untag(input.definition.getField("trimmed")) !== false;
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face.shape));
    const wraps = (periodic: boolean, period: () => number, span: number) =>
      periodic && (!trimmed || span >= period() - 1e-9);
    return [
      wraps(surface.IsUPeriodic(), () => surface.UPeriod(), bounds.UMax - bounds.UMin),
      wraps(surface.IsVPeriodic(), () => surface.VPeriod(), bounds.VMax - bounds.VMin),
    ];
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
