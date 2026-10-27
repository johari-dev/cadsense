import { describe, expect, it } from "vite-plus/test";
import { CAD_HIERARCHY_ROW_HEIGHT, cadHierarchyWindow } from "./CadHierarchyWindow";

/** Row offsets for `count` one-line rows. */
const uniform = (count: number) =>
  Array.from({ length: count + 1 }, (_, index) => index * CAD_HIERARCHY_ROW_HEIGHT);

describe("CAD hierarchy viewport", () => {
  it("covers tall fullscreen viewports with bounded overscan", () => {
    const { start, end } = cadHierarchyWindow(2810, 1400, uniform(10000));
    expect(start).toBe(94);
    expect(end).toBe(157);
    expect(start * 28).toBeLessThanOrEqual(2810);
    expect(end * 28).toBeGreaterThanOrEqual(4210);
  });

  it("keeps the sidebar window small", () => {
    expect(cadHierarchyWindow(0, 240, uniform(10000))).toEqual({ start: 0, end: 15 });
  });

  it("clamps stale scrolling when the component list shrinks", () => {
    expect(cadHierarchyWindow(9000, 240, uniform(6))).toEqual({ start: 0, end: 6 });
    expect(cadHierarchyWindow(9000, 240, uniform(0))).toEqual({ start: 0, end: 0 });
  });
});
