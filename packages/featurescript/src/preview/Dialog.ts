import type { FeatureScriptRuntime } from "../Runtime.ts";
import type { FunctionImpl } from "../runtime/Interpreter.ts";
import type { ModuleInstance } from "../runtime/Modules.ts";
import {
  equals,
  formatNumber,
  FsBox,
  FsFunction,
  FsMap,
  FsTagged,
  untag,
  type FsValue,
} from "../runtime/Value.ts";
import type { Parameter } from "../syntax/Ast.ts";
import { defaultDefinition, type FeatureSpec } from "../spec/FeatureSpec.ts";

/**
 * What Onshape's feature dialog does around a feature (https://cad.onshape.com/FsDoc/uispec.html):
 * `#variable` references in its inputs, its "Editing Logic Function", and its "Manipulator Change
 * Function". The dialog's definition is stateful in Onshape; here the caller carries it between
 * runs as an {@link EditingState}.
 */

/** The dialog's state between runs, kept by the caller and sent back with the next run. */
export interface EditingState {
  /** The inputs the person set, as FeatureScript expressions. */
  readonly parameters: Readonly<Record<string, string>>;
  /** Inputs the editing logic set (and the person hasn't changed since), as expressions. */
  readonly edited: Readonly<Record<string, string>>;
}

/**
 * The module the dialog step is loaded from. It isn't a workspace file (`<` and `>` aren't valid
 * in one on Windows), and failures are never located in it.
 */
export const DIALOG_MODULE = "<cadsense dialog>.fs";

/**
 * A dragged manipulator: its key in `addManipulators`, the `Manipulator` a run returned (as its
 * expression), and its fields' new values as expressions, e.g. `{ offset: "20 * millimeter" }`
 * (`offset`, `angle`, `flipped` or `transform`, by its type).
 */
export interface ManipulatorChange {
  readonly key: string;
  readonly manipulator: string;
  readonly changes: Readonly<Record<string, string>>;
}

/**
 * The dialog's state for a run: what the last run returned (null when the dialog opens), and the
 * inputs the person set since, even to the text they had: setting one again after the editing
 * logic overrode it takes it back.
 */
export interface DialogEditing {
  readonly previous: EditingState | null;
  readonly touched?: readonly string[];
}

/** What the dialog does around the step's feature. */
export interface DialogOptions {
  /** The dialog is open on it: run its editing logic, given the state the last run returned. */
  readonly editing?: DialogEditing;
  /** Run its manipulator change function for this drag, and not the feature. */
  readonly manipulatorChange?: ManipulatorChange;
}

/** The arguments Onshape passes an editing logic function after its first four, in order. */
const OPTIONAL_ARGUMENTS = [
  { name: "isCreating", type: "boolean" },
  { name: "specifiedParameters", type: "map" },
  { name: "hiddenBodies", type: "Query" },
  { name: "clickedButton", type: "string" },
] as const;
type OptionalArgument = (typeof OPTIONAL_ARGUMENTS)[number]["name"];

/**
 * `source` with each `#name` outside a string replaced by `getVariable(context, "name")`, as
 * Onshape pre-processes a dialog expression; null when it has none. `context` is the context
 * just before the feature, so the reference reads what earlier features set.
 */
export function variableReferences(source: string): string | null {
  let out = "";
  let found = false;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === "\\") out += source[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    const name = ch === "#" ? /^[A-Za-z_]\w*/.exec(source.slice(i + 1))?.[0] : undefined;
    if (name === undefined) {
      out += ch;
      continue;
    }
    out += `getVariable(context, ${JSON.stringify(name)})`;
    i += name.length;
    found = true;
  }
  return found ? out : null;
}

/**
 * Input expressions evaluated in `module`. One that reads a variable can't be evaluated before the
 * features run, so it's `lazy`: a function of the context that the dialog step calls just before
 * the feature. `lenient` leaves out expressions that don't evaluate (an earlier state's, after the
 * script changed) instead of throwing.
 */
export function evaluateInputs(
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  expressions: Readonly<Record<string, string>>,
  lenient = false,
): { readonly values: FsMap; readonly lazy: FsMap } {
  let values = FsMap.empty;
  let lazy = FsMap.empty;
  for (const [id, source] of Object.entries(expressions)) {
    const reading = variableReferences(source);
    try {
      if (reading === null) values = values.set(id, runtime.evaluate(module, source));
      else
        lazy = lazy.set(
          id,
          runtime.evaluate(module, `function(context is Context) { return (${reading}); }`),
        );
    } catch (error) {
      if (!lenient) throw error;
    }
  }
  return { values, lazy };
}

/** The function a feature's annotation names under `key` ("Editing Logic Function"), if any. */
export function featureFunctionName(
  module: ModuleInstance,
  feature: string,
  key: string,
): string | null {
  for (const declaration of module.ast.declarations) {
    if (declaration.kind !== "Const" || declaration.name !== feature) continue;
    for (const annotation of declaration.annotations)
      for (const entry of annotation.entries)
        if (entry.key.kind === "String" && entry.key.value === key && entry.value.kind === "String")
          return entry.value.value;
  }
  return null;
}

/** The parameters `fn` declares, or null for a value with several overloads. */
function declaredParameters(fn: FsFunction): readonly Parameter[] | null {
  // Every function value the interpreter makes holds a FunctionImpl.
  const impl = fn.impl as FunctionImpl;
  if (impl.kind === "lambda") return impl.node.params;
  return impl.decls.length === 1 ? impl.decls[0]!.node.params : null;
}

/**
 * Which optional arguments an editing logic function takes. Onshape's docs: it "may have between
 * four and seven arguments", the later ones can be left out, and "the ones you keep must stay in
 * the same relative order". So each declared parameter after the fourth takes the next optional
 * argument its type allows (extrude's `specifiedParameters is map, hiddenBodies is Query` skips
 * `isCreating`). Throws for a function no call could match.
 */
export function logicArguments(fn: FsValue, name: string): OptionalArgument[] {
  const params = fn instanceof FsFunction ? declaredParameters(fn) : null;
  if (params === null)
    throw new Error(`Editing Logic Function ${name} must be one function, not overloads.`);
  if (params.length < 4)
    throw new Error(
      `Editing Logic Function ${name} must take at least four arguments: context, id, oldDefinition, definition.`,
    );
  let next = 0;
  return params.slice(4).map((param) => {
    const at = OPTIONAL_ARGUMENTS.findIndex(
      (argument, i) => i >= next && (param.type === null || param.type.name === argument.type),
    );
    if (at < 0)
      throw new Error(
        `Editing Logic Function ${name}'s parameter ${param.name} matches none of Onshape's optional arguments left (isCreating, specifiedParameters, hiddenBodies, clickedButton, in that order).`,
      );
    next = at + 1;
    return OPTIONAL_ARGUMENTS[at]!.name;
  });
}

/**
 * The step that runs a feature as the dialog would, on the context just before the feature: it
 * evaluates the inputs that read variables (one that fails, a missing variable say, fails the
 * feature and blames that input by its label in `labels`), calls the editing logic (with `optional` extra arguments) and
 * rolls the context back, puts the definition it returned in the `resolved` box, and runs the
 * feature with it. A logic that throws fails the feature with that error, at its line. For a
 * manipulator change it calls the change function instead of the logic and the feature, with
 * what it was given in the `given` box (the run is thrown away; see `runPreview`).
 */
const dialogSource = (optional: number) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
import(path : "onshape/std/error.fs", version : "3083.0");

/** A list's items with the inner inputs they leave out at their defaults, as defaultDefinition gives them. */
function withItemDefaults(value, defaults)
{
    if (defaults == undefined || !(value is array))
        return value;
    for (var i = 0; i < size(value); i += 1)
    {
        if (!(value[i] is map))
            continue;
        for (var entry in defaults)
        {
            if (value[i][entry.key] == undefined)
                value[i][entry.key] = entry.value;
        }
    }
    return value;
}

export const runDialogStep = function(context is Context, id is Id, request is map)
{
    var definition = request.definition;
    var evaluated = {};
    for (var entry in request.lazy)
    {
        const evaluate = entry.value;
        try
        {
            definition[entry.key] = withItemDefaults(evaluate(context), request.itemDefaults[entry.key]);
            evaluated[entry.key] = definition[entry.key];
        }
        catch (error)
        {
            // Its own message, so the failure isn't located in the file: the expression isn't there.
            processError(context, id, regenError(request.labels[entry.key] ~ ": " ~ (error is string ? error : "it couldn't be evaluated."), [entry.key]));
            return;
        }
    }
    request.evaluated[] = evaluated;
    const changeManipulators = request.manipulatorChange;
    if (changeManipulators != undefined)
    {
        request.given[] = definition;
        try
        {
            request.resolved[] = changeManipulators(context, definition, request.newManipulators);
        }
        catch (error)
        {
            processError(context, id, error);
        }
        return;
    }
    const editLogic = request.logic;
    if (editLogic != undefined)
    {
        var oldDefinition = request.oldDefinition;
        for (var entry in request.oldLazy)
        {
            const evaluate = entry.value;
            oldDefinition[entry.key] = withItemDefaults(try silent(evaluate(context)), request.itemDefaults[entry.key]);
        }
        const token = @startFeature(context, id, {});
        try
        {
            definition = editLogic(context, id, oldDefinition, definition${Array.from(
              { length: optional },
              (_, i) => `, request.optional[${i}]`,
            ).join("")});
        }
        catch (error)
        {
            @abortFeature(context, id, token);
            processError(context, id, error);
            return;
        }
        @abortFeature(context, id, token);
    }
    request.resolved[] = definition;
    const runFeature = request.feature;
    runFeature(context, id, definition);
};
`;

/**
 * An earlier state's expressions for `spec`'s inputs, evaluated where they still evaluate: the
 * script may have changed since (an input or enum renamed), and those inputs go back to defaults.
 * With `fields`, other definition fields (ones the editing logic set) are kept too.
 */
const evaluateState = (
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  spec: FeatureSpec,
  expressions: Readonly<Record<string, string>>,
  fields = false,
) =>
  evaluateInputs(
    runtime,
    module,
    Object.fromEntries(
      Object.entries(expressions).filter(
        ([id]) => fields || spec.inputs.some((input) => input.id === id),
      ),
    ),
    true,
  );

/** A feature step ready for `runFeatures`, and what to read back after it ran. */
export interface DialogStep {
  readonly module: ModuleInstance;
  readonly feature: string;
  readonly definition: FsMap;
  /** After the run: the definition the feature ran with; undefined if the logic threw. */
  readonly resolved: FsBox;
  /** The definition before the logic, for when it threw. */
  readonly unresolved: FsMap;
  /** For a manipulator change: the definition its function was given, inputs evaluated. */
  readonly given: FsBox;
  /** After the run: the inputs that read variables, as they evaluated, by id. */
  readonly evaluated: FsBox;
  /** Whether the feature has editing logic; its state is then kept between runs. */
  readonly logic: boolean;
}

/** A step's feature, inputs and definition, as `runPreview` prepares it. */
export interface DialogTarget {
  readonly module: ModuleInstance;
  readonly spec: FeatureSpec;
  /** The inputs set, as expressions. */
  readonly parameters: Readonly<Record<string, string>>;
  /** The inputs' values, evaluated, without the ones that read variables. */
  readonly values: FsMap;
  /** `defaultDefinition` of `values`: every input's default, then the values. */
  readonly definition: FsMap;
  /** Inputs that read variables, as functions of the context; see `evaluateInputs`. */
  readonly lazy: FsMap;
}

/**
 * Each list input's inner defaults, by list id: what `defaultDefinition` gives a list item that
 * leaves an input out, for the dialog step to give lists it evaluates at run time.
 */
const itemDefaults = (spec: FeatureSpec) =>
  FsMap.fromEntries(
    spec.inputs
      .filter((input) => input.kind === "array")
      .map(
        (list) =>
          [
            list.id,
            FsMap.fromEntries(list.items.map((inner) => [inner.id, inner.defaultValue] as const)),
          ] as const,
      ),
  );

/** `map` without the keys `others` has. */
const without = (map: FsMap, others: FsMap) =>
  others.entries().reduce((rest, [key]) => rest.set(key, undefined), map);

/** `base` with `values`' entries set over it. */
const merge = (base: FsMap, values: FsMap) =>
  values.entries().reduce((merged, [id, value]) => merged.set(id, value), base);

/**
 * Whether input `id` is as it was when `editing.previous` was made: the person's `parameters` for
 * it are the same, and they haven't set it (`editing.touched`) since. False with no state.
 */
function untouchedSince(
  editing: DialogEditing | undefined,
  parameters: Readonly<Record<string, string>>,
): (id: string) => boolean {
  const previous = editing?.previous ?? null;
  const touched = new Set(editing?.touched);
  return (id) =>
    previous !== null && parameters[id] === previous.parameters[id] && !touched.has(id);
}

/**
 * The editing logic's earlier edits (`editing.previous.edited`) that still stand for a run of
 * `parameters`: those to inputs the person hasn't changed or set since. The run's definition takes
 * their values, and the dialog shows them in place of the person's expressions.
 */
export function standingEdits(
  editing: DialogEditing | undefined,
  parameters: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const unchanged = untouchedSince(editing, parameters);
  return Object.fromEntries(
    Object.entries(editing?.previous?.edited ?? {}).filter(([id]) => unchanged(id)),
  );
}

/**
 * A feature's step as Onshape's dialog runs it, or null when it needs nothing the plain feature
 * call doesn't do: no input reads a variable, and it has no editing logic or `editing` isn't
 * asked for (only the panel's previewed feature has a dialog open).
 *
 * `editing.previous` is the state the last run returned, null when the dialog opens: Onshape calls
 * the logic then with `oldDefinition` `{}` (its "preselection" case), and afterwards only when an
 * input changed. The logic's earlier changes join the definition unless the person changed or set
 * (`editing.touched`) that input since. The panel never commits a feature, so `isCreating` is always true.
 */
export function dialogStep(
  runtime: FeatureScriptRuntime,
  target: DialogTarget,
  options: DialogOptions = {},
): DialogStep | null {
  const { module, spec, parameters } = target;
  const { editing, manipulatorChange } = options;
  const change = manipulatorChange
    ? manipulatorChangeCall(runtime, target, manipulatorChange)
    : null;
  const name =
    editing && !change ? featureFunctionName(module, spec.name, "Editing Logic Function") : null;
  if (name === null && change === null && target.lazy.size === 0) return null;
  const logic = name === null ? undefined : runtime.interpreter.topLevelValue(module, name);
  const optional = name === null ? [] : logicArguments(logic, name);
  const previous = editing?.previous ?? null;
  const ids = spec.inputs.map((input) => input.id);
  const unchanged = untouchedSince(editing, parameters);
  const standing = standingEdits(editing, parameters);
  const kept = evaluateState(runtime, module, spec, standing, true);
  // Fields the logic removed (saved as `undefined`) stay out of the definition.
  const removed = Object.keys(standing).filter((key) => standing[key] === "undefined");
  // Both definitions are built the same way, list item defaults included, so the logic sees
  // only real changes; inputs evaluated at run time get the same item defaults there.
  const definition = removed.reduce(
    (built, key) => built.set(key, undefined),
    defaultDefinition(spec, merge(target.values, kept.values)),
  );
  // Any definition change runs the logic, a non-input field a manipulator set included.
  const changed =
    previous === null ||
    ![...new Set([...ids, ...Object.keys(parameters), ...Object.keys(previous.parameters)])].every(
      unchanged,
    );
  const before = previous ? evaluateState(runtime, module, spec, previous.parameters) : null;
  const oldEdited = previous
    ? evaluateState(runtime, module, spec, previous.edited, true).values
    : FsMap.empty;
  const oldDefinition =
    previous === null || before === null
      ? FsMap.empty
      : defaultDefinition(spec, merge(before.values, oldEdited));
  const values: Record<OptionalArgument, FsValue> = {
    isCreating: true,
    specifiedParameters: FsMap.fromEntries(ids.map((id) => [id, id in parameters] as const)),
    hiddenBodies: runtime.callStd("query.fs", "qNothing"),
    clickedButton: "",
  };
  const resolved = new FsBox(undefined);
  const given = new FsBox(undefined);
  const evaluated = new FsBox(undefined);
  return {
    module: runtime.load(DIALOG_MODULE, dialogSource(optional.length)),
    feature: "runDialogStep",
    definition: FsMap.fromEntries([
      ["feature", runtime.interpreter.topLevelValue(module, spec.name)],
      // A reference the logic's kept value replaced isn't read again.
      ["lazy", without(target.lazy, kept.values)],
      ["itemDefaults", itemDefaults(spec)],
      [
        "labels",
        FsMap.fromEntries(
          spec.inputs.flatMap((input) =>
            target.lazy.get(input.id) === undefined ? [] : [[input.id, input.label] as const],
          ),
        ),
      ],
      ["logic", changed ? logic : undefined],
      ["oldDefinition", oldDefinition],
      ["oldLazy", before ? without(before.lazy, oldEdited) : FsMap.empty],
      ["definition", definition],
      ["optional", optional.map((argument) => values[argument])],
      ["manipulatorChange", change?.function],
      ["newManipulators", change?.newManipulators],
      ["resolved", resolved],
      ["given", given],
      ["evaluated", evaluated],
    ]),
    resolved,
    given,
    evaluated,
    unresolved: definition,
    logic: name !== null,
  };
}

/**
 * The feature's "Manipulator Change Function", and its `newManipulators` for `change`: one entry,
 * the dragged manipulator with its changed fields. Throws when the feature has no such function
 * or the manipulator sent back isn't one.
 */
function manipulatorChangeCall(
  runtime: FeatureScriptRuntime,
  { module, spec }: DialogTarget,
  change: ManipulatorChange,
): { readonly function: FsValue; readonly newManipulators: FsMap } {
  const name = featureFunctionName(module, spec.name, "Manipulator Change Function");
  if (name === null)
    throw new Error(
      `${spec.typeName} has no Manipulator Change Function to take a manipulator change.`,
    );
  const manipulator = runtime.evaluate(module, change.manipulator);
  if (!(manipulator instanceof FsTagged) || !(manipulator.value instanceof FsMap))
    throw new Error(`Manipulator ${change.key} sent back isn't a Manipulator.`);
  const moved = Object.entries(change.changes).reduce(
    (fields, [field, source]) => fields.set(field, runtime.evaluate(module, source)),
    manipulator.value,
  );
  return {
    function: runtime.interpreter.topLevelValue(module, name),
    newManipulators: FsMap.fromEntries([[change.key, new FsTagged(manipulator.tag, moved)]]),
  };
}

/**
 * The person's inputs after a manipulator change: `target`'s, with every input (and any other
 * definition field) the change function set (`changed` differs from `given`) as an expression. A quantity it returned as a
 * string is that expression, as Onshape's docs allow. Throws for a value with no expression.
 */
export function changedParameters(
  runtime: FeatureScriptRuntime,
  target: DialogTarget,
  given: FsMap,
  changed: FsMap,
): Readonly<Record<string, string>> {
  const quantities = new Set(["length", "angle", "integer", "real"]);
  const isInput = (key: string) => target.spec.inputs.some((input) => input.id === key);
  return Object.fromEntries([
    // A field that isn't an input and that the function removed is gone.
    ...Object.entries(target.parameters).filter(
      ([key]) => isInput(key) || changed.get(key) !== undefined,
    ),
    ...target.spec.inputs.flatMap((input) => {
      const value = changed.get(input.id);
      if (equals(value, given.get(input.id))) return [];
      const text = untag(value);
      const expression =
        quantities.has(input.kind) && typeof text === "string"
          ? text
          : valueExpression(runtime, target.module, value);
      if (expression === null)
        throw new Error(
          `The Manipulator Change Function set ${input.id} to a value that has no expression to keep.`,
        );
      return [[input.id, expression] as const];
    }),
    // std lets the function change the definition "in any way": fields that aren't dialog inputs
    // pass to the feature too.
    ...changed.entries().flatMap(([key, value]) => {
      if (typeof key !== "string" || isInput(key)) return [];
      if (equals(value, given.get(key))) return [];
      const expression = valueExpression(runtime, target.module, value);
      if (expression === null)
        throw new Error(
          `The Manipulator Change Function set ${key} to a value that has no expression to keep.`,
        );
      return [[key, expression] as const];
    }),
  ]);
}

/** A JSON value: what `plainValue` makes of a FeatureScript value. */
export type PlainValue =
  | number
  | boolean
  | string
  | null
  | readonly PlainValue[]
  | { readonly [key: string]: PlainValue };

/**
 * `value` as JSON for drawing: quantities as their SI magnitude (meters, radians), enum values as
 * their member, maps by their string keys. Functions, boxes, builtins and infinities are null.
 */
export function plainValue(value: FsValue): PlainValue {
  if (value instanceof FsTagged) {
    const inner = value.value;
    if (value.tag.name === "ValueWithUnits" && inner instanceof FsMap)
      return plainValue(inner.getField("value"));
    return plainValue(inner);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainValue);
  if (value instanceof FsMap)
    return Object.fromEntries(
      value
        .entries()
        .flatMap(([key, entry]) => (typeof key === "string" ? [[key, plainValue(entry)]] : [])),
    );
  return null;
}

/**
 * The state to send with the next run: the target's parameters, and every input whose value in
 * `resolved` isn't what the person's inputs give it, as an expression: the target's definition,
 * or for an input that reads a variable, its value in `evaluated` (one the logic replaced wasn't
 * read, and keeps the logic's value, as Onshape replaces the expression). A value with no
 * expression that evaluates back to it (a function, say) can't be kept.
 */
export function editingState(
  runtime: FeatureScriptRuntime,
  target: DialogTarget,
  resolved: FsMap,
  evaluated: FsMap,
): EditingState {
  const { module, spec, parameters, definition, lazy } = target;
  const isInput = (key: string) => spec.inputs.some((input) => input.id === key);
  return {
    parameters,
    edited: Object.fromEntries([
      ...spec.inputs.flatMap((input) => {
        const value = resolved.get(input.id);
        const reads = lazy.get(input.id) !== undefined;
        if (reads && evaluated.has(input.id) && equals(value, evaluated.get(input.id))) return [];
        if (!reads && equals(value, definition.get(input.id))) return [];
        const expression = valueExpression(runtime, module, value);
        return expression === null ? [] : [[input.id, expression] as const];
      }),
      // Fields the logic set that aren't inputs, kept as Onshape keeps the definition it returned,
      // and ones it removed (a saved field it set to undefined stays removed).
      ...resolved.entries().flatMap(([key, value]) => {
        if (typeof key !== "string" || isInput(key) || equals(value, definition.get(key)))
          return [];
        const expression = valueExpression(runtime, module, value);
        return expression === null ? [] : [[key, expression] as const];
      }),
      ...Object.keys(parameters).flatMap((key) =>
        isInput(key) || resolved.get(key) !== undefined ? [] : [[key, "undefined"] as const],
      ),
    ]),
  };
}

/**
 * A FeatureScript expression that evaluates to `value` in `module`, or null when there's none
 * (functions, boxes, builtins) or it doesn't evaluate back to an equal value there (a tag whose
 * name the module can't see).
 */
export function valueExpression(
  runtime: FeatureScriptRuntime,
  module: ModuleInstance,
  value: FsValue,
): string | null {
  const text = expressionOf(value);
  if (text === null) return null;
  try {
    return equals(runtime.evaluate(module, text), value) ? text : null;
  } catch {
    return null;
  }
}

/** Std's base units, for writing a length as `0.012 * meter` rather than as its map. */
const BASE_UNITS = new Set(["meter", "radian"]);

function expressionOf(value: FsValue): string | null {
  if (value instanceof FsTagged) {
    if (value.tag.kind === "enum" && typeof value.value === "string")
      return `${value.tag.name}.${value.value}`;
    const inner = value.value;
    if (value.tag.name === "ValueWithUnits" && inner instanceof FsMap) {
      const magnitude = inner.getField("value");
      const unit = inner.getField("unit");
      const units = unit instanceof FsTagged ? unit.value : unit;
      const [only] = units instanceof FsMap ? units.entries() : [];
      if (
        typeof magnitude === "number" &&
        units instanceof FsMap &&
        units.size === 1 &&
        only?.[1] === 1 &&
        typeof only[0] === "string" &&
        BASE_UNITS.has(only[0])
      )
        return `${formatNumber(magnitude)} * ${only[0]}`;
    }
    const expression = expressionOf(inner);
    return expression === null ? null : `(${expression} as ${value.tag.name})`;
  }
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return String(value);
    case "number":
      return formatNumber(value);
    case "string":
      return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(expressionOf);
    return items.every((item) => item !== null) ? `[${items.join(", ")}]` : null;
  }
  if (value instanceof FsMap) {
    const entries = value.entries().map(([key, entry]) => {
      const keyText = typeof key === "string" ? JSON.stringify(key) : expressionOf(key);
      const entryText = expressionOf(entry);
      return keyText === null || entryText === null
        ? null
        : `${typeof key === "string" ? keyText : `(${keyText})`} : ${entryText}`;
    });
    return entries.every((entry) => entry !== null) ? `{ ${entries.join(", ")} }` : null;
  }
  return null;
}
