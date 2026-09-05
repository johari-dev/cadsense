import { describe, expect, it } from "vite-plus/test";
import {
  filterCommandPaletteGroups,
  commandPaletteThreadRouteKey,
  reduceCommandPaletteUiState,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("command palette thread route identity", () => {
  it("keeps the query-reset dependency stable when a draft route is reselected", () => {
    const first = commandPaletteThreadRouteKey({ draftId: "draft-1" });
    expect(commandPaletteThreadRouteKey({ draftId: "draft-1" })).toBe(first);
    expect(commandPaletteThreadRouteKey({ draftId: "draft-2" })).not.toBe(first);
  });

  it("distinguishes threads across environments and draft promotion", () => {
    const server = commandPaletteThreadRouteKey({ environmentId: "local", threadId: "one" });
    expect(commandPaletteThreadRouteKey({ environmentId: "local", threadId: "one" })).toBe(server);
    expect(commandPaletteThreadRouteKey({ environmentId: "remote", threadId: "one" })).not.toBe(
      server,
    );
    expect(commandPaletteThreadRouteKey({ environmentId: "local", threadId: "two" })).not.toBe(
      server,
    );
    expect(commandPaletteThreadRouteKey({ draftId: "one" })).not.toBe(server);
    expect(commandPaletteThreadRouteKey({})).toBeNull();
  });
});

describe("reduceCommandPaletteUiState", () => {
  it("keeps only one search overlay open", () => {
    const initial = { open: false, mode: "command" as const, openIntent: null };
    const files = reduceCommandPaletteUiState(initial, { _tag: "ToggleMode", mode: "files" });
    expect(files).toEqual({ open: true, mode: "files", openIntent: null });
    expect(reduceCommandPaletteUiState(files, { _tag: "ToggleMode", mode: "files" }).open).toBe(
      false,
    );
  });

  it("records direct-open intents", () => {
    expect(
      reduceCommandPaletteUiState(
        { open: false, mode: "command", openIntent: null },
        { _tag: "OpenAddProject" },
      ),
    ).toEqual({ open: true, mode: "command", openIntent: { kind: "add-project" } });
  });
});

describe("filterCommandPaletteGroups", () => {
  const groups: CommandPaletteGroup[] = [
    {
      value: "actions",
      label: "Actions",
      items: [
        {
          kind: "action",
          value: "add",
          searchTerms: ["add project", "folder"],
          title: "Add project",
          icon: null,
          run: async () => {},
        },
      ],
    },
  ];

  it("matches normalized search terms", () => {
    expect(filterCommandPaletteGroups(groups, " PROJECT ")[0]?.items[0]?.value).toBe("add");
    expect(filterCommandPaletteGroups(groups, "missing")).toEqual([]);
  });
});
