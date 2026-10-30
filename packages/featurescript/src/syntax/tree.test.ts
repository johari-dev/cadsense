import { describe, expect, it } from "vite-plus/test";
import type { Declaration } from "./Ast.ts";
import { parseModule } from "./Parser.ts";
import { sexpr } from "./Sexpr.ts";
import { sourceFile } from "./Source.ts";

/** Parses `body` as the statements of a function and returns them as S-expressions. */
const statements = (body: string) => {
  const { module, diagnostics } = parseModule(
    sourceFile("test.fs", `FeatureScript 3083;\nfunction f() {\n${body}\n}\n`),
  );
  expect(diagnostics).toEqual([]);
  const declaration = module.declarations[0] as Extract<Declaration, { kind: "Function" }>;
  return declaration.body.body.map(sexpr);
};
/** Parses `source` in expression position (after `return`), where `{` is a map and `try(...)` an expression. */
const expression = (source: string) =>
  statements(`return ${source};`)[0]!.replace(/^\(return (.*)\)$/, "$1");
const declarations = (source: string) => {
  const { module, diagnostics } = parseModule(
    sourceFile("test.fs", `FeatureScript 3083;\n${source}\n`),
  );
  expect(diagnostics).toEqual([]);
  return module.declarations.map(sexpr);
};

// Failure modes 3, 4, 9 and 10 in FeatureScript.md.
describe("precedence and associativity", () => {
  it.each([
    ["-x ^ 2", "(- (^ x 2))"],
    ["2 ^ 3 ^ 2", "(^ 2 (^ 3 2))"],
    ["2 ^ -1", "(^ 2 -1)"],
    ["-2", "-2"],
    ["a ~ b + c", "(+ (~ a b) c)"],
    ["a + b * c", "(+ a (* b c))"],
    ["a - b - c", "(- (- a b) c)"],
    ["x is T && y", "(&& (is x T) y)"],
    ["!x is T", "(is (! x) T)"],
    ["!(x is T)", "(! (is x T))"],
    ["a + b as T", "(as (+ a b) T)"],
    ["a ? b : c ? d : e", "(?: a b (?: c d e))"],
    ["a || b ? c : d", "(?: (|| a b) c d)"],
    ["a ?? b || c", "(?? a (|| b c))"],
    ["a && b || c && d", "(|| (&& a b) (&& c d))"],
    ["a < b == c < d", "(== (< a b) (< c d))"],
    ["x->f(y)[0]", "([] (-> x f y) 0)"],
    ["x->f()->g(1)", "(-> (-> x f) g 1)"],
    ["a.b.c(d)", "(call (. (. a b) c) d)"],
    ["a?.b?.c", "(?. (?. a b) c)"],
    ["a?[0]", "(?[] a 0)"],
    ["x[]", "(deref x)"],
    ["x[][0]", "([] (deref x) 0)"],
    ["@size(a)", "(call @size a)"],
    ["ns::f(1)", "(call ns::f 1)"],
  ])("%s", (source, tree) => expect(expression(source)).toBe(tree));
});

describe("literals and names", () => {
  it.each([
    ["1e-5", "0.00001"],
    ["3e9", "3000000000"],
    [".5", "0.5"],
    ["inf", "inf"],
    ["-inf", "-inf"],
    ['"a\\tb\\u0041"', JSON.stringify("a\tbA")],
    ["'single \\' quote'", JSON.stringify("single ' quote")],
    ["definition.type", "(. definition type)"],
    ["x.in", "(. x in)"],
    [
      '{ type : 1, "b" : 2, (meter) : 3, E.V : 4 }',
      '(map ("type" 1) ("b" 2) (meter 3) ((. E V) 4))',
    ],
    ["[1, 2]", "(array 1 2)"],
    ["[]", "(array)"],
    ["{}", "(map)"],
    ["new box({})", "(box (map))"],
    ["try(f())", "(try (call f))"],
    ["try silent(f())", "(try-silent (call f))"],
    ["switch (m) { E.A : 0, E.B : 1 }", "(switch m (map ((. E A) 0) ((. E B) 1)))"],
  ])("%s", (source, tree) => expect(expression(source)).toBe(tree));
});

describe("lambdas", () => {
  it.each([
    ["x => x + 1", "(lambda (x) _ (+ x 1))"],
    ["(a, b) => a * b", "(lambda (a b) _ (* a b))"],
    ["(a is number) returns number => a", "(lambda (a:number) number a)"],
    ['i => { "index" : i }', '(lambda (i) _ (map ("index" i)))'],
    ["i => {}", "(lambda (i) _ (map))"],
    [
      "(a, b) => { const c = a ^ 2; return b * c; }",
      "(lambda (a b) _ (block (const c _ (^ a 2)) (return (* b c))))",
    ],
    ["x => { x ? f() : g(); }", "(lambda (x) _ (block (?: x (call f) (call g))))"],
    [
      "function(x is Query) returns map { return {}; }",
      "(lambda (x:Query) map (block (return (map))))",
    ],
    ["(a)", "a"],
  ])("%s", (source, tree) => expect(expression(source)).toBe(tree));
});

describe("statements", () => {
  it.each([
    ["var x;", "(var x _ _)"],
    ["var z is Vector = vector(0, 0);", "(var z Vector (call vector 0 0))"],
    ["const e is number = exp(1);", "(const e number (call exp 1))"],
    ["b.c = false;", "(= (. b c) false)"],
    ["f.g.h[] = 0;", "(= (deref (. (. f g) h)) 0)"],
    ['x ~= "s";', '(~= x "s")'],
    ["x ??= 1;", "(??= x 1)"],
    ["for (var i = 0; i != 10; i += 1) f(i);", "(for (var i _ 0) (!= i 10) (+= i 1) (call f i))"],
    ["for (var k, v in m) f(k);", "(for-in k v m (call f k))"],
    ["for (x in a) f(x);", "(for-in _ x a (call f x))"],
    ["if (a) f(); else if (b) g(); else h();", "(if a (call f) (if b (call g) (call h)))"],
    ["try silent { f(); }", "(try-silent (block (call f)) _)"],
    ["try { f(); } catch { g(); }", "(try (block (call f)) (catch _ (block (call g))))"],
    ["try { f(); } catch (e) { g(e); }", "(try (block (call f)) (catch e (block (call g e))))"],
    [
      'annotation { "Name" : "A" } definition.a is boolean;',
      '(annotated (map ("Name" "A")) (is (. definition a) boolean))',
    ],
    [
      'annotation { "Group Name" : "G" } { isLength(definition.d, B); }',
      '(annotated (map ("Group Name" "G")) (block (call isLength (. definition d) B)))',
    ],
    ["{ var x = 1; }", "(block (var x _ 1))"],
    ["{}", "(block)"],
    ["try(f());", "(try (call f) _)"],
    ["try(f())->g();", "(-> (try (call f)) g)"],
  ])("%s", (source, tree) => expect(statements(source)[0]).toBe(tree));
});

describe("declarations", () => {
  it("covers every top-level form", () => {
    expect(
      declarations(`
        import(path : "onshape/std/geometry.fs", version : "3083.0");
        export import(path : "onshape/std/query.fs", version : "3083.0");
        export const LIMIT is number = 5;
        export type Box3d typecheck canBeBox3d;
        export predicate canBeBox3d(value) precondition value is map; { value.min is Vector; }
        export enum Side { annotation { "Name" : "Front" } FRONT, BACK }
        export operator+(a is Id, b is string) returns Id { return a; }
        export operator-(a is Vector) returns Vector { return a; }
        export function makeArray(size is number) returns array precondition isNonNegativeInteger(size); { return @resize([], size); }
        annotation { "Feature Type Name" : "Widget" }
        export const widget = defineFeature(function(context is Context, id is Id, definition is map)
            precondition { annotation { "Name" : "Width" } isLength(definition.width, LENGTH_BOUNDS); }
            { });
      `),
    ).toEqual([
      "(import onshape/std/geometry.fs 3083.0)",
      "(import onshape/std/query.fs 3083.0)",
      "(const LIMIT number 5)",
      "(type Box3d canBeBox3d)",
      "(predicate canBeBox3d (value) _ (pre (is value map)) (block (is (. value min) Vector)))",
      "(enum Side FRONT BACK)",
      "(operator+ (a:Id b:string) Id _ (block (return a)))",
      "(operator- (a:Vector) Vector _ (block (return a)))",
      "(function makeArray (size:number) array (pre (call isNonNegativeInteger size)) (block (return (call @resize (array) size))))",
      '(const widget _ (call defineFeature (lambda (context:Context id:Id definition:map) _ (pre (block (annotated (map ("Name" "Width")) (call isLength (. definition width) LENGTH_BOUNDS)))) (block))))',
    ]);
  });
});
