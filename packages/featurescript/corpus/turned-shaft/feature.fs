FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** A stepped shaft: a profile sketched on the XZ plane, revolved around the Z axis. */
annotation { "Feature Type Name" : "Turned shaft" }
export const turnedShaft = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Shoulder radius" }
        isLength(definition.shoulderRadius, { (millimeter) : [7, 10, 100] } as LengthBoundSpec);
    }
    {
        const r = definition.shoulderRadius;
        const sketch = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });
        const points = [vector(0 * millimeter, 0 * millimeter), vector(r, 0 * millimeter), vector(r, 20 * millimeter),
                        vector(6, 20) * millimeter, vector(6, 50) * millimeter, vector(0, 50) * millimeter];
        for (var i = 0; i < size(points); i += 1)
        {
            skLineSegment(sketch, "edge" ~ i, { "start" : points[i], "end" : points[(i + 1) % size(points)] });
        }
        skLineSegment(sketch, "axis", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 50) * millimeter, "construction" : true });
        skSolve(sketch);
        revolve(context, id + "revolve", { "entities" : qSketchRegion(id + "profile"), "axis" : sketchEntityQuery(id + "profile", EntityType.EDGE, "axis") });
        opDeleteBodies(context, id + "deleteSketch", { "entities" : qCreatedBy(id + "profile", EntityType.BODY) });
    });
