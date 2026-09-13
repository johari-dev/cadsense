import type { CadViewState } from "@cadsense/contracts";
import { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { CadCameraToolbar } from "./CadCameraToolbar";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
afterEach(() => hooks.reset());

type Control = {
  children?: ReactNode;
  "aria-label"?: string;
  value?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
};
function findControl(node: ReactNode, label: string): Control | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findControl(child, label);
      if (found) return found;
    }
  }
  if (!isValidElement<Control>(node)) return;
  const children = node.props.children;
  const text = Array.isArray(children)
    ? children.filter((child) => typeof child === "string").join("")
    : children;
  if (node.props["aria-label"] === label || text === label) return node.props;
  return findControl(node.props.children, label);
}

it("resyncs an open section editor after incoming sections and reset without losing drafts on camera changes", () => {
  let view: CadViewState = {
    rootId: "root",
    snapshotId: "snapshot",
    revision: 0,
    camera: { kind: "preset", preset: "isometric", fit: [] },
    visibility: {},
    isolatedOccurrenceIds: [],
    explosion: 0,
    sectionPlanes: [{ normal: [1, 0, 0], constant: -0.02 }],
  };
  const render = () => {
    hooks.beginRender();
    return CadCameraToolbar({
      view,
      disabled: false,
      onChange: (next) => {
        view = next;
      },
    });
  };
  findControl(render(), "Section")!.onClick!();
  expect(findControl(render(), "Section axis")!.value).toBe("x");
  expect(findControl(render(), "Section offset in meters")!.value).toBe("0.02");
  findControl(render(), "Section offset in meters")!.onChange!({ target: { value: "0.03" } });
  view = {
    ...view,
    camera: { kind: "preset", preset: "front", fit: [] },
    sectionPlanes: [{ normal: [1, 0, 0], constant: -0.02 }],
  };
  expect(findControl(render(), "Section offset in meters")!.value).toBe("0.03");
  view = { ...view, sectionPlanes: [{ normal: [0, 1, 0], constant: 0.04 }] };
  expect(findControl(render(), "Section axis")!.value).toBe("y");
  expect(findControl(render(), "Section offset in meters")!.value).toBe("-0.04");
  findControl(render(), "Reset inspection (section)")!.onClick!();
  expect(findControl(render(), "Section axis")!.value).toBe("z");
  expect(findControl(render(), "Section offset in meters")!.value).toBe("0");
  view = { ...view, sectionPlanes: [{ normal: [0, 0, -1], constant: 0.5 }] };
  expect(
    findControl(
      render(),
      "Apply section replaces the current planes with the selected axis and offset.",
    ),
  ).toBeDefined();
});
