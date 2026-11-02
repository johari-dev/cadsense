FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Language behaviors FeatureScript.md lists as "to confirm against Onshape". Each feature stores what
// it sees in context variables, which the conformance probe reads back. An expression that throws is
// stored as "<error>".

/** Stores `value`, or "<error>" when the `try silent` around it caught an error (or it was undefined). */
function record(context is Context, name is string, value)
{
    setVariable(context, name, value == undefined ? "<error>" : value);
}

/**
 * `a + b as T`: `(a + b) as T` keeps the sum and drops its tag; `a + (b as T)` adds a Vector to a plain
 * array, which no std operator accepts. `1 == 1 as boolean` likewise tells `==` from `as`.
 */
annotation { "Feature Type Name" : "As precedence" }
export const langAsPrecedence = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sum = try silent(vector(1, 2) + vector(3, 4) as array);
        record(context, "sum", sum);
        record(context, "sumIsVector", try silent(sum is Vector));
        record(context, "equality", try silent(1 == 1 as boolean));
        record(context, "product", try silent(2 * vector(1, 2) as array));
    });

/** `a ?? b || c` and `a ?? b == c`, with values that give different results for each grouping. */
annotation { "Feature Type Name" : "Nullish precedence" }
export const langNullishPrecedence = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        // `false ?? (false || true)` is false; `(false ?? false) || true` is true.
        record(context, "withOr", try silent(false ?? false || true));
        // `1 ?? (2 == 3)` is 1; `(1 ?? 2) == 3` is false.
        record(context, "withEquals", try silent(1 ?? 2 == 3));
        // `(undefined ?? false) ? "a" : "b"` is "b".
        record(context, "withConditional", try silent(undefined ?? false ? "a" : "b"));
        // `undefined ?? (1 + 1)` and `(undefined ?? 1) + 1` are both 2.
        record(context, "withPlus", try silent(undefined ?? 1 + 1));
    });

/** `^` associativity and how it binds against unary minus. */
annotation { "Feature Type Name" : "Power" }
export const langPower = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const x = 3;
        record(context, "negTwoSquared", try silent(-2 ^ 2));
        record(context, "negXSquared", try silent(-x ^ 2));
        record(context, "twoCubedSquared", try silent(2 ^ 3 ^ 2));
        record(context, "twoToMinusOne", try silent(2 ^ -1));
        record(context, "parenthesized", try silent((-2) ^ 2));
        record(context, "timesPower", try silent(2 * 3 ^ 2));
    });

/** Map key order and number formatting in `toString`. */
annotation { "Feature Type Name" : "toString" }
export const langToString = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const mixed = { "b" : 1, "a" : 2, "B" : 3, 10 : "ten", 9 : "nine", true : "yes", false : "no" };
        record(context, "mixedMap", try silent(toString(mixed)));
        record(context, "mixedKeys", try silent(toString(keys(mixed))));
        record(context, "enumKeys", try silent(toString(keys({ EntityType.VERTEX : 1, EntityType.BODY : 2, EntityType.FACE : 3 }))));
        record(context, "nested", try silent(toString({ "list" : [1, [2, 3]], "map" : { "z" : 1, "y" : 2 } })));
        const numbers = [0.1 + 0.2, 1 / 3, 2.0, 100, 1e21, 1e-7, 123456789012, -0, PI, 1.5e300, inf, -inf, 0.000123, 1e6, 12345.678];
        var printed = [];
        for (var n in numbers)
            printed = append(printed, try silent(toString(n)));
        record(context, "numbers", printed);
    });

/** How `~` prints tagged values, numbers and nested containers. */
annotation { "Feature Type Name" : "Tilde" }
export const langTilde = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        record(context, "length", try silent("" ~ 2 * meter));
        record(context, "lengthMm", try silent("" ~ 25 * millimeter));
        record(context, "vector", try silent("" ~ vector(1, 2, 3) * millimeter));
        record(context, "plainVector", try silent("" ~ vector(1, 2, 3)));
        record(context, "nested", try silent("" ~ [1, [2, "x"], { "a" : 1, "b" : [true, undefined] }]));
        record(context, "enumValue", try silent("" ~ EntityType.FACE));
        record(context, "undefinedValue", try silent("" ~ undefined));
        record(context, "booleanValue", try silent("" ~ true));
        record(context, "half", try silent("" ~ 0.5));
        record(context, "third", try silent("" ~ 1 / 3));
        record(context, "large", try silent("" ~ 1e21));
        record(context, "integerLike", try silent("" ~ 2.0));
        record(context, "id", try silent("" ~ makeId("a")));
        record(context, "box", try silent("" ~ new box(1)));
        record(context, "planeValue", try silent("" ~ plane(vector(0, 0, 0) * meter, vector(0, 0, 1))));
    });
