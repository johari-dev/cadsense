import { Component, createRef, type ReactNode } from "react";

/** Matches the sidebar's own width transition (ui/sidebar.tsx). */
const FOLD_TIMING = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/**
 * Where each visible `data-sidebar-fold` element sits, by its key: its left edge and vertical
 * center. Left edges, not centers, so a wide expanded row lines up with its small rail button.
 */
function measure(root: HTMLElement | null) {
  const anchors = new Map<string, { x: number; y: number }>();
  for (const el of root?.querySelectorAll<HTMLElement>("[data-sidebar-fold]") ?? []) {
    const rect = el.getBoundingClientRect();
    const key = el.dataset.sidebarFold;
    if (key && rect.width > 0) {
      anchors.set(key, { x: rect.x, y: rect.y + rect.height / 2 });
    }
  }
  return anchors;
}

/**
 * Slides the elements that the expanded sidebar and the icon rail share between their two
 * spots when the sidebar folds. Mark each pair with the same `data-sidebar-fold` key. A class,
 * because getSnapshotBeforeUpdate is the one place React runs before the fold hides the old
 * layout, so the old positions can still be measured there.
 */
export class SidebarFoldMotion extends Component<{
  readonly collapsed: boolean;
  readonly children: ReactNode;
}> {
  private readonly root = createRef<HTMLDivElement>();
  private animations: Animation[] = [];

  override getSnapshotBeforeUpdate(previous: SidebarFoldMotion["props"]) {
    if (previous.collapsed === this.props.collapsed) return null;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    // Includes any slide still running, so a quick reversal starts from where things are.
    return measure(this.root.current);
  }

  override componentDidUpdate(
    _previous: SidebarFoldMotion["props"],
    _state: unknown,
    from: ReturnType<typeof measure> | null,
  ) {
    if (!from) return;
    this.cancel();
    for (const el of this.root.current?.querySelectorAll<HTMLElement>("[data-sidebar-fold]") ??
      []) {
      const start = from.get(el.dataset.sidebarFold ?? "");
      const rect = el.getBoundingClientRect();
      if (!start || rect.width === 0) continue;
      const x = start.x - rect.x;
      const y = start.y - (rect.y + rect.height / 2);
      this.animations.push(
        el.animate([{ translate: `${x}px ${y}px` }, { translate: "none" }], FOLD_TIMING),
      );
    }
    // Opening, the thread lists are already in place while their projects slide down onto
    // them, so they stay hidden for the first half and fade in once the rows have mostly arrived.
    if (this.props.collapsed) return;
    for (const list of this.root.current?.querySelectorAll('[data-slot="sidebar-menu-sub"]') ??
      []) {
      this.animations.push(
        list.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 100,
          delay: 100,
          fill: "backwards",
        }),
      );
    }
  }

  override componentWillUnmount() {
    this.cancel();
  }

  private cancel() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  override render() {
    return (
      <div ref={this.root} className="contents">
        {this.props.children}
      </div>
    );
  }
}
