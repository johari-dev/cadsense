FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Std's own features called from custom features with typical inputs, each on geometry it builds
// itself. The corpus already covers the plainest uses of extrude, revolve, fillet, chamfer, shell,
// opLoft and opSweep, so these pick the next most common options.

/** Sketches `points` (in millimeters, closed) on `sketchPlane` as line segments. */
function sketchPolygon(context is Context, id is Id, sketchPlane is Plane, points is array)
{
    const sketch = newSketchOnPlane(context, id, { "sketchPlane" : sketchPlane });
    for (var i = 0; i < size(points); i += 1)
        skLineSegment(sketch, "edge" ~ i, { "start" : points[i] * millimeter, "end" : points[(i + 1) % size(points)] * millimeter });
    skSolve(sketch);
}

const XY_PLANE = plane(vector(0, 0, 0) * meter, vector(0, 0, 1), vector(1, 0, 0));
// Sketch (u, v) is world (u, 0, v) on this plane.
const XZ_PLANE = plane(vector(0, 0, 0) * meter, vector(0, -1, 0), vector(1, 0, 0));

/** A 40 x 30 x 10 mm block, a 16 mm boss extruded 15 mm onto its top, and a 10 x 6 mm pocket cut 5 mm deep. */
annotation { "Feature Type Name" : "Std extrude" }
export const stdExtrude = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });
        const top = plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0));
        const bossSketch = newSketchOnPlane(context, id + "bossSketch", { "sketchPlane" : top });
        skCircle(bossSketch, "circle", { "center" : vector(15, 15) * millimeter, "radius" : 8 * millimeter });
        skSolve(bossSketch);
        extrude(context, id + "boss", {
                    "entities" : qSketchRegion(id + "bossSketch"),
                    "endBound" : BoundingType.BLIND,
                    "depth" : 15 * millimeter,
                    "operationType" : NewBodyOperationType.ADD,
                    "defaultScope" : true
                });
        sketchPolygon(context, id + "pocketSketch", top, [vector(28, 4), vector(38, 4), vector(38, 10), vector(28, 10)]);
        extrude(context, id + "pocket", {
                    "entities" : qSketchRegion(id + "pocketSketch"),
                    "endBound" : BoundingType.BLIND,
                    "depth" : 5 * millimeter,
                    "oppositeDirection" : true,
                    "operationType" : NewBodyOperationType.REMOVE,
                    "defaultScope" : true
                });
    });

/** A 10 x 5 mm rectangle revolved fully about z (a washer), and a second one revolved 90 degrees. */
annotation { "Feature Type Name" : "Std revolve" }
export const stdRevolve = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const full = newSketchOnPlane(context, id + "fullSketch", { "sketchPlane" : XZ_PLANE });
        skRectangle(full, "profile", { "firstCorner" : vector(10, 0) * millimeter, "secondCorner" : vector(20, 5) * millimeter });
        skLineSegment(full, "axis", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 10) * millimeter, "construction" : true });
        skSolve(full);
        revolve(context, id + "full", {
                    "entities" : qSketchRegion(id + "fullSketch"),
                    "axis" : sketchEntityQuery(id + "fullSketch", EntityType.EDGE, "axis")
                });
        const partial = newSketchOnPlane(context, id + "partialSketch", { "sketchPlane" : XZ_PLANE });
        skRectangle(partial, "profile", { "firstCorner" : vector(30, 0) * millimeter, "secondCorner" : vector(40, 5) * millimeter });
        skLineSegment(partial, "axis", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 10) * millimeter, "construction" : true });
        skSolve(partial);
        revolve(context, id + "partial", {
                    "entities" : qSketchRegion(id + "partialSketch"),
                    "axis" : sketchEntityQuery(id + "partialSketch", EntityType.EDGE, "axis"),
                    "fullRevolve" : false,
                    "endBound" : RevolveBoundingType.BLIND,
                    "angle" : 90 * degree,
                    "symmetric" : false,
                    "oppositeDirection" : false
                });
    });

/** A 40 x 30 x 20 mm block with the four edges of its top face filleted at 3 mm. */
annotation { "Feature Type Name" : "Std fillet" }
export const stdFillet = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        fillet(context, id + "fillet", {
                    "entities" : qCoincidesWithPlane(qCreatedBy(id + "block", EntityType.EDGE), plane(vector(0, 0, 20) * millimeter, vector(0, 0, 1))),
                    "radius" : 3 * millimeter
                });
    });

/** A 40 x 30 x 20 mm block with its top edges chamfered 2 mm by 3 mm (two offsets). */
annotation { "Feature Type Name" : "Std chamfer" }
export const stdChamfer = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        chamfer(context, id + "chamfer", {
                    "entities" : qCoincidesWithPlane(qCreatedBy(id + "block", EntityType.EDGE), plane(vector(0, 0, 20) * millimeter, vector(0, 0, 1))),
                    "chamferType" : ChamferType.TWO_OFFSETS,
                    "width1" : 2 * millimeter,
                    "width2" : 3 * millimeter
                });
    });

/** A 40 x 30 x 20 mm block shelled 1.5 mm inward with its top (z = 20) and front (y = 0) faces removed. */
annotation { "Feature Type Name" : "Std shell" }
export const stdShell = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const faces = qCreatedBy(id + "block", EntityType.FACE);
        shell(context, id + "shell", {
                    "entities" : qUnion([qContainsPoint(faces, vector(20, 15, 20) * millimeter), qContainsPoint(faces, vector(20, 0, 10) * millimeter)]),
                    "thickness" : 1.5 * millimeter
                });
    });

/** Std's loft feature from a 10 mm circle at z = 0 to a 10 mm square at z = 30 mm. */
annotation { "Feature Type Name" : "Std loft" }
export const stdLoft = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const bottom = newSketchOnPlane(context, id + "bottom", { "sketchPlane" : XY_PLANE });
        skCircle(bottom, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 10 * millimeter });
        skSolve(bottom);
        sketchPolygon(context, id + "top", plane(vector(0, 0, 30) * millimeter, vector(0, 0, 1), vector(1, 0, 0)),
            [vector(-5, -5), vector(5, -5), vector(5, 5), vector(-5, 5)]);
        loft(context, id + "loft", {
                    "sheetProfilesArray" : [{ "sheetProfileEntities" : qSketchRegion(id + "bottom") }, { "sheetProfileEntities" : qSketchRegion(id + "top") }]
                });
    });

/** Std's sweep feature: a 3 mm circle swept along a 30 mm line then a tangent quarter arc of radius 20 mm. */
annotation { "Feature Type Name" : "Std sweep" }
export const stdSweep = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const profile = newSketchOnPlane(context, id + "profile", { "sketchPlane" : XY_PLANE });
        skCircle(profile, "circle", { "center" : vector(0, 0) * millimeter, "radius" : 3 * millimeter });
        skSolve(profile);
        const path = newSketchOnPlane(context, id + "path", { "sketchPlane" : XZ_PLANE });
        skLineSegment(path, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 30) * millimeter });
        skArc(path, "arc", { "start" : vector(0, 30) * millimeter, "mid" : vector(20 - 20 / sqrt(2), 30 + 20 / sqrt(2)) * millimeter, "end" : vector(20, 50) * millimeter });
        skSolve(path);
        sweep(context, id + "sweep", {
                    "profiles" : qSketchRegion(id + "profile"),
                    "path" : qCreatedBy(id + "path", EntityType.EDGE)
                });
    });

/** A 4 mm pin on a plate, patterned as a part: 4 instances 15 mm apart along x. */
annotation { "Feature Type Name" : "Std linear pattern" }
export const stdLinearPattern = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(70, 20, 5) * millimeter });
        fCylinder(context, id + "pin", { "bottomCenter" : vector(10, 10, 5) * millimeter, "topCenter" : vector(10, 10, 15) * millimeter, "radius" : 4 * millimeter });
        linearPattern(context, id + "pattern", {
                    "patternType" : PatternType.PART,
                    "entities" : qCreatedBy(id + "pin", EntityType.BODY),
                    "directionOne" : qContainsPoint(qCreatedBy(id + "plate", EntityType.EDGE), vector(35, 0, 0) * millimeter),
                    "distance" : 15 * millimeter,
                    "instanceCount" : 4
                });
    });

/** A 3 mm pin 20 mm from a 5 mm hub, patterned as a part: 6 instances around the hub's axis. */
annotation { "Feature Type Name" : "Std circular pattern" }
export const stdCircularPattern = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCylinder(context, id + "hub", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 10) * millimeter, "radius" : 5 * millimeter });
        fCylinder(context, id + "pin", { "bottomCenter" : vector(20, 0, 0) * millimeter, "topCenter" : vector(20, 0, 10) * millimeter, "radius" : 3 * millimeter });
        circularPattern(context, id + "pattern", {
                    "patternType" : PatternType.PART,
                    "entities" : qCreatedBy(id + "pin", EntityType.BODY),
                    "axis" : qGeometry(qCreatedBy(id + "hub", EntityType.FACE), GeometryType.CYLINDER),
                    "angle" : 360 * degree,
                    "instanceCount" : 6,
                    "equalSpace" : true
                });
    });

/** A simple 6 mm hole through a 40 x 30 x 10 mm block at a sketch point on its top face. */
annotation { "Feature Type Name" : "Std hole" }
export const stdHole = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 10) * millimeter });
        const sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 10) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
        skPoint(sketch, "center", { "position" : vector(20, 15) * millimeter });
        skSolve(sketch);
        hole(context, id + "hole", {
                    "locations" : qCreatedBy(id + "sketch", EntityType.VERTEX),
                    "scope" : qCreatedBy(id + "block", EntityType.BODY),
                    "style" : HoleStyle.SIMPLE,
                    "endStyle" : HoleEndStyle.THROUGH,
                    "holeDiameter" : 6 * millimeter
                });
    });

/** The four side faces of a 40 x 30 x 20 mm block drafted 5 degrees about its bottom face. */
annotation { "Feature Type Name" : "Std draft" }
export const stdDraft = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const faces = qCreatedBy(id + "block", EntityType.FACE);
        // One point on each side face: y = 0, x = 40, y = 30, x = 0.
        const sides = qUnion(mapArray([vector(20, 0, 10), vector(40, 15, 10), vector(20, 30, 10), vector(0, 15, 10)],
                function(point) { return qContainsPoint(faces, point * millimeter); }));
        draft(context, id + "draft", {
                    "neutralPlane" : qContainsPoint(faces, vector(20, 15, 0) * millimeter),
                    "draftFaces" : sides,
                    "angle" : 5 * degree
                });
    });

/** A 3-turn helix on the side of a 10 mm cylinder, 30 mm tall. */
annotation { "Feature Type Name" : "Std helix" }
export const stdHelix = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCylinder(context, id + "cylinder", { "bottomCenter" : vector(0, 0, 0) * millimeter, "topCenter" : vector(0, 0, 30) * millimeter, "radius" : 10 * millimeter });
        helix(context, id + "helix", {
                    "axisType" : AxisType.SURFACE,
                    "entities" : qGeometry(qCreatedBy(id + "cylinder", EntityType.FACE), GeometryType.CYLINDER),
                    "pathType" : PathType.TURNS,
                    "revolutions" : 3,
                    "startAngle" : 0 * degree,
                    "handedness" : Direction.CW
                });
    });

/** Std's variable feature assigns #wall = 4 mm, and a block reads it back for its height. */
annotation { "Feature Type Name" : "Std variable" }
export const stdVariable = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        assignVariable(context, id + "variable", {
                    "mode" : VariableMode.ASSIGNED,
                    "variableType" : VariableType.LENGTH,
                    "name" : "wall",
                    "lengthValue" : 4 * millimeter
                });
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 0) * millimeter + vector(0 * meter, 0 * meter, getVariable(context, "wall")) });
    });

/** Std's mate connector feature at the centroid of a block's top face, moved up 5 mm and turned 30 degrees. */
annotation { "Feature Type Name" : "Std mate connector" }
export const stdMateConnector = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "block", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(40, 30, 20) * millimeter });
        const block = qCreatedBy(id + "block", EntityType.BODY);
        mateConnector(context, id + "connector", {
                    "originType" : OriginCreationType.ON_ENTITY,
                    "originQuery" : qContainsPoint(qCreatedBy(id + "block", EntityType.FACE), vector(20, 15, 20) * millimeter),
                    "entityInferenceType" : EntityInferenceType.CENTROID,
                    "ownerPart" : block,
                    "transform" : true,
                    "translationZ" : 5 * millimeter,
                    "rotationType" : RotationType.ABOUT_Z,
                    "rotation" : 30 * degree
                });
    });
