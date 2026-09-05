import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import type { CommandPaletteOpenIntent } from "./CommandPalette.logic";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: reactHookHarness.useEffect,
    useLayoutEffect: reactHookHarness.useEffect,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { useCommandPaletteQuery } from "./useCommandPaletteQuery";

describe("command palette query lifecycle", () => {
  beforeEach(() => hooks.reset());

  it.each([
    ["add-project", "add project"],
    ["new-thread-in", "new thread in"],
  ] as const)("preserves the %s intent through mount and consumption", (kind, expected) => {
    let intent: CommandPaletteOpenIntent | null = { kind };
    const clear = () => {
      intent = null;
    };
    const render = () => {
      hooks.beginRender();
      return useCommandPaletteQuery("draft:one", intent, clear);
    };
    render();
    expect(render().query).toBe(expected);
    expect(render().query).toBe(expected);
  });

  it("retains edited search on rerender and clears it only when the thread changes", () => {
    const clear = () => {};
    const render = (route: string | null) => {
      hooks.beginRender();
      return useCommandPaletteQuery(route, null, clear);
    };
    const initial = render(null);
    initial.setQuery("onshape");
    initial.setHighlightedItemValue("connection");
    expect(render(null).query).toBe("onshape");
    render("draft:one");
    expect(render("draft:one").query).toBe("");
    expect(render("draft:one").highlightedItemValue).toBeNull();
  });
});
