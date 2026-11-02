FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

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
