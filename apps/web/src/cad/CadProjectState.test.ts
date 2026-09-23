import {
  CadHash,
  CadSnapshotId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  initialCadProjectState,
} from "@cadsense/contracts";
import { expect, it } from "vite-plus/test";
import type { Project, ThreadShell } from "../types";
import { cadPanelLockStatus, findCadProjectRunBlocker } from "./CadProjectState";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const now = "2026-09-23T00:00:00.000Z";
const project = {
  id: projectId,
  environmentId,
  cad: initialCadProjectState(),
} satisfies Pick<Project, "id" | "environmentId" | "cad">;

const shell = (id: string, title: string, runningTurn: string | null): ThreadShell => ({
  environmentId,
  id: ThreadId.make(id),
  projectId,
  title,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  latestTurn: runningTurn
    ? {
        turnId: TurnId.make(runningTurn),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      }
    : null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const self = ThreadId.make("self");
const idle = { agentControlling: false, agentActivityTurnId: null, captureId: null };

it("names another chat's run as the lock cause and grays out the viewer", () => {
  const threads = [
    shell("self", "This chat", null),
    { ...shell("other", "Gearbox review", "turn-9"), environmentId: EnvironmentId.make("x") },
    shell("other", "Gearbox review", "turn-9"),
  ];
  const blocker = findCadProjectRunBlocker(project, threads, self);
  expect(blocker?.threadId).toBe("other");
  expect(blocker?.thread?.environmentId).toBe(environmentId);
  expect(cadPanelLockStatus({ threadId: self, blocker, panel: idle, operation: "sync" })).toEqual({
    message: 'Locked while "Gearbox review" runs.',
    agent: false,
  });
});

it("prefers this chat's own run over another chat's", () => {
  const threads = [shell("other", "Other", "turn-9"), shell("self", "This chat", "turn-1")];
  expect(findCadProjectRunBlocker(project, threads, self)?.threadId).toBe("self");
  expect(findCadProjectRunBlocker(project, threads)?.threadId).toBe("other");
});

it("keeps agent status steady across the gap between CAD tool calls in one run", () => {
  const blocker = findCadProjectRunBlocker(project, [shell("self", "This chat", "turn-1")], self);
  const turn = TurnId.make("turn-1");
  const during = cadPanelLockStatus({
    threadId: self,
    blocker,
    panel: { ...idle, agentControlling: true, agentActivityTurnId: turn },
    operation: null,
  });
  const between = cadPanelLockStatus({
    threadId: self,
    blocker,
    panel: { ...idle, agentActivityTurnId: turn },
    operation: null,
  });
  expect(during).toEqual({
    message: "Agent is looking at CAD. Controls unlock when the run ends.",
    agent: true,
  });
  expect(between).toEqual(during);
});

it("does not credit CAD use from an earlier run to a new run", () => {
  const blocker = findCadProjectRunBlocker(project, [shell("self", "This chat", "turn-2")], self);
  expect(
    cadPanelLockStatus({
      threadId: self,
      blocker,
      panel: { ...idle, agentActivityTurnId: TurnId.make("turn-1") },
      operation: null,
    }),
  ).toEqual({ message: "Locked while this chat runs.", agent: false });
});

it("explains the agent's captured view while its presentation is pending", () => {
  const captureId = CadSnapshotId.make("00000000-0000-4000-8000-000000000001");
  const pending = {
    ...project,
    cad: {
      ...project.cad,
      pendingPresentations: [
        {
          threadId: self,
          turnId: TurnId.make("turn-1"),
          captureId,
          rootId: CadHash.make("1".repeat(64)),
        },
      ],
    },
  };
  const blocker = findCadProjectRunBlocker(pending, [shell("self", "This chat", null)], self);
  expect(blocker?.threadId).toBe("self");
  expect(
    cadPanelLockStatus({ threadId: self, blocker, panel: { ...idle, captureId }, operation: null }),
  ).toEqual({
    message: "Showing the agent's last view. Controls unlock when the run ends.",
    agent: true,
  });
});

it("explains operations and returns null once nothing locks the panel", () => {
  const blocker = findCadProjectRunBlocker(project, [shell("self", "This chat", null)], self);
  expect(blocker).toBeNull();
  expect(
    cadPanelLockStatus({ threadId: self, blocker, panel: idle, operation: "discover" }),
  ).toEqual({
    message: "Updating CAD from Onshape.",
    agent: false,
  });
  expect(cadPanelLockStatus({ threadId: self, blocker, panel: idle, operation: null })).toBeNull();
});
