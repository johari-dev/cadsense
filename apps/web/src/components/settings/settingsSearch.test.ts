import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    tab: "general",
  },
  {
    id: "network-access",
    title: "Network access",
    tab: "integrations",
  },
  {
    id: "providers",
    title: "Providers",
    tab: "providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    tab: "general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    tab: "general",
  },
];

describe("searchSettings", () => {
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass")).toEqual([]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("does not offer settings that have no row", () => {
    for (const query of [
      "confirmation",
      "streaming",
      "project folder",
      "hold to quit",
      "cad storage",
      "browser",
    ]) {
      expect(searchSettings(query)).toEqual([]);
    }
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("show-permission-settings")).toEqual({
      id: "show-permission-settings",
      title: "Permission settings",
    });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("context window")[0]).toMatchObject({
      id: "show-context-window-indicator",
      tab: "appearance",
    });
  });
  it("routes the title model and removed CAD projects to their new tabs", () => {
    expect(searchSettings("title model")[0]).toMatchObject({ tab: "providers" });
    expect(searchSettings("removed cad")[0]).toMatchObject({ tab: "archived" });
  });
  it("does not offer removed appearance settings", () => {
    expect(searchSettings("word wrap")).toEqual([]);
    expect(searchSettings("code font")).toEqual([]);
  });
});
