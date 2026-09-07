import {
  CadUserOperationError,
  CommandId,
  type CadStorageInput,
  type CadStorageEntry,
  type ProjectId,
  type OrchestrationCommand,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import { CadProjectQuiescence } from "./CadUserOperations.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { CadPanel } from "./CadPanel.ts";

export class CadStorage extends Context.Service<
  CadStorage,
  {
    readonly watch: Stream.Stream<readonly CadStorageEntry[], CadUserOperationError>;
    readonly run: (input: CadStorageInput) => Effect.Effect<void, CadUserOperationError>;
  }
>()("@cadsense/server/cad/CadStorage") {}
const failed = () => new CadUserOperationError({ reason: "operation-failed" });
type Command = {
  [K in OrchestrationCommand["type"]]: Omit<
    Extract<OrchestrationCommand, { type: K }>,
    "commandId"
  >;
}[OrchestrationCommand["type"]];

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const store = yield* CadSnapshotStore;
  const panel = yield* CadPanel;
  const allocator = yield* ManagedWorkspaceAllocator;
  const quiescence = yield* CadProjectQuiescence;
  const crypto = yield* Crypto.Crypto;
  const gate = yield* Semaphore.make(1);
  const read = query.getCommandReadModel().pipe(Effect.mapError(failed));
  const projectFor = Effect.fn("CadStorage.projectFor")(function* (projectId: ProjectId) {
    const model = yield* read;
    const project = model.projects.find(
      (project) => project.id === projectId && project.onshapeSource,
    );
    if (!project) return yield* new CadUserOperationError({ reason: "not-found" });
    return project;
  });
  const dispatch = Effect.fn("CadStorage.dispatch")(function* (command: Command) {
    const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed)));
    yield* engine
      .dispatch({ ...command, commandId })
      .pipe(Effect.mapError(() => new CadUserOperationError({ reason: "busy" })));
  });
  const cleanup = Effect.fn("CadStorage.cleanup")(function* (
    projectId: ProjectId,
    removedAt: string,
  ) {
    const model = yield* read;
    const project = model.projects.find((project) => project.id === projectId);
    const storage = project?.cad?.storage;
    if (!project?.deletedAt || !storage || storage.removedAt !== removedAt) return yield* failed();
    if (!storage.cleanupPending) return;
    yield* panel.releaseProject(projectId);
    if (storage.deleteCad) {
      const stored = yield* store.list().pipe(Effect.mapError(failed));
      const targets = new Set([
        ...stored
          .filter((snapshot) => snapshot.projectId === projectId)
          .map((snapshot) => snapshot.snapshotId),
        ...(project.cad?.roots.flatMap((root) =>
          [root.current?.snapshotId, root.rollback?.snapshotId].filter((id): id is string => !!id),
        ) ?? []),
      ]);
      const protectedIds = model.projects
        .filter((item) => item.id !== projectId)
        .flatMap(
          (item) =>
            item.cad?.roots.flatMap((root) =>
              [root.current?.snapshotId, root.rollback?.snapshotId].filter(
                (id): id is string => !!id,
              ),
            ) ?? [],
        );
      yield* store.remove([...targets], protectedIds).pipe(Effect.mapError(failed));
    }
    if (storage.deleteWorkspace) {
      yield* allocator
        .remove({ projectId, workspaceRoot: project.workspaceRoot })
        .pipe(Effect.mapError(failed));
      yield* sql`DELETE FROM cad_project_memory WHERE project_id=${projectId}`.pipe(
        Effect.mapError(failed),
      );
    }
    yield* dispatch({ type: "project.onshape.cleanup.complete", projectId, removedAt });
  });
  const run = Effect.fn("CadStorage.run")(
    function* (input: CadStorageInput) {
      const project = yield* projectFor(input.projectId);
      if (input.kind === "remove") {
        const operationId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
        yield* dispatch({
          type: "project.cad.operation.reserve",
          projectId: project.id,
          operationId,
          kind: "cleanup",
          root: null,
        });
        yield* quiescence.confirm(project.id).pipe(
          Effect.andThen(
            dispatch({
              type: "project.onshape.remove",
              projectId: project.id,
              operationId,
              deleteCad: input.deleteCad,
              deleteWorkspace: input.deleteWorkspace,
            }),
          ),
          Effect.tapError(() =>
            dispatch({
              type: "project.cad.operation.end",
              projectId: project.id,
              operationId,
              status: "failed",
              reason: "Project removal could not finish. Existing data is unchanged.",
            }).pipe(Effect.ignore),
          ),
        );
        const removed = yield* projectFor(project.id);
        if (removed.cad?.storage)
          yield* cleanup(project.id, removed.cad.storage.removedAt).pipe(
            Effect.catch(() => Effect.logWarning("CAD cleanup pending", { projectId: project.id })),
          );
      } else {
        if (!project.deletedAt || project.cad?.storage?.removedAt !== input.removedAt)
          return yield* failed();
        if (input.kind === "restore") {
          if (project.cad.storage.cleanupPending)
            return yield* new CadUserOperationError({ reason: "busy" });
          yield* allocator
            .provision({ projectId: project.id, workspaceRoot: project.workspaceRoot })
            .pipe(Effect.mapError(failed));
          yield* dispatch({
            type: "project.onshape.restore",
            projectId: project.id,
            removedAt: input.removedAt,
          });
        } else {
          if (input.kind === "cleanup")
            yield* dispatch({
              type: "project.onshape.cleanup.request",
              projectId: project.id,
              removedAt: input.removedAt,
              deleteCad: input.deleteCad,
              deleteWorkspace: input.deleteWorkspace,
            });
          yield* cleanup(project.id, input.removedAt);
        }
      }
    },
    gate.withPermits(1),
    Effect.uninterruptible,
  );
  const list = read.pipe(
    Effect.map((model) =>
      model.projects.flatMap((project) => {
        const storage = project.cad?.storage;
        return project.deletedAt && storage
          ? [
              {
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                ...storage,
                byteLength:
                  project.cad?.roots.reduce(
                    (sum, root) =>
                      sum +
                      (root.current?.assetBytes ?? 0) +
                      (root.current?.manifestBytes ?? 0) +
                      (root.rollback?.assetBytes ?? 0) +
                      (root.rollback?.manifestBytes ?? 0),
                    0,
                  ) ?? 0,
              },
            ]
          : [];
      }),
    ),
  );
  const watch = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* engine.subscribeDomainEvents;
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.type === "project.onshape.storage-set"),
          Stream.mapEffect(() => list),
        ),
      );
    }),
  );
  return CadStorage.of({ run, watch });
});
export const layer = Layer.effect(CadStorage, make);
