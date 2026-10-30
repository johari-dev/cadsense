FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Sketches whose solve Onshape doesn't document: over-constrained, inconsistent or ambiguous
// constraints. Each feature makes one sketch, `id + "sketch"`, on the XY plane, so sketch
// coordinates are world x and y. The conformance cases read the solved entities back through
// sketchEntityQuery and the feature's status.

/** A sketch on the XY plane, with sketch x along world x. */
function xySketch(context is Context, id is Id) returns Sketch
{
    return newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1), vector(1, 0, 0)) });
}

/**
 * A FIXed 10 mm arc around the origin from 0 to 90 degrees, with its end pulled by a COINCIDENT onto
 * a FIXed point at -10 degrees on the same circle. FIX on an arc holds its center and radius, not
 * its ends, so the solve can move the end along the circle.
 */
annotation { "Feature Type Name" : "Solver: fixed arc, end pulled" }
export const solverArcPulled = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = xySketch(context, id);
        skArc(sketch, "arc", {
                    "start" : vector(10, 0) * millimeter,
                    "mid" : vector(cos(45 * degree), sin(45 * degree)) * 10 * millimeter,
                    "end" : vector(0, 10) * millimeter
                });
        skPoint(sketch, "target", { "position" : vector(cos(-10 * degree), sin(-10 * degree)) * 10 * millimeter });
        skConstraint(sketch, "fixArc", { "constraintType" : ConstraintType.FIX, "localFirst" : "arc" });
        skConstraint(sketch, "fixTarget", { "constraintType" : ConstraintType.FIX, "localFirst" : "target" });
        skConstraint(sketch, "pull", { "constraintType" : ConstraintType.COINCIDENT, "localFirst" : "arc.end", "localSecond" : "target" });
        skSolve(sketch);
    });

/**
 * A parallelogram of four lines joined end to end by COINCIDENTs, with both pairs of opposite
 * sides PARALLEL, and the bottom and top given LENGTHs 10 and 12 mm. A parallelogram's opposite
 * sides are equal, so the constraints can't all hold. Drawn as (0, 0), (10, 0), (13, 5), (3, 5) mm.
 */
annotation { "Feature Type Name" : "Solver: inconsistent parallelogram" }
export const solverInconsistentParallelogram = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = xySketch(context, id);
        const corners = [vector(0, 0), vector(10, 0), vector(13, 5), vector(3, 5)];
        for (var i = 0; i < 4; i += 1)
        {
            skLineSegment(sketch, "line" ~ i, { "start" : corners[i] * millimeter, "end" : corners[(i + 1) % 4] * millimeter });
        }
        for (var i = 0; i < 4; i += 1)
        {
            skConstraint(sketch, "join" ~ i, {
                        "constraintType" : ConstraintType.COINCIDENT,
                        "localFirst" : "line" ~ i ~ ".end",
                        "localSecond" : "line" ~ ((i + 1) % 4) ~ ".start"
                    });
        }
        skConstraint(sketch, "parallel02", { "constraintType" : ConstraintType.PARALLEL, "localFirst" : "line0", "localSecond" : "line2" });
        skConstraint(sketch, "parallel13", { "constraintType" : ConstraintType.PARALLEL, "localFirst" : "line1", "localSecond" : "line3" });
        skConstraint(sketch, "length0", { "constraintType" : ConstraintType.LENGTH, "localFirst" : "line0", "length" : 10 * millimeter });
        skConstraint(sketch, "length2", { "constraintType" : ConstraintType.LENGTH, "localFirst" : "line2", "length" : 12 * millimeter });
        skSolve(sketch);
    });

/** A FIXed line drawn from (0, 0) to (10, 0) mm, with a LENGTH of 15 mm it can't reach. */
annotation { "Feature Type Name" : "Solver: fixed line, length" }
export const solverFixedLineLength = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = xySketch(context, id);
        skLineSegment(sketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(10, 0) * millimeter });
        skConstraint(sketch, "fix", { "constraintType" : ConstraintType.FIX, "localFirst" : "line" });
        skConstraint(sketch, "length", { "constraintType" : ConstraintType.LENGTH, "localFirst" : "line", "length" : 15 * millimeter });
        skSolve(sketch);
    });

/** A FIXed line from `start` to `end`, and a point drawn on it at (5, 0) mm with a DISTANCE of 5 mm to the line. */
function pointOffLine(context is Context, id is Id, start is Vector, end is Vector)
{
    const sketch = xySketch(context, id);
    skLineSegment(sketch, "line", { "start" : start * millimeter, "end" : end * millimeter });
    skPoint(sketch, "point", { "position" : vector(5, 0) * millimeter });
    skConstraint(sketch, "fix", { "constraintType" : ConstraintType.FIX, "localFirst" : "line" });
    skConstraint(sketch, "distance", {
                "constraintType" : ConstraintType.DISTANCE,
                "localFirst" : "point",
                "localSecond" : "line",
                "direction" : DimensionDirection.MINIMUM,
                "length" : 5 * millimeter
            });
    skSolve(sketch);
}

/** {@link pointOffLine} with the line drawn left to right, (0, 0) to (10, 0) mm. */
annotation { "Feature Type Name" : "Solver: point off a line, left to right" }
export const solverDistanceLeftToRight = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        pointOffLine(context, id, vector(0, 0), vector(10, 0));
    });

/** {@link pointOffLine} with the line drawn right to left, (10, 0) to (0, 0) mm. */
annotation { "Feature Type Name" : "Solver: point off a line, right to left" }
export const solverDistanceRightToLeft = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        pointOffLine(context, id, vector(10, 0), vector(0, 0));
    });

/**
 * A FIXed line from (0, 0) to (50, 0) mm, and a 5 mm circle drawn at (20, 1) mm, crossing the line,
 * with a RADIUS of 5 mm, TANGENT to the line, and its center COINCIDENT with a FIXed point at
 * (20, -5) mm. Only a circle below the line satisfies all of them.
 */
annotation { "Feature Type Name" : "Solver: tangent circle" }
export const solverTangentCircle = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const sketch = xySketch(context, id);
        skLineSegment(sketch, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(50, 0) * millimeter });
        skCircle(sketch, "circle", { "center" : vector(20, 1) * millimeter, "radius" : 5 * millimeter });
        skPoint(sketch, "anchor", { "position" : vector(20, -5) * millimeter });
        skConstraint(sketch, "fixLine", { "constraintType" : ConstraintType.FIX, "localFirst" : "line" });
        skConstraint(sketch, "fixAnchor", { "constraintType" : ConstraintType.FIX, "localFirst" : "anchor" });
        skConstraint(sketch, "radius", { "constraintType" : ConstraintType.RADIUS, "localFirst" : "circle", "length" : 5 * millimeter });
        skConstraint(sketch, "tangent", { "constraintType" : ConstraintType.TANGENT, "localFirst" : "circle", "localSecond" : "line" });
        skConstraint(sketch, "center", { "constraintType" : ConstraintType.COINCIDENT, "localFirst" : "circle.center", "localSecond" : "anchor" });
        skSolve(sketch);
    });

/**
 * A FIXed line from (0, 0) to (50, 0) mm, and a free line drawn from (0, 0) to (20, 0) mm with its
 * start COINCIDENT to the fixed line's start and an ANGLE of `angle` to it. Nothing holds the free
 * line's length, so the solve shows whether rotating it keeps the drawn 20 mm.
 */
function angledLine(context is Context, id is Id, angle is ValueWithUnits)
{
    const sketch = xySketch(context, id);
    skLineSegment(sketch, "fixed", { "start" : vector(0, 0) * millimeter, "end" : vector(50, 0) * millimeter });
    skLineSegment(sketch, "free", { "start" : vector(0, 0) * millimeter, "end" : vector(20, 0) * millimeter });
    skConstraint(sketch, "fix", { "constraintType" : ConstraintType.FIX, "localFirst" : "fixed" });
    skConstraint(sketch, "join", { "constraintType" : ConstraintType.COINCIDENT, "localFirst" : "free.start", "localSecond" : "fixed.start" });
    skConstraint(sketch, "angle", { "constraintType" : ConstraintType.ANGLE, "localFirst" : "fixed", "localSecond" : "free", "angle" : angle });
    skSolve(sketch);
}

/** {@link angledLine} at 70 degrees. */
annotation { "Feature Type Name" : "Solver: angled line, 70 degrees" }
export const solverAngle70 = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        angledLine(context, id, 70 * degree);
    });

/** {@link angledLine} at 88 degrees. */
annotation { "Feature Type Name" : "Solver: angled line, 88 degrees" }
export const solverAngle88 = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        angledLine(context, id, 88 * degree);
    });

/**
 * A FIXed line from (0, 0) to (50, 0) mm, and a free 20 mm line drawn from (0, 10) mm at 30 degrees
 * above horizontal, ending at (17.32, 20) mm, joined to nothing. `level` is the one constraint that
 * makes the free line horizontal; the solve shows whether it keeps 20 mm and which ends move.
 */
function levelledLine(context is Context, id is Id, level is map)
{
    const sketch = xySketch(context, id);
    skLineSegment(sketch, "fixed", { "start" : vector(0, 0) * millimeter, "end" : vector(50, 0) * millimeter });
    skLineSegment(sketch, "free", {
                "start" : vector(0, 10) * millimeter,
                "end" : (vector(0, 10) + vector(cos(30 * degree), sin(30 * degree)) * 20) * millimeter
            });
    skConstraint(sketch, "fix", { "constraintType" : ConstraintType.FIX, "localFirst" : "fixed" });
    skConstraint(sketch, "level", level);
    skSolve(sketch);
}

/** {@link levelledLine} with the free line HORIZONTAL. */
annotation { "Feature Type Name" : "Solver: levelled line, horizontal" }
export const solverLevelHorizontal = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        levelledLine(context, id, { "constraintType" : ConstraintType.HORIZONTAL, "localFirst" : "free" });
    });

/** {@link levelledLine} with the free line PARALLEL to the fixed one. */
annotation { "Feature Type Name" : "Solver: levelled line, parallel" }
export const solverLevelParallel = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        levelledLine(context, id, { "constraintType" : ConstraintType.PARALLEL, "localFirst" : "fixed", "localSecond" : "free" });
    });

/** {@link levelledLine} with an ANGLE of 0 degrees from the fixed line to the free one. */
annotation { "Feature Type Name" : "Solver: levelled line, zero angle" }
export const solverLevelZeroAngle = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        levelledLine(context, id, { "constraintType" : ConstraintType.ANGLE, "localFirst" : "fixed", "localSecond" : "free", "angle" : 0 * degree });
    });
