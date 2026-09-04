// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { assert, it } from "@effect/vitest";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { OnshapeConnections } from "../../onshape/OnshapeConnections.ts";
import * as OnshapeConnectionsLayer from "../../onshape/OnshapeConnections.ts";
import { OnshapeProjects } from "../../onshape/OnshapeProjects.ts";
import * as OnshapeProjectsLayer from "../../onshape/OnshapeProjects.ts";
import * as OnshapeRequestSigner from "../../onshape/OnshapeRequestSigner.ts";
import * as OnshapeTransport from "../../onshape/OnshapeTransport.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ManagedWorkspaceAllocatorLayer from "../../workspace/ManagedWorkspaceAllocator.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OnshapeWorkspaceReactor } from "../Services/OnshapeWorkspaceReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OnshapeWorkspaceReactorLive } from "./OnshapeWorkspaceReactor.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-09-04T00:00:00.000Z";
const projectId = ProjectId.make("onshape-restart-project");
const connectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001");
const source = OnshapeProjectSource.make({
  connectionId,
  host: "https://cad.onshape.com",
  documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
  configuration: "Size=Large",
});

interface ConnectionHarnessState {
  readonly secrets: Map<string, Uint8Array>;
  requests: number;
}

function makeOrchestrationLayer(
  baseDir: string,
  dbPath: string,
  connectionState: ConnectionHarnessState,
) {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  const connectionDependencies = Layer.mergeAll(
    persistence,
    OnshapeRequestSigner.layer,
    Layer.succeed(
      OnshapeTransport.OnshapeTransport,
      OnshapeTransport.OnshapeTransport.of({
        execute: () =>
          Effect.sync(() => {
            connectionState.requests += 1;
            return { status: 200, retryAfter: null };
          }),
      }),
    ),
    Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(connectionState.secrets.get(name))),
        set: (name, value) =>
          Effect.sync(() => connectionState.secrets.set(name, Uint8Array.from(value))),
        create: (name, value) =>
          Effect.sync(() => connectionState.secrets.set(name, Uint8Array.from(value))),
        getOrCreateRandom: () => Effect.die("Unused test service method."),
        remove: (name) => Effect.sync(() => connectionState.secrets.delete(name)),
      }),
    ),
  );
  const connections = OnshapeConnectionsLayer.layer.pipe(Layer.provide(connectionDependencies));
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  const allocator = ManagedWorkspaceAllocatorLayer.layer;
  const workspaceReactor = OnshapeWorkspaceReactorLive.pipe(
    Layer.provideMerge(allocator),
    Layer.provideMerge(orchestration),
  );
  const projects = OnshapeProjectsLayer.layer.pipe(
    Layer.provideMerge(connections),
    Layer.provideMerge(allocator),
    Layer.provideMerge(workspaceReactor),
    Layer.provideMerge(orchestration),
  );
  return projects.pipe(
    Layer.provideMerge(connections),
    Layer.provideMerge(allocator),
    Layer.provideMerge(workspaceReactor),
    Layer.provideMerge(orchestration),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect(
  "restores an Onshape source after its saved connection is removed and the server restarts",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-onshape-restart-")),
      ),
      (baseDir) => {
        const dbPath = NodePath.join(baseDir, "state.sqlite");
        const connectionState: ConnectionHarnessState = { secrets: new Map(), requests: 0 };
        let savedConnectionId = connectionId;
        return Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const context = yield* Layer.build(
              makeOrchestrationLayer(baseDir, dbPath, connectionState),
            );
            yield* Effect.gen(function* () {
              const connections = yield* OnshapeConnections;
              const projects = yield* OnshapeProjects;
              const reactor = yield* OnshapeWorkspaceReactor;
              const query = yield* ProjectionSnapshotQuery;
              yield* reactor.start();

              const saved = yield* connections.create({
                name: "Team CAD",
                host: "cad.onshape.com",
                accessKeyId: "test-access-key",
                secretKey: "test-secret-key",
              });
              savedConnectionId = saved.connectionId;
              yield* projects.create({
                projectId,
                title: "FRC intake",
                connectionId: saved.connectionId,
                url: "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc?configuration=Size%3DLarge",
              });

              const created = (yield* query.getSnapshot()).projects.find(
                (project) => project.id === projectId,
              );
              assert.strictEqual(created?.onshapeSource?.managedWorkspaceReady, true);
              assert.isTrue(NodeFS.existsSync(created?.workspaceRoot ?? ""));

              yield* connections.remove({ connectionId: saved.connectionId });
              assert.deepStrictEqual((yield* connections.list()).connections, []);
              assert.strictEqual(connectionState.requests, 1);
            }).pipe(Effect.provide(context));
          }).pipe(Effect.scoped);

          yield* Effect.gen(function* () {
            const context = yield* Layer.build(
              makeOrchestrationLayer(baseDir, dbPath, connectionState),
            );
            yield* Effect.gen(function* () {
              const connections = yield* OnshapeConnections;
              const projects = yield* OnshapeProjects;
              const reactor = yield* OnshapeWorkspaceReactor;
              const query = yield* ProjectionSnapshotQuery;
              const engine = yield* OrchestrationEngineService;
              yield* reactor.start();

              assert.deepStrictEqual((yield* connections.list()).connections, []);
              const restored = (yield* query.getSnapshot()).projects.find(
                (project) => project.id === projectId,
              );
              assert.deepStrictEqual(restored?.onshapeSource, {
                ...source,
                connectionId: savedConnectionId,
                managedWorkspaceReady: true,
              });
              assert.strictEqual(connectionState.requests, 1);

              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("thread-create-offline-onshape"),
                threadId: ThreadId.make("offline-onshape-thread"),
                projectId,
                title: "Offline work",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.6",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: now,
              });
              assert.strictEqual(connectionState.requests, 1);

              const replacement = yield* connections.create({
                name: "Replacement CAD",
                host: "https://cad.onshape.com",
                accessKeyId: "replacement-access-key",
                secretKey: "replacement-secret-key",
              });
              yield* projects.setConnection({
                projectId,
                connectionId: replacement.connectionId,
              });
              const rebound = (yield* query.getSnapshot()).projects.find(
                (project) => project.id === projectId,
              );
              assert.deepStrictEqual(rebound?.onshapeSource, {
                ...source,
                connectionId: replacement.connectionId,
                managedWorkspaceReady: true,
              });
              assert.strictEqual(connectionState.requests, 2);
            }).pipe(Effect.provide(context));
          }).pipe(Effect.scoped);
        });
      },
      (baseDir) => Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
    ),
);

it.effect("selects only active Onshape projects whose managed workspace is pending", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-onshape-pending-query-")),
    ),
    (baseDir) => {
      const dbPath = NodePath.join(baseDir, "state.sqlite");
      const connectionState: ConnectionHarnessState = { secrets: new Map(), requests: 0 };
      const regularProjectId = ProjectId.make("regular-project");
      const pendingProjectId = ProjectId.make("pending-onshape-project");
      const readyProjectId = ProjectId.make("ready-onshape-project");
      const deletedProjectId = ProjectId.make("deleted-onshape-project");
      return Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeOrchestrationLayer(baseDir, dbPath, connectionState),
          );
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;

            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("project-create-regular-pending-query"),
              projectId: regularProjectId,
              title: "Regular project",
              workspaceRoot: NodePath.join(baseDir, "regular"),
              defaultModelSelection: null,
              createdAt: now,
            });

            const createOnshape = (input: {
              readonly projectId: ProjectId;
              readonly documentId: OnshapeDocumentId;
            }) =>
              engine.dispatch({
                type: "project.onshape.create",
                commandId: CommandId.make(`server:onshape-project-create:${input.projectId}`),
                projectId: input.projectId,
                title: input.projectId,
                workspaceRoot: NodePath.join(baseDir, `managed-${input.projectId}`),
                defaultModelSelection: null,
                onshapeSource: { ...source, documentId: input.documentId },
                createdAt: now,
              });

            yield* createOnshape({
              projectId: pendingProjectId,
              documentId: OnshapeDocumentId.make("111111111111111111111111"),
            });
            yield* createOnshape({
              projectId: readyProjectId,
              documentId: OnshapeDocumentId.make("222222222222222222222222"),
            });
            yield* engine.dispatch({
              type: "project.onshape.workspace.ready",
              commandId: CommandId.make("server:onshape-workspace-ready:pending-query"),
              projectId: readyProjectId,
            });
            yield* createOnshape({
              projectId: deletedProjectId,
              documentId: OnshapeDocumentId.make("333333333333333333333333"),
            });
            yield* engine.dispatch({
              type: "project.delete",
              commandId: CommandId.make("project-delete-onshape-pending-query"),
              projectId: deletedProjectId,
            });

            const pending = yield* query.listPendingOnshapeProjects();
            assert.deepStrictEqual(
              pending.map((project) => project.id),
              [pendingProjectId],
            );
            assert.strictEqual(connectionState.requests, 0);
          }).pipe(Effect.provide(context));
        }),
      );
    },
    (baseDir) => Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
  ),
);
