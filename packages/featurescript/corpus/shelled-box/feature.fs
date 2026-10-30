FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A block hollowed out with 2 mm walls and its top face removed. */
annotation { "Feature Type Name" : "Shelled box" }
export const shelledBox = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const top = qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(20, 15, 20) * millimeter);
        shell(context, id + "shell", { "entities" : top, "thickness" : 2 * millimeter });
    });
