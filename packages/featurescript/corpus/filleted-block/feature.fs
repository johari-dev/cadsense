FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A block with its four vertical edges filleted. */
annotation { "Feature Type Name" : "Filleted block" }
export const filletedBlock = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Radius" }
        isLength(definition.radius, { (millimeter) : [0.5, 5, 14] } as LengthBoundSpec);
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        fillet(context, id + "fillet", { "entities" : qParallelEdges(qCreatedBy(id + "block", EntityType.EDGE), vector(0, 0, 1)), "radius" : definition.radius });
    });
