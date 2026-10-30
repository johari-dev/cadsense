FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A construction plane and point, then a 5 mm circle sketched on the plane and extruded 4 mm. */
annotation { "Feature Type Name" : "Construction" }
export const construction = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        opPoint(context, id + "point", { "point" : vector(7, 0, 10) * millimeter });
        const planeFace = qCreatedBy(id + "plane", EntityType.FACE);
        const sketchPlane = evPlane(context, { "face" : planeFace });
        setVariable(context, "planeZ", sketchPlane.origin[2] / millimeter);
        setVariable(context, "planeIsConstruction", size(evaluateQuery(context, qConstructionFilter(planeFace, ConstructionObject.YES))));
        setVariable(context, "pointX", evVertexPoint(context, { "vertex" : qCreatedBy(id + "point", EntityType.VERTEX) })[0] / millimeter);
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : sketchPlane });
        skCircle(sketch, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 5 * millimeter });
        skSolve(sketch);
        extrude(context, id + "boss", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 4 * millimeter });
        setVariable(context, "bossTopZ", evBox3d(context, { "topology" : qCreatedBy(id + "boss", EntityType.BODY) }).maxCorner[2] / millimeter);
    });
