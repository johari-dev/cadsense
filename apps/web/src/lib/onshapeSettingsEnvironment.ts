import { EnvironmentId } from "@cadsense/contracts";
import * as Schema from "effect/Schema";

const decodeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);

export function parseOnshapeSettingsSearch(search: Record<string, unknown>): {
  environmentId?: EnvironmentId;
} {
  return search.environmentId === undefined
    ? {}
    : { environmentId: decodeEnvironmentId(search.environmentId) };
}

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
