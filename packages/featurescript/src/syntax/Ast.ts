import type { Span } from "./Source.ts";

/** A type name after `is`, `as`, `returns`, or in a parameter: `number`, `Query`, `function`, `ns::Type`. */
export interface TypeRef {
  readonly name: string;
  readonly span: Span;
}

export interface Parameter {
  readonly name: string;
  readonly type: TypeRef | null;
  readonly span: Span;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "~"
  | "<"
  | ">"
  | "<="
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??";
export type AssignmentOperator =
  | "="
  | "+="
  | "-="
  | "*="
  | "/="
  | "^="
  | "%="
  | "||="
  | "&&="
  | "??="
  | "~=";

/** A map literal entry. `key` is a string literal for bare identifiers (`{ a : 1 }`). */
export interface MapEntry {
  readonly key: Expression;
  readonly value: Expression;
}

/** Shared by named functions, lambdas, and operator overloads. */
export interface FunctionParts {
  readonly params: readonly Parameter[];
  readonly returns: TypeRef | null;
  /** `precondition { ... }` or `precondition expr;`. */
  readonly precondition: Block | Expression | null;
}

export type Expression =
  | { readonly kind: "Number"; readonly value: number; readonly span: Span }
  | { readonly kind: "String"; readonly value: string; readonly span: Span }
  | { readonly kind: "Boolean"; readonly value: boolean; readonly span: Span }
  | { readonly kind: "Undefined"; readonly span: Span }
  /** A variable or top-level name; `namespace` holds `a::b::` qualifiers. */
  | {
      readonly kind: "Identifier";
      readonly name: string;
      readonly namespace: readonly string[];
      readonly span: Span;
    }
  /** `@name`, only valid as a callee. */
  | { readonly kind: "Builtin"; readonly name: string; readonly span: Span }
  | { readonly kind: "Array"; readonly elements: readonly Expression[]; readonly span: Span }
  | { readonly kind: "Map"; readonly entries: readonly MapEntry[]; readonly span: Span }
  | {
      readonly kind: "Unary";
      readonly operator: "-" | "!";
      readonly operand: Expression;
      readonly span: Span;
    }
  | {
      readonly kind: "Binary";
      readonly operator: BinaryOperator;
      readonly left: Expression;
      readonly right: Expression;
      readonly span: Span;
    }
  | {
      readonly kind: "Conditional";
      readonly test: Expression;
      readonly consequent: Expression;
      readonly alternate: Expression;
      readonly span: Span;
    }
  | { readonly kind: "Is"; readonly value: Expression; readonly type: TypeRef; readonly span: Span }
  | { readonly kind: "As"; readonly value: Expression; readonly type: TypeRef; readonly span: Span }
  | {
      readonly kind: "Call";
      readonly callee: Expression;
      readonly args: readonly Expression[];
      readonly span: Span;
    }
  /** `x->f(a)`: calls `f(x, a)`. `callee` is always an identifier. */
  | {
      readonly kind: "Pipe";
      readonly receiver: Expression;
      readonly callee: Expression;
      readonly args: readonly Expression[];
      readonly span: Span;
    }
  | {
      readonly kind: "Member";
      readonly object: Expression;
      readonly property: string;
      readonly optional: boolean;
      readonly span: Span;
    }
  | {
      readonly kind: "Index";
      readonly object: Expression;
      readonly index: Expression;
      readonly optional: boolean;
      readonly span: Span;
    }
  /** `x[]`: the value inside a box. `x?[]` is undefined when `x` is. */
  | {
      readonly kind: "Deref";
      readonly object: Expression;
      readonly optional: boolean;
      readonly span: Span;
    }
  | ({
      readonly kind: "Lambda";
      readonly body: Block | Expression;
      readonly span: Span;
    } & FunctionParts)
  | { readonly kind: "NewBox"; readonly value: Expression; readonly span: Span }
  /** `try(expr)` / `try silent(expr)`: undefined if `expr` throws. */
  | {
      readonly kind: "Try";
      readonly silent: boolean;
      readonly expression: Expression;
      readonly span: Span;
    }
  /** `switch (x) { k : v, ... }`: the value for key `x`. */
  | {
      readonly kind: "Switch";
      readonly discriminant: Expression;
      readonly cases: Extract<Expression, { kind: "Map" }>;
      readonly span: Span;
    };

export type Statement =
  | { readonly kind: "Block"; readonly body: readonly Statement[]; readonly span: Span }
  | {
      readonly kind: "Var";
      readonly constant: boolean;
      readonly name: string;
      readonly type: TypeRef | null;
      readonly init: Expression | null;
      readonly span: Span;
    }
  | { readonly kind: "ExpressionStatement"; readonly expression: Expression; readonly span: Span }
  | {
      readonly kind: "Assign";
      readonly operator: AssignmentOperator;
      readonly target: Expression;
      readonly value: Expression;
      readonly span: Span;
    }
  | {
      readonly kind: "If";
      readonly test: Expression;
      readonly consequent: Statement;
      readonly alternate: Statement | null;
      readonly span: Span;
    }
  | {
      readonly kind: "While";
      readonly test: Expression;
      readonly body: Statement;
      readonly span: Span;
    }
  | {
      readonly kind: "For";
      readonly init: Statement | null;
      readonly test: Expression | null;
      readonly update: Statement | null;
      readonly body: Statement;
      readonly span: Span;
    }
  /** `for (var v in x)` or `for (var k, v in x)`; `declare` is false when `var` is omitted. */
  | {
      readonly kind: "ForIn";
      readonly declare: boolean;
      readonly key: string | null;
      readonly value: string;
      readonly iterable: Expression;
      readonly body: Statement;
      readonly span: Span;
    }
  | { readonly kind: "Return"; readonly value: Expression | null; readonly span: Span }
  | { readonly kind: "Break"; readonly span: Span }
  | { readonly kind: "Continue"; readonly span: Span }
  | { readonly kind: "Throw"; readonly value: Expression; readonly span: Span }
  | {
      readonly kind: "TryStatement";
      readonly silent: boolean;
      readonly body: Statement;
      readonly catchName: string | null;
      readonly catchType: TypeRef | null;
      readonly handler: Statement | null;
      readonly span: Span;
    }
  /** `annotation { ... } statement`, used for feature UI specs in preconditions. */
  | {
      readonly kind: "Annotated";
      readonly annotation: Extract<Expression, { kind: "Map" }>;
      readonly statement: Statement;
      readonly span: Span;
    };

export type Block = Extract<Statement, { kind: "Block" }>;
export type MapLiteral = Extract<Expression, { kind: "Map" }>;

interface DeclarationBase {
  readonly exported: boolean;
  readonly annotations: readonly MapLiteral[];
  readonly span: Span;
}

export type Declaration =
  | ({
      readonly kind: "Import";
      readonly namespace: readonly string[];
      readonly path: string;
      readonly version: string;
    } & DeclarationBase)
  | ({
      readonly kind: "Const";
      readonly name: string;
      readonly type: TypeRef | null;
      readonly value: Expression;
    } & DeclarationBase)
  | ({ readonly kind: "Function"; readonly name: string; readonly body: Block } & FunctionParts &
      DeclarationBase)
  /** Each expression statement in the body must be true; `returns` is always null. */
  | ({ readonly kind: "Predicate"; readonly name: string; readonly body: Block } & FunctionParts &
      DeclarationBase)
  | ({
      readonly kind: "Operator";
      readonly operator: "+" | "-" | "*" | "/" | "%" | "^" | "<";
      readonly body: Block;
    } & FunctionParts &
      DeclarationBase)
  | ({
      readonly kind: "Type";
      readonly name: string;
      readonly typecheck: TypeRef;
    } & DeclarationBase)
  | ({
      readonly kind: "Enum";
      readonly name: string;
      readonly members: readonly {
        readonly name: string;
        readonly annotations: readonly MapLiteral[];
        readonly span: Span;
      }[];
    } & DeclarationBase);

export interface Module {
  /** From `FeatureScript 3083;`. Null if the header is missing. */
  readonly version: number | null;
  readonly declarations: readonly Declaration[];
}
