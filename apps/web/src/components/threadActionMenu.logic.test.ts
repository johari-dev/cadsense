import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  isPinned: false,
  isRegeneratingTitle: false,
  isRunning: false,
  supportsPinning: true,
  supportsTitleRegeneration: true,
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("offers pinning only when supported", () => {
    expect(ids(baseState)).toContain("pin");
    expect(ids({ ...baseState, isPinned: true })).toContain("unpin");
    expect(ids({ ...baseState, supportsPinning: false })).not.toContain("pin");
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ disabled: true });
  });

  it("disables archive while the thread is running and keeps delete destructive", () => {
    const items = buildThreadActionMenuItems({ ...baseState, isRunning: true });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
});
