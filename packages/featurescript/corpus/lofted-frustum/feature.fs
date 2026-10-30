FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** Lofts a 20 mm square at z = 0 to a 10 mm square at z = 30 mm: a frustum of a square pyramid. */
annotation { "Feature Type Name" : "Lofted frustum" }
export const loftedFrustum = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const bottom = newSketchOnPlane(context, id + "bottom", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(bottom, "square", { "firstCorner" : vector(-10, -10) * millimeter, "secondCorner" : vector(10, 10) * millimeter });
        skSolve(bottom);
        const top = newSketchOnPlane(context, id + "top", { "sketchPlane" : plane(vector(0, 0, 30) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(top, "square", { "firstCorner" : vector(-5, -5) * millimeter, "secondCorner" : vector(5, 5) * millimeter });
        skSolve(top);
        opLoft(context, id + "loft", { "profileSubqueries" : [qSketchRegion(id + "bottom"), qSketchRegion(id + "top")] });
        setVariable(context, "capCount", size(evaluateQuery(context, qCapEntity(id + "loft", CapType.EITHER, EntityType.FACE))));
    });
