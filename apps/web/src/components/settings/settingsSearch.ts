import { isElectron } from "~/env";

import type { SettingsTab } from "./settingsLocation";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly tab: SettingsTab;
  readonly targetId?: string;
  readonly desktopOnly?: boolean;
}

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "cad-storage",
    title: "CAD storage, removed Onshape and local CAD projects, restore and cleanup",
    tab: "cad-storage",
  },
  { id: "interface-font", title: "Interface font", tab: "appearance" },
  { id: "prompt-font", title: "Prompt font", tab: "appearance" },
  { id: "font-smoothing", title: "Font smoothing", tab: "appearance" },
  { id: "show-permission-settings", title: "Show permission settings", tab: "appearance" },
  {
    id: "show-context-window-indicator",
    title: "Show context window indicator",
    tab: "appearance",
  },
  {
    id: "show-onshape-sync-api-calls",
    title: "Show Onshape API calls per sync",
    tab: "appearance",
  },
  {
    id: "add-project-starts-in",
    title: "Default project folder",
    tab: "general",
  },
  { id: "archive-confirmation", title: "Archive confirmation", tab: "general" },
  { id: "delete-confirmation", title: "Delete confirmation", tab: "general" },
  {
    id: "quit-confirmation",
    title: "Hold to quit",
    tab: "general",
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Thread title model",
    tab: "general",
  },
  { id: "usage-analytics", title: "Usage analytics", tab: "general" },
  { id: "diagnostics", title: "Diagnostics", tab: "general" },
  {
    id: "streaming-text",
    title: "Streaming text",
    tab: "general",
  },
  { id: "keybindings", title: "Keybindings", tab: "keybindings" },
  { id: "providers", title: "Providers", tab: "providers" },
  {
    id: "onshape-connections",
    title: "Onshape connections",
    tab: "integrations",
    targetId: "onshape-connections",
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    tab: "integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    tab: "integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    tab: "integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    tab: "integrations",
    targetId: "browser",
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    tab: "integrations",
    targetId: "browser",
  },
  { id: "archive", title: "Archived threads", tab: "archived" },
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

  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      normalizeSearchText(item.title).includes(normalizedQuery),
  );
}
