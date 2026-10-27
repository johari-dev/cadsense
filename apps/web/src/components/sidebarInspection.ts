import { create } from "zustand";

/**
 * On desktop the app sidebar is either expanded or folded to its icon rail; collapsing never
 * hides it. Inspection mode (the right panel is maximized, or CAD comments are docked beside
 * the model) folds an expanded sidebar to the rail so the model gets the width. The user can
 * still expand it; that choice holds until inspection ends, and then their own state comes
 * back. Mobile uses a sheet with its own open state and ignores all of this.
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
  /** What made the latest change: entering or leaving inspection, or the user's own toggle. */
  readonly changedBy: "inspection" | "user";
}

export const INITIAL_SIDEBAR_INSPECTION: SidebarInspectionState = {
  userOpen: true,
  inspecting: false,
  override: null,
  changedBy: "user",
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
    return { ...state, inspecting: event.inspecting, override: null, changedBy: "inspection" };
  }
  return state.inspecting
    ? { ...state, override: event.open, changedBy: "user" }
    : { ...state, userOpen: event.open, changedBy: "user" };
}

/**
 * How the sidebar's latest change should look. An inspection fold or restore changes the right
 * panel's width in the same frame (it takes back the width the rail frees), so the sidebar
 * snaps with it instead of sliding while the panel jumps. The user's own toggles animate.
 */
export function sidebarMotion(state: SidebarInspectionState): "instant" | "animated" {
  return state.changedBy === "inspection" ? "instant" : "animated";
}

/** Whether the desktop sidebar is expanded (true) or folded to its icon rail (false). */
export function resolveSidebarOpen(state: SidebarInspectionState): boolean {
  if (!state.inspecting) return state.userOpen;
  return state.override ?? false;
}
