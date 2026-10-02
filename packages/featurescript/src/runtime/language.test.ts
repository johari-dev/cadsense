import { describe, it } from "vite-plus/test";
import { testRuntime } from "./testing.ts";

/**
 * Language conformance from the FsDoc pages (cited per group). Each case runs against the real
 * vendored std. These are documented behavior, not Onshape recordings; the recorder will add those.
 */
const { expectValue, expectThrow, expectFault } = testRuntime();

const ENUMS = "enum E { A, B }\nenum Z { B, A }";
const ANYTHING = "predicate anything(x) { true; }\ntype Anything typecheck anything;";
const EVEN = "predicate isEven(x) { x % 2 == 0; }\ntype Even typecheck isEven;";

// Failure mode 11. https://cad.onshape.com/FsDoc/type-tags.html#assignment-and-copying
describe("values are copied, boxes are shared", () => {
  it("maps copy on assignment", () =>
    expectValue(
      "var a = { 0 : false, 1 : true }; var b = a; a[0] = true; return [a == b, b[0]];",
      "[false, false]",
    ));
  it("arrays copy on assignment", () =>
    expectValue("var a = [1, 2]; var b = a; b[0] = 9; return [a, b];", "[[1, 2], [9, 2]]"));
  it("nested containers copy", () =>
    expectValue("var a = { x : [1] }; var b = a; b.x[0] = 2; return a.x[0];", "1"));
  it("arguments copy", () =>
    expectValue(
      "var a = { x : 1 }; const b = mutate(a); return [a.x, b.x];",
      "[1, 2]",
      "function mutate(m) { m.x = 2; return m; }",
    ));
  it("self-assignment copies, no cycle", () =>
    expectValue(
      "var recursive = { a : 0 }; recursive.a = recursive; return recursive;",
      "{ a : { a : 0 } }",
    ));
  it("boxes are shared", () =>
    expectValue(
      'var b1 = new box(1); var b2 = b1; b1[] = "new value"; return b2[];',
      '"new value"',
    ));
  it("a box lets a closure keep state", () =>
    expectValue(
      "const c = counter(); c(); c(); return c();",
      "3",
      "function counter() returns function { const b = new box(0); return function() { b[] += 1; return b[]; }; }",
    ));
  it("lambdas capture values when created", () =>
    expectValue("var x = 1; const f = function() { return x; }; x = 2; return f();", "1"));
  it("curried arrow lambdas", () =>
    expectValue("return (a => b => c => a * b + c)(4)(5)(6);", "26"));
});

// https://cad.onshape.com/FsDoc/type-tags.html#maps
describe("maps", () => {
  it("storing undefined removes the key", () =>
    expectValue("var m = { a : 1 }; m.a = undefined; return [m, size(m)];", "[{}, 0]"));
  it("a literal with an undefined value drops it", () =>
    expectValue("return { a : true, a : undefined };", "{}"));
  it("later keys win", () => expectValue("return ({ a : 0, a : 1 })['a'];", "1"));
  it("parenthesized keys are evaluated", () =>
    expectValue(
      'var a = "hello, world"; return { a : false, (a) : true }["hello, world"];',
      "true",
    ));
  it("maps can be keys", () =>
    expectValue("const m = { { a : false } : true }; return m[{ a : false }];", "true"));
  it("absent keys read as undefined", () => expectValue("return ({}).x;", "undefined"));
  it("op= on an absent field fails", () => expectThrow("var x = {}; x.k += 1; return x;"));
});

// https://cad.onshape.com/FsDoc/type-tags.html#arrays and #containers
describe("containers", () => {
  it("reading past the end fails", () => expectThrow("var a = []; return a[0];"));
  it("arrays don't grow on write", () => expectThrow("var a = [1]; a[1] = 2; return a;"));
  it("fields of undefined fail", () => expectThrow("var u; return u.x;"));
  it("safe navigation yields undefined", () =>
    expectValue(
      "var b = undefined; return [b?[0], b?.x, b?[]];",
      "[undefined, undefined, undefined]",
    ));
  it("safe navigation still reads values", () =>
    expectValue("var a = [1, 2]; var z = { k : 75 }; return [a?[1], z?.k];", "[2, 75]"));
});

// https://cad.onshape.com/FsDoc/syntax.html and type-tags.html#numbers
describe("operators", () => {
  it("?? picks the first defined value", () =>
    expectValue("return [undefined ?? 1, 2 ?? 1];", "[1, 2]"));
  it("% takes the sign of the second operand", () =>
    expectValue("return [7 % 3, -7 % 3, 7 % -3];", "[1, 2, -2]"));
  it("NaN raises, infinity doesn't", () =>
    expectValue("return [try(0 / 0), 1 / 0];", "[undefined, inf]"));
  it("^ is right-associative", () => expectValue("return 2 ^ 3 ^ 2;", "512"));
  it("~ converts non-strings", () =>
    expectValue('return ["hole" ~ 1, "a" ~ true];', '["hole1", "atrue"]'));
  it("&& and || short-circuit", () =>
    expectValue("var m; return [false && m.x, true || m.x];", "[false, true]"));
  it("-0 equals 0", () => expectValue("return -0 == 0;", "true"));
  it("conditions must be booleans", () => expectThrow("if (1) { return 1; } return 0;"));
  it("x->f(y) is f(x, y)", () =>
    expectValue("return [3, 1, 2]->sort(function(a, b) { return a - b; });", "[1, 2, 3]"));
});

// https://cad.onshape.com/FsDoc/type-tags.html#type-conversion and #type-testing
describe("type tags", () => {
  it("enum values are tagged strings", () =>
    expectValue(
      "return [E.A is E, E.A is string, (E.A as string) is string, (E.A as string) is E];",
      "[true, true, true, false]",
      ENUMS,
    ));
  it("as converts a member name", () => expectValue('return "A" as E;', "E.A", ENUMS));
  it("as rejects non-members", () => expectThrow('return "Z" as E;', ENUMS));
  it("as rejects non-strings for enums", () => expectThrow("return 0 as E;", ENUMS));
  it("an enum name is a map of its values", () =>
    expectValue("return [E is map, size(E)];", "[true, 2]", ENUMS));
  it("different tags are different values", () =>
    expectValue(
      "const x = { value : 1 }; return [x == (x as Anything), x == ((x as Anything) as map)];",
      "[false, true]",
      ANYTHING,
    ));
  it("is matches the tag and the standard type", () =>
    expectValue(
      "const x = { value : 1 } as Anything; return [x is map, x is Anything, { value : 1 } is Anything];",
      "[true, true, false]",
      ANYTHING,
    ));
  it("predefined operators drop tags", () =>
    expectValue(
      "return [(2 as Even) + (2 as Even) == 4, ((2 as Even) + (2 as Even)) is Even];",
      "[true, false]",
      EVEN,
    ));
  it("standard types", () =>
    expectValue(
      "return [undefined is undefined, 1 is number, 's' is string, [] is array, {} is map, new box(1) is box, (x => x) is function];",
      "[true, true, true, true, true, true, true]",
    ));
  it("enums compare by declaration order", () =>
    expectValue("return [E.A < E.B, Z.B < Z.A];", "[true, true]", ENUMS));
});

// Failure mode 12. https://cad.onshape.com/FsDoc/top-level.html#overload-resolution
describe("overloads", () => {
  const FOO =
    'function foo(x) { return "any"; }\nfunction foo(x is map) { return "map"; }\nfunction foo(x is ValueWithUnits) { return "units"; }';
  it("picks the most specific satisfying overload", () =>
    expectValue("return [foo(1), foo({}), foo(meter)];", '["any", "map", "units"]', FOO));
  it("no unique most specific overload is an error", () =>
    expectThrow(
      "return g(1, 2);",
      "function g(x is number, y) { return 1; }\nfunction g(x, y is number) { return 2; }",
    ));
  it("no satisfying overload is an error", () =>
    expectThrow("return h(1);", "function h(x is string) { return x; }"));
  it("a local that isn't a function doesn't hide top-level functions", () =>
    expectValue("const size = 3; return size([1, 2]);", "2"));
  it("a local lambda is called directly", () =>
    expectValue("const f = x => x * 2; return f(3);", "6"));
  it("a failed precondition is a catchable error", () =>
    expectValue(
      "return [try(sq(-1)), sq(4)];",
      "[undefined, 4]",
      "function sq(n is number) precondition n >= 0; { return n; }",
    ));
  it("predicates succeed when every statement is true", () =>
    expectValue(
      'return [canBeUsed(1), canBeUsed(-1), canBeUsed("a")];',
      "[true, false, false]",
      "predicate canBeUsed(x) { x is number; if (x is number) { x > 0; } }",
    ));
  it("a non-boolean predicate statement is an error", () =>
    expectValue("return try(bad(1));", "undefined", "predicate bad(x) { x; }"));
  it("return types are checked", () =>
    expectValue("return try(r());", "undefined", 'function r() returns number { return "s"; }'));
  it("units go through std's operator overloads", () =>
    expectValue(
      "return [(2 * meter + 3 * meter) == 5 * meter, 1 * inch < 3 * centimeter, toString(2 * meter)];",
      '[true, true, "2 meter"]',
    ));
});

// https://cad.onshape.com/FsDoc/variables.html
describe("variables", () => {
  it("typed variables stay that type", () =>
    expectThrow('var y is number = 1; y = "s"; return y;'));
  it("constants can't be assigned", () => expectThrow("const c = 1; c = 2; return c;"));
  it("blocks scope variables", () =>
    expectValue("var v = 1; if (true) { var v = 2; } return v;", "1"));
});

// https://cad.onshape.com/FsDoc/syntax.html#statement-types
describe("control flow", () => {
  it("for-in over a map yields key/value maps in key order", () =>
    expectValue(
      'var out = []; for (var x in { b : 2, a : 1 }) out = append(out, x.key ~ "=" ~ x.value); return out;',
      '["a=1", "b=2"]',
    ));
  it("for-in with two variables over an array", () =>
    expectValue(
      "var out = []; for (var i, v in [100, 200]) out = append(out, [i, v]); return out;",
      "[[0, 100], [1, 200]]",
    ));
  it("break and continue", () =>
    expectValue(
      "var s = 0; for (var i = 0; i < 10; i += 1) { if (i == 2) continue; if (i == 5) break; s += i; } return s;",
      "8",
    ));
  it("while", () => expectValue("var i = 0; while (i < 4) i += 1; return i;", "4"));
  it("switch evaluates only the matching case", () =>
    expectValue(
      'return [switch ("b") { "a" : 1, "b" : 2 }, switch ("a") { "a" : 1, "b" : boom() }];',
      "[2, 1]",
      'function boom() { throw "boom"; }',
    ));
});

// Failure modes 13 and 14. https://cad.onshape.com/FsDoc/exceptions.html
describe("exceptions", () => {
  it("catch receives the thrown value", () =>
    expectValue('try { throw { message : "x" }; } catch (e) { return e.message; }', '"x"'));
  it("a catch block doesn't catch its own throw", () =>
    expectValue(
      "try { try { throw 1; } catch (e) { throw e + 1; } } catch (e2) { return e2; }",
      "2",
    ));
  it("try without catch continues after the block", () =>
    expectValue("var r = 1; try { throw 2; r = 3; } return r;", "1"));
  it("language errors are catchable", () =>
    expectValue(
      "var u; var a = []; return [try(u.x), try(a[3]), try(h(1)), try(sq(-1)), try(0 / 0), try('Q' as E)];",
      "[undefined, undefined, undefined, undefined, undefined, undefined]",
      `${ENUMS}\nfunction h(x is string) { return x; }\nfunction sq(n is number) precondition n >= 0; { return n; }`,
    ));
  it("try silent can't hide an unsupported builtin", () =>
    expectFault(
      'return try silent(evVolume(newContext(), { "entities" : qNothing() }));',
      "unsupported-builtin",
    ));
  it("an unknown name is a fault, not an exception", () =>
    expectFault("return try silent(notDefinedAnywhere);", "unresolved-name"));
});

// Failure mode 15. https://cad.onshape.com/FsDoc/relational.html
describe("ordering", () => {
  it("standard types sort undefined, boolean, number, string", () =>
    expectValue(
      'return keys({ "b" : 1, "a" : 1, 2 : 1, 1 : 1, true : 1 });',
      '[true, 1, 2, "a", "b"]',
    ));
  it("arrays sort by size first", () =>
    expectValue("return keys({ [2] : 1, [1, 1] : 1, [1] : 1 });", "[[1], [2], [1, 1]]"));
  it("tagged values sort after untagged ones", () =>
    expectValue('return keys({ (E.A) : 1, "z" : 2 });', '["z", E.A]', ENUMS));
  it("enum values sort by declaration order", () =>
    expectValue("return keys({ (Z.A) : 1, (Z.B) : 2 });", "[Z.B, Z.A]", ENUMS));
});

describe("limits", () => {
  const limited = testRuntime({ maxSteps: 100_000 });
  it("an infinite loop stops with a fault try can't catch", () =>
    limited.expectFault("try silent { while (true) {} } return 1;", "limit"));
  it("runaway recursion stops with a fault", () =>
    expectFault("return try silent(rec(0));", "limit", "function rec(n) { return rec(n + 1); }"));
});
