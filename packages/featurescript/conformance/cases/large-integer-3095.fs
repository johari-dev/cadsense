FeatureScript 3095;
import(path : "onshape/std/geometry.fs", version : "3095.0");

// Integer literals past 2^53 under a 3095 header. Std 3095 adds V3095_LARGE_INTEGER_LITERALS; the same
// feature sits in a 3083 and a 3095 Feature Studio to show what changed. A literal Onshape rejects
// fails the whole Feature Studio, so each version has a file of its own.

annotation { "Feature Type Name" : "Large integer literal 3095" }
export const largeInteger3095 = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        setVariable(context, "printed", toString(12345678901234567890));
        setVariable(context, "tilde", "" ~ 12345678901234567890);
        setVariable(context, "twoTo53PlusOne", toString(9007199254740993));
        // 12345678901234567168 is the double nearest 12345678901234567890.
        setVariable(context, "equalsNearestDouble", 12345678901234567890 == 12345678901234567168);
        setVariable(context, "lastDigit", 12345678901234567890 % 10);
        setVariable(context, "tenth", toString(12345678901234567890 / 10));
        setVariable(context, "isInteger", isInteger(12345678901234567890));
        setVariable(context, "contextVersion", getCurrentVersion(context));
    });
