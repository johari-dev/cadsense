import {
  CommandId,
  type ModelSelection,
  OnshapeConnectionNotFoundError,
  type OnshapeProjectCreateBaseInput,
  type OnshapeProjectError,
  OnshapeProjectConflictError,
  OnshapeProjectHostMismatchError,
  type OnshapeProjectMutationResult,
  OnshapeProjectNotFoundError,
  type OnshapeProjectOperation,
  OnshapeProjectOperationError,
  type OnshapeProjectSetConnectionInput,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OnshapeWorkspaceReactor } from "../orchestration/Services/OnshapeWorkspaceReactor.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import { OnshapeConnections, type OnshapeConnectionsShape } from "./OnshapeConnections.ts";
import * as OnshapeSourceUrl from "./OnshapeSourceUrl.ts";

export interface OnshapeProjectCreateInput extends OnshapeProjectCreateBaseInput {
  readonly defaultModelSelection?: ModelSelection | null;
}

export interface OnshapeProjectsShape {
  readonly create: (
    input: OnshapeProjectCreateInput,
  ) => Effect.Effect<OnshapeProjectMutationResult, OnshapeProjectError>;
  readonly setConnection: (
    input: OnshapeProjectSetConnectionInput,
  ) => Effect.Effect<OnshapeProjectMutationResult, OnshapeProjectError>;
}

export class OnshapeProjects extends Context.Service<OnshapeProjects, OnshapeProjectsShape>()(
  "@cadsense/server/onshape/OnshapeProjects",
) {}

const operationError = (operation: OnshapeProjectOperation) =>
  new OnshapeProjectOperationError({ operation });

const findConnection = Effect.fn("OnshapeProjects.findConnection")(function* (
  connections: OnshapeConnectionsShape,
  connectionId: OnshapeProjectCreateBaseInput["connectionId"],
  operation: OnshapeProjectOperation,
) {
  const result = yield* connections.list().pipe(Effect.mapError(() => operationError(operation)));
  const connection = result.connections.find((entry) => entry.connectionId === connectionId);
  if (connection === undefined) {
    return yield* new OnshapeConnectionNotFoundError({ connectionId });
  }
  return connection;
});

export const make = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const workspaces = yield* ManagedWorkspaceAllocator;
  const orchestration = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const workspaceReactor = yield* OnshapeWorkspaceReactor;
  const crypto = yield* Crypto.Crypto;

  const nextCommandId = (tag: string, operation: OnshapeProjectOperation) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
      Effect.mapError(() => operationError(operation)),
    );

  const create: OnshapeProjectsShape["create"] = Effect.fn("OnshapeProjects.create")(
    function* (input) {
      const connection = yield* findConnection(connections, input.connectionId, "create");
      const onshapeSource = yield* OnshapeSourceUrl.parse({ url: input.url, connection });
      const workspaceRoot = yield* workspaces.resolve(input.projectId);
      const result = yield* orchestration
        .dispatch({
          type: "project.onshape.create",
          commandId: yield* nextCommandId("onshape-project-create", "create"),
          projectId: input.projectId,
          title: input.title,
          workspaceRoot,
          defaultModelSelection: input.defaultModelSelection ?? null,
          onshapeSource,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestrationCommandInvariantError" &&
            error.detail.includes("Onshape source")
              ? new OnshapeProjectConflictError()
              : operationError("create"),
          ),
        );
      yield* workspaceReactor
        .drainThrough(result.sequence)
        .pipe(Effect.mapError(() => operationError("create")));
      return { projectId: input.projectId };
    },
  );

  const setConnection: OnshapeProjectsShape["setConnection"] = Effect.fn(
    "OnshapeProjects.setConnection",
  )(function* (input) {
    const project = yield* snapshots
      .getProjectShellById(input.projectId)
      .pipe(Effect.mapError(() => operationError("set-connection")));
    if (Option.isNone(project) || project.value.onshapeSource === undefined) {
      return yield* new OnshapeProjectNotFoundError({ projectId: input.projectId });
    }
    const connection = yield* findConnection(connections, input.connectionId, "set-connection");
    if (connection.host !== project.value.onshapeSource.host) {
      return yield* new OnshapeProjectHostMismatchError();
    }
    yield* Effect.uninterruptible(
      orchestration.dispatch({
        type: "project.onshape.connection.set",
        commandId: yield* nextCommandId("onshape-project-set-connection", "set-connection"),
        projectId: input.projectId,
        connectionId: input.connectionId,
      }),
    ).pipe(Effect.mapError(() => operationError("set-connection")));
    return { projectId: input.projectId };
  });

  return OnshapeProjects.of({ create, setConnection });
});

export const layer = Layer.effect(OnshapeProjects, make);
