import { describe, expect, it } from "vite-plus/test";
import { cadHierarchyWindow } from "./CadHierarchyWindow";

describe("CAD hierarchy viewport", () => {
  it("covers tall fullscreen viewports with bounded overscan", () => {
    const { start, end } = cadHierarchyWindow(2810, 1400, 10000);
    expect(start).toBe(94);
    expect(end).toBe(157);
    expect(start * 28).toBeLessThanOrEqual(2810);
    expect(end * 28).toBeGreaterThanOrEqual(4210);
  });

  it("keeps the sidebar window small", () => {
    expect(cadHierarchyWindow(0, 240, 10000)).toEqual({ start: 0, end: 22 });
  });

  it("clamps stale scrolling when the component list shrinks", () => {
    expect(cadHierarchyWindow(9000, 240, 6)).toEqual({ start: 0, end: 6 });
    expect(cadHierarchyWindow(9000, 240, 0)).toEqual({ start: 0, end: 0 });
  });
});
