FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/** Sweeps a 2 mm circle along a quarter arc of radius 20 mm that starts along +z. */
annotation { "Feature Type Name" : "Swept tube" }
export const sweptTube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });
        skSolve(profile);
        // Sketch (u, v) is world (u, 0, v) on this plane.
        const path = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0)) });
        skArc(path, "arc", { "start" : vector(0, 0) * millimeter, "mid" : vector(20 - 20 / sqrt(2), 20 / sqrt(2)) * millimeter, "end" : vector(20, 20) * millimeter });
        skSolve(path);
        opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });
        // The arc ends heading along +x, so the end cap is a disc centered on (20, 0, 20).
        const endCap = evApproximateCentroid(context, { "entities" : qCapEntity(id + "sweep", CapType.END, EntityType.FACE) });
        setVariable(context, "endCapX", endCap[0] / millimeter);
        setVariable(context, "endCapZ", endCap[2] / millimeter);
    });
