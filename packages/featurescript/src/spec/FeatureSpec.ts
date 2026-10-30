import type { Expression, MapLiteral, Statement } from "../syntax/Ast.ts";
import type { Span } from "../syntax/Source.ts";
import { FsFault, FsThrow } from "../runtime/Errors.ts";
import type { Interpreter } from "../runtime/Interpreter.ts";
import type { ModuleInstance } from "../runtime/Modules.ts";
import { equals, FsMap, FsTagged, untag, type FsValue, type TypeDef } from "../runtime/Value.ts";

/**
 * A feature's inputs, read statically from its precondition the way Onshape builds the feature
 * dialog (https://cad.onshape.com/FsDoc/uispec.html).
 */
export interface FeatureSpec {
  /** The exported constant, e.g. `boltCircle`. */
  readonly name: string;
  /** "Feature Type Name", e.g. `Bolt circle`. */
  readonly typeName: string;
  readonly description: string | null;
  readonly inputs: readonly FeatureInput[];
}

export type InputKind =
  | "length"
  | "angle"
  | "integer"
  | "real"
  | "anything"
  | "boolean"
  | "string"
  | "query"
  | "enum"
  | "array"
  | "other";

export interface FeatureInput {
  /** The `definition` key. */
  readonly id: string;
  /** "Name" from the annotation, or the id. */
  readonly label: string;
  readonly kind: InputKind;
  /**
   * The value the dialog starts with: the bound spec's default (lengths in millimeters, angles in
   * degrees), the "Default" annotation, false, "", the first enum member, or an empty query.
   */
  readonly defaultValue: FsValue;
  /** Quantity bounds, in the unit the bound spec declares them in. */
  readonly bounds: { readonly min: FsValue; readonly max: FsValue } | null;
  readonly enumType: TypeDef | null;
  /** "MaxNumberOfPicks" for queries. */
  readonly maxPicks: number | null;
  /** Source of the "Filter" annotation for queries, e.g. `EntityType.FACE && GeometryType.PLANE`. */
  readonly filter: string | null;
  /** Source of the `if` conditions the input sits under; all must hold for it to show. */
  readonly conditions: readonly string[];
  /** Enclosing "Group Name", if any. */
  readonly group: string | null;
  /** Inner inputs of an array parameter. */
  readonly items: readonly FeatureInput[];
  /** The input's annotation, evaluated. */
  readonly annotation: FsMap;
  readonly span: Span;
}

const QUANTITY: Readonly<Record<string, InputKind>> = {
  isLength: "length",
  isAngle: "angle",
  isInteger: "integer",
  isReal: "real",
  isAnything: "anything",
};
/** The std constant a quantity's default is shown in, when the bound spec has an entry for it. */
const PREFERRED_UNIT: Readonly<Partial<Record<InputKind, string>>> = {
  length: "millimeter",
  angle: "degree",
};

/** Every `defineFeature` constant in `module` with a "Feature Type Name", in source order. */
export function featureSpecs(interpreter: Interpreter, module: ModuleInstance): FeatureSpec[] {
  const specs: FeatureSpec[] = [];
  for (const declaration of module.ast.declarations) {
    if (declaration.kind !== "Const") continue;
    const annotation = evaluateAnnotations(interpreter, module, declaration.annotations);
    const typeName = untag(annotation.getField("Feature Type Name"));
    const call = declaration.value;
    if (
      typeof typeName !== "string" ||
      call.kind !== "Call" ||
      call.callee.kind !== "Identifier" ||
      call.callee.name !== "defineFeature"
    )
      continue;
    const lambda = call.args[0];
    if (lambda?.kind !== "Lambda") continue;
    const description = untag(annotation.getField("Feature Type Description"));
    const reader = new SpecReader(interpreter, module);
    if (lambda.precondition?.kind === "Block")
      reader.statements(
        lambda.precondition.body,
        { annotations: [], conditions: [], group: null },
        reader.inputs,
        null,
      );
    specs.push({
      name: declaration.name,
      typeName,
      description: typeof description === "string" ? description : null,
      inputs: reader.inputs,
    });
  }
  return specs;
}

/** The definition to run `spec` with: every input's default, then `overrides`. */
export function defaultDefinition(spec: FeatureSpec, overrides: FsMap = FsMap.empty): FsMap {
  let definition = FsMap.fromEntries(
    spec.inputs.map((input) => [input.id, input.defaultValue] as const),
  );
  for (const [key, value] of overrides.entries()) definition = definition.set(key, value);
  return definition;
}

/** Annotation keys Onshape parses itself rather than evaluating; `Filter` uses `&&` on enum values. */
const UNEVALUATED = new Set(["Filter"]);

/**
 * Evaluates annotation literals entry by entry. Keys in `UNEVALUATED` and entries that raise (an icon
 * import we don't have, say) are left out; their source is still available from the syntax tree.
 */
function evaluateAnnotations(
  interpreter: Interpreter,
  module: ModuleInstance,
  annotations: readonly MapLiteral[],
): FsMap {
  let merged = FsMap.empty;
  for (const annotation of annotations)
    for (const entry of annotation.entries) {
      if (entry.key.kind === "String" && UNEVALUATED.has(entry.key.value)) continue;
      try {
        merged = merged.set(
          interpreter.evaluate(entry.key, module),
          interpreter.evaluate(entry.value, module),
        );
      } catch (error) {
        // An icon from another Onshape document isn't available locally; the dialog doesn't need it.
        if (
          !(
            error instanceof FsThrow ||
            (error instanceof FsFault && error.reason === "unresolved-name")
          )
        )
          throw error;
      }
    }
  return merged;
}

interface Scope {
  /** Annotations on the statement being read. */
  readonly annotations: readonly MapLiteral[];
  readonly conditions: readonly string[];
  readonly group: string | null;
}

class SpecReader {
  readonly inputs: FeatureInput[] = [];
  private readonly interpreter: Interpreter;
  private readonly module: ModuleInstance;
  /** Array parameter id to its inner inputs, filled by `for (var item in definition.x)` loops. */
  private readonly arrayItems = new Map<string, FeatureInput[]>();

  constructor(interpreter: Interpreter, module: ModuleInstance) {
    this.interpreter = interpreter;
    this.module = module;
  }

  private source(span: Span) {
    return this.module.file.text.slice(span.start, span.end);
  }

  statements(
    statements: readonly Statement[],
    scope: Scope,
    into: FeatureInput[],
    item: string | null,
  ) {
    for (const statement of statements) this.statement(statement, scope, into, item);
  }

  private statement(
    statement: Statement,
    scope: Scope,
    into: FeatureInput[],
    item: string | null,
  ): void {
    const plain = { ...scope, annotations: [] };
    switch (statement.kind) {
      case "Annotated": {
        const group = untag(
          evaluateAnnotations(this.interpreter, this.module, [statement.annotation]).getField(
            "Group Name",
          ),
        );
        if (typeof group === "string" && statement.statement.kind === "Block")
          return this.statements(statement.statement.body, { ...plain, group }, into, item);
        return this.statement(
          statement.statement,
          { ...scope, annotations: [...scope.annotations, statement.annotation] },
          into,
          item,
        );
      }
      case "Block":
        return this.statements(statement.body, plain, into, item);
      case "If": {
        const test = this.source(statement.test.span);
        this.statement(
          statement.consequent,
          { ...plain, conditions: [...scope.conditions, test] },
          into,
          item,
        );
        if (statement.alternate)
          this.statement(
            statement.alternate,
            { ...plain, conditions: [...scope.conditions, `!(${test})`] },
            into,
            item,
          );
        return;
      }
      case "ForIn": {
        // `for (var profile in definition.profiles) { ... profile.width ... }` declares an array's inner inputs.
        const array = this.field(statement.iterable, null);
        const items = array === null ? undefined : this.arrayItems.get(array);
        if (items && statement.body.kind === "Block")
          this.statements(statement.body.body, plain, items, statement.value);
        return;
      }
      case "ExpressionStatement": {
        const input = this.input(statement.expression, scope, item);
        if (input) into.push(input);
        return;
      }
      default:
        return;
    }
  }

  /** `definition.x`, or `item.x` inside an array loop, as `x`. */
  private field(expression: Expression | undefined, item: string | null): string | null {
    if (expression?.kind !== "Member" || expression.object.kind !== "Identifier") return null;
    const owner = expression.object.name;
    return owner === "definition" || owner === item ? expression.property : null;
  }

  private input(expression: Expression, scope: Scope, item: string | null): FeatureInput | null {
    const annotation = evaluateAnnotations(this.interpreter, this.module, scope.annotations);
    const named = (id: string) => {
      const label = untag(annotation.getField("Name"));
      return {
        id,
        label: typeof label === "string" ? label : id,
        conditions: scope.conditions,
        group: scope.group,
        annotation,
        span: expression.span,
        bounds: null,
        enumType: null,
        maxPicks: null,
        filter: null,
        items: [],
      };
    };
    const annotatedDefault = annotation.getField("Default");

    if (expression.kind === "Is") {
      const id = this.field(expression.value, item);
      if (id === null) return null;
      const type = this.interpreter.resolveType(expression.type, this.module);
      if (type.kind === "tag" && type.def.kind === "enum") {
        const chosen =
          typeof untag(annotatedDefault) === "string"
            ? (untag(annotatedDefault) as string)
            : type.def.members[0];
        return {
          ...named(id),
          kind: "enum",
          enumType: type.def,
          defaultValue: chosen === undefined ? undefined : new FsTagged(type.def, chosen),
        };
      }
      if (type.kind === "tag" && type.def.name === "Query") {
        const picks = untag(annotation.getField("MaxNumberOfPicks"));
        return {
          ...named(id),
          kind: "query",
          defaultValue: this.interpreter.callFunction(
            this.interpreter.topLevelValue(this.module, "qNothing"),
            [],
          ),
          maxPicks: typeof picks === "number" ? picks : null,
          filter: this.annotationSource(scope.annotations, "Filter"),
        };
      }
      if (type.kind === "standard" && type.name === "boolean")
        return { ...named(id), kind: "boolean", defaultValue: annotatedDefault ?? false };
      if (type.kind === "standard" && type.name === "string")
        return { ...named(id), kind: "string", defaultValue: annotatedDefault ?? "" };
      if (type.kind === "standard" && type.name === "array") {
        const items: FeatureInput[] = [];
        this.arrayItems.set(id, items);
        return { ...named(id), kind: "array", defaultValue: [], items };
      }
      return { ...named(id), kind: "other", defaultValue: annotatedDefault };
    }

    if (expression.kind === "Call" && expression.callee.kind === "Identifier") {
      const kind = QUANTITY[expression.callee.name];
      const id = kind ? this.field(expression.args[0], item) : null;
      if (!kind || id === null) return null;
      const boundsArg = expression.args[1];
      return {
        ...named(id),
        kind,
        ...(boundsArg ? this.quantity(kind, boundsArg) : { defaultValue: undefined, bounds: null }),
      };
    }
    return null;
  }

  /** Source text of `key`'s value in the statement's annotation literals. */
  private annotationSource(annotations: readonly MapLiteral[], key: string): string | null {
    for (const annotation of annotations)
      for (const entry of annotation.entries)
        if (entry.key.kind === "String" && entry.key.value === key)
          return this.source(entry.value.span);
    return null;
  }

  /**
   * Reads a bound spec `{ (unit) : [min, default, max], (otherUnit) : default }`. The default uses the
   * preferred unit when the spec has an entry for it; the bounds use the unit that declares them.
   */
  private quantity(
    kind: InputKind,
    boundsExpression: Expression,
  ): Pick<FeatureInput, "defaultValue" | "bounds"> {
    const spec = untag(this.interpreter.evaluate(boundsExpression, this.module));
    if (!(spec instanceof FsMap)) return { defaultValue: undefined, bounds: null };
    const entries = spec.entries();
    const preferredName = PREFERRED_UNIT[kind];
    const preferred = preferredName
      ? this.interpreter.topLevelValue(this.module, preferredName)
      : undefined;
    const declaring = entries.find(([, value]) => Array.isArray(untag(value)));
    const chosen =
      entries.find(([unit]) => preferred !== undefined && equals(unit, preferred)) ??
      declaring ??
      entries[0];
    if (!chosen) return { defaultValue: undefined, bounds: null };
    const chosenValue = untag(chosen[1]);
    const defaultNumber = Array.isArray(chosenValue)
      ? (chosenValue as readonly FsValue[])[1]
      : chosen[1];
    const range = declaring ? (untag(declaring[1]) as readonly FsValue[]) : null;
    return {
      defaultValue: times(defaultNumber, chosen[0]),
      bounds:
        declaring && range
          ? { min: times(range[0], declaring[0]), max: times(range[2], declaring[0]) }
          : null,
    };
  }
}

/** `n * unit`, where `unit` is a number (unitless) or a ValueWithUnits map. */
function times(n: FsValue, unit: FsValue): FsValue {
  const number = untag(n);
  if (typeof number !== "number") return n;
  const u = untag(unit);
  if (typeof u === "number") return number * u;
  if (!(u instanceof FsMap)) return n;
  const scaled = u.set("value", number * (u.getField("value") as number));
  return unit instanceof FsTagged ? new FsTagged(unit.tag, scaled) : scaled;
}
