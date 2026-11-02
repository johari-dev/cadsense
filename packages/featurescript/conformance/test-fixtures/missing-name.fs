FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Not a conformance case: test/conformance.compare.test.ts runs it to check that a fault other than
// an unsupported builtin (here a name that doesn't resolve) counts as a mismatch.

annotation { "Feature Type Name" : "Calls a missing function" }
export const callsMissingFunction = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        missingFunction(context);
    });
