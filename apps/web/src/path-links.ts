function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  return separator === "\\"
    ? `${cleanBase}\\${next.replaceAll("/", "\\")}`
    : `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/)?.[1];
  if (posixUser) return `/Users/${posixUser}`;
  const posixHome = cwd.match(/^\/home\/([^/]+)/)?.[1];
  if (posixHome) return `/home/${posixHome}`;
  return cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/)?.[1];
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;
  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) return { path, line, column };
  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);
  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }
  return { path, line, column };
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);
  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) resolvedPath = joinPath(home, path.slice(2), isWindowsPathStyle(home) ? "\\" : "/");
  } else if (!isAbsolutePath(path)) {
    resolvedPath = joinPath(cwd, path, isWindowsPathStyle(cwd) ? "\\" : "/");
  }
  return line ? `${resolvedPath}:${line}${column ? `:${column}` : ""}` : resolvedPath;
}
