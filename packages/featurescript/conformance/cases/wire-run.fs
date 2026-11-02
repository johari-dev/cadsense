FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

export enum WireSizeType
{
    annotation { "Name" : "AWG" }
    AWG,
    annotation { "Name" : "Diameter" }
    DIAMETER
}

/**
 * One feature for a whole wire run: it fits a path through waypoints and sweeps a bundle of wires along it.
 *
 * Waypoints snap to a vertex or mate connector, plus an XYZ offset that a triad manipulator drags. A waypoint
 * with no point picked is free: its offset is measured from the origin. When the first or last waypoint is a
 * mate connector, the wire leaves or enters along its Z axis, so put connectors on device ports with Z pointing
 * out of the port. A direction pick overrides that. Wires are named from the label, e.g. "Motor to Spark MAX wire 1".
 */
annotation { "Feature Type Name" : "Wire run",
        "Feature Name Template" : "#title (#length)",
        "Manipulator Change Function" : "wireRunManipulatorChange",
        "Feature Type Description" : "Routes a bundle of wires through waypoints, e.g. motor to motor controller or breaker to PDH." }
export const wireRun = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Label", "Default" : "", "Description" : "Names the run and its wires, e.g. Motor to Spark MAX." }
        definition.label is string;

        annotation { "Name" : "Waypoints", "Item name" : "Waypoint", "Item label template" : "#point" }
        definition.waypoints is array;
        for (var waypoint in definition.waypoints)
        {
            annotation { "Name" : "Point", "Filter" : QueryFilterCompound.ALLOWS_VERTEX, "MaxNumberOfPicks" : 1 }
            waypoint.point is Query;

            annotation { "Name" : "X offset" }
            isLength(waypoint.x, ZERO_DEFAULT_LENGTH_BOUNDS);

            annotation { "Name" : "Y offset" }
            isLength(waypoint.y, ZERO_DEFAULT_LENGTH_BOUNDS);

            annotation { "Name" : "Z offset" }
            isLength(waypoint.z, ZERO_DEFAULT_LENGTH_BOUNDS);
        }

        annotation { "Name" : "Start direction", "Filter" : QueryFilterCompound.ALLOWS_DIRECTION, "MaxNumberOfPicks" : 1,
                    "Description" : "Defaults to the Z axis of a mate connector at the first waypoint." }
        definition.startDirection is Query;

        annotation { "Name" : "Flip start", "UIHint" : UIHint.OPPOSITE_DIRECTION }
        definition.flipStart is boolean;

        annotation { "Name" : "End direction", "Filter" : QueryFilterCompound.ALLOWS_DIRECTION, "MaxNumberOfPicks" : 1,
                    "Description" : "Direction the wire points out of the end port. Defaults to the Z axis of a mate connector at the last waypoint." }
        definition.endDirection is Query;

        annotation { "Name" : "Flip end", "UIHint" : UIHint.OPPOSITE_DIRECTION }
        definition.flipEnd is boolean;

        annotation { "Name" : "Straight lead", "Description" : "How far the wire runs straight out of each port before it bends." }
        isLength(definition.lead, { (millimeter) : [0, 15, 1000] } as LengthBoundSpec);

        annotation { "Name" : "Wire count" }
        isInteger(definition.wireCount, { (unitless) : [1, 2, 12] } as IntegerBoundSpec);

        annotation { "Name" : "Size by", "UIHint" : UIHint.HORIZONTAL_ENUM }
        definition.sizeType is WireSizeType;

        if (definition.sizeType == WireSizeType.AWG)
        {
            annotation { "Name" : "Gauge (AWG)" }
            isInteger(definition.gauge, { (unitless) : [0, 12, 36] } as IntegerBoundSpec);

            annotation { "Name" : "Insulation thickness" }
            isLength(definition.insulation, { (millimeter) : [0, 0.6, 10] } as LengthBoundSpec);
        }
        else
        {
            annotation { "Name" : "Wire diameter" }
            isLength(definition.diameter, { (millimeter) : [0.1, 3.3, 100] } as LengthBoundSpec);
        }

        annotation { "Name" : "Clocking angle", "Description" : "Rotates the bundle about the wire path." }
        isAngle(definition.clocking, ANGLE_360_ZERO_DEFAULT_BOUNDS);
    }
    {
        const title = definition.label == "" ? "Wire run" : definition.label;
        setFeatureComputedParameter(context, id, { "name" : "title", "value" : title });

        throwIfMissingPoints(context, definition.waypoints);
        const waypoints = mapArray(definition.waypoints, function(waypoint) { return resolveWaypoint(context, waypoint); });

        // Show a triad on every waypoint so the path can be dragged into place.
        for (var i = 0; i < size(waypoints); i += 1)
        {
            addManipulators(context, id, { ("waypoint" ~ i) : triadManipulator({
                                "base" : waypoints[i].base,
                                "offset" : waypoints[i].point - waypoints[i].base
                            }) });
        }

        // A run still being built (new feature, or one point clicked so far) is unfinished, not an error.
        if (size(waypoints) < 2)
        {
            reportFeatureInfo(context, id, "Add at least two waypoints to build the wire.");
            return;
        }

        const last = size(waypoints) - 1;
        const startDirection = endDirection(context, definition.startDirection, definition.flipStart, waypoints[0]);
        // The end port direction points out of the port, so the wire arrives travelling the other way.
        const endPortDirection = endDirection(context, definition.endDirection, definition.flipEnd, waypoints[last]);
        const arrival = endPortDirection == undefined ? undefined : -endPortDirection;

        const path = fitPath(context, id + "path", mapArray(waypoints, function(w) { return w.point; }),
            startDirection, arrival, definition.lead);

        const radius = (definition.sizeType == WireSizeType.AWG
                ? awgDiameter(definition.gauge) + 2 * definition.insulation
                : definition.diameter) / 2;
        const start = evEdgeTangentLine(context, { "edge" : path, "parameter" : 0 });
        sketchBundle(context, id + "profile", start, definition.wireCount, radius, definition.clocking);

        try
        {
            opSweep(context, id + "sweep", {
                        "profiles" : qCreatedBy(id + "profile", EntityType.FACE),
                        "path" : path
                    });
        }
        catch (error)
        {
            setErrorEntities(context, id, { "entities" : path });
            throw regenError("Wire sweep failed. Spread out tight waypoints or shorten the straight lead.");
        }

        // "Motor to Spark MAX wire 1", or "Wire run 1" with no label. A single wire drops the number.
        const wires = evaluateQuery(context, qCreatedBy(id + "sweep", EntityType.BODY));
        const prefix = definition.label == "" ? title : definition.label ~ " wire";
        for (var i = 0; i < size(wires); i += 1)
        {
            setProperty(context, { "entities" : wires[i], "propertyType" : PropertyType.NAME,
                        "value" : size(wires) == 1 ? prefix : prefix ~ " " ~ (i + 1) });
        }

        setFeatureComputedParameter(context, id, { "name" : "length", "value" : evLength(context, { "entities" : path }) });
        opDeleteBodies(context, id + "cleanup", {
                    "entities" : qUnion([qCreatedBy(id + "path", EntityType.BODY), qCreatedBy(id + "profile", EntityType.BODY)])
                });
    });

/** Writes dragged triad offsets back into the matching waypoint's X/Y/Z offset. */
export function wireRunManipulatorChange(context is Context, definition is map, newManipulators is map) returns map
{
    for (var i = 0; i < size(definition.waypoints); i += 1)
    {
        const manipulator = newManipulators["waypoint" ~ i];
        if (manipulator == undefined)
            continue;
        definition.waypoints[i].x = manipulator.offset[0];
        definition.waypoints[i].y = manipulator.offset[1];
        definition.waypoints[i].z = manipulator.offset[2];
    }
    return definition;
}

/**
 * Throws naming every waypoint whose point was picked but no longer resolves (a deleted or missing port),
 * instead of letting it fall back to the origin. Empty picks are free waypoints and pass.
 */
function throwIfMissingPoints(context is Context, waypoints is array)
{
    var missing = [];
    for (var i = 0; i < size(waypoints); i += 1)
    {
        if (hasPick(waypoints[i].point) && isQueryEmpty(context, waypoints[i].point))
            missing = append(missing, toString(i + 1));
    }
    if (size(missing) == 1)
        throw regenError("Waypoint " ~ missing[0] ~ " has a point picked that no longer exists. Re-pick it or clear it.", ["waypoints"]);
    if (size(missing) > 1)
        throw regenError("Waypoints " ~ join(missing, ", ") ~ " have points picked that no longer exist. Re-pick them or clear them.", ["waypoints"]);
}

/** True when a query parameter holds a pick. An empty selection box is qNothing() or an empty union. */
function hasPick(query is Query) returns boolean
{
    return query.queryType != QueryType.NOTHING && !(query.queryType == QueryType.UNION && size(query.subqueries) == 0);
}

/**
 * Returns { base, point, portDirection } for a waypoint. base is the snapped reference (origin when free),
 * point adds the offset, and portDirection is the mate connector Z axis when there is one.
 */
function resolveWaypoint(context is Context, waypoint is map) returns map
{
    var base = vector(0, 0, 0) * meter;
    var portDirection = undefined;
    if (!isQueryEmpty(context, qBodyType(waypoint.point, BodyType.MATE_CONNECTOR)))
    {
        const port = evMateConnector(context, { "mateConnector" : waypoint.point });
        base = port.origin;
        portDirection = port.zAxis;
    }
    else if (!isQueryEmpty(context, waypoint.point))
    {
        base = evVertexPoint(context, { "vertex" : waypoint.point });
    }
    return { "base" : base, "point" : base + vector(waypoint.x, waypoint.y, waypoint.z), "portDirection" : portDirection };
}

/** Direction pointing out of the port at one end of the run, or undefined when the end is free. */
function endDirection(context is Context, pick is Query, flip is boolean, waypoint is map)
{
    var direction = isQueryEmpty(context, pick) ? waypoint.portDirection : extractDirection(context, pick);
    if (direction == undefined)
        return undefined;
    return flip ? -direction : direction;
}

/**
 * Fits a spline through points. Ends with a direction get an extra point one lead length out, so the wire
 * runs straight out of the port before bending. Returns the path edge.
 */
function fitPath(context is Context, id is Id, points is array, startDirection, arrival, lead is ValueWithUnits) returns Query
{
    var fitPoints = points;
    if (startDirection != undefined && lead > TOLERANCE.zeroLength * meter)
        fitPoints = concatenateArrays([[points[0], points[0] + startDirection * lead], subArray(points, 1)]);
    if (arrival != undefined && lead > TOLERANCE.zeroLength * meter)
    {
        const n = size(fitPoints);
        fitPoints = concatenateArrays([subArray(fitPoints, 0, n - 1), [fitPoints[n - 1] - arrival * lead, fitPoints[n - 1]]]);
    }

    var chordLength = 0 * meter;
    for (var i = 1; i < size(fitPoints); i += 1)
    {
        if (tolerantEquals(fitPoints[i - 1], fitPoints[i]))
            throw regenError("Two waypoints sit on the same spot, or a waypoint is inside a straight lead", ["waypoints"]);
        chordLength += norm(fitPoints[i] - fitPoints[i - 1]);
    }

    // The fit spline runs over [0, 1], so end derivatives scaled by the chord length match its natural speed.
    var spline = { "points" : fitPoints };
    if (startDirection != undefined)
        spline.startDerivative = startDirection * chordLength;
    if (arrival != undefined)
        spline.endDerivative = arrival * chordLength;
    opFitSpline(context, id, spline);
    return qCreatedBy(id, EntityType.EDGE);
}

/** Sketches count circles of the given radius in a touching ring, centred on the path start and normal to it. */
function sketchBundle(context is Context, id is Id, start is Line, count is number, radius is ValueWithUnits, clocking is ValueWithUnits)
{
    const xDirection = rotationMatrix3d(start.direction, clocking) * perpendicularVector(start.direction);
    const sketch = newSketchOnPlane(context, id, { "sketchPlane" : plane(start.origin, start.direction, xDirection) });

    // Ring radius that makes neighbours touch, plus a hair of clearance so each wire stays its own body.
    const ringRadius = count == 1 ? 0 * meter : (radius + 0.01 * millimeter) / sin(PI / count * radian);
    for (var i = 0; i < count; i += 1)
    {
        const angle = (2 * PI * i / count) * radian;
        skCircle(sketch, "wire" ~ i, { "center" : vector(cos(angle), sin(angle)) * ringRadius, "radius" : radius });
    }
    skSolve(sketch);
}

/** Bare copper diameter for an AWG size. */
function awgDiameter(gauge is number) returns ValueWithUnits
{
    return 0.005 * inch * 92 ^ ((36 - gauge) / 39);
}
