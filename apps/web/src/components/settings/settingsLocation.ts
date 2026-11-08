import { EnvironmentId } from "@cadsense/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Settings opens as an overlay on top of whatever page is showing. Its state lives in root
 * search params (`?settings=providers`), so the page behind it stays mounted, Back closes it,
 * and any navigation that does not carry these params closes it too.
 */

/** The settings tabs, in display order. */
export const SETTINGS_TAB_LABELS = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers",
  integrations: "Integrations",
  keybindings: "Keybindings",
  archived: "Archive",
} as const;

/**
 * A settings page. Diagnostics has no tab of its own; General links to it. Removed CAD projects
 * live at the bottom of Archive, reached with the `cad-storage` hash.
 */
export type SettingsTab = keyof typeof SETTINGS_TAB_LABELS | "diagnostics";

export interface SettingsSearchParams {
  readonly settings?: SettingsTab;
  /** Integrations only: the device whose Onshape connections to show. */
  readonly onshapeEnvironmentId?: EnvironmentId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

function isSettingsTab(value: unknown): value is SettingsTab {
  return (
    value === "diagnostics" ||
    (typeof value === "string" && Object.hasOwn(SETTINGS_TAB_LABELS, value))
  );
}

/**
 * Root route `validateSearch`. A bad link opens nothing rather than failing the whole app. A
 * malformed device id also opens nothing, because an explicitly targeted device must never fall
 * back to a different device's credentials.
 */
export function parseSettingsSearch(search: Record<string, unknown>): SettingsSearchParams {
  const { settings, onshapeEnvironmentId } = search;
  if (!isSettingsTab(settings)) return {};
  if (onshapeEnvironmentId === undefined) return { settings };
  return Option.match(decodeEnvironmentId(onshapeEnvironmentId), {
    onNone: () => ({}),
    onSome: (environmentId) => ({ settings, onshapeEnvironmentId: environmentId }),
  });
}

/**
 * Navigation options that open settings on `tab` over the current page. Spread them into
 * `navigate` or a `Link`. Navigating anywhere without these params closes settings.
 */
export function settingsLocation(tab: SettingsTab, onshapeEnvironmentId?: EnvironmentId) {
  return {
    to: ".",
    search:
      onshapeEnvironmentId === undefined
        ? { settings: tab }
        : { settings: tab, onshapeEnvironmentId },
  } as const;
}
