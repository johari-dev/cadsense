FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

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
