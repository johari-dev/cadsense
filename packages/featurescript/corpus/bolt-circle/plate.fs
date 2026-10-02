FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** The base the bolt circle runs on: a 100 x 60 x 10 mm plate with its top face at z = 10 mm. */
annotation { "Feature Type Name" : "Plate" }
export const plate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cuboid", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });
    });
