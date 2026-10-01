import type { Declaration, Expression, Statement, TypeRef } from "./Ast.ts";

/**
 * Prints syntax trees as compact S-expressions, so tests can assert tree shape (precedence,
 * associativity, block-vs-map decisions) in one readable line.
 */
export function sexpr(node: Expression | Statement | Declaration): string {
  const list = (...parts: string[]) => `(${parts.join(" ")})`;
  const type = (t: TypeRef | null) => (t === null ? "_" : t.name);
  const many = (nodes: readonly (Expression | Statement)[]) => nodes.map(sexpr);
  switch (node.kind) {
    case "Number":
      return Number.isFinite(node.value) ? String(node.value) : node.value > 0 ? "inf" : "-inf";
    case "String":
      return JSON.stringify(node.value);
    case "Boolean":
      return String(node.value);
    case "Undefined":
      return "undefined";
    case "Identifier":
      return [...node.namespace, node.name].join("::");
    case "Builtin":
      return `@${node.name}`;
    case "Array":
      return list("array", ...many(node.elements));
    case "Map":
      return list("map", ...node.entries.map((e) => list(sexpr(e.key), sexpr(e.value))));
    case "Unary":
      return list(node.operator, sexpr(node.operand));
    case "Binary":
      return list(node.operator, sexpr(node.left), sexpr(node.right));
    case "Conditional":
      return list("?:", sexpr(node.test), sexpr(node.consequent), sexpr(node.alternate));
    case "Is":
      return list("is", sexpr(node.value), node.type.name);
    case "As":
      return list("as", sexpr(node.value), node.type.name);
    case "Call":
      return list("call", sexpr(node.callee), ...many(node.args));
    case "Pipe":
      return list("->", sexpr(node.receiver), sexpr(node.callee), ...many(node.args));
    case "Member":
      return list(node.optional ? "?." : ".", sexpr(node.object), node.property);
    case "Index":
      return list(node.optional ? "?[]" : "[]", sexpr(node.object), sexpr(node.index));
    case "Deref":
      return list("deref", sexpr(node.object));
    case "Lambda":
      return list(
        "lambda",
        list(...node.params.map((p) => (p.type ? `${p.name}:${p.type.name}` : p.name))),
        type(node.returns),
        ...(node.precondition ? [list("pre", sexpr(node.precondition))] : []),
        sexpr(node.body),
      );
    case "NewBox":
      return list("box", sexpr(node.value));
    case "Try":
      return list(node.silent ? "try-silent" : "try", sexpr(node.expression));
    case "Switch":
      return list("switch", sexpr(node.discriminant), sexpr(node.cases));
    case "Block":
      return list("block", ...many(node.body));
    case "Var":
      return list(
        node.constant ? "const" : "var",
        node.name,
        type(node.type),
        node.init ? sexpr(node.init) : "_",
      );
    case "ExpressionStatement":
      return sexpr(node.expression);
    case "Assign":
      return list(node.operator, sexpr(node.target), sexpr(node.value));
    case "If":
      return list(
        "if",
        sexpr(node.test),
        sexpr(node.consequent),
        node.alternate ? sexpr(node.alternate) : "_",
      );
    case "While":
      return list("while", sexpr(node.test), sexpr(node.body));
    case "For":
      return list(
        "for",
        node.init ? sexpr(node.init) : "_",
        node.test ? sexpr(node.test) : "_",
        node.update ? sexpr(node.update) : "_",
        sexpr(node.body),
      );
    case "ForIn":
      return list("for-in", node.key ?? "_", node.value, sexpr(node.iterable), sexpr(node.body));
    case "Return":
      return list("return", ...(node.value ? [sexpr(node.value)] : []));
    case "Break":
      return "(break)";
    case "Continue":
      return "(continue)";
    case "Throw":
      return list("throw", sexpr(node.value));
    case "TryStatement":
      return list(
        node.silent ? "try-silent" : "try",
        sexpr(node.body),
        node.handler ? list("catch", node.catchName ?? "_", sexpr(node.handler)) : "_",
      );
    case "Annotated":
      return list("annotated", sexpr(node.annotation), sexpr(node.statement));
    case "Import":
      return list("import", node.path, node.version);
    case "Const":
      return list("const", node.name, type(node.type), sexpr(node.value));
    case "Function":
    case "Operator":
    case "Predicate":
      return list(
        ...(node.kind === "Operator"
          ? [`operator${node.operator}`]
          : [node.kind.toLowerCase(), node.name]),
        list(...node.params.map((p) => (p.type ? `${p.name}:${p.type.name}` : p.name))),
        type(node.returns),
        node.precondition ? list("pre", sexpr(node.precondition)) : "_",
        sexpr(node.body),
      );
    case "Type":
      return list("type", node.name, node.typecheck.name);
    case "Enum":
      return list("enum", node.name, ...node.members.map((m) => m.name));
  }
}
