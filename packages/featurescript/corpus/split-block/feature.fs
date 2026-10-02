FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** Splits a 20 mm cube with the plane z = 5 mm. */
annotation { "Feature Type Name" : "Split block" }
export const splitBlock = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 20) * millimeter });
        opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "cube", EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });
        setVariable(context, "pieces", size(evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID))));
        setVariable(context, "lowerVolume", evVolume(context, { "entities" : qContainsPoint(qEverything(EntityType.BODY), vector(10, 10, 0) * millimeter) }) / millimeter ^ 3);
    });
