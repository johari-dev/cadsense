import { create } from "zustand";

/**
 * Inspection mode: while the user inspects a model (the right panel is maximized, or CAD
 * comments are docked beside the model), the app sidebar collapses to an icon rail so the
 * model gets the width. The user can still expand it; that choice holds until inspection
 * ends, and then their own sidebar state comes back.
 */

/** What can put the workspace into inspection mode. */
export type InspectionTrigger = "panel-maximized" | "cad-comments-docked";

/**
 * Counted holds per trigger, so two mounted panels cannot clear each other's signal. Panels
 * call `holdInspection` while the condition is true and release it when it ends or they unmount.
 */
export const useInspectionTriggersStore = create<{
  holds: Readonly<Record<InspectionTrigger, number>>;
}>(() => ({ holds: { "panel-maximized": 0, "cad-comments-docked": 0 } }));

/** Starts holding `trigger`. Returns the release; calling it more than once is a no-op. */
export function holdInspection(trigger: InspectionTrigger): () => void {
  const shift = (delta: number) =>
    useInspectionTriggersStore.setState((state) => ({
      holds: { ...state.holds, [trigger]: Math.max(0, state.holds[trigger] + delta) },
    }));
  shift(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    shift(-1);
  };
}

export function isInspecting(state: {
  readonly holds: Readonly<Record<InspectionTrigger, number>>;
}): boolean {
  return state.holds["panel-maximized"] > 0 || state.holds["cad-comments-docked"] > 0;
}

export interface SidebarInspectionState {
  /** The user's own open state outside inspection. */
  readonly userOpen: boolean;
  readonly inspecting: boolean;
  /** An explicit open or collapse during the current inspection; null until they make one. */
  readonly override: boolean | null;
}

export const INITIAL_SIDEBAR_INSPECTION: SidebarInspectionState = {
  userOpen: true,
  inspecting: false,
  override: null,
};

export type SidebarInspectionEvent =
  | { readonly type: "inspection"; readonly inspecting: boolean }
  | { readonly type: "user"; readonly open: boolean };

export function reduceSidebarInspection(
  state: SidebarInspectionState,
  event: SidebarInspectionEvent,
): SidebarInspectionState {
  if (event.type === "inspection") {
    if (event.inspecting === state.inspecting) return state;
    // Entering or leaving inspection drops any choice made during the previous one.
    return { ...state, inspecting: event.inspecting, override: null };
  }
  return state.inspecting ? { ...state, override: event.open } : { ...state, userOpen: event.open };
}

/**
 * How the desktop sidebar renders. Outside inspection it follows the user and collapses
 * off-canvas. During inspection an open sidebar becomes the icon rail unless the user expands
 * it; a sidebar they had hidden stays hidden. Mobile uses a sheet and is never changed.
 */
export function resolveSidebarPresentation(
  state: SidebarInspectionState,
  environment: { readonly isMobile: boolean },
): { readonly open: boolean; readonly collapsible: "offcanvas" | "icon" } {
  if (environment.isMobile || !state.inspecting) {
    return { open: state.userOpen, collapsible: "offcanvas" };
  }
  if (state.override === null) {
    return { open: false, collapsible: state.userOpen ? "icon" : "offcanvas" };
  }
  return { open: state.override, collapsible: "icon" };
}
