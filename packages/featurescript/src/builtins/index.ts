import type { Oc } from "../geometry/occt.ts";
import type { BuiltinImpl, BuiltinTable } from "../runtime/Interpreter.ts";
import { CONSTRUCTION_BUILTINS } from "./construction.ts";
import { contextBuiltins } from "./context.ts";
import { CORE_BUILTINS } from "./core.ts";
import { EVALUATOR_BUILTINS } from "./evaluators.ts";
import { GEOMETRY_BUILTINS } from "./geometry.ts";
import { OPERATION_BUILTINS } from "./operations.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Std builtins this runtime doesn't implement yet. Calling one stops the run with a fault that
 * FeatureScript's `try` can't catch. Geometry arrives with the OpenCascade kernel (milestone M4).
 */
export const UNSUPPORTED = [
  // Queries and topology
  "clusterBodies",
  "constructPaths",
  "getQueryVariable",
  "lastModifyingOperationId",
  "lastOperationId",
  "setQueryVariable",
  "skipOrderDisambiguation",
  "unpackQuery",
  // Geometry operations
  "opBodyDraft",
  "opBooleanedPattern",
  "opBoundarySurface",
  "opConstrainedSurface",
  "opCreateBSplineCurve",
  "opCreateBSplineSurface",
  "opCreateCompositePart",
  "opCreateCurvesOnFace",
  "opCreateIsocline",
  "opCreateOutline",
  "opDeleteFace",
  "opDerip",
  "opDraft",
  "opDropCurve",
  "opEdgeChange",
  "opEditCurve",
  "opEnclose",
  "opExtendSheetBody",
  "opExtractSurface",
  "opExtractWires",
  "opFaceBlend",
  "opFillSurface",
  "opFitSpline",
  "opFlipOrientation",
  "opFullRoundFillet",
  "opHelix",
  "opHole",
  "opImportForeign",
  "opIntersectFaces",
  "opMateConnector",
  "opMergeContexts",
  "opModifyCompositePart",
  "opModifyFillet",
  "opMoveCurveBoundary",
  "opMoveFace",
  "opNameEntity",
  "opOffsetCurveOnFace",
  "opOffsetFace",
  "opOffsetWire",
  "opPolyline",
  "opReplaceFace",
  "opRuledSurface",
  "opSMFlatOperation",
  "opSplineThroughEdges",
  "opSplitByIsocline",
  "opSplitBySelfShadow",
  "opSplitEdges",
  "opSplitFace",
  "opTessellatedLoft",
  "opWrap",
  // Geometry evaluation
  "evApproximateBSplineCurve",
  "evApproximateBSplineSurface",
  "evCollisionDetection",
  "evCornerType",
  "evEdgeConvexity",
  "evEdgeCurvatureDerivatives",
  "evEdgeCurvatures",
  "evFaceCurvatureDerivatives",
  "evFaceCurvatures",
  "evFacePeriodicity",
  "evFaceTangentPlanesAtEdge",
  "evFaults",
  "evFilletRadius",
  "evMateConnector",
  "evMateConnectorCoordSystem",
  "evMaxPathDeviation",
  "evMaxTolerance",
  "evMeshPoints",
  "evOffsetDetection",
  "evOwnerSketchPlane",
  "evPlanarEdge",
  "evPlanarEdges",
  "evPointsDeviation",
  "evRaycast",
  "evRuledSurfaceBases",
  "evSheetMetalBendUp",
  "evSheetMetalFlatTransformation",
  "evSheetMetalFormToolBodies",
  "evSheetMetalHoleToolBodies",
  "evTessellatedLoftMatches",
  "evTolerances",
  "evaluateSpline",
  // Sketches
  "skBezier",
  "skConicSegment",
  "skEllipse",
  "skEllipticalArc",
  "skFitSpline",
  "skImage",
  "skInterpolatedSpline",
  "skInterpolatedSplineSegment",
  "skSetInitialGuess",
  "skSpline",
  "skSplineSegment",
  "skText",
  // Attributes and properties
  "getHoleAttributes",
  "getProperty",
  "setProperty",
  // Patterns and sheet metal
  "computeCircularPatternTransforms",
  "computeCurvePatternTransforms",
  "computeLinearPatternTransforms",
  "sheetMetalApplyInFlat",
  "updateSheetMetalGeometry",
  // Other
  "alignCanonically",
  "approximateSpline",
  "clampContextVersion",
  "containsSketch",
  "convert",
  "getFeatureName",
  "getLanguageVersion",
  "getParameterToleranceInfo",
  "matrixSvd",
  "validateToleranceSchema",
  "valuesSortedById",
] as const satisfies readonly StdBuiltinName[];

/**
 * Every builtin std calls, each either implemented or explicitly unsupported. Re-vendoring std with a
 * new builtin fails the type check here until someone decides which it is.
 */
export const createBuiltins = (oc: Oc | null): BuiltinTable =>
  ({
    ...(Object.fromEntries(UNSUPPORTED.map((name) => [name, "unsupported"])) as Record<
      (typeof UNSUPPORTED)[number],
      "unsupported"
    >),
    ...CORE_BUILTINS,
    ...contextBuiltins(oc),
    ...GEOMETRY_BUILTINS,
    ...EVALUATOR_BUILTINS,
    ...OPERATION_BUILTINS,
    ...CONSTRUCTION_BUILTINS,
  }) satisfies Record<StdBuiltinName, BuiltinImpl | "unsupported">;

/** Names with an implementation, for the test that nothing is both implemented and unsupported. */
export const IMPLEMENTED: readonly string[] = [
  ...Object.keys(CORE_BUILTINS),
  ...Object.keys(contextBuiltins(null)),
  ...Object.keys(GEOMETRY_BUILTINS),
  ...Object.keys(EVALUATOR_BUILTINS),
  ...Object.keys(OPERATION_BUILTINS),
  ...Object.keys(CONSTRUCTION_BUILTINS),
];
