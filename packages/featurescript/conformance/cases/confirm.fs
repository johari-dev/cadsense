FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Geometry behaviors FeatureScript.md lists as "to confirm against Onshape". Each feature builds what
// it needs; the conformance case reads the answers back with evaluators after it runs.

/** A 40 x 30 x 20 mm block, and an L-shaped sketch region whose centroid differs from its box center. */
annotation { "Feature Type Name" : "evPlane origin" }
export const confirmEvPlaneOrigin = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        // An L: 30 x 10 along x plus 10 x 20 up y, at z = 50 mm. Centroid (11, 11) mm; box center (15, 15) mm.
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 50) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        const points = [vector(0, 0), vector(30, 0), vector(30, 10), vector(10, 10), vector(10, 30), vector(0, 30)];
        for (var i = 0; i < size(points); i += 1)
            skLineSegment(sketch, "edge" ~ i, { "start" : points[i] * millimeter, "end" : points[(i + 1) % size(points)] * millimeter });
        skSolve(sketch);
        extrude(context, id + "lBlock", { "entities" : qSketchRegion(id + "sketch"), "endBound" : BoundingType.BLIND, "depth" : 5 * millimeter });
    });

/** A sketch with a closed rectangle, an open line and a circle. */
annotation { "Feature Type Name" : "Sketch bodies" }
export const confirmSketchBodies = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(sketch, "rectangle", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(20, 10) * millimeter });
        skLineSegment(sketch, "line", { "start" : vector(30, 0) * millimeter, "end" : vector(40, 10) * millimeter });
        skCircle(sketch, "circle", { "center" : vector(60, 5) * millimeter, "radius" : 5 * millimeter });
        skSolve(sketch);
    });

/** Three blocks created in the order 3, 1, 2 (by volume), placed at x = 20, 0 and 10 mm. */
annotation { "Feature Type Name" : "Query order" }
export const confirmQueryOrder = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "third", { "corner1" : vector(20, 0, 0) * millimeter, "corner2" : vector(23, 1, 1) * millimeter });
        fCuboid(context, id + "first", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(1, 1, 1) * millimeter });
        fCuboid(context, id + "second", { "corner1" : vector(10, 0, 0) * millimeter, "corner2" : vector(12, 1, 1) * millimeter });
    });

/** A 40 x 30 x 20 mm block, and a 5 mm circle on its top face extruded through all as a new body. */
annotation { "Feature Type Name" : "Through all, new body" }
export const confirmThroughAllNew = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 20) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(sketch, "circle", { "center" : vector(20, 15) * millimeter, "radius" : 5 * millimeter });
        skSolve(sketch);
        extrude(context, id + "extrude", {
                    "entities" : qSketchRegion(id + "sketch"),
                    "endBound" : BoundingType.THROUGH_ALL,
                    "oppositeDirection" : true,
                    "operationType" : NewBodyOperationType.NEW
                });
    });

/** The same block 100 mm along x, with the circle cut through all with a removal. */
annotation { "Feature Type Name" : "Through all, remove" }
export const confirmThroughAllRemove = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(100, 0, 0) * millimeter, "corner2" : vector(140, 30, 20) * millimeter });
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(100, 0, 20) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(sketch, "circle", { "center" : vector(20, 15) * millimeter, "radius" : 5 * millimeter });
        skSolve(sketch);
        extrude(context, id + "extrude", {
                    "entities" : qSketchRegion(id + "sketch"),
                    "endBound" : BoundingType.THROUGH_ALL,
                    "oppositeDirection" : true,
                    "operationType" : NewBodyOperationType.REMOVE,
                    "defaultScope" : false,
                    "booleanScope" : qCreatedBy(id + "block", EntityType.BODY)
                });
    });

/** A fit spline through unevenly spaced points, for edge parameters and point spacing. */
annotation { "Feature Type Name" : "Fit spline" }
export const confirmFitSpline = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const points = [vector(0, 0, 0) * millimeter, vector(5, 0, 0) * millimeter, vector(30, 10, 0) * millimeter, vector(40, 0, 0) * millimeter];
        opFitSpline(context, id + "plain", { "points" : points });
        opFitSpline(context, id + "derivatives", {
                    "points" : mapArray(points, function(p) { return p + vector(0, 0, 20) * millimeter; }),
                    "startDerivative" : vector(0, 40, 0) * millimeter,
                    "endDerivative" : vector(0, -40, 0) * millimeter
                });
    });

/** A 20 mm cube split by the plane z = 5 mm. */
annotation { "Feature Type Name" : "Split part id" }
export const confirmSplitPartId = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 20) * millimeter });
        opSplitPart(context, id + "split", { "targets" : qCreatedBy(id + "cube", EntityType.BODY), "tool" : plane(vector(0, 0, 5) * millimeter, vector(0, 0, 1)) });
    });

/** An L-shaped part, the union of a 20 x 10 x 10 mm and a 10 x 20 x 10 mm block, for the full inertia tensor. */
annotation { "Feature Type Name" : "Inertia products" }
export const confirmInertiaProducts = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 10, 10) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(0, 10, 0) * millimeter, "corner2" : vector(10, 30, 10) * millimeter });
        opBoolean(context, id + "union", { "tools" : qCreatedBy(id, EntityType.BODY), "operationType" : BooleanOperationType.UNION });
    });

/** opPlane without a size and opPoint, read back as bodies. */
annotation { "Feature Type Name" : "Plane and point" }
export const confirmPlaneAndPoint = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        opPoint(context, id + "point", { "point" : vector(7, 0, 10) * millimeter });
    });

/** A 10 mm cube, for qContainsPoint on its body and faces. */
annotation { "Feature Type Name" : "Contains point" }
export const confirmContainsPoint = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
    });

/** Names a block, then reads the name back with getProperty inside the feature. */
annotation { "Feature Type Name" : "getProperty" }
export const confirmGetProperty = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        const block = qCreatedBy(id + "block", EntityType.BODY);
        setProperty(context, { "entities" : block, "propertyType" : PropertyType.NAME, "value" : "Named block" });
        var read = "<no value>";
        try
        {
            const name = getProperty(context, { "entity" : block, "propertyType" : PropertyType.NAME });
            read = name == undefined ? "<undefined>" : name;
        }
        catch (error)
        {
            read = "<error>";
        }
        setVariable(context, "readName", read);
    });

/** A fit spline wire and a mate connector, both moved 100 mm along x with opTransform. */
annotation { "Feature Type Name" : "Transform wire and point" }
export const confirmTransformWireAndPoint = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "owner", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
        opFitSpline(context, id + "wire", { "points" : [vector(0, 0, 20) * millimeter, vector(10, 5, 20) * millimeter, vector(20, 0, 20) * millimeter] });
        opMateConnector(context, id + "connector", {
                    "coordSystem" : coordSystem(vector(5, 5, 10) * millimeter, vector(1, 0, 0), vector(0, 0, 1)),
                    "owner" : qCreatedBy(id + "owner", EntityType.BODY)
                });
        opTransform(context, id + "move", {
                    "bodies" : qUnion([qCreatedBy(id + "wire", EntityType.BODY), qCreatedBy(id + "connector", EntityType.BODY)]),
                    "transform" : transform(vector(100, 0, 0) * millimeter)
                });
    });

/** A 10 mm cube, for qClosestTo with ties. */
annotation { "Feature Type Name" : "Closest to" }
export const confirmClosestTo = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });
    });

/** A sketch with one circle on `face`, made by std's newSketch, which aligns the plane itself. */
function sketchOnFace(context is Context, id is Id, face is Query)
{
    const sketch = newSketch(context, id, { "sketchPlane" : face });
    skCircle(sketch, "circle", { "center" : vector(5, 5) * millimeter, "radius" : 2 * millimeter });
    skSolve(sketch);
}

/**
 * A 40 x 30 x 20 mm block away from the origin, from (10, 20, 5) to (50, 50, 25) mm, with a sketch on
 * its bottom (normal -z), back (+y) and left (-x) faces. Each sketch has a 2 mm circle at sketch
 * (5, 5) mm, so where its center lands shows the sketch's origin and axes.
 */
annotation { "Feature Type Name" : "Sketches on faces" }
export const confirmSketchesOnFaces = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(10, 20, 5) * millimeter, "corner2" : vector(50, 50, 25) * millimeter });
        const faces = qCreatedBy(id + "block", EntityType.FACE);
        sketchOnFace(context, id + "bottomSketch", qContainsPoint(faces, vector(30, 35, 5) * millimeter));
        sketchOnFace(context, id + "backSketch", qContainsPoint(faces, vector(30, 50, 15) * millimeter));
        sketchOnFace(context, id + "leftSketch", qContainsPoint(faces, vector(10, 35, 15) * millimeter));
    });

/** Three sketches on the XY plane: a lone 10 mm circle, a 20 x 10 mm rectangle, and a 5 mm circle inside a 40 mm square. */
annotation { "Feature Type Name" : "Sketch edges" }
export const confirmSketchEdges = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const circle = newSketchOnPlane(context, id + "circleSketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(circle, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 10 * millimeter });
        skSolve(circle);
        const rectangle = newSketchOnPlane(context, id + "rectangleSketch", { "sketchPlane" : plane(vector(50, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(rectangle, "rectangle", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(20, 10) * millimeter });
        skSolve(rectangle);
        const nested = newSketchOnPlane(context, id + "nestedSketch", { "sketchPlane" : plane(vector(100, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skRectangle(nested, "square", { "firstCorner" : vector(0, 0) * millimeter, "secondCorner" : vector(40, 40) * millimeter });
        skCircle(nested, "circle", { "center" : vector(20, 20) * millimeter, "radius" : 5 * millimeter });
        skSolve(nested);
    });

/**
 * Std's sweep of a 1 mm circle along every edge qCreatedBy finds in a sketch of one 10 mm circle on
 * the XY plane. The profile sits across the path at (10, 0, 0) mm, facing along it. By Pappus a
 * full sweep is PI 1^2 * 2 PI 10 = 197.39 mm^3.
 */
annotation { "Feature Type Name" : "Sweep along a sketch circle" }
export const confirmSweepAlongSketchCircle = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const path = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(path, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 10 * millimeter });
        skSolve(path);
        const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });
        skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });
        skSolve(profile);
        sweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });
    });

/**
 * opSweep, without std's sweep feature around it, of a 1 mm circle along every edge qCreatedBy
 * finds in a sketch of one 10 mm circle on the XY plane. The same geometry as
 * {@link confirmSweepAlongSketchCircle}; a full sweep is 197.39 mm^3.
 */
annotation { "Feature Type Name" : "opSweep along a sketch circle" }
export const confirmOpSweepAlongSketchCircle = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const path = newSketchOnPlane(context, id + "path", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skCircle(path, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 10 * millimeter });
        skSolve(path);
        const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(10, 0, 0) * millimeter, vector(0, 1, 0), vector(1, 0, 0)) });
        skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 1 * millimeter });
        skSolve(profile);
        opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });
    });
