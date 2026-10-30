FeatureScript 2716;
import(path : "onshape/std/geometry.fs", version : "2716.0");

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
