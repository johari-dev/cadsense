import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

// Without type information a rule cannot tell `name.slice(0, 120)` from an array slice, so this
// one reports only the shape that is always text: a slice written right beside an ellipsis.
const ELLIPSIS_AT_START = /^(?:\u{2026}|\.\.\.)/u;
const ELLIPSIS_AT_END = /(?:\u{2026}|\.\.\.)$/u;
const CUT_METHODS = new Set(["slice", "substring", "substr"]);
const TRIM_METHODS = new Set(["trim", "trimEnd", "trimStart"]);

/** The call `node` makes when it is `receiver.method(...)` with a plain property name. */
const methodCall = (node: ESTree.Node) => {
  if (node.type !== "CallExpression") return Option.none();
  const callee = unwrapExpression(node.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return Option.none();
  const member = callee.value;
  if (member.computed) return Option.none();
  return Option.map(getPropertyName(member.property), (name) => ({
    name,
    receiver: member.object,
    arguments: node.arguments,
  }));
};

/**
 * Which end of its text `node` keeps when it is a cut: "start" for `text.slice(0, n)`, "end" for
 * `text.slice(-n)`. A trim after the cut does not change what it is.
 */
const cutKeeps = (node: unknown): "start" | "end" | undefined => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return undefined;
  const call = methodCall(expression.value);
  if (Option.isNone(call)) return undefined;
  const { name, receiver, arguments: args } = call.value;
  if (TRIM_METHODS.has(name) && args.length === 0) return cutKeeps(receiver);
  if (!CUT_METHODS.has(name)) return undefined;
  const [first] = args;
  if (args.length === 2 && first?.type === "Literal" && first.value === 0) return "start";
  if (args.length === 1 && first?.type === "UnaryExpression" && first.operator === "-")
    return "end";
  return undefined;
};

/** The text of `node` when it is a string literal or a template with no expressions. */
const literalText = (node: unknown): string | undefined => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return undefined;
  const literal = expression.value;
  if (literal.type === "Literal")
    return typeof literal.value === "string" ? literal.value : undefined;
  if (literal.type === "TemplateLiteral" && literal.expressions.length === 0)
    return literal.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

const MESSAGE =
  "Do not cut text with slice: it can leave half an emoji, and a lone surrogate breaks JSON for strict parsers. Use clip from @cadsense/shared/String, for example `${clip(text, max - 1)}\u{2026}`.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow truncating text with slice beside an ellipsis; use clip from @cadsense/shared/String.",
    },
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        node.expressions.forEach((expression, index) => {
          const keeps = cutKeeps(expression);
          const before = node.quasis[index]?.value.cooked ?? "";
          const after = node.quasis[index + 1]?.value.cooked ?? "";
          if (
            (keeps === "start" && ELLIPSIS_AT_START.test(after)) ||
            (keeps === "end" && ELLIPSIS_AT_END.test(before))
          )
            context.report({ node: expression, message: MESSAGE });
        });
      },
      BinaryExpression(node) {
        if (node.operator !== "+") return;
        if (
          (cutKeeps(node.left) === "start" &&
            ELLIPSIS_AT_START.test(literalText(node.right) ?? "")) ||
          (cutKeeps(node.right) === "end" && ELLIPSIS_AT_END.test(literalText(node.left) ?? ""))
        )
          context.report({ node, message: MESSAGE });
      },
    };
  },
});
