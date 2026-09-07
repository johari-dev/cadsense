import {
  MessageId,
  OrchestrationReadModel,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ProviderSession,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { make } from "./CadProjectQuiescence.ts";

const now = "2026-09-05T00:00:00Z";
const projectId = ProjectId.make("cad-project");
const threadId = ThreadId.make("deleted-cad-thread");
const otherThread = ThreadId.make("other-thread");
const model = Schema.decodeUnknownSync(OrchestrationReadModel)({
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      title: "CAD",
      workspaceRoot: "C:/cad",
      defaultModelSelection: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      cad: {
        enabled: true,
        catalog: null,
        roots: [],
        lastOutcome: null,
        operation: {
          operationId: "00000000-0000-4000-8000-000000000001",
          kind: "discover",
          root: null,
          startedAt: now,
        },
      },
    },
  ],
  threads: [threadId, otherThread].map((id) => ({
    id,
    projectId: id === threadId ? projectId : "other-project",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "full-access",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: id === threadId ? now : null,
    messages: [],
    activities: [],
    session: null,
  })),
});
const unused = () => Effect.die("Unexpected test operation");
const harness = Effect.fn(function* (
  options: {
    working?: boolean;
    pending?: boolean;
    keepProcess?: boolean;
    loseReservation?: boolean;
  } = {},
) {
  const stopped: ThreadId[] = [];
  let reads = 0;
  let sessions: ProviderSession[] = [threadId, threadId, otherThread].map((id) => ({
    threadId: id,
    provider: ProviderDriverKind.make("codex"),
    status: "closed",
    runtimeMode: "full-access",
    createdAt: now,
    updatedAt: now,
  }));
  const query = ProjectionSnapshotQuery.of({
    getCommandReadModel: () =>
      Effect.sync(() => {
        reads++;
        if (options.loseReservation && reads > 1)
          return {
            ...model,
            projects: model.projects.map((project) => ({
              ...project,
              cad: { ...project.cad!, operation: null },
            })),
          };
        if (options.pending)
          return {
            ...model,
            threads: model.threads.map((thread) =>
              thread.id !== threadId
                ? thread
                : {
                    ...thread,
                    turnAdmission: {
                      pending: [
                        { messageId: MessageId.make("pending"), requestedAt: now, turnId: null },
                      ],
                      completedTurnIds: [],
                    },
                  },
            ),
          };
        return model;
      }),
    getProjectShellById: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    listPendingOnshapeProjects: unused,
    getArchivedShellSnapshot: unused,
    searchThreads: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadShellById: unused,
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
  });
  const providers = ProviderService.of({
    listSessions: () => Effect.succeed(sessions),
    stopIdleSession: ({ threadId }) =>
      Effect.sync(() => {
        stopped.push(threadId);
        if (!options.keepProcess)
          sessions = sessions.filter((session) => session.threadId !== threadId);
      }),
    startSession: unused,
    sendTurn: unused,
    interruptTurn: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    stopSession: unused,
    getCapabilities: unused,
    getInstanceInfo: unused,
    uploadFeedback: unused,
    streamEvents: Stream.empty,
  });
  const service = yield* make.pipe(
    Effect.provideService(ProjectionSnapshotQuery, query),
    Effect.provideService(ProviderService, providers),
    Effect.provideService(ThreadBackgroundLivenessService, {
      recordTaskLiveness: () => {},
      clearThreadLiveness: () => {},
      getThreadBackgroundLiveness: () => (options.working ? "working" : "monitoring"),
    }),
  );
  return { service, stopped, sessions: () => sessions };
});

it.effect(
  "confirms all old instances of a deleted project thread without stopping another project",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.confirm(projectId);
      assert.deepEqual(h.stopped, [threadId]);
      assert.deepEqual(
        h.sessions().map((session) => session.threadId),
        [otherThread],
      );
    }),
);
it.effect("rejects working descendants and accepted starts before attempting native shutdown", () =>
  Effect.gen(function* () {
    for (const options of [{ working: true }, { pending: true }]) {
      const h = yield* harness(options);
      assert.equal((yield* h.service.confirm(projectId).pipe(Effect.flip)).reason, "busy");
      assert.deepEqual(h.stopped, []);
    }
  }),
);
it.effect(
  "requires both an empty native registry and the same durable reservation after shutdown",
  () =>
    Effect.gen(function* () {
      for (const options of [{ keepProcess: true }, { loseReservation: true }]) {
        const h = yield* harness(options);
        assert.equal((yield* h.service.confirm(projectId).pipe(Effect.flip)).reason, "busy");
        assert.deepEqual(h.stopped, [threadId]);
      }
    }),
);
