import { positionAt, type Position, type SourceFile, type Span } from "./Source.ts";

export type DiagnosticCode =
  | "invalid-character"
  | "invalid-number"
  | "unterminated-string"
  | "invalid-escape"
  | "unterminated-comment"
  | "expected"
  | "unexpected-token"
  | "invalid-assignment-target"
  | "missing-version"
  | "unresolved-import";

/** A compile-time problem in one source file. */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly span: Span;
}

/** A diagnostic resolved to positions, for display and tests. */
export interface LocatedDiagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly file: string;
  readonly start: Position;
  readonly end: Position;
}

export const locate = (file: SourceFile, diagnostic: Diagnostic): LocatedDiagnostic => ({
  code: diagnostic.code,
  message: diagnostic.message,
  file: file.path,
  start: positionAt(file, diagnostic.span.start),
  end: positionAt(file, diagnostic.span.end),
});

/** `path:line:column code message`, the format the tests and the agent read. */
export const formatDiagnostic = (located: LocatedDiagnostic) =>
  `${located.file}:${located.start.line}:${located.start.column} ${located.code} ${located.message}`;
