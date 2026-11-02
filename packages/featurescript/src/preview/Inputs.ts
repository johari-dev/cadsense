import type { FeatureScriptRuntime } from "../Runtime.ts";
import type { ModuleInstance } from "../runtime/Modules.ts";
import { FsMap, untag } from "../runtime/Value.ts";
import type { FeatureInput, FeatureSpec, InputKind } from "../spec/FeatureSpec.ts";
import { variableReferences } from "./Dialog.ts";
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
  /** The feature's status blames this input, so Onshape outlines it. */
  readonly faulty: boolean;
  readonly group: string | null;
  /** Source of a query's "Filter" annotation. */
  readonly filter: string | null;
  readonly maxPicks: number | null;
  /** A list input's "Item name", such as `Waypoint`. */
  readonly itemName: string | null;
  /** A list input's items as they ran, each its inner inputs with that item's values. */
  readonly items: readonly (readonly DialogInput[])[];
}

/**
 * The top-level inputs of `spec` as a dialog shows them for `definition`. Conditions are evaluated
 * with `definition` bound, so a "Through all" checkbox hides "Depth" here the way it does in
 * Onshape. A condition that can't be evaluated leaves its input visible. `faulty` is the run's
 * `faultyParameters`: input ids, or `list[index].inner` for an input inside a list item. An input
 * whose expression (in `expressions`) reads a variable shows that expression, `#width`, as
 * Onshape's dialog does.
 */
export function dialogInputs(
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  spec: FeatureSpec,
  definition: FsMap,
  options: {
    readonly faulty?: readonly string[];
    readonly expressions?: Readonly<Record<string, string>>;
  } = {},
): DialogInput[] {
  const blamed = new Set(options.faulty);
  const reference = (id: string) => {
    const source = options.expressions?.[id];
    return source !== undefined && variableReferences(source) !== null ? source.trim() : null;
  };
  const holds = (condition: string) => {
    try {
      const test = runtime.evaluate(module, `function(definition) { return ${condition}; }`);
      return untag(runtime.interpreter.callFunction(test, [definition])) !== false;
    } catch {
      return true;
    }
  };
  // Conditions inside a list's loop name the item variable, so they can't be checked here; those
  // inputs show. `path` is how a faulty parameter names the input: its id, or `list[i].id`.
  const row = (input: FeatureInput, values: FsMap, path: string | null): DialogInput => {
    const value = values.getField(input.id) ?? input.defaultValue;
    const itemName = untag(input.annotation.getField("Item name") ?? "");
    const items = untag(value);
    return {
      id: input.id,
      label: input.label,
      kind: input.kind,
      value:
        input.kind === "array"
          ? ""
          : ((path === null ? reference(input.id) : null) ?? formatInput(value)),
      options: input.enumType?.members.map((member) => `${input.enumType?.name}.${member}`) ?? [],
      visible: path !== null || input.conditions.every(holds),
      faulty: blamed.has(path === null ? input.id : `${path}.${input.id}`),
      group: input.group,
      filter: input.filter,
      maxPicks: input.maxPicks,
      itemName: typeof itemName === "string" && itemName !== "" ? itemName : null,
      items:
        input.kind === "array" && Array.isArray(items)
          ? items.map((item, index) => {
              const fields = untag(item);
              const itemValues = fields instanceof FsMap ? fields : FsMap.empty;
              return input.items.map((inner) => row(inner, itemValues, `${input.id}[${index}]`));
            })
          : [],
    };
  };
  return spec.inputs.map((input) => row(input, definition, null));
}
