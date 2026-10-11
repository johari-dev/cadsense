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
import {
  cadPanelLockStatus,
  findCadThreadRunBlocker,
  isCadProjectRunActive,
} from "./CadProjectState";

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

it("leaves this chat's panel unlocked while another chat runs or presents", () => {
  const other = ThreadId.make("other");
  const presenting = {
    ...project,
    cad: {
      ...project.cad,
      pendingPresentations: [
        {
          threadId: other,
          turnId: TurnId.make("turn-9"),
          captureId: CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
          rootId: CadHash.make("1".repeat(64)),
        },
      ],
    },
  };
  const threads = [shell("self", "This chat", null), shell("other", "Gearbox review", "turn-9")];
  expect(findCadThreadRunBlocker(presenting, threads, self)).toBeNull();
  expect(cadPanelLockStatus({ blocker: null, panel: idle, operation: null })).toBeNull();
  // Project-wide CAD changes, like sync and cleanup, still wait for every chat.
  expect(isCadProjectRunActive(project, threads)).toBe(true);
  expect(isCadProjectRunActive(presenting, [shell("self", "This chat", null)])).toBe(true);
  expect(isCadProjectRunActive(project, [shell("self", "This chat", null)])).toBe(false);
});

it("only counts this chat's own run in this project and environment", () => {
  const elsewhere = [
    { ...shell("self", "This chat", "turn-1"), environmentId: EnvironmentId.make("x") },
    { ...shell("self", "This chat", "turn-1"), projectId: ProjectId.make("other-project") },
  ];
  expect(findCadThreadRunBlocker(project, elsewhere, self)).toBeNull();
  const own = shell("self", "This chat", "turn-1");
  expect(findCadThreadRunBlocker(project, [...elsewhere, own], self)).toEqual({ thread: own });
});

it("keeps agent status steady across the gap between CAD tool calls in one run", () => {
  const blocker = findCadThreadRunBlocker(project, [shell("self", "This chat", "turn-1")], self);
  const turn = TurnId.make("turn-1");
  const during = cadPanelLockStatus({
    blocker,
    panel: { ...idle, agentControlling: true, agentActivityTurnId: turn },
    operation: null,
  });
  const between = cadPanelLockStatus({
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
  const blocker = findCadThreadRunBlocker(project, [shell("self", "This chat", "turn-2")], self);
  expect(
    cadPanelLockStatus({
      blocker,
      panel: { ...idle, agentActivityTurnId: TurnId.make("turn-1") },
      operation: null,
    }),
  ).toEqual({ message: "Locked while this chat runs.", agent: false });
});

it("does not credit the previous turn's CAD use while a new run is starting", () => {
  const previous = shell("self", "This chat", "turn-1");
  const starting: ThreadShell = {
    ...previous,
    latestTurn: { ...previous.latestTurn!, state: "completed", completedAt: now },
    session: {
      threadId: self,
      status: "starting",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  };
  const blocker = findCadThreadRunBlocker(project, [starting], self);
  expect(
    cadPanelLockStatus({
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
  const blocker = findCadThreadRunBlocker(pending, [shell("self", "This chat", null)], self);
  expect(blocker?.thread?.id).toBe(self);
  // The run has ended, so the strip must not promise an unlock "when the run ends".
  expect(cadPanelLockStatus({ blocker, panel: { ...idle, captureId }, operation: null })).toEqual({
    message: "Showing the agent's last view.",
    agent: true,
  });
  const running = findCadThreadRunBlocker(pending, [shell("self", "This chat", "turn-1")], self);
  expect(
    cadPanelLockStatus({
      blocker: running,
      panel: { ...idle, captureId },
      operation: null,
    }),
  ).toEqual({
    message: "Showing the agent's last view. Controls unlock when the run ends.",
    agent: true,
  });
});

it("explains operations and returns null once nothing locks the panel", () => {
  const blocker = findCadThreadRunBlocker(project, [shell("self", "This chat", null)], self);
  expect(blocker).toBeNull();
  expect(cadPanelLockStatus({ blocker, panel: idle, operation: "discover" })).toEqual({
    message: "Updating CAD from Onshape.",
    agent: false,
  });
  expect(cadPanelLockStatus({ blocker, panel: idle, operation: null })).toBeNull();
});
