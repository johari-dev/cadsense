import {
  EnvironmentId,
  OnshapeProjectSource,
  OrchestrationProjectShell,
} from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useEffect: reactHookHarness.useEffect };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.check }));
vi.mock("../state/onshapeProjects", () => ({
  onshapeProjectEnvironment: { checkVersions: Symbol("checkVersions") },
}));

import { useOnshapeVersionCheckOnOpen } from "./useOnshapeVersionCheckOnOpen";

const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "11111111-1111-4111-8111-111111111111",
  host: "https://cad.onshape.com",
  documentId: "05760c4d8b40fba37db8fa48",
  workspaceType: "w",
  workspaceId: "f31b499c519e8471cced93dc",
  configuration: "",
  autoReviewVersions: true,
});
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
const makeProject = (id: string, autoReviewVersions = true) => ({
  ...decodeProject({
    id,
    title: "CAD",
    workspaceRoot: `D:/managed/${id}`,
    defaultModelSelection: null,
    onshapeSource: { ...source, autoReviewVersions },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }),
  environmentId: EnvironmentId.make("test"),
});
type TestProject = ReturnType<typeof makeProject>;

function render(project: TestProject | null, connected = true) {
  hooks.beginRender();
  useOnshapeVersionCheckOnOpen(project, connected);
}
const opened = (projectId: string) => ({
  environmentId: "test",
  input: { projectId, reason: "opened" },
});

describe("useOnshapeVersionCheckOnOpen", () => {
  beforeEach(() => {
    hooks.reset();
    state.check.mockReset();
  });

  it("checks once per opened project, not on every render", () => {
    const first = makeProject("project-a");
    render(first);
    render({ ...first, title: "Renamed" });
    render(first);
    expect(state.check.mock.calls).toEqual([[opened("project-a")]]);

    render(makeProject("project-b"));
    expect(state.check.mock.calls).toEqual([[opened("project-a")], [opened("project-b")]]);
  });

  it("waits for the environment connection and skips projects without the setting", () => {
    render(makeProject("project-a"), false);
    render(makeProject("project-b", false));
    render(null);
    expect(state.check).not.toHaveBeenCalled();

    render(makeProject("project-a"), false);
    render(makeProject("project-a"), true);
    expect(state.check.mock.calls).toEqual([[opened("project-a")]]);
  });
});
