/** A FeatureScript source file. Nodes and tokens store offsets; line/column are computed on demand. */
export interface SourceFile {
  /** Module path as imported, e.g. `onshape/std/geometry.fs`, or a workspace-relative path. */
  readonly path: string;
  readonly text: string;
  /** Offset of the first character of each line. */
  readonly lineStarts: readonly number[];
}

/** 1-based line and column. Columns count UTF-16 code units, matching editors. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Half-open offset range `[start, end)` into the source text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export const sourceFile = (path: string, text: string): SourceFile => {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    // \r\n counts as one line break; a lone \r is a break too.
    if (char === 10 || (char === 13 && text.charCodeAt(i + 1) !== 10)) lineStarts.push(i + 1);
  }
  return { path, text, lineStarts };
};

export const positionAt = (file: SourceFile, offset: number): Position => {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (file.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - file.lineStarts[low]! + 1 };
};
