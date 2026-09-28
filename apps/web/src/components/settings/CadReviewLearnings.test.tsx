import { EnvironmentId, ProjectId, type CadReviewLearning } from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({ learnings: undefined as unknown, remove: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.learnings }));
vi.mock("../../state/cadPanel", () => ({
  cadPanelEnvironment: { learnings: () => "learnings", removeLearning: "remove" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.remove }));
import { CadReviewLearnings } from "./CadReviewLearnings";

const project = {
  id: ProjectId.make("cad-project"),
  environmentId: EnvironmentId.make("test"),
} as unknown as Project;
interface Props {
  children?: ReactNode;
  onClick?: () => void;
  "aria-label"?: string;
  disabled?: boolean;
}
const find = (tree: ReactNode, predicate: (props: Props) => boolean): Props[] => {
  if (Array.isArray(tree)) return tree.flatMap((child) => find(child, predicate));
  if (!isValidElement<Props>(tree)) return [];
  return [...(predicate(tree.props) ? [tree.props] : []), ...find(tree.props.children, predicate)];
};
const render = () => {
  hooks.beginRender();
  return CadReviewLearnings({ project });
};
const learning = (id: string, text: string): CadReviewLearning => ({
  id,
  projectId: project.id,
  text,
  sourceCommentId: "comment",
  sourceThreadId: "thread" as CadReviewLearning["sourceThreadId"],
  createdAt: "2026-09-05T00:00:00Z",
});

beforeEach(() => {
  hooks.reset();
  state.remove.mockReset();
  state.remove.mockResolvedValue(AsyncResult.success(undefined));
});

it("explains how learnings appear when there are none", () => {
  state.learnings = AsyncResult.success([]);
  const texts = find(render(), (props) => typeof props.children === "string").map(
    (props) => props.children,
  );
  expect(texts).toContain("None yet. Dismiss a finding with a reason to add one.");
});

it("lists each learning and removes the one whose control was used", () => {
  state.learnings = AsyncResult.success([
    learning("a", "Vent holes are intentional."),
    learning("b", "The motor is a placeholder."),
  ]);
  const tree = render();
  expect(find(tree, (props) => props.children === "Vent holes are intentional.")).toHaveLength(1);
  expect(find(tree, (props) => props.children === "The motor is a placeholder.")).toHaveLength(1);
  const removeButtons = find(tree, (props) => props["aria-label"] === "Remove learning");
  expect(removeButtons).toHaveLength(2);
  removeButtons[1]!.onClick!();
  expect(state.remove).toHaveBeenCalledExactlyOnceWith({
    environmentId: project.environmentId,
    input: { projectId: project.id, learningId: "b", commandId: expect.any(String) },
  });
  // Both controls lock while a removal is in flight.
  expect(
    find(render(), (props) => props["aria-label"] === "Remove learning").every(
      (props) => props.disabled === true,
    ),
  ).toBe(true);
});
