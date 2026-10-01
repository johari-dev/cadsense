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
