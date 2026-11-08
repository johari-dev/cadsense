import type { SettingsTab } from "./settingsLocation";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly tab: SettingsTab;
  readonly targetId?: string;
}

// Catalog order is result order, so items follow tab order and then page order.
export const SETTINGS_SEARCH_ITEMS = [
  { id: "diagnostics", title: "Diagnostics", tab: "general" },
  { id: "usage-analytics", title: "Usage analytics", tab: "general" },
  { id: "restore-defaults", title: "Restore defaults", tab: "general" },
  { id: "interface-font", title: "Interface font", tab: "appearance" },
  { id: "font-smoothing", title: "Font smoothing", tab: "appearance" },
  { id: "show-permission-settings", title: "Permission settings", tab: "appearance" },
  { id: "show-context-window-indicator", title: "Context window indicator", tab: "appearance" },
  { id: "show-onshape-sync-api-calls", title: "Onshape API calls per sync", tab: "appearance" },
  { id: "providers", title: "Providers", tab: "providers" },
  { id: "text-generation-model", title: "Thread title model", tab: "providers" },
  {
    id: "onshape-connections",
    title: "Onshape connections",
    tab: "integrations",
    targetId: "onshape-connections",
  },
  { id: "keybindings", title: "Keybindings", tab: "keybindings" },
  { id: "archive", title: "Archived threads", tab: "archived" },
  { id: "cad-storage", title: "Removed CAD projects", tab: "archived" },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter((item) => normalizeSearchText(item.title).includes(normalizedQuery));
}
