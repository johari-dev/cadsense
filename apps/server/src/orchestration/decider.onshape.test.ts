import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-04T00:00:00.000Z";
const projectId = ProjectId.make("onshape-project");
const connectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001");
const replacementConnectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000002");
const source = OnshapeProjectSource.make({
  connectionId,
  host: "https://cad.onshape.com",
  documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
  elementId: OnshapeElementId.make("b53dde24ab8b46d679af9944"),
  configuration: "Size=Large",
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function eventOfType<Type extends OrchestrationEvent["type"]>(
  result: PlannedEvent | ReadonlyArray<PlannedEvent>,
  type: Type,
): Omit<Extract<OrchestrationEvent, { readonly type: Type }>, "sequence"> {
  if (!("type" in result) || result.type !== type) {
    return assert.fail(`Expected one ${type} event.`);
  }
  return result as Omit<Extract<OrchestrationEvent, { readonly type: Type }>, "sequence">;
}

it.layer(NodeServices.layer)("Onshape project decider", (it) => {
  it.effect("creates and projects a source-bound project", () =>
    Effect.gen(function* () {
      const event = eventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.onshape.create",
            commandId: CommandId.make("server:onshape-project-create:1"),
            projectId,
            title: "FRC intake",
            workspaceRoot: "/managed/project-hash",
            defaultModelSelection: null,
            onshapeSource: source,
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
        "project.created",
      );

      assert.deepStrictEqual(event.payload.onshapeSource, {
        ...source,
        managedWorkspaceReady: false,
      });

      const projected = yield* projectEvent(createEmptyReadModel(now), {
        ...event,
        sequence: 1,
      });
      assert.deepStrictEqual(projected.projects[0]?.onshapeSource, {
        ...source,
        managedWorkspaceReady: false,
      });
    }),
  );

  it.effect("rejects a duplicate active source even through another saved connection", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-onshape-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("server:onshape-project-create:1"),
        causationEventId: null,
        correlationId: CommandId.make("server:onshape-project-create:1"),
        metadata: {},
        payload: {
          projectId,
          title: "FRC intake",
          workspaceRoot: "/managed/project-hash",
          defaultModelSelection: null,
          onshapeSource: source,
          createdAt: now,
          updatedAt: now,
        },
      });

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.onshape.create",
            commandId: CommandId.make("server:onshape-project-create:2"),
            projectId: ProjectId.make("duplicate-onshape-project"),
            title: "Duplicate intake",
            workspaceRoot: "/managed/another-project-hash",
            defaultModelSelection: null,
            onshapeSource: { ...source, connectionId: replacementConnectionId },
            createdAt: now,
          },
          readModel: seeded,
        }),
      );

      assert.include(error.message, "already exists for this Onshape source");
    }),
  );

  it.effect("rebinds only the saved connection reference", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-onshape-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("server:onshape-project-create:1"),
        causationEventId: null,
        correlationId: CommandId.make("server:onshape-project-create:1"),
        metadata: {},
        payload: {
          projectId,
          title: "FRC intake",
          workspaceRoot: "/managed/project-hash",
          defaultModelSelection: null,
          onshapeSource: source,
          createdAt: now,
          updatedAt: now,
        },
      });
      const event = eventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.onshape.connection.set",
            commandId: CommandId.make("server:onshape-project-set-connection:1"),
            projectId,
            connectionId: replacementConnectionId,
          },
          readModel: seeded,
        }),
        "project.meta-updated",
      );

      const projected = yield* projectEvent(seeded, { ...event, sequence: 2 });
      assert.deepStrictEqual(projected.projects[0]?.onshapeSource, {
        ...source,
        connectionId: replacementConnectionId,
      });
    }),
  );

  it.effect("rejects readiness and rebinding after the project is deleted", () =>
    Effect.gen(function* () {
      const active = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-onshape-project-created-before-delete"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("server:onshape-project-create:before-delete"),
        causationEventId: null,
        correlationId: CommandId.make("server:onshape-project-create:before-delete"),
        metadata: {},
        payload: {
          projectId,
          title: "FRC intake",
          workspaceRoot: "/managed/project-hash",
          defaultModelSelection: null,
          onshapeSource: { ...source, managedWorkspaceReady: false },
          createdAt: now,
          updatedAt: now,
        },
      });
      const deleted = yield* projectEvent(active, {
        sequence: 2,
        eventId: EventId.make("event-onshape-project-deleted-before-ready"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.deleted",
        occurredAt: now,
        commandId: CommandId.make("project-delete-before-ready"),
        causationEventId: null,
        correlationId: CommandId.make("project-delete-before-ready"),
        metadata: {},
        payload: { projectId, deletedAt: now },
      });

      const readyError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.onshape.workspace.ready",
            commandId: CommandId.make("server:onshape-workspace-ready:after-delete"),
            projectId,
          },
          readModel: deleted,
        }),
      );
      const rebindError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.onshape.connection.set",
            commandId: CommandId.make("server:onshape-project-set-connection:after-delete"),
            projectId,
            connectionId: replacementConnectionId,
          },
          readModel: deleted,
        }),
      );

      assert.include(readyError.message, "is deleted");
      assert.include(rebindError.message, "is deleted");
    }),
  );

  it.effect("rejects client attempts to replace a managed Onshape workspace", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-onshape-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("server:onshape-project-create:1"),
        causationEventId: null,
        correlationId: CommandId.make("server:onshape-project-create:1"),
        metadata: {},
        payload: {
          projectId,
          title: "FRC intake",
          workspaceRoot: "/managed/project-hash",
          defaultModelSelection: null,
          onshapeSource: source,
          createdAt: now,
          updatedAt: now,
        },
      });

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("client-project-meta-update:1"),
            projectId,
            workspaceRoot: "/user/chosen/path",
          },
          readModel: seeded,
        }),
      );

      assert.include(error.message, "server-managed Onshape workspace");
    }),
  );

  it.effect("marks the managed workspace ready before threads can be created", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-onshape-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("server:onshape-project-create:1"),
        causationEventId: null,
        correlationId: CommandId.make("server:onshape-project-create:1"),
        metadata: {},
        payload: {
          projectId,
          title: "FRC intake",
          workspaceRoot: "/managed/project-hash",
          defaultModelSelection: null,
          onshapeSource: { ...source, managedWorkspaceReady: false },
          createdAt: now,
          updatedAt: now,
        },
      });

      const blocked = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make("thread-create-before-workspace-ready"),
            threadId: ThreadId.make("thread-before-workspace-ready"),
            projectId,
            title: "New thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
          readModel: seeded,
        }),
      );
      assert.include(blocked.message, "managed workspace is not ready");

      const readyEvent = eventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.onshape.workspace.ready",
            commandId: CommandId.make("server:onshape-workspace-ready:1"),
            projectId,
          },
          readModel: seeded,
        }),
        "project.meta-updated",
      );
      const ready = yield* projectEvent(seeded, { ...readyEvent, sequence: 2 });
      assert.isTrue(ready.projects[0]?.onshapeSource?.managedWorkspaceReady);
    }),
  );
});
