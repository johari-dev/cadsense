import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";
import { CadHierarchyTree } from "./CadHierarchyTree";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useState: h.useState,
    useMemo: h.useMemo,
    useRef: h.useRef,
    useLayoutEffect: h.useEffect,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
afterEach(() => hooks.reset());

const manifest = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: "1".repeat(64),
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: "https://cad.onshape.com",
    documentId: "1".repeat(24),
    elementId: "2".repeat(24),
    kind: "assembly",
    originalRevision: { kind: "m", id: "3".repeat(24) },
    microversionId: "3".repeat(24),
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: ["Parent", "Child", "Leaf"].map((name, index) => ({
    id: String(index + 1).repeat(64),
    parentId: index === 0 ? null : String(index).repeat(64),
    occurrencePath: [],
    instanceId: null,
    name,
    kind: "assembly",
    suppressed: false,
    defaultVisible: true,
    sourcePartKey: null,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  })),
  parts: [],
  assets: [],
  dependencies: [],
});

it.each(["Highlight", "Ghost"])(
  "shows inherited %s state and clears it when toggled off",
  (effect) => {
    let view: CadViewState = {
      rootId: manifest.rootId,
      snapshotId: manifest.snapshotId,
      revision: 0,
      camera: { kind: "preset", preset: "isometric", fit: [] },
      visibility: {},
      isolatedOccurrenceIds: [],
      explosion: 0,
      highlightedOccurrenceIds: [manifest.rootId],
      ghost: { occurrenceIds: [manifest.rootId], opacity: 0.2 },
    };
    const render = () => {
      hooks.beginRender();
      return CadHierarchyTree({
        manifest,
        view,
        disabled: false,
        onChange: (next) => {
          view = next;
        },
      });
    };
    const control = (name: string) =>
      visitElements(render(), (element) => element.props["aria-label"] === `${effect} ${name}`)!
        .props;
    for (const name of ["Parent", "Child", "Leaf"])
      expect(control(name)["aria-pressed"]).toBe(true);
    (control("Child").onClick as () => void)();
    for (const name of ["Parent", "Child", "Leaf"])
      expect(control(name)["aria-pressed"]).toBe(false);
    if (effect === "Highlight") expect(view.ghost?.occurrenceIds).toEqual([manifest.rootId]);
    else expect(view.highlightedOccurrenceIds).toEqual([manifest.rootId]);
    (control("Child").onClick as () => void)();
    expect(control("Parent")["aria-pressed"]).toBe(false);
    expect(control("Child")["aria-pressed"]).toBe(true);
    expect(control("Leaf")["aria-pressed"]).toBe(true);
  },
);
