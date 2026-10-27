import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  holdInspection,
  INITIAL_SIDEBAR_INSPECTION,
  isInspecting,
  reduceSidebarInspection,
  resolveSidebarPresentation,
  useInspectionTriggersStore,
  type SidebarInspectionState,
} from "./sidebarInspection";

const desktop = (state: SidebarInspectionState) =>
  resolveSidebarPresentation(state, { isMobile: false });

describe("reduceSidebarInspection and resolveSidebarPresentation", () => {
  it("shows the user's sidebar while nothing is being inspected", () => {
    expect(desktop(INITIAL_SIDEBAR_INSPECTION)).toEqual({ open: true, collapsible: "offcanvas" });
    const hidden = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "user",
      open: false,
    });
    expect(desktop(hidden)).toEqual({ open: false, collapsible: "offcanvas" });
  });

  it("collapses an open sidebar to the icon rail when inspection starts", () => {
    const inspecting = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    expect(desktop(inspecting)).toEqual({ open: false, collapsible: "icon" });
  });

  it("keeps a sidebar the user expands during inspection expanded until inspection ends", () => {
    let state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    state = reduceSidebarInspection(state, { type: "user", open: true });
    expect(desktop(state).open).toBe(true);
    // A repeated inspection signal (another render, the second trigger) must not undo it.
    state = reduceSidebarInspection(state, { type: "inspection", inspecting: true });
    expect(desktop(state).open).toBe(true);
  });

  it("restores the user's own state when inspection ends, whatever they chose during it", () => {
    let state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    state = reduceSidebarInspection(state, { type: "user", open: true });
    state = reduceSidebarInspection(state, { type: "user", open: false });
    state = reduceSidebarInspection(state, { type: "inspection", inspecting: false });
    expect(desktop(state)).toEqual({ open: true, collapsible: "offcanvas" });

    let hidden = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, { type: "user", open: false });
    hidden = reduceSidebarInspection(hidden, { type: "inspection", inspecting: true });
    hidden = reduceSidebarInspection(hidden, { type: "user", open: true });
    hidden = reduceSidebarInspection(hidden, { type: "inspection", inspecting: false });
    expect(desktop(hidden)).toEqual({ open: false, collapsible: "offcanvas" });
  });

  it("starts each inspection fresh instead of reusing the last one's choice", () => {
    let state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    state = reduceSidebarInspection(state, { type: "user", open: true });
    state = reduceSidebarInspection(state, { type: "inspection", inspecting: false });
    state = reduceSidebarInspection(state, { type: "inspection", inspecting: true });
    expect(desktop(state)).toEqual({ open: false, collapsible: "icon" });
  });

  it("keeps a sidebar the user had hidden hidden, rather than adding a rail", () => {
    let state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, { type: "user", open: false });
    state = reduceSidebarInspection(state, { type: "inspection", inspecting: true });
    expect(desktop(state)).toEqual({ open: false, collapsible: "offcanvas" });
  });

  it("collapses back to the rail when the user collapses it again during inspection", () => {
    let state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    state = reduceSidebarInspection(state, { type: "user", open: true });
    state = reduceSidebarInspection(state, { type: "user", open: false });
    expect(desktop(state)).toEqual({ open: false, collapsible: "icon" });
  });

  it("leaves narrow (mobile) windows alone, where the sidebar is a sheet", () => {
    const state = reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
      type: "inspection",
      inspecting: true,
    });
    expect(resolveSidebarPresentation(state, { isMobile: true })).toEqual({
      open: true,
      collapsible: "offcanvas",
    });
  });

  it("returns the same state object when nothing changes", () => {
    expect(
      reduceSidebarInspection(INITIAL_SIDEBAR_INSPECTION, {
        type: "inspection",
        inspecting: false,
      }),
    ).toBe(INITIAL_SIDEBAR_INSPECTION);
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
