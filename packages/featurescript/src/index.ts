// Local FeatureScript compiler and runtime. See ../FeatureScript.md.
export type * from "./syntax/Ast.ts";
export {
  formatDiagnostic,
  locate,
  type Diagnostic,
  type DiagnosticCode,
  type LocatedDiagnostic,
} from "./syntax/Diagnostic.ts";
export { tokenize, type Token } from "./syntax/Lexer.ts";
export { parseModule } from "./syntax/Parser.ts";
export {
  positionAt,
  sourceFile,
  type Position,
  type SourceFile,
  type Span,
} from "./syntax/Source.ts";
export {
  BASE_FEATURE_ID,
  FeatureScriptRuntime,
  STD_DIR,
  type FeatureRun,
  type RuntimeOptions,
} from "./Runtime.ts";
export {
  describePreview,
  featureFailure,
  runPreview,
  userLocation,
  VIEWS,
  writePreview,
  type PreviewChanges,
  type PreviewResult,
  type PreviewStep,
  type SolidSummary,
  type SourceLocation,
} from "./preview/Preview.ts";
export { dialogInputs, type DialogInput } from "./preview/Inputs.ts";
export { toGlb } from "./geometry/Glb.ts";
export type { View } from "./preview/Render.ts";
export { FsFault, FsThrow, type FsFrame } from "./runtime/Errors.ts";
export { ModuleLoadError, type ModuleInstance } from "./runtime/Modules.ts";
export { equals, formatValue, FsMap, FsTagged, type FsValue } from "./runtime/Value.ts";
export {
  defaultDefinition,
  featureSpecs,
  type FeatureInput,
  type FeatureSpec,
  type InputKind,
} from "./spec/FeatureSpec.ts";
