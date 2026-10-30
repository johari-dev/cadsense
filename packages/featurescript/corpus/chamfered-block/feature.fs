FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A block with the four edges of its top face chamfered. */
annotation { "Feature Type Name" : "Chamfered block" }
export const chamferedBlock = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const topEdges = qCoincidesWithPlane(qCreatedBy(id + "block", EntityType.EDGE), plane(vector(0, 0, 20) * millimeter, vector(0, 0, 1)));
        chamfer(context, id + "chamfer", { "entities" : topEdges, "width" : 2 * millimeter });
    });
