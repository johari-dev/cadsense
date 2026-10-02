FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A 10 mm sphere from opSphere: one face and no edges or vertices, like Parasolid. */
annotation { "Feature Type Name" : "Sphere" }
export const sphere = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        opSphere(context, id + "ball", { "center" : vector(0, 0, 5) * millimeter, "radius" : 10 * millimeter });
        setVariable(context, "centroidZ", evApproximateCentroid(context, { "entities" : qCreatedBy(id + "ball", EntityType.BODY) })[2] / millimeter);
    });
