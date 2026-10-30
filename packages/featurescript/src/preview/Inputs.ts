import type { FeatureScriptRuntime } from "../Runtime.ts";
import type { ModuleInstance } from "../runtime/Modules.ts";
import { FsMap, untag } from "../runtime/Value.ts";
import type { FeatureSpec, InputKind } from "../spec/FeatureSpec.ts";
import { formatInput } from "./Preview.ts";

/** One row of a feature dialog: an input, its current value, and whether Onshape would show it. */
export interface DialogInput {
  readonly id: string;
  readonly label: string;
  readonly kind: InputKind;
  /** The value the feature ran with, as a person would type it (`5.5 mm`, `30 deg`, `true`). */
  readonly value: string;
  /** Enum members as FeatureScript expressions (`BoundingType.BLIND`); empty for other kinds. */
  readonly options: readonly string[];
  /** False when an `if` the input sits under is false for this definition, as in Onshape's dialog. */
  readonly visible: boolean;
  readonly group: string | null;
  /** Source of a query's "Filter" annotation. */
  readonly filter: string | null;
  readonly maxPicks: number | null;
}

/**
 * The top-level inputs of `spec` as a dialog shows them for `definition`. Conditions are evaluated
 * with `definition` bound, so a "Through all" checkbox hides "Depth" here the way it does in
 * Onshape. A condition that can't be evaluated leaves its input visible.
 */
export function dialogInputs(
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  spec: FeatureSpec,
  definition: FsMap,
): DialogInput[] {
  const holds = (condition: string) => {
    try {
      const test = runtime.evaluate(module, `function(definition) { return ${condition}; }`);
      return untag(runtime.interpreter.callFunction(test, [definition])) !== false;
    } catch {
      return true;
    }
  };
  return spec.inputs.map((input) => ({
    id: input.id,
    label: input.label,
    kind: input.kind,
    value: formatInput(definition.getField(input.id) ?? input.defaultValue),
    options: input.enumType?.members.map((member) => `${input.enumType?.name}.${member}`) ?? [],
    visible: input.conditions.every(holds),
    group: input.group,
    filter: input.filter,
    maxPicks: input.maxPicks,
  }));
}
