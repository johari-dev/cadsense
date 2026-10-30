FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

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
