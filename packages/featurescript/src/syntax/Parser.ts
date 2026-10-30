import type {
  AssignmentOperator,
  BinaryOperator,
  Block,
  Declaration,
  Expression,
  FunctionParts,
  MapEntry,
  MapLiteral,
  Module,
  Parameter,
  Statement,
  TypeRef,
} from "./Ast.ts";
import type { Diagnostic, DiagnosticCode } from "./Diagnostic.ts";
import { tokenize, type Keyword, type Punctuator, type Token } from "./Lexer.ts";
import type { SourceFile, Span } from "./Source.ts";

/** Thrown inside the parser only; caught at statement and declaration boundaries for recovery. */
class ParseFailure {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) {
    this.diagnostic = diagnostic;
  }
}

const ASSIGNMENT_OPERATORS = new Set<string>([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "^=",
  "%=",
  "||=",
  "&&=",
  "??=",
  "~=",
]);
const OVERLOADABLE = new Set<string>(["+", "-", "*", "/", "%", "^", "<"]);
/** Keywords that can name a type after `is`/`as`/`returns`. */
const TYPE_KEYWORDS = new Set<string>(["function", "undefined"]);

/** Binary precedence, higher binds tighter. `?:` sits below all of these; unary and `^` above. */
const BINARY_PRECEDENCE: Readonly<Partial<Record<string, number>>> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  is: 5,
  as: 5,
  "+": 6,
  "-": 6,
  "~": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

/**
 * Parses one FeatureScript module. Always returns a module; syntax errors are reported as
 * diagnostics and the parser resumes at the next statement or declaration.
 */
export function parseModule(file: SourceFile): { module: Module; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics } = tokenize(file);
  const result = new Parser(tokens, diagnostics).module();
  // Lexer and parser diagnostics interleave; report them in source order.
  result.diagnostics.sort((a, b) => a.span.start - b.span.start);
  return result;
}

/**
 * Parses a single expression, such as a feature parameter value (`5 * millimeter`,
 * `qCreatedBy(makeId("Feature1"), EntityType.FACE)`). Anything after the expression is an error.
 */
export function parseExpression(file: SourceFile): {
  expression: Expression | null;
  diagnostics: Diagnostic[];
} {
  const { tokens, diagnostics } = tokenize(file);
  const parser = new Parser(tokens, diagnostics);
  const expression = parser.standaloneExpression();
  diagnostics.sort((a, b) => a.span.start - b.span.start);
  return { expression, diagnostics };
}

class Parser {
  private index = 0;
  private readonly tokens: readonly Token[];
  private readonly diagnostics: Diagnostic[];

  constructor(tokens: readonly Token[], diagnostics: Diagnostic[]) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  // ---------------------------------------------------------------- token helpers

  private get token(): Token {
    return this.tokens[this.index]!;
  }
  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }
  private advance(): Token {
    const token = this.token;
    if (token.kind !== "eof") this.index++;
    return token;
  }
  private isPunct(value: Punctuator, token = this.token) {
    return token.kind === "punctuator" && token.value === value;
  }
  private isKeyword(value: Keyword, token = this.token) {
    return token.kind === "keyword" && token.value === value;
  }
  private eatPunct(value: Punctuator) {
    if (!this.isPunct(value)) return false;
    this.advance();
    return true;
  }
  private eatKeyword(value: Keyword) {
    if (!this.isKeyword(value)) return false;
    this.advance();
    return true;
  }
  private fail(code: DiagnosticCode, message: string, span: Span = this.token): never {
    throw new ParseFailure({ code, message, span: { start: span.start, end: span.end } });
  }
  private describe(token: Token) {
    if (token.kind === "eof") return "the end of the file";
    if (token.kind === "string") return "a string";
    if (token.kind === "number") return "a number";
    return `"${token.kind === "builtin" ? "@" : ""}${token.value}"`;
  }
  private expectPunct(value: Punctuator, context?: string): Token {
    if (this.isPunct(value)) return this.advance();
    // A missing `;` is reported right after the previous token, where it belongs.
    const previous = this.tokens[this.index - 1];
    const at = value === ";" && previous ? { start: previous.end, end: previous.end } : this.token;
    return this.fail(
      "expected",
      `Expected "${value}"${context ? ` ${context}` : ""} but found ${this.describe(this.token)}.`,
      at,
    );
  }
  private expectKeyword(value: Keyword): Token {
    if (this.isKeyword(value)) return this.advance();
    return this.fail("expected", `Expected "${value}" but found ${this.describe(this.token)}.`);
  }
  /** Identifiers, plus keywords where a plain name is unambiguous (after `.`, as map keys). */
  private name(allowKeywords = false): { value: string; span: Span } {
    const token = this.token;
    if (token.kind === "identifier" || (allowKeywords && token.kind === "keyword")) {
      this.advance();
      return { value: token.value, span: token };
    }
    return this.fail("expected", `Expected a name but found ${this.describe(token)}.`);
  }
  private spanFrom(start: number): Span {
    return { start, end: this.tokens[this.index - 1]?.end ?? start };
  }

  // ---------------------------------------------------------------- module

  standaloneExpression(): Expression | null {
    try {
      const expression = this.expression();
      if (this.token.kind !== "eof")
        this.fail(
          "unexpected-token",
          `Expected the end of the expression but found ${this.describe(this.token)}.`,
        );
      return expression;
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      this.report(error.diagnostic);
      return null;
    }
  }

  module(): { module: Module; diagnostics: Diagnostic[] } {
    let version: number | null = null;
    if (this.token.kind === "identifier" && this.token.value === "FeatureScript") {
      this.advance();
      const number = this.tokens[this.index]!;
      if (number.kind === "number") {
        this.advance();
        version = number.value;
      } else
        this.report({
          code: "expected",
          message: "Expected a version number after FeatureScript.",
          span: number,
        });
      this.recover(() => this.expectPunct(";", "after the FeatureScript version"));
    } else {
      this.report({
        code: "missing-version",
        message: 'A module must start with a version header such as "FeatureScript 3083;".',
        span: { start: 0, end: 0 },
      });
    }
    const declarations: Declaration[] = [];
    while (this.token.kind !== "eof") {
      const start = this.index;
      try {
        declarations.push(this.declaration());
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.report(error.diagnostic);
        this.skipToDeclaration(start);
      }
    }
    return { module: { version, declarations }, diagnostics: this.diagnostics };
  }

  private report(diagnostic: Diagnostic) {
    this.diagnostics.push(diagnostic);
  }
  private recover(run: () => void) {
    try {
      run();
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      this.report(error.diagnostic);
    }
  }
  /** After a failed declaration: skip to a token that can start the next one, always making progress. */
  private skipToDeclaration(start: number) {
    if (this.index === start) this.advance();
    let depth = 0;
    while (this.token.kind !== "eof") {
      const t = this.token;
      if (
        depth === 0 &&
        t.kind === "keyword" &&
        [
          "export",
          "annotation",
          "function",
          "const",
          "enum",
          "type",
          "predicate",
          "operator",
          "import",
        ].includes(t.value)
      )
        return;
      if (this.isPunct("{")) depth++;
      if (this.isPunct("}")) depth = Math.max(0, depth - 1);
      this.advance();
      if (
        depth === 0 &&
        (this.isPunct(";", this.tokens[this.index - 1]) ||
          this.isPunct("}", this.tokens[this.index - 1]))
      )
        return;
    }
  }

  private annotations(): MapLiteral[] {
    const out: MapLiteral[] = [];
    while (this.isKeyword("annotation")) {
      this.advance();
      out.push(this.mapLiteral());
    }
    return out;
  }

  private declaration(): Declaration {
    const start = this.token.start;
    const annotations = this.annotations();
    const exported = this.eatKeyword("export");
    const base = () => ({ exported, annotations, span: this.spanFrom(start) });
    const t = this.token;

    // import(...), ns::import(...)
    if (this.isKeyword("import") || (t.kind === "identifier" && this.isPunct("::", this.peek()))) {
      const namespace: string[] = [];
      while (this.token.kind === "identifier" && this.isPunct("::", this.peek())) {
        namespace.push(this.advance().value as string);
        this.advance();
      }
      this.expectKeyword("import");
      this.expectPunct("(");
      const args = new Map<string, string>();
      do {
        const key = this.name(true).value;
        this.expectPunct(":");
        const value = this.token;
        if (value.kind !== "string") this.fail("expected", `Expected a string for import ${key}.`);
        this.advance();
        args.set(key, value.value as string);
      } while (this.eatPunct(","));
      this.expectPunct(")");
      this.expectPunct(";");
      const path = args.get("path");
      if (path === undefined)
        this.fail("expected", "An import needs a path.", { start, end: this.token.start });
      return { kind: "Import", namespace, path, version: args.get("version") ?? "", ...base() };
    }
    if (this.eatKeyword("const")) {
      const name = this.name().value;
      const type = this.eatKeyword("is") ? this.typeRef() : null;
      this.expectPunct("=");
      const value = this.expression();
      this.expectPunct(";");
      return { kind: "Const", name, type, value, ...base() };
    }
    if (this.eatKeyword("function")) {
      const name = this.name().value;
      const parts = this.functionParts();
      const body = this.block();
      return { kind: "Function", name, ...parts, body, ...base() };
    }
    if (this.eatKeyword("predicate")) {
      const name = this.name().value;
      const parts = this.functionParts();
      const body = this.block();
      return { kind: "Predicate", name, ...parts, body, ...base() };
    }
    if (this.eatKeyword("operator")) {
      const op = this.token;
      if (op.kind !== "punctuator" || !OVERLOADABLE.has(op.value))
        this.fail("expected", `Only + - * / % ^ < can be overloaded, found ${this.describe(op)}.`);
      this.advance();
      const parts = this.functionParts();
      const body = this.block();
      return {
        kind: "Operator",
        operator: op.value as "+" | "-" | "*" | "/" | "%" | "^" | "<",
        ...parts,
        body,
        ...base(),
      };
    }
    if (this.eatKeyword("type")) {
      const name = this.name().value;
      this.expectKeyword("typecheck");
      const typecheck = this.typeRef();
      this.expectPunct(";");
      return { kind: "Type", name, typecheck, ...base() };
    }
    if (this.eatKeyword("enum")) {
      const name = this.name().value;
      this.expectPunct("{");
      const members: { name: string; annotations: MapLiteral[]; span: Span }[] = [];
      if (!this.isPunct("}")) {
        do {
          const memberStart = this.token.start;
          const memberAnnotations = this.annotations();
          const memberName = this.name().value;
          members.push({
            name: memberName,
            annotations: memberAnnotations,
            span: this.spanFrom(memberStart),
          });
        } while (this.eatPunct(","));
      }
      this.expectPunct("}", "to close the enum");
      return { kind: "Enum", name, members, ...base() };
    }
    return this.fail(
      "unexpected-token",
      `Expected a top-level declaration (import, const, function, predicate, operator, type, enum) but found ${this.describe(t)}.`,
    );
  }

  // ---------------------------------------------------------------- functions

  private parameters(): Parameter[] {
    this.expectPunct("(");
    const params: Parameter[] = [];
    if (!this.isPunct(")")) {
      do {
        const name = this.name();
        const type = this.eatKeyword("is") ? this.typeRef() : null;
        params.push({ name: name.value, type, span: this.spanFrom(name.span.start) });
      } while (this.eatPunct(","));
    }
    this.expectPunct(")", "to close the parameter list");
    return params;
  }

  private functionParts(): FunctionParts {
    const params = this.parameters();
    const returns = this.eatKeyword("returns") ? this.typeRef() : null;
    let precondition: Block | Expression | null = null;
    if (this.eatKeyword("precondition")) {
      if (this.isPunct("{")) precondition = this.block();
      else {
        precondition = this.expression();
        this.expectPunct(";", "after the precondition");
      }
    }
    return { params, returns, precondition };
  }

  private typeRef(): TypeRef {
    const t = this.token;
    if (t.kind === "keyword" && TYPE_KEYWORDS.has(t.value)) {
      this.advance();
      return { name: t.value, span: t };
    }
    const first = this.name();
    let name = first.value;
    while (this.isPunct("::") && this.peek().kind === "identifier") {
      this.advance();
      name += `::${this.advance().value}`;
    }
    return { name, span: this.spanFrom(first.span.start) };
  }

  // ---------------------------------------------------------------- statements

  private block(): Block {
    const start = this.expectPunct("{").start;
    const body: Statement[] = [];
    while (!this.isPunct("}") && this.token.kind !== "eof") {
      const before = this.index;
      try {
        body.push(this.statement());
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.report(error.diagnostic);
        this.skipStatement(before);
      }
    }
    this.expectPunct("}", "to close the block");
    return { kind: "Block", body, span: this.spanFrom(start) };
  }

  /** After a failed statement: skip past the next `;` at this depth, or stop before a `}` that closes it. */
  private skipStatement(start: number) {
    if (this.index === start) this.advance();
    let depth = 0;
    while (this.token.kind !== "eof") {
      if (this.isPunct("{")) depth++;
      else if (this.isPunct("}")) {
        if (depth === 0) return;
        depth--;
      } else if (this.isPunct(";") && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private statement(): Statement {
    const t = this.token;
    const start = t.start;
    if (this.isPunct("{")) return this.block();
    if (this.isKeyword("annotation")) {
      this.advance();
      const annotation = this.mapLiteral();
      const statement = this.statement();
      return { kind: "Annotated", annotation, statement, span: this.spanFrom(start) };
    }
    if (this.isKeyword("var") || this.isKeyword("const")) {
      const declaration = this.variable();
      this.expectPunct(";");
      return { ...declaration, span: this.spanFrom(start) };
    }
    if (this.eatKeyword("if")) {
      this.expectPunct("(");
      const test = this.expression();
      this.expectPunct(")");
      const consequent = this.statement();
      const alternate = this.eatKeyword("else") ? this.statement() : null;
      return { kind: "If", test, consequent, alternate, span: this.spanFrom(start) };
    }
    if (this.eatKeyword("while")) {
      this.expectPunct("(");
      const test = this.expression();
      this.expectPunct(")");
      const body = this.statement();
      return { kind: "While", test, body, span: this.spanFrom(start) };
    }
    if (this.eatKeyword("for")) return this.forStatement(start);
    if (this.eatKeyword("return")) {
      const value = this.isPunct(";") ? null : this.expression();
      this.expectPunct(";");
      return { kind: "Return", value, span: this.spanFrom(start) };
    }
    if (this.eatKeyword("break")) {
      this.expectPunct(";");
      return { kind: "Break", span: this.spanFrom(start) };
    }
    if (this.eatKeyword("continue")) {
      this.expectPunct(";");
      return { kind: "Continue", span: this.spanFrom(start) };
    }
    if (this.eatKeyword("throw")) {
      const value = this.expression();
      this.expectPunct(";");
      return { kind: "Throw", value, span: this.spanFrom(start) };
    }
    if (this.isKeyword("try") && !this.isTryExpressionStatement()) {
      this.advance();
      const silent = this.eatSilent();
      const body = this.statement();
      let catchName: string | null = null;
      let catchType: TypeRef | null = null;
      let handler: Statement | null = null;
      if (this.eatKeyword("catch")) {
        // `catch (e)`, `catch (e is T)`, or a bare `catch` that ignores the error.
        if (this.eatPunct("(")) {
          catchName = this.name().value;
          if (this.eatKeyword("is")) catchType = this.typeRef();
          this.expectPunct(")");
        }
        handler = this.statement();
      }
      return {
        kind: "TryStatement",
        silent,
        body,
        catchName,
        catchType,
        handler,
        span: this.spanFrom(start),
      };
    }
    const simple = this.simpleStatement();
    this.expectPunct(";");
    return { ...simple, span: this.spanFrom(start) };
  }

  /** `silent` is a contextual word after `try`, not a keyword. */
  private eatSilent() {
    if (this.token.kind === "identifier" && this.token.value === "silent") {
      this.advance();
      return true;
    }
    return false;
  }

  /**
   * `try(expr)->f();` or `try(x).y = 1;` would be expression statements; std only writes `try` statements
   * at statement start, so treat `try` there as a statement unless it's clearly followed by postfix use.
   */
  private isTryExpressionStatement() {
    let i = this.index + 1;
    if (this.tokens[i]?.kind === "identifier" && this.tokens[i]!.value === "silent") i++;
    if (!this.isPunct("(", this.tokens[i])) return false;
    const close = this.matching(i);
    const after = this.tokens[close + 1];
    return (
      after !== undefined &&
      after.kind === "punctuator" &&
      [".", "->", "[", "?.", "?["].includes(after.value)
    );
  }

  private variable(): Extract<Statement, { kind: "Var" }> {
    const start = this.token.start;
    const constant = this.advance().value === "const";
    const name = this.name().value;
    const type = this.eatKeyword("is") ? this.typeRef() : null;
    let init: Expression | null = null;
    if (this.eatPunct("=")) init = this.expression();
    else if (constant) this.fail("expected", `Constant "${name}" needs a value.`);
    return { kind: "Var", constant, name, type, init, span: this.spanFrom(start) };
  }

  /** Expression or assignment, without the trailing `;` (also used in `for` headers). */
  private simpleStatement(): Statement {
    const start = this.token.start;
    const expression = this.expression();
    const t = this.token;
    if (t.kind === "punctuator" && ASSIGNMENT_OPERATORS.has(t.value)) {
      if (!this.isAssignable(expression))
        this.fail(
          "invalid-assignment-target",
          "Only a variable, or a part of one (x.y, x[i], x[]), can be assigned.",
          expression.span,
        );
      this.advance();
      const value = this.expression();
      return {
        kind: "Assign",
        operator: t.value as AssignmentOperator,
        target: expression,
        value,
        span: this.spanFrom(start),
      };
    }
    return { kind: "ExpressionStatement", expression, span: this.spanFrom(start) };
  }

  private isAssignable(expression: Expression): boolean {
    switch (expression.kind) {
      case "Identifier":
        return expression.namespace.length === 0;
      case "Member":
      case "Index":
        return !expression.optional && this.isAssignable(expression.object);
      case "Deref":
        return this.isAssignable(expression.object);
      default:
        return false;
    }
  }

  private forStatement(start: number): Statement {
    this.expectPunct("(");
    // for-in: `for (var a in x)`, `for (var k, v in x)`, `var` optional.
    const declare = this.isKeyword("var");
    const offset = declare ? 1 : 0;
    const first = this.peek(offset);
    const isForIn =
      first.kind === "identifier" &&
      (this.isKeyword("in", this.peek(offset + 1)) ||
        (this.isPunct(",", this.peek(offset + 1)) &&
          this.peek(offset + 2).kind === "identifier" &&
          this.isKeyword("in", this.peek(offset + 3))));
    if (isForIn) {
      if (declare) this.advance();
      const a = this.name().value;
      const b = this.eatPunct(",") ? this.name().value : null;
      this.expectKeyword("in");
      const iterable = this.expression();
      this.expectPunct(")");
      const body = this.statement();
      return {
        kind: "ForIn",
        declare,
        key: b === null ? null : a,
        value: b ?? a,
        iterable,
        body,
        span: this.spanFrom(start),
      };
    }
    const init = this.isPunct(";")
      ? null
      : this.isKeyword("var") || this.isKeyword("const")
        ? this.variable()
        : this.simpleStatement();
    this.expectPunct(";");
    const test = this.isPunct(";") ? null : this.expression();
    this.expectPunct(";");
    const update = this.isPunct(")") ? null : this.simpleStatement();
    this.expectPunct(")");
    const body = this.statement();
    return { kind: "For", init, test, update, body, span: this.spanFrom(start) };
  }

  // ---------------------------------------------------------------- expressions

  expression(): Expression {
    const start = this.token.start;
    const test = this.binary(1);
    if (!this.eatPunct("?")) return test;
    const consequent = this.expression();
    this.expectPunct(":", "in a conditional expression");
    const alternate = this.expression();
    return { kind: "Conditional", test, consequent, alternate, span: this.spanFrom(start) };
  }

  private binary(minPrecedence: number): Expression {
    const start = this.token.start;
    let left = this.unary();
    for (;;) {
      const t = this.token;
      const op =
        t.kind === "punctuator" || (t.kind === "keyword" && (t.value === "is" || t.value === "as"))
          ? t.value
          : null;
      const precedence = op === null ? undefined : BINARY_PRECEDENCE[op];
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.advance();
      if (op === "is" || op === "as") {
        const type = this.typeRef();
        const span = this.spanFrom(start);
        left =
          op === "is"
            ? { kind: "Is", value: left, type, span }
            : { kind: "As", value: left, type, span };
        continue;
      }
      const right = this.binary(precedence + 1);
      left = {
        kind: "Binary",
        operator: op as BinaryOperator,
        left,
        right,
        span: this.spanFrom(start),
      };
    }
  }

  private unary(): Expression {
    const t = this.token;
    if (this.isPunct("-") || this.isPunct("!")) {
      this.advance();
      const operand = this.unary();
      // "Negated constants are converted to negative constants."
      if (t.value === "-" && operand.kind === "Number")
        return { kind: "Number", value: -operand.value, span: this.spanFrom(t.start) };
      return {
        kind: "Unary",
        operator: t.value as "-" | "!",
        operand,
        span: this.spanFrom(t.start),
      };
    }
    return this.power();
  }

  /** `^` is right-associative and binds tighter than unary minus on its left: `-x^2` is `-(x^2)`. */
  private power(): Expression {
    const start = this.token.start;
    const base = this.postfix();
    if (!this.eatPunct("^")) return base;
    const exponent = this.unary();
    return {
      kind: "Binary",
      operator: "^",
      left: base,
      right: exponent,
      span: this.spanFrom(start),
    };
  }

  private postfix(): Expression {
    const start = this.token.start;
    let expression = this.primary();
    for (;;) {
      if (this.isPunct("(")) {
        const args = this.arguments();
        expression = { kind: "Call", callee: expression, args, span: this.spanFrom(start) };
      } else if (this.isPunct(".") || this.isPunct("?.")) {
        const optional = this.advance().value === "?.";
        const property = this.name(true).value;
        expression = {
          kind: "Member",
          object: expression,
          property,
          optional,
          span: this.spanFrom(start),
        };
      } else if (this.isPunct("[") || this.isPunct("?[")) {
        const optional = this.advance().value === "?[";
        if (this.eatPunct("]")) {
          expression = { kind: "Deref", object: expression, optional, span: this.spanFrom(start) };
          continue;
        }
        const index = this.expression();
        this.expectPunct("]");
        expression = {
          kind: "Index",
          object: expression,
          index,
          optional,
          span: this.spanFrom(start),
        };
      } else if (this.eatPunct("->")) {
        const calleeStart = this.token.start;
        const namespace: string[] = [];
        let name = this.name().value;
        while (this.eatPunct("::")) {
          namespace.push(name);
          name = this.name().value;
        }
        const callee: Expression = {
          kind: "Identifier",
          name,
          namespace,
          span: this.spanFrom(calleeStart),
        };
        if (!this.isPunct("("))
          this.fail("expected", 'Expected "(" after the function name in x->f(...).');
        const args = this.arguments();
        expression = {
          kind: "Pipe",
          receiver: expression,
          callee,
          args,
          span: this.spanFrom(start),
        };
      } else return expression;
    }
  }

  private arguments(): Expression[] {
    this.expectPunct("(");
    const args: Expression[] = [];
    if (!this.isPunct(")")) {
      do args.push(this.expression());
      while (this.eatPunct(","));
    }
    this.expectPunct(")", "to close the argument list");
    return args;
  }

  private primary(): Expression {
    const t = this.token;
    const start = t.start;
    switch (t.kind) {
      case "number":
        this.advance();
        return { kind: "Number", value: t.value, span: t };
      case "string":
        this.advance();
        return { kind: "String", value: t.value, span: t };
      case "builtin":
        this.advance();
        return { kind: "Builtin", name: t.value, span: t };
      case "identifier": {
        if (this.isPunct("=>", this.peek())) return this.arrowLambda();
        this.advance();
        const namespace: string[] = [];
        let name = t.value;
        while (this.isPunct("::") && this.peek().kind === "identifier") {
          this.advance();
          namespace.push(name);
          name = this.advance().value as string;
        }
        return { kind: "Identifier", name, namespace, span: this.spanFrom(start) };
      }
      case "keyword":
        switch (t.value) {
          case "true":
          case "false":
            this.advance();
            return { kind: "Boolean", value: t.value === "true", span: t };
          case "undefined":
            this.advance();
            return { kind: "Undefined", span: t };
          case "inf":
            this.advance();
            return { kind: "Number", value: Number.POSITIVE_INFINITY, span: t };
          case "function": {
            this.advance();
            const parts = this.functionParts();
            const body = this.block();
            return { kind: "Lambda", ...parts, body, span: this.spanFrom(start) };
          }
          case "new": {
            this.advance();
            const box = this.name();
            if (box.value !== "box")
              this.fail(
                "expected",
                `Only "new box(...)" is supported, found "new ${box.value}".`,
                box.span,
              );
            this.expectPunct("(");
            const value = this.expression();
            this.expectPunct(")");
            return { kind: "NewBox", value, span: this.spanFrom(start) };
          }
          case "try": {
            this.advance();
            const silent = this.eatSilent();
            this.expectPunct("(", "after try in an expression");
            const expression = this.expression();
            this.expectPunct(")");
            return { kind: "Try", silent, expression, span: this.spanFrom(start) };
          }
          case "switch": {
            this.advance();
            this.expectPunct("(");
            const discriminant = this.expression();
            this.expectPunct(")");
            const cases = this.mapLiteral();
            return { kind: "Switch", discriminant, cases, span: this.spanFrom(start) };
          }
          default:
            return this.fail(
              "unexpected-token",
              `Expected an expression but found ${this.describe(t)}.`,
            );
        }
      case "punctuator":
        if (t.value === "(") {
          if (this.isArrowParameters()) return this.arrowLambda();
          this.advance();
          const inner = this.expression();
          this.expectPunct(")");
          return inner;
        }
        if (t.value === "[") {
          this.advance();
          const elements: Expression[] = [];
          if (!this.isPunct("]")) {
            do elements.push(this.expression());
            while (this.eatPunct(","));
          }
          this.expectPunct("]", "to close the array");
          return { kind: "Array", elements, span: this.spanFrom(start) };
        }
        if (t.value === "{") return this.mapLiteral();
        return this.fail(
          "unexpected-token",
          `Expected an expression but found ${this.describe(t)}.`,
        );
      case "eof":
        return this.fail("unexpected-token", "Expected an expression but the file ended.");
    }
  }

  /** Index of the token closing the bracket opened at `open`, or the eof index. */
  private matching(open: number) {
    let depth = 0;
    for (let i = open; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.kind !== "punctuator") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "?[") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return this.tokens.length - 1;
  }

  /** `(a, b) =>`, `(a is T) returns U =>`: parenthesized parameters followed by `=>` or `returns`. */
  private isArrowParameters() {
    const after = this.tokens[this.matching(this.index) + 1];
    return after !== undefined && (this.isPunct("=>", after) || this.isKeyword("returns", after));
  }

  private arrowLambda(): Expression {
    const start = this.token.start;
    let params: Parameter[];
    if (this.token.kind === "identifier") {
      const name = this.advance();
      params = [{ name: name.value as string, type: null, span: name }];
    } else params = this.parameters();
    const returns = this.eatKeyword("returns") ? this.typeRef() : null;
    this.expectPunct("=>");
    const body = this.isPunct("{") && !this.braceOpensMap() ? this.block() : this.expression();
    return {
      kind: "Lambda",
      params,
      returns,
      precondition: null,
      body,
      span: this.spanFrom(start),
    };
  }

  /**
   * After `=>`, `{` is a map if its first entry looks like `key :` (or it's `{}`), else a block.
   * Statements never contain a top-level `:` before `;` unless it's a `?:`, which we check for.
   */
  private braceOpensMap() {
    const next = this.peek();
    if (this.isPunct("}", next)) return true;
    for (let i = this.index + 1, depth = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.kind !== "punctuator") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (depth === 0) return false;
        depth--;
      } else if (
        depth === 0 &&
        (t.value === ";" || t.value === "?" || ASSIGNMENT_OPERATORS.has(t.value))
      )
        return false;
      else if (depth === 0 && (t.value === ":" || t.value === ",")) return t.value === ":";
    }
    return false;
  }

  private mapLiteral(): MapLiteral {
    const start = this.expectPunct("{", "to start a map").start;
    const entries: MapEntry[] = [];
    if (!this.isPunct("}"))
      do {
        const t = this.token;
        let key: Expression;
        // A bare identifier is a string key: `{ a : 1 }` is `{ "a" : 1 }`. Reserved words aren't,
        // so `{ true : 1 }` has the boolean key `true`.
        if (t.kind === "identifier" && this.isPunct(":", this.peek())) {
          this.advance();
          key = { kind: "String", value: t.value, span: t };
        } else key = this.binary(1);
        this.expectPunct(":", "after a map key");
        const value = this.expression();
        entries.push({ key, value });
        // Onshape takes a trailing comma before the closing brace.
      } while (this.eatPunct(",") && !this.isPunct("}"));
    this.expectPunct("}", "to close the map");
    return { kind: "Map", entries, span: this.spanFrom(start) };
  }
}
