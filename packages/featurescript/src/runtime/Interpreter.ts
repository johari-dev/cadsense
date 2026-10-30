import type {
  AssignmentOperator,
  Block,
  Expression,
  Parameter,
  Statement,
  TypeRef,
} from "../syntax/Ast.ts";
import type { Span } from "../syntax/Source.ts";
import { FsFault, FsThrow, type FsFrame } from "./Errors.ts";
import type { Callable, ConstSlot, ModuleInstance, ModuleLoader, Operator } from "./Modules.ts";
import {
  arraySet,
  compare,
  equals,
  formatValue,
  FsBox,
  FsFunction,
  FsMap,
  FsTagged,
  isStandardType,
  standardType,
  untag,
  type FsArray,
  type FsValue,
  type StandardType,
  type TypeDef,
} from "./Value.ts";

type LambdaNode = Extract<Expression, { kind: "Lambda" }>;
type CallNode = Extract<Expression, { kind: "Call" | "Pipe" }>;

/** A type after name resolution: a standard type, or a declared type or enum (a tag). */
export type ResolvedType =
  | { readonly kind: "standard"; readonly name: StandardType }
  | { readonly kind: "tag"; readonly def: TypeDef };

interface Binding {
  value: FsValue;
  readonly constant: boolean;
  readonly type: ResolvedType | null;
}

class Scope {
  readonly vars = new Map<string, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  lookup(name: string): Binding | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
}

/** What a function value runs. */
export type FunctionImpl =
  | {
      readonly kind: "lambda";
      /** The constant or variable it was assigned to when created, for stack traces. */
      readonly name: string;
      readonly node: LambdaNode;
      readonly captured: Scope;
      readonly module: ModuleInstance;
    }
  | { readonly kind: "overloads"; readonly name: string; readonly decls: readonly Callable[] };

interface Frame {
  returnValue: FsValue;
}

interface Env {
  readonly scope: Scope;
  readonly module: ModuleInstance;
  /** Inside a predicate or precondition, expression statements must be `true`. */
  readonly predicate: boolean;
  readonly frame: Frame;
}

/** Statement completion. Statements return these instead of throwing for control flow. */
const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;
/** A predicate statement evaluated to `false`. */
const FAILED = 4;
type Completion = typeof NORMAL | typeof BREAK | typeof CONTINUE | typeof RETURN | typeof FAILED;

/** Where a builtin was called from, plus helpers builtins need. */
export interface BuiltinCall {
  readonly interpreter: Interpreter;
  readonly module: ModuleInstance;
  readonly span: Span;
  /** Raises a catchable FeatureScript exception with a string message. */
  fail(message: string): never;
  /** Stops the run: something this runtime can't do locally (not catchable by FeatureScript). */
  unsupported(message: string): never;
  /** Raises a catchable FeatureScript exception carrying `value` (e.g. a regen error map). */
  raise(value: FsValue): never;
}
export type BuiltinImpl = (args: readonly FsValue[], call: BuiltinCall) => FsValue;
/** Builtins by name. `"unsupported"` marks a std builtin this runtime knowingly lacks. */
export type BuiltinTable = Readonly<Record<string, BuiltinImpl | "unsupported">>;

export interface InterpreterOptions {
  /** Statements and calls before the run is stopped. Default 2e8. */
  readonly maxSteps?: number;
  /**
   * Nested FeatureScript calls before the run is stopped. Default 600: Node's default JS stack fits
   * about 940 (measured), and std's own recursion stays far shallower.
   */
  readonly maxDepth?: number;
}

interface CallRecord {
  readonly name: string;
  readonly callerFile: string;
  readonly span: Span;
}

const TOP = "<top level>";

/**
 * Runs FeatureScript by walking the syntax tree. Not reentrant across threads, but a run may call
 * back into FeatureScript from builtins (callbacks, nested features).
 */
export class Interpreter {
  readonly loader: ModuleLoader;
  private readonly builtins: BuiltinTable;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private steps = 0;
  private readonly calls: CallRecord[] = [];
  private silentDepth = 0;
  /** The last predicate statement that came out false, for precondition error messages. */
  private failedStatement: { readonly module: ModuleInstance; readonly span: Span } | null = null;
  /** `print` output. */
  readonly console: string[] = [];
  /** Exceptions caught by a non-silent `try`; Onshape lists these in the notices pane. */
  readonly notices: FsThrow[] = [];
  /** Builtins called so far, so tests can see which ones a run depends on. */
  readonly builtinsCalled = new Set<string>();

  private readonly typeCache = new WeakMap<TypeRef, ResolvedType>();
  private readonly lambdaFreeNames = new WeakMap<LambdaNode, readonly string[]>();
  private readonly overloadValues = new WeakMap<readonly Callable[], FsFunction<FunctionImpl>>();

  constructor(loader: ModuleLoader, builtins: BuiltinTable, options: InterpreterOptions = {}) {
    this.loader = loader;
    this.builtins = builtins;
    this.maxSteps = options.maxSteps ?? 2e8;
    this.maxDepth = options.maxDepth ?? 600;
  }

  // ------------------------------------------------------------------ public entry points

  /** The value of a top-level name in `module`: a constant, an enum, or a function. */
  topLevelValue(module: ModuleInstance, name: string): FsValue {
    return this.identifierValue(
      { kind: "Identifier", name, namespace: [], span: { start: 0, end: 0 } },
      this.topEnv(module),
    );
  }

  /** Evaluates an expression from `module`'s syntax tree in that module's top-level scope. */
  evaluate(expression: Expression, module: ModuleInstance): FsValue {
    if (this.calls.length === 0) this.steps = 0;
    return this.eval(expression, this.topEnv(module));
  }

  /** Calls a function value, e.g. a feature returned by `defineFeature`. */
  callFunction(
    fn: FsValue,
    args: readonly FsValue[],
    site?: { readonly module: ModuleInstance; readonly span: Span },
  ): FsValue {
    if (!(fn instanceof FsFunction))
      throw new FsFault("internal", "callFunction needs a function value.", []);
    const span = site?.span ?? { start: 0, end: 0 };
    const callerFile = site?.module.path ?? TOP;
    if (this.calls.length > 0)
      return this.callValue(fn as FsFunction<FunctionImpl>, args, span, callerFile);
    // A top-level run: the step budget starts over, and a JS stack overflow becomes a limit fault.
    this.steps = 0;
    try {
      return this.callValue(fn as FsFunction<FunctionImpl>, args, span, callerFile);
    } catch (error) {
      if (error instanceof RangeError)
        throw new FsFault("limit", "Out of stack; recursion is too deep.", []);
      throw error;
    } finally {
      this.calls.length = 0;
    }
  }

  /** A FeatureScript stack for an error raised at `span` in `file`, innermost first. */
  frames(file: string, span: Span): FsFrame[] {
    const calls = this.calls;
    const frames: FsFrame[] = [{ function: calls.at(-1)?.name ?? TOP, file, span }];
    for (let i = calls.length - 1; i >= 0; i--)
      frames.push({
        function: calls[i - 1]?.name ?? TOP,
        file: calls[i]!.callerFile,
        span: calls[i]!.span,
      });
    return frames;
  }

  /** Raises a catchable language error. */
  fail(message: string, module: ModuleInstance, span: Span): never {
    throw new FsThrow(message, this.frames(module.path, span));
  }

  private fault(
    reason: FsFault["reason"],
    message: string,
    module: ModuleInstance,
    span: Span,
  ): never {
    throw new FsFault(reason, message, this.frames(module.path, span));
  }

  private topEnv(module: ModuleInstance): Env {
    return { scope: new Scope(null), module, predicate: false, frame: { returnValue: undefined } };
  }

  private step(env: Env, span: Span) {
    if (++this.steps > this.maxSteps)
      this.fault(
        "limit",
        `Stopped after ${this.maxSteps} steps; is there an infinite loop?`,
        env.module,
        span,
      );
  }

  // ------------------------------------------------------------------ types

  resolveType(type: TypeRef, module: ModuleInstance): ResolvedType {
    const cached = this.typeCache.get(type);
    if (cached) return cached;
    let resolved: ResolvedType;
    if (isStandardType(type.name)) resolved = { kind: "standard", name: type.name };
    else {
      const parts = type.name.split("::");
      const name = parts.pop()!;
      const slot = this.loader
        .lookup(module, name, parts)
        .find((entry) => entry.kind === "type" || entry.kind === "enum");
      if (!slot || (slot.kind !== "type" && slot.kind !== "enum"))
        this.fault("unresolved-name", `Type ${type.name} not found.`, module, type.span);
      resolved = { kind: "tag", def: slot.def };
    }
    this.typeCache.set(type, resolved);
    return resolved;
  }

  isType(value: FsValue, type: ResolvedType): boolean {
    if (type.kind === "tag") return value instanceof FsTagged && value.tag === type.def;
    return standardType(value) === type.name;
  }

  private describe(value: FsValue) {
    return value instanceof FsTagged
      ? `${value.tag.name} (${standardType(value)})`
      : standardType(value);
  }

  // ------------------------------------------------------------------ statements

  private execBlock(block: Block, env: Env): Completion {
    const inner: Env = {
      scope: new Scope(env.scope),
      module: env.module,
      predicate: env.predicate,
      frame: env.frame,
    };
    for (const statement of block.body) {
      const completion = this.exec(statement, inner);
      if (completion !== NORMAL) return completion;
    }
    return NORMAL;
  }

  /** Runs `statement` in its own scope unless it's a block (which makes one anyway). */
  private execScoped(statement: Statement, env: Env): Completion {
    // Loops run their bodies through here, so an empty body still counts toward the step limit.
    if (statement.kind === "Block") {
      this.step(env, statement.span);
      return this.execBlock(statement, env);
    }
    return this.exec(statement, { ...env, scope: new Scope(env.scope) });
  }

  private exec(statement: Statement, env: Env): Completion {
    this.step(env, statement.span);
    switch (statement.kind) {
      case "Block":
        return this.execBlock(statement, env);
      case "Var": {
        if (env.scope.vars.has(statement.name))
          this.fail(
            `${statement.name} is already declared in this scope.`,
            env.module,
            statement.span,
          );
        const type = statement.type ? this.resolveType(statement.type, env.module) : null;
        const init = statement.init;
        const value =
          init === null
            ? undefined
            : init.kind === "Lambda"
              ? this.makeLambda(init, env, statement.name)
              : this.eval(init, env);
        if (type && !this.isType(value, type))
          this.fail(
            `${statement.name} must be ${statement.type!.name}, got ${this.describe(value)}.`,
            env.module,
            statement.span,
          );
        env.scope.vars.set(statement.name, { value, constant: statement.constant, type });
        return NORMAL;
      }
      case "ExpressionStatement": {
        const value = this.eval(statement.expression, env);
        if (!env.predicate || value === true) return NORMAL;
        if (value === false) {
          this.failedStatement = { module: env.module, span: statement.span };
          return FAILED;
        }
        return this.fail(
          `A predicate statement must be true or false, got ${this.describe(value)}.`,
          env.module,
          statement.span,
        );
      }
      case "Assign":
        this.assign(statement.target, statement.operator, statement.value, env);
        return NORMAL;
      case "If": {
        const test = this.condition(statement.test, env);
        if (test) return this.execScoped(statement.consequent, env);
        return statement.alternate ? this.execScoped(statement.alternate, env) : NORMAL;
      }
      case "While":
        while (this.condition(statement.test, env)) {
          const completion = this.execScoped(statement.body, env);
          if (completion === BREAK) break;
          if (completion === RETURN || completion === FAILED) return completion;
        }
        return NORMAL;
      case "For": {
        const loop: Env = { ...env, scope: new Scope(env.scope) };
        if (statement.init) this.exec(statement.init, loop);
        while (statement.test === null || this.condition(statement.test, loop)) {
          const completion = this.execScoped(statement.body, loop);
          if (completion === BREAK) break;
          if (completion === RETURN || completion === FAILED) return completion;
          if (statement.update) this.exec(statement.update, loop);
        }
        return NORMAL;
      }
      case "ForIn":
        return this.execForIn(statement, env);
      case "Return":
        env.frame.returnValue = statement.value ? this.eval(statement.value, env) : undefined;
        return RETURN;
      case "Break":
        return BREAK;
      case "Continue":
        return CONTINUE;
      case "Throw":
        throw new FsThrow(
          this.eval(statement.value, env),
          this.frames(env.module.path, statement.span),
        );
      case "TryStatement": {
        const depth = this.calls.length;
        if (statement.silent) this.silentDepth++;
        try {
          return this.execScoped(statement.body, env);
        } catch (error) {
          if (!(error instanceof FsThrow)) throw error;
          this.calls.length = depth;
          const catchType = statement.catchType
            ? this.resolveType(statement.catchType, env.module)
            : null;
          if (catchType && !this.isType(error.value, catchType)) throw error;
          if (!statement.silent && this.silentDepth === 0) this.notices.push(error);
          if (!statement.handler) return NORMAL;
          const handlerEnv: Env = { ...env, scope: new Scope(env.scope) };
          if (statement.catchName)
            handlerEnv.scope.vars.set(statement.catchName, {
              value: error.value,
              constant: false,
              type: null,
            });
          return this.execScoped(statement.handler, handlerEnv);
        } finally {
          if (statement.silent) this.silentDepth--;
        }
      }
      case "Annotated":
        return this.exec(statement.statement, env);
    }
  }

  private execForIn(statement: Extract<Statement, { kind: "ForIn" }>, env: Env): Completion {
    const container = untag(this.eval(statement.iterable, env));
    let items: (readonly [FsValue, FsValue])[];
    if (Array.isArray(container))
      items = (container as FsArray).map((value, index) => [index, value] as const);
    else if (container instanceof FsMap) items = [...container.entries()];
    else
      return this.fail(
        `for-in needs an array or a map, got ${this.describe(container)}.`,
        env.module,
        statement.iterable.span,
      );
    const isMap = container instanceof FsMap;
    for (const [key, value] of items) {
      const loop: Env = { ...env, scope: new Scope(env.scope) };
      const element =
        statement.key === null && isMap
          ? FsMap.fromEntries([
              ["key", key],
              ["value", value],
            ])
          : value;
      const bind = (name: string, bound: FsValue) => {
        if (statement.declare)
          loop.scope.vars.set(name, { value: bound, constant: false, type: null });
        else this.assignName(name, () => bound, loop, statement.span);
      };
      if (statement.key !== null) bind(statement.key, key);
      bind(statement.value, element);
      const completion = this.execScoped(statement.body, loop);
      if (completion === BREAK) break;
      if (completion === RETURN || completion === FAILED) return completion;
    }
    return NORMAL;
  }

  private condition(expression: Expression, env: Env): boolean {
    const value = this.eval(expression, env);
    if (typeof value !== "boolean")
      this.fail(
        `A condition must be true or false, got ${this.describe(value)}.`,
        env.module,
        expression.span,
      );
    return value;
  }

  // ------------------------------------------------------------------ assignment

  private assign(
    target: Expression,
    operator: AssignmentOperator,
    valueExpression: Expression,
    env: Env,
  ) {
    const update = (old: FsValue): FsValue => {
      if (operator === "=") return this.eval(valueExpression, env);
      if (operator === "||=" || operator === "&&=") {
        if (typeof old !== "boolean")
          this.fail(
            `${operator} needs a boolean, got ${this.describe(old)}.`,
            env.module,
            target.span,
          );
        if (operator === "||=" ? old : !old) return old;
        return this.condition(valueExpression, env);
      }
      if (operator === "??=") return old !== undefined ? old : this.eval(valueExpression, env);
      return this.binary(
        operator.slice(0, -1) as "+",
        old,
        this.eval(valueExpression, env),
        env,
        target.span,
      );
    };
    this.assignTo(target, update, env);
  }

  private assignName(name: string, update: (old: FsValue) => FsValue, env: Env, span: Span) {
    const binding = env.scope.lookup(name);
    if (!binding) {
      if (this.loader.lookup(env.module, name).length)
        this.fail(`Cannot assign to top-level ${name}.`, env.module, span);
      this.fault("unresolved-name", `Variable ${name} not found.`, env.module, span);
    }
    if (binding.constant) this.fail(`Cannot assign to constant ${name}.`, env.module, span);
    const value = update(binding.value);
    if (binding.type && !this.isType(value, binding.type))
      this.fail(
        `${name} must stay ${this.typeName(binding.type)}, got ${this.describe(value)}.`,
        env.module,
        span,
      );
    binding.value = value;
  }

  private typeName(type: ResolvedType) {
    return type.kind === "tag" ? type.def.name : type.name;
  }

  /** Applies `update` to the location `target` names, copying containers along the path. */
  private assignTo(target: Expression, update: (old: FsValue) => FsValue, env: Env): void {
    switch (target.kind) {
      case "Identifier":
        return this.assignName(target.name, update, env, target.span);
      case "Member":
        return this.assignTo(
          target.object,
          (container) =>
            this.setEntry(
              container,
              target.property,
              update(this.member(container, target.property, false, env, target.span)),
              env,
              target.span,
            ),
          env,
        );
      case "Index": {
        const index = this.eval(target.index, env);
        return this.assignTo(
          target.object,
          (container) =>
            this.setEntry(
              container,
              index,
              update(this.index(container, index, false, env, target.span)),
              env,
              target.span,
            ),
          env,
        );
      }
      case "Deref": {
        const box = untag(this.eval(target.object, env));
        if (!(box instanceof FsBox))
          this.fail(`x[] = ... needs a box, got ${this.describe(box)}.`, env.module, target.span);
        box.value = update(box.value);
        return;
      }
      default:
        this.fail("This expression can't be assigned to.", env.module, target.span);
    }
  }

  private setEntry(
    container: FsValue,
    key: FsValue,
    value: FsValue,
    env: Env,
    span: Span,
  ): FsValue {
    const tag = container instanceof FsTagged ? container.tag : null;
    const inner = untag(container);
    let updated: FsValue;
    if (inner instanceof FsMap) updated = inner.set(key, value);
    else if (Array.isArray(inner))
      updated = arraySet(inner, this.arrayIndex(inner as FsArray, key, env, span), value);
    else
      return this.fail(
        `Cannot set ${typeof key === "string" ? `field "${key}"` : "an element"} of ${this.describe(container)}.`,
        env.module,
        span,
      );
    return tag ? new FsTagged(tag, updated as FsArray | FsMap) : updated;
  }

  private arrayIndex(array: FsArray, key: FsValue, env: Env, span: Span): number {
    const index = untag(key);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= array.length)
      this.fail(
        `Array index ${formatValue(key)} is out of range for an array of size ${array.length}.`,
        env.module,
        span,
      );
    return index;
  }

  // ------------------------------------------------------------------ expressions

  eval(expression: Expression, env: Env): FsValue {
    switch (expression.kind) {
      case "Number":
      case "String":
      case "Boolean":
        return expression.value;
      case "Undefined":
        return undefined;
      case "Identifier":
        return this.identifierValue(expression, env);
      case "Builtin":
        return this.fault(
          "unresolved-name",
          `@${expression.name} can only be called.`,
          env.module,
          expression.span,
        );
      case "Array":
        return expression.elements.map((element) => this.eval(element, env));
      case "Map":
        return FsMap.fromEntries(
          expression.entries.map(
            (entry) => [this.eval(entry.key, env), this.eval(entry.value, env)] as const,
          ),
        );
      case "Unary": {
        const operand = this.eval(expression.operand, env);
        if (expression.operator === "!") {
          if (typeof operand !== "boolean")
            this.fail(
              `! needs a boolean, got ${this.describe(operand)}.`,
              env.module,
              expression.span,
            );
          return !operand;
        }
        if (typeof operand === "number") return -operand;
        const overload = this.findOperator("-", [operand]);
        if (overload) return this.invokeOperator(overload, [operand], env, expression.span);
        const base = untag(operand);
        if (typeof base === "number") return -base;
        return this.fail(`Cannot negate ${this.describe(operand)}.`, env.module, expression.span);
      }
      case "Binary": {
        const op = expression.operator;
        if (op === "&&" || op === "||") {
          const left = this.eval(expression.left, env);
          if (typeof left !== "boolean")
            this.fail(
              `${op} needs booleans, got ${this.describe(left)}.`,
              env.module,
              expression.left.span,
            );
          if (op === "&&" ? !left : left) return left;
          const right = this.eval(expression.right, env);
          if (typeof right !== "boolean")
            this.fail(
              `${op} needs booleans, got ${this.describe(right)}.`,
              env.module,
              expression.right.span,
            );
          return right;
        }
        if (op === "??") {
          const left = this.eval(expression.left, env);
          return left !== undefined ? left : this.eval(expression.right, env);
        }
        const left = this.eval(expression.left, env);
        const right = this.eval(expression.right, env);
        return this.binary(op, left, right, env, expression.span);
      }
      case "Conditional":
        return this.condition(expression.test, env)
          ? this.eval(expression.consequent, env)
          : this.eval(expression.alternate, env);
      case "Is":
        return this.isType(
          this.eval(expression.value, env),
          this.resolveType(expression.type, env.module),
        );
      case "As":
        return this.cast(this.eval(expression.value, env), expression.type, env);
      case "Call":
      case "Pipe":
        return this.evalCall(expression, env);
      case "Member":
        return this.member(
          this.eval(expression.object, env),
          expression.property,
          expression.optional,
          env,
          expression.span,
        );
      case "Index": {
        const object = this.eval(expression.object, env);
        if (object === undefined && expression.optional) return undefined;
        return this.index(
          object,
          this.eval(expression.index, env),
          expression.optional,
          env,
          expression.span,
        );
      }
      case "Deref": {
        const box = untag(this.eval(expression.object, env));
        if (box === undefined && expression.optional) return undefined;
        if (!(box instanceof FsBox))
          return this.fail(
            `x[] needs a box, got ${this.describe(box)}.`,
            env.module,
            expression.span,
          );
        return box.value;
      }
      case "Lambda":
        return this.makeLambda(expression, env);
      case "NewBox":
        return new FsBox(this.eval(expression.value, env));
      case "Try": {
        const depth = this.calls.length;
        if (expression.silent) this.silentDepth++;
        try {
          return this.eval(expression.expression, env);
        } catch (error) {
          if (!(error instanceof FsThrow)) throw error;
          this.calls.length = depth;
          if (!expression.silent && this.silentDepth === 0) this.notices.push(error);
          return undefined;
        } finally {
          if (expression.silent) this.silentDepth--;
        }
      }
      case "Switch": {
        const value = this.eval(expression.discriminant, env);
        // Only the matching case is evaluated; std passes expensive calls as case values.
        for (const entry of expression.cases.entries)
          if (equals(this.eval(entry.key, env), value)) return this.eval(entry.value, env);
        return undefined;
      }
    }
  }

  private identifierValue(node: Extract<Expression, { kind: "Identifier" }>, env: Env): FsValue {
    if (node.namespace.length === 0) {
      const binding = env.scope.lookup(node.name);
      if (binding) return binding.value;
    }
    const found = this.loader.lookup(env.module, node.name, node.namespace);
    if (found.length === 0)
      return this.fault(
        "unresolved-name",
        `${[...node.namespace, node.name].join("::")} not found.`,
        env.module,
        node.span,
      );
    // Functions overload across imports, but a module's own constant or enum shadows whatever it
    // imports under that name.
    const own = found.filter((entry) => entry.module === env.module);
    const visible = own.some((entry) => entry.kind !== "callable") ? own : found;
    const callables = visible.filter((entry): entry is Callable => entry.kind === "callable");
    if (callables.length) return this.overloadValue(node.name, callables);
    const candidates = own.length ? own : visible;
    if (candidates.length > 1)
      return this.fault(
        "unresolved-name",
        `${node.name} is ambiguous: declared in ${candidates.map((c) => c.module.path).join(", ")}.`,
        env.module,
        node.span,
      );
    const entry = candidates[0]!;
    if (entry.kind === "const") return this.constValue(entry, node.span);
    if (entry.kind === "enum") return this.loader.enumValue(entry.def);
    return this.fault(
      "unresolved-name",
      `Type ${node.name} can't be used as a value.`,
      env.module,
      node.span,
    );
  }

  private overloadValue(name: string, decls: readonly Callable[]): FsFunction<FunctionImpl> {
    let value = this.overloadValues.get(decls);
    if (!value) {
      value = new FsFunction<FunctionImpl>({ kind: "overloads", name, decls });
      this.overloadValues.set(decls, value);
    }
    return value;
  }

  private constValue(slot: ConstSlot, span: Span): FsValue {
    if (slot.state === "done") return slot.value;
    if (slot.state === "evaluating")
      this.fault("internal", `Constant ${slot.node.name} depends on itself.`, slot.module, span);
    slot.state = "evaluating";
    try {
      const env = this.topEnv(slot.module);
      const init = slot.node.value;
      const value =
        init.kind === "Lambda" ? this.makeLambda(init, env, slot.node.name) : this.eval(init, env);
      if (slot.node.type && !this.isType(value, this.resolveType(slot.node.type, slot.module)))
        this.fail(
          `Constant ${slot.node.name} must be ${slot.node.type.name}, got ${this.describe(value)}.`,
          slot.module,
          slot.node.span,
        );
      slot.value = value;
      slot.state = "done";
      return value;
    } finally {
      if (slot.state === "evaluating") slot.state = "pending";
    }
  }

  private cast(value: FsValue, type: TypeRef, env: Env): FsValue {
    const resolved = this.resolveType(type, env.module);
    const base = untag(value);
    if (resolved.kind === "standard") {
      if (standardType(base) !== resolved.name)
        this.fail(
          `Cannot convert ${this.describe(value)} to ${resolved.name}.`,
          env.module,
          type.span,
        );
      return base;
    }
    if (
      resolved.def.kind === "enum" &&
      (typeof base !== "string" || !resolved.def.ordinals.has(base))
    )
      this.fail(
        `${formatValue(base)} is not a member of ${resolved.def.name}.`,
        env.module,
        type.span,
      );
    return new FsTagged(resolved.def, base);
  }

  member(object: FsValue, property: string, optional: boolean, env: Env, span: Span): FsValue {
    const base = untag(object);
    if (base instanceof FsMap) return base.getField(property);
    if (base === undefined && optional) return undefined;
    return this.fail(
      `Cannot read field "${property}" of ${this.describe(object)}.`,
      env.module,
      span,
    );
  }

  private index(object: FsValue, key: FsValue, optional: boolean, env: Env, span: Span): FsValue {
    const base = untag(object);
    if (base instanceof FsMap) return base.get(key);
    if (Array.isArray(base))
      return (base as FsArray)[this.arrayIndex(base as FsArray, key, env, span)];
    if (base === undefined && optional) return undefined;
    return this.fail(`Cannot index ${this.describe(object)}.`, env.module, span);
  }

  // ------------------------------------------------------------------ operators

  private binary(op: string, left: FsValue, right: FsValue, env: Env, span: Span): FsValue {
    if (typeof left === "number" && typeof right === "number") {
      if (op === "<" || op === ">" || op === "<=" || op === ">=")
        return this.compareNumbers(op, left, right);
      if (op !== "==" && op !== "!=" && op !== "~")
        return this.arithmetic(op, left, right, env, span);
    }
    switch (op) {
      case "==":
        return equals(left, right);
      case "!=":
        return !equals(left, right);
      case "~":
        return (
          (typeof left === "string" ? left : formatValue(left)) +
          (typeof right === "string" ? right : formatValue(right))
        );
      case "<":
        return this.lessThan(left, right, env, span);
      case ">":
        return this.lessThan(right, left, env, span);
      case "<=":
        return !this.lessThan(right, left, env, span);
      case ">=":
        return !this.lessThan(left, right, env, span);
    }
    if (left instanceof FsTagged || right instanceof FsTagged) {
      const overload = this.findOperator(op, [left, right]);
      if (overload) return this.invokeOperator(overload, [left, right], env, span);
      const a = untag(left);
      const b = untag(right);
      // Predefined operators still apply to tagged numbers, with an untagged result.
      if (typeof a === "number" && typeof b === "number")
        return this.arithmetic(op, a, b, env, span);
    }
    return this.fail(
      `Operator ${op} can't be applied to ${this.describe(left)} and ${this.describe(right)}.`,
      env.module,
      span,
    );
  }

  private compareNumbers(op: "<" | ">" | "<=" | ">=", a: number, b: number) {
    return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
  }

  private arithmetic(op: string, a: number, b: number, env: Env, span: Span): number {
    let result: number;
    switch (op) {
      case "+":
        result = a + b;
        break;
      case "-":
        result = a - b;
        break;
      case "*":
        result = a * b;
        break;
      case "/":
        result = a / b;
        break;
      case "%":
        // The result takes the sign of the second operand.
        result = a - b * Math.floor(a / b);
        break;
      case "^":
        result = a ** b;
        break;
      default:
        return this.fail(`Operator ${op} can't be applied to numbers.`, env.module, span);
    }
    if (Number.isNaN(result)) this.fail(`${a} ${op} ${b} is not a number.`, env.module, span);
    return result;
  }

  private lessThan(left: FsValue, right: FsValue, env: Env, span: Span): boolean {
    if (typeof left === "number" && typeof right === "number") return left < right;
    if (typeof left === "string" && typeof right === "string") return left < right;
    if (
      left instanceof FsTagged &&
      right instanceof FsTagged &&
      left.tag === right.tag &&
      left.tag.kind === "enum"
    )
      return compare(left, right) < 0;
    if (left instanceof FsTagged || right instanceof FsTagged) {
      const overload = this.findOperator("<", [left, right]);
      if (overload) {
        const result = this.invokeOperator(overload, [left, right], env, span);
        if (typeof result !== "boolean")
          this.fail("operator< must return a boolean.", env.module, span);
        return result;
      }
      const a = untag(left);
      const b = untag(right);
      if (typeof a === "number" && typeof b === "number") return a < b;
    }
    return this.fail(
      `Cannot compare ${this.describe(left)} with ${this.describe(right)}.`,
      env.module,
      span,
    );
  }

  private findOperator(op: string, args: readonly FsValue[]): Operator | undefined {
    const candidates = this.loader.operators.get(op);
    if (!candidates) return undefined;
    const satisfying = candidates.filter((candidate) =>
      this.satisfies(candidate.node.params, candidate.module, args),
    );
    return this.mostSpecific(satisfying, (candidate) =>
      this.specificity(candidate.node.params, candidate.module),
    );
  }

  private invokeOperator(
    operator: Operator,
    args: readonly FsValue[],
    env: Env,
    span: Span,
  ): FsValue {
    return this.invokeDeclaration(
      `operator${operator.node.operator}`,
      operator.node,
      operator.module,
      args,
      span,
      env.module.path,
    );
  }

  // ------------------------------------------------------------------ calls

  private evalCall(node: CallNode, env: Env): FsValue {
    const callee = node.callee;
    const argExpressions = node.kind === "Pipe" ? [node.receiver, ...node.args] : node.args;
    if (callee.kind === "Builtin")
      return this.callBuiltin(callee.name, argExpressions, env, node.span);
    let fn: FsValue;
    if (callee.kind === "Identifier") {
      const local = callee.namespace.length === 0 ? env.scope.lookup(callee.name) : undefined;
      if (local?.value instanceof FsFunction) fn = local.value;
      else {
        const found = this.loader.lookup(env.module, callee.name, callee.namespace);
        const callables = found.filter((entry): entry is Callable => entry.kind === "callable");
        if (callables.length) {
          const args = argExpressions.map((arg) => this.eval(arg, env));
          return this.callOverloads(callee.name, callables, args, node.span, env.module.path);
        }
        fn = local ? local.value : this.identifierValue(callee, env);
      }
    } else fn = this.eval(callee, env);
    if (!(fn instanceof FsFunction))
      return this.fail(`Cannot call ${this.describe(fn)}.`, env.module, callee.span);
    const args = argExpressions.map((arg) => this.eval(arg, env));
    return this.callValue(fn as FsFunction<FunctionImpl>, args, node.span, env.module.path);
  }

  private callValue(
    fn: FsFunction<FunctionImpl>,
    args: readonly FsValue[],
    span: Span,
    callerFile: string,
  ): FsValue {
    const impl = fn.impl;
    if (impl.kind === "overloads")
      return this.callOverloads(impl.name, impl.decls, args, span, callerFile);
    return this.invokeDeclaration(
      impl.name,
      impl.node,
      impl.module,
      args,
      span,
      callerFile,
      impl.captured,
    );
  }

  private callBuiltin(
    name: string,
    argExpressions: readonly Expression[],
    env: Env,
    span: Span,
  ): FsValue {
    const impl = this.builtins[name];
    if (impl === undefined || impl === "unsupported")
      this.fault("unsupported-builtin", `@${name} is not supported locally yet.`, env.module, span);
    const args = argExpressions.map((arg) => this.eval(arg, env));
    this.builtinsCalled.add(name);
    const module = env.module;
    return impl(args, {
      interpreter: this,
      module,
      span,
      fail: (message: string) => this.fail(message, module, span),
      unsupported: (message: string) => this.fault("unsupported-builtin", message, module, span),
      raise: (value: FsValue) => {
        throw new FsThrow(value, this.frames(module.path, span));
      },
    });
  }

  private satisfies(
    params: readonly Parameter[],
    module: ModuleInstance,
    args: readonly FsValue[],
  ) {
    if (params.length !== args.length) return false;
    for (let i = 0; i < params.length; i++) {
      const type = params[i]!.type;
      if (type && !this.isType(args[i], this.resolveType(type, module))) return false;
    }
    return true;
  }

  /** Per parameter: 2 for a tag constraint, 1 for a standard type, 0 for none. */
  private specificity(params: readonly Parameter[], module: ModuleInstance): number[] {
    return params.map((param) =>
      param.type === null ? 0 : this.resolveType(param.type, module).kind === "tag" ? 2 : 1,
    );
  }

  /** The candidate more specific than every other, or undefined if there's no unique one. */
  private mostSpecific<T>(
    candidates: readonly T[],
    specificity: (candidate: T) => number[],
  ): T | undefined {
    if (candidates.length <= 1) return candidates[0];
    const specs = candidates.map(specificity);
    outer: for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        let strictly = false;
        for (let k = 0; k < specs[i]!.length; k++) {
          if (specs[i]![k]! < specs[j]![k]!) continue outer;
          if (specs[i]![k]! > specs[j]![k]!) strictly = true;
        }
        if (!strictly) continue outer;
      }
      return candidates[i];
    }
    return undefined;
  }

  private callOverloads(
    name: string,
    decls: readonly Callable[],
    args: readonly FsValue[],
    span: Span,
    callerFile: string,
  ): FsValue {
    const satisfying = decls.filter((decl) => this.satisfies(decl.node.params, decl.module, args));
    const chosen = this.mostSpecific(satisfying, (decl) =>
      this.specificity(decl.node.params, decl.module),
    );
    if (!chosen) {
      const types = `(${args.map((arg) => this.describe(arg)).join(", ")})`;
      throw new FsThrow(
        satisfying.length
          ? `Call to ${name}${types} is ambiguous.`
          : `No overload of ${name} accepts ${types}.`,
        this.frames(callerFile, span),
      );
    }
    return this.invokeDeclaration(name, chosen.node, chosen.module, args, span, callerFile);
  }

  /** Runs a function, predicate, operator or lambda with already-matched arguments. */
  private invokeDeclaration(
    name: string,
    node: {
      readonly kind: string;
      readonly params: readonly Parameter[];
      readonly returns: TypeRef | null;
      readonly precondition: Block | Expression | null;
      readonly body: Block | Expression;
    },
    module: ModuleInstance,
    args: readonly FsValue[],
    span: Span,
    callerFile: string,
    captured: Scope | null = null,
  ): FsValue {
    if (this.calls.length >= this.maxDepth)
      throw new FsFault(
        "limit",
        `Calls nested more than ${this.maxDepth} deep.`,
        this.frames(callerFile, span),
      );
    this.calls.push({ name, callerFile, span });
    const depth = this.calls.length;
    try {
      const scope = new Scope(captured);
      const env: Env = { scope, module, predicate: false, frame: { returnValue: undefined } };
      if (node.params.length !== args.length)
        this.fail(
          `${name} takes ${node.params.length} argument(s), got ${args.length}.`,
          module,
          span,
        );
      node.params.forEach((param, i) => {
        const type = param.type ? this.resolveType(param.type, module) : null;
        // Lambdas check types here; top-level overloads were already matched on them.
        if (type && captured && !this.isType(args[i], type))
          this.fail(
            `Argument ${param.name} must be ${param.type!.name}, got ${this.describe(args[i])}.`,
            module,
            param.span,
          );
        scope.vars.set(param.name, { value: args[i], constant: false, type });
      });
      if (node.precondition) {
        const precondition = node.precondition;
        const ok =
          precondition.kind === "Block"
            ? this.execBlock(precondition, { ...env, predicate: true }) !== FAILED
            : this.predicateValue(precondition, env);
        if (!ok) {
          const failed =
            precondition.kind === "Block"
              ? this.failedStatement
              : { module, span: precondition.span };
          const detail = failed
            ? `: ${failed.module.file.text.slice(failed.span.start, failed.span.end).trim()}`
            : ".";
          this.fail(
            `Precondition of ${name} failed${detail}`,
            module,
            failed?.module === module ? failed.span : precondition.span,
          );
        }
      }
      if (node.kind === "Predicate")
        return this.execBlock(node.body as Block, { ...env, predicate: true }) !== FAILED;
      let result: FsValue;
      if (node.body.kind === "Block") {
        this.execBlock(node.body, env);
        result = env.frame.returnValue;
      } else result = this.eval(node.body as Expression, env);
      if (node.returns) {
        const type = this.resolveType(node.returns, module);
        if (!this.isType(result, type))
          this.fail(
            `${name} must return ${node.returns.name}, returned ${this.describe(result)}.`,
            module,
            node.returns.span,
          );
      }
      return result;
    } finally {
      this.calls.length = depth - 1;
    }
  }

  private predicateValue(expression: Expression, env: Env): boolean {
    const value = this.eval(expression, env);
    if (typeof value !== "boolean")
      this.fail(
        `A precondition must be true or false, got ${this.describe(value)}.`,
        env.module,
        expression.span,
      );
    return value;
  }

  // ------------------------------------------------------------------ lambdas

  private makeLambda(node: LambdaNode, env: Env, name = "function"): FsFunction<FunctionImpl> {
    const captured = new Scope(null);
    for (const name of this.freeNames(node)) {
      const binding = env.scope.lookup(name);
      // Captured by value at creation; later changes outside don't reach the lambda.
      if (binding)
        captured.vars.set(name, { value: binding.value, constant: false, type: binding.type });
    }
    return new FsFunction<FunctionImpl>({
      kind: "lambda",
      name,
      node,
      captured,
      module: env.module,
    });
  }

  /** Identifiers a lambda body mentions, a superset of what it captures. Cached per lambda. */
  private freeNames(node: LambdaNode): readonly string[] {
    const cached = this.lambdaFreeNames.get(node);
    if (cached) return cached;
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.kind === "Identifier" && (record.namespace as unknown[]).length === 0)
        names.add(record.name as string);
      for (const key in record) if (key !== "span") walk(record[key]);
    };
    walk(node.body);
    walk(node.precondition);
    for (const param of node.params) names.delete(param.name);
    const result = [...names];
    this.lambdaFreeNames.set(node, result);
    return result;
  }
}
