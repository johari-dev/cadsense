FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// One trailing comma in an enum. Std never writes one; if Onshape rejects it, this whole
// Feature Studio fails to compile, so it lives in a file of its own.

enum TrailingCommaEnumValues
{
    FIRST,
    SECOND,
}

annotation { "Feature Type Name" : "Trailing comma in an enum" }
export const langTrailingCommaEnum = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        setVariable(context, "count", size(keys({ TrailingCommaEnumValues.FIRST : 1, TrailingCommaEnumValues.SECOND : 2 })));
    });
