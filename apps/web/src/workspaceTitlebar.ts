// Keep titlebar rows clear of the floating sidebar toggle. A hidden sidebar puts the row at
// the window edge, so it pads to the toggle's right side. A sidebar folded to its icon rail
// puts the row after the rail. The toggle fits inside the rail except on macOS, where it
// clears the traffic lights and reaches past it, so each row keeps its own padding (the
// first max() argument) unless `--workspace-titlebar-rail-content-left` needs more.
//
// Beside the rail, the row also fades the rail's titlebar tint in from its left edge
// (`rail-titlebar-fade` in index.css).

export const PAGE_HEADER_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-state=rail]_&]:pl-[max(calc(env(safe-area-inset-left)+1.25rem),var(--workspace-titlebar-rail-content-left))] rail-titlebar-fade";

export const RIGHT_PANEL_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-state=rail]_&]:pl-[max(0.5rem,var(--workspace-titlebar-rail-content-left))] rail-titlebar-fade";
