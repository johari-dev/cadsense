import type { EnvironmentId } from "@cadsense/contracts";

/** An explicitly selected device must never fall back to a different device's credentials. */
export function resolveOnshapeSettingsEnvironment(
  available: readonly EnvironmentId[],
  selected: EnvironmentId | null,
  primary: EnvironmentId | null,
): EnvironmentId | null {
  if (selected !== null) return available.includes(selected) ? selected : null;
  if (primary !== null && available.includes(primary)) return primary;
  return available[0] ?? null;
}
