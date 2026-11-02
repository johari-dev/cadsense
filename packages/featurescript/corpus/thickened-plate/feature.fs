FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** Thickens a 20 mm square sketch region 3 mm along its normal and 2 mm against it. */
annotation { "Feature Type Name" : "Thickened plate" }
export const thickenedPlate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(sketch, "square", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(20, 20) * millimeter });
        skSolve(sketch);
        opThicken(context, id + "thicken", { "entities" : qSketchRegion(id + "sketch"), "thickness1" : 3 * millimeter, "thickness2" : 2 * millimeter });
        const box = evBox3d(context, { "topology" : qCreatedBy(id + "thicken", EntityType.BODY) });
        setVariable(context, "minZ", box.minCorner[2] / millimeter);
        setVariable(context, "maxZ", box.maxCorner[2] / millimeter);
    });
