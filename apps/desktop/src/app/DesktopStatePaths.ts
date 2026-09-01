import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(cadsenseHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(cadsenseHome)) {
    return Option.none();
  }
  const trimmed = cadsenseHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly cadsenseHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.cadsenseHome), () =>
    input.joinPath(input.homeDirectory, ".cadsense"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly cadsenseHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.cadsenseHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
