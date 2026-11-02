FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// The features of the 14 cases in corpus/, copied unchanged below this header so one Feature Studio
// holds them all. Each section names the file it came from.

// ---- corpus/bolt-circle/plate.fs
/** The base the bolt circle runs on: a 100 x 60 x 10 mm plate with its top face at z = 10 mm. */
annotation { "Feature Type Name" : "Plate" }
export const plate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "cuboid", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });
    });

// ---- corpus/bolt-circle/feature.fs
annotation { "Feature Type Name" : "Bolt circle",
        "Feature Type Description" : "Cuts evenly spaced holes on a circle" }
export const boltCircle = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Face", "Filter" : EntityType.FACE && GeometryType.PLANE, "MaxNumberOfPicks" : 1 }
        definition.face is Query;

        annotation { "Name" : "Hole count" }
        isInteger(definition.count, { (unitless) : [2, 6, 64] } as IntegerBoundSpec);

        annotation { "Name" : "Circle diameter" }
        isLength(definition.circleDiameter, { (millimeter) : [1, 50, 1e5] } as LengthBoundSpec);

        annotation { "Name" : "Hole diameter" }
        isLength(definition.holeDiameter, { (millimeter) : [0.5, 5, 1e4] } as LengthBoundSpec);

        annotation { "Name" : "Start angle" }
        isAngle(definition.startAngle, ANGLE_360_ZERO_DEFAULT_BOUNDS);

        annotation { "Name" : "Through all", "Default" : true }
        definition.throughAll is boolean;

        if (!definition.throughAll)
        {
            annotation { "Name" : "Depth" }
            isLength(definition.depth, LENGTH_BOUNDS);
        }
    }
    {
        const plane = evPlane(context, { "face" : definition.face });
        const radius = definition.circleDiameter / 2;
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane });

        for (var i = 0; i < definition.count; i += 1)
        {
            const angle = definition.startAngle + i * 360 * degree / definition.count;
            skCircle(sketch, "hole" ~ i, {
                    "center" : vector(cos(angle), sin(angle)) * radius,
                    "radius" : definition.holeDiameter / 2
            });
        }
        skSolve(sketch);

        extrude(context, id + "cut", {
                "entities" : qSketchRegion(id + "sketch"),
                "oppositeDirection" : true,
                "endBound" : definition.throughAll ? BoundingType.THROUGH_ALL : BoundingType.BLIND,
                "depth" : definition.depth,
                "operationType" : NewBodyOperationType.REMOVE,
                "defaultScope" : false,
                "booleanScope" : qOwnerBody(definition.face)
        });
    });

// ---- corpus/boss-pattern/feature.fs
/** One boss on a plate, copied to the other three corners with opPattern, then merged. */
annotation { "Feature Type Name" : "Boss pattern" }
export const bossPattern = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(80, 80, 5) * millimeter });
        fCylinder(context, id + "boss", { "bottomCenter" : vector(20, 20, 5) * millimeter, "topCenter" : vector(20, 20, 15) * millimeter, "radius" : 4 * millimeter });
        opPattern(context, id + "pattern", {
                "entities" : qCreatedBy(id + "boss", EntityType.BODY),
                "transforms" : [transform(vector(40, 0, 0) * millimeter), transform(vector(0, 40, 0) * millimeter), transform(vector(40, 40, 0) * millimeter)],
                "instanceNames" : ["1", "2", "3"]
        });
        opBoolean(context, id + "union", {
                "tools" : qUnion([qCreatedBy(id + "plate", EntityType.BODY), qCreatedBy(id + "boss", EntityType.BODY), qCreatedBy(id + "pattern", EntityType.BODY)]),
                "operationType" : BooleanOperationType.UNION
        });
    });

// ---- corpus/chamfered-block/feature.fs
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

// ---- corpus/construction/feature.fs
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

// ---- corpus/evaluators/feature.fs
/** Measures a block and a cylinder with std's evaluators and stores the results in millimeters. */
annotation { "Feature Type Name" : "Evaluators" }
export const evaluators = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        fCylinder(context, id + "pin", { "bottomCenter" : vector(60, 0, 0) * millimeter, "topCenter" : vector(60, 0, 10) * millimeter, "radius" : 5 * millimeter });
        const block = qCreatedBy(id + "block", EntityType.BODY);
        const pin = qCreatedBy(id + "pin", EntityType.BODY);
        const blockFace = function(point) { return qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), point * millimeter); };
        const blockEdge = function(point) { return qContainsPoint(qCreatedBy(id + "block", EntityType.EDGE), point * millimeter); };
        setVariable(context, "boxMaxX", evBox3d(context, { "topology" : block }).maxCorner[0] / millimeter);
        setVariable(context, "volume", evVolume(context, { "entities" : block }) / millimeter ^ 3);
        setVariable(context, "topArea", evArea(context, { "entities" : blockFace(vector(20, 15, 20)) }) / millimeter ^ 2);
        setVariable(context, "edgeLength", evLength(context, { "entities" : blockEdge(vector(20, 0, 0)) }) / millimeter);
        setVariable(context, "gap", evDistance(context, { "side0" : block, "side1" : pin }).distance / millimeter);
        setVariable(context, "cornerZ", evVertexPoint(context, { "vertex" : qContainsPoint(qCreatedBy(id + "block", EntityType.VERTEX), vector(40, 30, 20) * millimeter) })[2] / millimeter);
        setVariable(context, "edgeDirectionZ", abs(evEdgeTangentLine(context, { "edge" : blockEdge(vector(0, 0, 10)), "parameter" : 0.5 }).direction[2]));
        setVariable(context, "topNormalZ", evFaceTangentPlane(context, { "face" : blockFace(vector(20, 15, 20)), "parameter" : vector(0.5, 0.5) }).normal[2]);
        const pinSide = qGeometry(qCreatedBy(id + "pin", EntityType.FACE), GeometryType.CYLINDER);
        setVariable(context, "pinRadius", evSurfaceDefinition(context, { "face" : pinSide }).radius / millimeter);
        const pinTopEdge = qContainsPoint(qCreatedBy(id + "pin", EntityType.EDGE), vector(65, 0, 10) * millimeter);
        setVariable(context, "pinCircleRadius", evCurveDefinition(context, { "edge" : pinTopEdge }).radius / millimeter);
    });

// ---- corpus/filleted-block/feature.fs
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

// ---- corpus/lofted-frustum/feature.fs
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

// ---- corpus/mass-properties/feature.fs
/** Mass properties of a 10 x 20 x 30 mm block of density 1000 kg/m^3, and a face centroid. */
annotation { "Feature Type Name" : "Mass properties" }
export const massProperties = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 20, 30) * millimeter });
        const props = evApproximateMassProperties(context, { "entities" : qCreatedBy(id + "block", EntityType.BODY), "density" : 1000 * kilogram / meter ^ 3 });
        setVariable(context, "massGrams", props.mass / gram);
        setVariable(context, "volume", props.volume / millimeter ^ 3);
        setVariable(context, "centroidY", props.centroid[1] / millimeter);
        setVariable(context, "centroidZ", props.centroid[2] / millimeter);
        // inertia is a MatrixWithUnits in kg m^2; read it in kg mm^2.
        setVariable(context, "ixx", props.inertia.value[0][0] * 1e6);
        setVariable(context, "izz", props.inertia.value[2][2] * 1e6);
        setVariable(context, "ixy", props.inertia.value[0][1] * 1e6);
        // Two 10 mm cubes touching along z, evaluated together: centroid (10, 10, 5) mm, and each 1 g
        // cube sits at (+-5, +-5) from it, so Ixy = -(2 * 1 g * 25 mm^2) = -0.05 kg mm^2.
        fCuboid(context, id + "a", { "corner1" : vector(0, 0, 100) * millimeter, "corner2" : vector(10, 10, 110) * millimeter });
        fCuboid(context, id + "b", { "corner1" : vector(10, 10, 100) * millimeter, "corner2" : vector(20, 20, 110) * millimeter });
        const pair = evApproximateMassProperties(context, { "entities" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY)]), "density" : 1000 * kilogram / meter ^ 3 });
        setVariable(context, "pairIxy", pair.inertia.value[0][1] * 1e6);
        setVariable(context, "pairIyx", pair.inertia.value[1][0] * 1e6);
        const top = qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(5, 10, 30) * millimeter);
        setVariable(context, "topArea", evApproximateMassProperties(context, { "entities" : top, "density" : 1 * kilogram / meter ^ 2 }).area / millimeter ^ 2);
        setVariable(context, "topCentroidX", evApproximateCentroid(context, { "entities" : top })[0] / millimeter);
    });

// ---- corpus/shelled-box/feature.fs
/** A block hollowed out with 2 mm walls and its top face removed. */
annotation { "Feature Type Name" : "Shelled box" }
export const shelledBox = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const top = qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(20, 15, 20) * millimeter);
        shell(context, id + "shell", { "entities" : top, "thickness" : 2 * millimeter });
    });

// ---- corpus/sphere/feature.fs
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

// ---- corpus/split-block/feature.fs
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

// ---- corpus/swept-tube/feature.fs
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

// ---- corpus/thickened-plate/feature.fs
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

// ---- corpus/turned-shaft/feature.fs
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
