import type { Vec3 } from "../geometry/Sketch.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { array, integer, map } from "./args.ts";
import { plus, scaled } from "./edges.ts";
import { magnitude, vector } from "./geometryArgs.ts";
import { lengthVector, quantity, stdType, stdValue } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * The transforms std's Linear, Circular and Curve pattern features apply. std keeps the code it ran
 * before these builtins for held-back features (`computeLinearPatternTransforms` and friends in
 * linearPattern.fs, circularPattern.fs and curvePattern.fs); these follow it exactly, plus skipped
 * instances and the points std's skip-instance manipulators sit on. Transforms are built by std's
 * own `transform` and `rotationAround`.
 */

/** Calls a std function with every overload std declares (geometry.fs imports them all). */
const callStd = (call: BuiltinCall, name: string, args: readonly FsValue[]) =>
  call.interpreter.callFunction(stdValue(call, "geometry.fs", name), args);

/** A std `Transform` as numbers: rows of its linear part and its translation in meters. */
function parts(call: BuiltinCall, transform: FsValue): { linear: number[][]; translation: Vec3 } {
  const fields = map(call, transform, "transform");
  return {
    linear: array(call, fields.getField("linear"), "linear").map((row) =>
      array(call, row, "linear").map((c) => magnitude(call, c, "linear")),
    ),
    translation: vector(call, fields.getField("translation"), 3, "translation"),
  };
}
const times = (linear: readonly (readonly number[])[], v: Vec3): Vec3 =>
  linear.map((row) => row.reduce((sum, x, k) => sum + x * v[k]!, 0)) as unknown as Vec3;
/** Where `transform` takes `point`. */
const applied = (call: BuiltinCall, transform: FsValue, point: Vec3): Vec3 => {
  const { linear, translation } = parts(call, transform);
  return plus(translation, times(linear, point));
};
/** std's `operator*(Transform, Transform)`: `second` after `first`. */
function after(call: BuiltinCall, second: FsValue, first: FsValue): FsValue {
  const a = parts(call, second);
  const b = parts(call, first);
  const linear = a.linear.map((row) =>
    b.linear[0]!.map((_, j) => row.reduce((sum, x, k) => sum + x * b.linear[k]![j]!, 0)),
  );
  return callStd(call, "transform", [
    new FsTagged(stdType(call, "matrix.fs", "Matrix"), linear),
    lengthVector(call, plus(a.translation, times(a.linear, b.translation))),
  ]);
}

interface Instance {
  readonly name: string;
  /** Undefined for the seed. */
  readonly transform: FsValue;
  readonly skipped: boolean;
}

/**
 * std's `PatternTransforms`: the instances that aren't the seed or skipped, and, when instances
 * can be skipped and std found a start point, where every instance (seed included) puts it.
 */
function patternTransforms(
  call: BuiltinCall,
  definition: FsMap,
  instances: readonly Instance[],
): FsMap {
  const made = instances.filter(
    (instance) => instance.transform !== undefined && !instance.skipped,
  );
  const start = definition.getField("startPoint");
  const points =
    untag(definition.getField("skipInstances")) === true && start !== undefined
      ? instances.map((instance) => {
          const point = vector(call, start, 3, "startPoint");
          return lengthVector(
            call,
            instance.transform === undefined ? point : applied(call, instance.transform, point),
          );
        })
      : [];
  return FsMap.fromEntries([
    ["transforms", made.map((instance) => instance.transform)],
    ["instanceNames", made.map((instance) => instance.name)],
    ["manipulatorPoints", points],
  ]);
}

/** Skipped instances, keyed by their indices joined with commas. */
function skippedKeys(call: BuiltinCall, definition: FsMap, fields: readonly string[]): Set<string> {
  if (untag(definition.getField("skipInstances")) !== true) return new Set();
  return new Set(
    array(call, definition.getField("skippedInstances") ?? [], "skippedInstances").map(
      (instance) => {
        const indices = map(call, instance, "skippedInstances item");
        return fields.map((field) => integer(call, indices.getField(field), field)).join(",");
      },
    ),
  );
}

const flag = (definition: FsMap, field: string) => untag(definition.getField(field)) === true;

export const PATTERN_BUILTINS = {
  /** Instances `i` (and `i_j` past the first row) at `i * offset1 + j * offset2`. */
  computeLinearPatternTransforms: ([, args], call) => {
    const definition = map(call, args, "definition");
    const count1 = integer(call, definition.getField("instanceCount"), "instanceCount", 1);
    const count2 =
      definition.getField("instanceCountTwo") === undefined
        ? 1
        : integer(call, definition.getField("instanceCountTwo"), "instanceCountTwo", 1);
    const offset1 = vector(call, definition.getField("offset1"), 3, "offset1");
    const offset2: Vec3 =
      definition.getField("offset2") === undefined
        ? [0, 0, 0]
        : vector(call, definition.getField("offset2"), 3, "offset2");
    const skipped = skippedKeys(call, definition, ["index1", "index2"]);
    const instances: Instance[] = [];
    for (let j = flag(definition, "isCenteredTwo") ? 1 - count2 : 0; j < count2; j++)
      for (let i = flag(definition, "isCentered") ? 1 - count1 : 0; i < count1; i++)
        instances.push({
          name: `${i}${j === 0 ? "" : `_${j}`}`,
          transform:
            i === 0 && j === 0
              ? undefined
              : callStd(call, "transform", [
                  lengthVector(call, plus(scaled(offset1, i), scaled(offset2, j))),
                ]),
          skipped: skipped.has(`${i},${j}`),
        });
    return patternTransforms(call, definition, instances);
  },

  /** Instance `i` turned `i * angle` about `axis`; centered patterns go both ways. */
  computeCircularPatternTransforms: ([, args], call) => {
    const definition = map(call, args, "definition");
    const count = integer(call, definition.getField("instanceCount"), "instanceCount", 1);
    const angle = magnitude(call, definition.getField("angle"), "angle");
    const axis = definition.getField("axis");
    const skipped = skippedKeys(call, definition, ["index"]);
    const instances: Instance[] = [];
    for (let i = flag(definition, "isCentered") ? 1 - count : 0; i < count; i++)
      instances.push({
        name: String(i),
        transform:
          i === 0
            ? undefined
            : callStd(call, "rotationAround", [axis, quantity(call, i * angle, "ANGLE_UNITS")]),
        skipped: skipped.has(String(i)),
      });
    return patternTransforms(call, definition, instances);
  },

  /**
   * Instance `i` is the move from tangent `i - 1` to tangent `i` after instance `i - 1`; tangents
   * are `Line`s or `Plane`s.
   */
  computeCurvePatternTransforms: ([, args], call) => {
    const definition = map(call, args, "definition");
    const count = integer(call, definition.getField("instanceCount"), "instanceCount", 1);
    const tangents = array(call, definition.getField("tangents"), "tangents");
    if (tangents.length < count) return call.fail("Curve patterns need a tangent per instance.");
    const skipped = skippedKeys(call, definition, ["index"]);
    const instances: Instance[] = [{ name: "0", transform: undefined, skipped: false }];
    for (let i = 1; i < count; i++) {
      const step = callStd(call, "transform", [tangents[i - 1], tangents[i]]);
      const previous = instances[i - 1]!.transform;
      instances.push({
        name: String(i),
        transform: previous === undefined ? step : after(call, step, previous),
        skipped: skipped.has(String(i)),
      });
    }
    return patternTransforms(call, definition, instances);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
