import { isElectron } from "~/env";

export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly desktopOnly?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Fonts",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/integrations": "Integrations",
  "/settings/archived": "Archive",
};

export const SETTINGS_SEARCH_ITEMS = [
  { id: "interface-font", title: "Interface font", to: "/settings/appearance" },
  { id: "prompt-font", title: "Prompt font", to: "/settings/appearance" },
  { id: "code-font", title: "Code font", to: "/settings/appearance" },
  { id: "font-smoothing", title: "Font smoothing", to: "/settings/appearance" },
  { id: "word-wrap", title: "Word wrap", to: "/settings/appearance" },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  { id: "archive-confirmation", title: "Archive confirmation", to: "/settings/general" },
  { id: "delete-confirmation", title: "Delete confirmation", to: "/settings/general" },
  {
    id: "quit-confirmation",
    title: "Hold to quit",
    to: "/settings/general",
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/general",
  },
  { id: "diagnostics", title: "Diagnostics", to: "/settings/general" },
  {
    id: "streaming-text",
    title: "Streaming text",
    to: "/settings/general",
  },
  { id: "keybindings", title: "Keybindings", to: "/settings/keybindings" },
  { id: "providers", title: "Providers", to: "/settings/providers" },
  {
    id: "onshape-connections",
    title: "Onshape connections",
    to: "/settings/integrations",
    targetId: "onshape-connections",
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    to: "/settings/integrations",
    targetId: "browser",
  },
  { id: "archive", title: "Archived threads", to: "/settings/archived" },
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
