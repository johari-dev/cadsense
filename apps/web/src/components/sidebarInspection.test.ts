import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  holdInspection,
  INITIAL_SIDEBAR_INSPECTION,
  isInspecting,
  reduceSidebarInspection,
  resolveSidebarOpen,
  sidebarMotion,
  useInspectionTriggersStore,
} from "./sidebarInspection";

const start = (state = INITIAL_SIDEBAR_INSPECTION) =>
  reduceSidebarInspection(state, { type: "inspection", inspecting: true });
const end = (state: typeof INITIAL_SIDEBAR_INSPECTION) =>
  reduceSidebarInspection(state, { type: "inspection", inspecting: false });
const userSets = (state: typeof INITIAL_SIDEBAR_INSPECTION, open: boolean) =>
  reduceSidebarInspection(state, { type: "user", open });

describe("reduceSidebarInspection and resolveSidebarOpen", () => {
  it("follows the user while nothing is being inspected", () => {
    expect(resolveSidebarOpen(INITIAL_SIDEBAR_INSPECTION)).toBe(true);
    expect(resolveSidebarOpen(userSets(INITIAL_SIDEBAR_INSPECTION, false))).toBe(false);
  });

  it("folds an expanded sidebar to the rail when inspection starts", () => {
    expect(resolveSidebarOpen(start())).toBe(false);
  });

  it("keeps a sidebar the user expands during inspection expanded until inspection ends", () => {
    let state = userSets(start(), true);
    expect(resolveSidebarOpen(state)).toBe(true);
    // A repeated inspection signal (another render, the second trigger) must not undo it.
    state = start(state);
    expect(resolveSidebarOpen(state)).toBe(true);
  });

  it("restores the user's own state when inspection ends, whatever they chose during it", () => {
    const expanded = end(userSets(userSets(start(), true), false));
    expect(resolveSidebarOpen(expanded)).toBe(true);

    const rail = end(userSets(start(userSets(INITIAL_SIDEBAR_INSPECTION, false)), true));
    expect(resolveSidebarOpen(rail)).toBe(false);
  });

  it("keeps a collapsed sidebar collapsed through an inspection", () => {
    const collapsed = userSets(INITIAL_SIDEBAR_INSPECTION, false);
    expect(resolveSidebarOpen(start(collapsed))).toBe(false);
    expect(resolveSidebarOpen(end(start(collapsed)))).toBe(false);
  });

  it("starts each inspection fresh instead of reusing the last one's choice", () => {
    expect(resolveSidebarOpen(start(end(userSets(start(), true))))).toBe(false);
  });

  it("collapses back when the user collapses it again during inspection", () => {
    expect(resolveSidebarOpen(userSets(userSets(start(), true), false))).toBe(false);
  });

  it("folds and restores instantly for inspection, but animates the user's own toggles", () => {
    // Inspection changes land with the panel layout in one frame; the user's clicks animate.
    expect(sidebarMotion(start())).toBe("instant");
    expect(sidebarMotion(userSets(start(), true))).toBe("animated");
    expect(sidebarMotion(end(userSets(start(), true)))).toBe("instant");
    expect(sidebarMotion(userSets(INITIAL_SIDEBAR_INSPECTION, false))).toBe("animated");
  });

  it("returns the same state object when nothing changes", () => {
    expect(end(INITIAL_SIDEBAR_INSPECTION)).toBe(INITIAL_SIDEBAR_INSPECTION);
  });
});

describe("inspection triggers", () => {
  afterEach(() => {
    useInspectionTriggersStore.setState({
      holds: { "panel-maximized": 0, "cad-comments-docked": 0 },
    });
  });

  it("stays inspecting while either trigger holds, and ends when both release", () => {
    const releaseMaximized = holdInspection("panel-maximized");
    const releaseDocked = holdInspection("cad-comments-docked");
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(true);
    releaseMaximized();
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(true);
    releaseDocked();
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(false);
  });

  it("counts holds, so a second panel releasing does not end the first one's hold", () => {
    const first = holdInspection("cad-comments-docked");
    const second = holdInspection("cad-comments-docked");
    second();
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(true);
    first();
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(false);
  });

  it("ignores a release called twice", () => {
    const keep = holdInspection("panel-maximized");
    const release = holdInspection("panel-maximized");
    release();
    release();
    expect(isInspecting(useInspectionTriggersStore.getState())).toBe(true);
    keep();
  });
});
