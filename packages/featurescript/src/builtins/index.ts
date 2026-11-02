import type { Oc } from "../geometry/occt.ts";
import type { BuiltinImpl, BuiltinTable } from "../runtime/Interpreter.ts";
import { ModelContext } from "../runtime/ModelContext.ts";
import { FsBuiltin, untag } from "../runtime/Value.ts";
import { CONSTRUCTION_BUILTINS } from "./construction.ts";
import { contextBuiltins } from "./context.ts";
import { BSPLINE_BUILTINS } from "./bspline.ts";
import { CORE_BUILTINS } from "./core.ts";
import { CURVATURE_BUILTINS } from "./curvature.ts";
import { CURVE_BUILTINS } from "./curves.ts";
import { DISPLAY_BUILTINS } from "./display.ts";
import { EVALUATOR_BUILTINS } from "./evaluators.ts";
import { FACE_BUILTINS } from "./faces.ts";
import { GEOMETRY_BUILTINS } from "./geometry.ts";
import { MATE_CONNECTOR_BUILTINS } from "./mateConnectors.ts";
import { OPERATION_BUILTINS } from "./operations.ts";
import { PATH_BUILTINS } from "./paths.ts";
import { PATTERN_BUILTINS } from "./patterns.ts";
import { PLANE_BUILTINS } from "./planes.ts";
import { PROBE_BUILTINS } from "./probes.ts";
import { TOPOLOGY_BUILTINS } from "./topology.ts";
import { HOLE_BUILTINS } from "./hole.ts";
import { SURFACE_BUILTINS } from "./surfaces.ts";
import { SKETCH_BUILTINS } from "./sketch.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Std builtins this runtime doesn't implement yet. Calling one stops the run with a fault that
 * FeatureScript's `try` can't catch. Geometry arrives with the OpenCascade kernel (milestone M4).
 */
export const UNSUPPORTED = [
  "clusterBodies",
  "evFaceCurvatureDerivatives",
  "evFaults",
  "evMaxTolerance",
  "evOffsetDetection",
  "evRuledSurfaceBases",
  "evSheetMetalBendUp",
  "evSheetMetalFlatTransformation",
  "evSheetMetalFormToolBodies",
  "evSheetMetalHoleToolBodies",
  "evTessellatedLoftMatches",
  "evTolerances",
  "opBodyDraft",
  "opBooleanedPattern",
  "opBoundarySurface",
  "opConstrainedSurface",
  "opCreateCompositePart",
  "opCreateCurvesOnFace",
  "opCreateIsocline",
  "opDerip",
  "opFaceBlend",
  "opImportForeign",
  "opMergeContexts",
  "opModifyCompositePart",
  "opMoveCurveBoundary",
  "opNameEntity",
  "opOffsetCurveOnFace",
  "opOffsetWire",
  "opSMFlatOperation",
  "opSplitByIsocline",
  "opSplitBySelfShadow",
  "opTessellatedLoft",
  "opWrap",
  "sheetMetalApplyInFlat",
  "skImage",
  "skInterpolatedSpline",
  "skInterpolatedSplineSegment",
  "skSpline",
  "skSplineSegment",
  "skText",
  "unpackQuery",
  "updateSheetMetalGeometry",
  "validateToleranceSchema",
] as const satisfies readonly StdBuiltinName[];

/**
 * An operation (`op*` builtin, called with a context and an id) made atomic and recorded: if it
 * fails partway (one body done, the next one failing), the context goes back to how it was before
 * it; if it succeeds, it records itself for `lastOperationId`, `lastModifyingOperationId` and
 * fillet queries.
 */
const recorded =
  (name: string, operation: BuiltinImpl): BuiltinImpl =>
  (args, call) => {
    const target = untag(args[0]);
    const model =
      target instanceof FsBuiltin && target.native instanceof ModelContext ? target.native : null;
    if (!model) return operation(args, call);
    const before = model.geometry;
    const saved = model.snapshot();
    let result;
    try {
      result = operation(args, call);
    } catch (error) {
      model.restore(saved);
      throw error;
    }
    model.recordOperation(args[1], before, name, args[2]);
    return result;
  };
const withRecordedOperations = (table: Record<string, BuiltinImpl | "unsupported">): BuiltinTable =>
  Object.fromEntries(
    Object.entries(table).map(([name, impl]) => [
      name,
      name.startsWith("op") && impl !== "unsupported" ? recorded(name, impl) : impl,
    ]),
  );

/**
 * Every builtin std calls, each either implemented or explicitly unsupported. Re-vendoring std with a
 * new builtin fails the type check here until someone decides which it is.
 */
export const createBuiltins = (oc: Oc | null): BuiltinTable =>
  withRecordedOperations({
    ...(Object.fromEntries(UNSUPPORTED.map((name) => [name, "unsupported"])) as Record<
      (typeof UNSUPPORTED)[number],
      "unsupported"
    >),
    ...CORE_BUILTINS,
    ...contextBuiltins(oc),
    // After the context's no-op UI builtins, which these replace.
    ...DISPLAY_BUILTINS,
    ...GEOMETRY_BUILTINS,
    ...EVALUATOR_BUILTINS,
    ...OPERATION_BUILTINS,
    ...FACE_BUILTINS,
    ...CONSTRUCTION_BUILTINS,
    ...PLANE_BUILTINS,
    ...TOPOLOGY_BUILTINS,
    ...PATH_BUILTINS,
    ...MATE_CONNECTOR_BUILTINS,
    ...PATTERN_BUILTINS,
    ...CURVATURE_BUILTINS,
    ...PROBE_BUILTINS,
    ...HOLE_BUILTINS,
    ...CURVE_BUILTINS,
    ...BSPLINE_BUILTINS,
    ...SURFACE_BUILTINS,
    ...SKETCH_BUILTINS,
  } satisfies Record<StdBuiltinName, BuiltinImpl | "unsupported">);

/** Names with an implementation, for the test that nothing is both implemented and unsupported. */
export const IMPLEMENTED: readonly string[] = [
  ...Object.keys(CORE_BUILTINS),
  ...Object.keys(contextBuiltins(null)),
  ...Object.keys(DISPLAY_BUILTINS),
  ...Object.keys(GEOMETRY_BUILTINS),
  ...Object.keys(EVALUATOR_BUILTINS),
  ...Object.keys(OPERATION_BUILTINS),
  ...Object.keys(FACE_BUILTINS),
  ...Object.keys(CONSTRUCTION_BUILTINS),
  ...Object.keys(PLANE_BUILTINS),
  ...Object.keys(TOPOLOGY_BUILTINS),
  ...Object.keys(PATH_BUILTINS),
  ...Object.keys(MATE_CONNECTOR_BUILTINS),
  ...Object.keys(PATTERN_BUILTINS),
  ...Object.keys(CURVATURE_BUILTINS),
  ...Object.keys(PROBE_BUILTINS),
  ...Object.keys(HOLE_BUILTINS),
  ...Object.keys(CURVE_BUILTINS),
  ...Object.keys(BSPLINE_BUILTINS),
  ...Object.keys(SURFACE_BUILTINS),
  ...Object.keys(SKETCH_BUILTINS),
];
