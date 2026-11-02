FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

/**
 * Two 20 mm device blocks with a mate connector on each port, for a Wire run to snap to. The motor's
 * port is on its +x face at (20, 10, 10) mm with Z along +x; the controller's is on its -x face at
 * (100, 40, 30) mm with Z along -x, both pointing out of their blocks.
 */
annotation { "Feature Type Name" : "Wire ports" }
export const wirePorts = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        fCuboid(context, id + "motor", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(20, 20, 20) * millimeter });
        fCuboid(context, id + "controller", { "corner1" : vector(100, 30, 20) * millimeter, "corner2" : vector(120, 50, 40) * millimeter });
        opMateConnector(context, id + "motorPort", {
                    "coordSystem" : coordSystem(vector(20, 10, 10) * millimeter, vector(0, 1, 0), vector(1, 0, 0)),
                    "owner" : qCreatedBy(id + "motor", EntityType.BODY)
                });
        opMateConnector(context, id + "controllerPort", {
                    "coordSystem" : coordSystem(vector(100, 40, 30) * millimeter, vector(0, 1, 0), vector(-1, 0, 0)),
                    "owner" : qCreatedBy(id + "controller", EntityType.BODY)
                });
    });
