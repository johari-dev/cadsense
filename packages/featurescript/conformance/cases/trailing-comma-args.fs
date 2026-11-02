FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// One trailing comma in an argument list. Std never writes one; if Onshape rejects it, this whole
// Feature Studio fails to compile, so it lives in a file of its own.

annotation { "Feature Type Name" : "Trailing comma in arguments" }
export const langTrailingCommaArgs = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        setVariable(context, "count", max(1, 3, ));
    });
