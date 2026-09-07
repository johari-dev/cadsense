import {
  CadViewError,
  type CadPanelState,
  type CadPanelSceneTicket,
  type CadSnapshotManifest,
  type ThreadId,
  type ProjectId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { readCadUserView, readLatestCadCapture } from "./CadSessionPersistence.ts";
import { initialCadView, rebaseCadView } from "./CadViewState.ts";
import { CadViewing } from "./CadViewing.ts";

interface Scene {
  readonly cancel: Deferred.Deferred<void>;
  readonly released: Deferred.Deferred<void>;
  readonly ticket: CadPanelSceneTicket;
  readonly manifest: CadSnapshotManifest;
  readonly readAsset: (hash: string) => Effect.Effect<Uint8Array, CadViewError>;
}
export class CadPanel extends Context.Service<
  CadPanel,
  {
    readonly watch: (threadId: ThreadId) => Stream.Stream<CadPanelState, CadViewError>;
    readonly scene: (
      threadId: ThreadId,
      snapshotId: string,
    ) => Stream.Stream<CadPanelSceneTicket, CadViewError>;
    readonly read: (ticket: CadPanelSceneTicket) => Effect.Effect<Scene, CadViewError>;
    readonly releaseProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("@cadsense/server/cad/CadPanel") {}
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });

export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const store = yield* CadSnapshotStore;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const viewing = yield* CadViewing;
  const scenes = new Map<string, Scene>();
  let sceneCount = 0;
  const projectFor = Effect.fn("CadPanel.projectFor")(function* (threadId: ThreadId) {
    const thread = yield* query.getThreadShellById(threadId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(thread)) return yield* unavailable();
    const project = yield* query
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(project) ||
      !project.value.onshapeSource ||
      project.value.cad?.enabled === false
    )
      return yield* unavailable();
    return project.value;
  });
  const state = Effect.fn("CadPanel.state")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Omit<CadPanelState, "agentControlling" | "agentActivityTurnId">,
    CadViewError
  > {
    const project = yield* projectFor(threadId);
    const saved = yield* readCadUserView(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(unavailable),
    );
    const pending = project.cad?.pendingPresentations?.find((item) => item.threadId === threadId);
    const captured = pending
      ? yield* readLatestCadCapture(threadId, pending.turnId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(unavailable),
        )
      : null;
    if (captured && captured.record.capture.captureId === pending?.captureId)
      return {
        threadId,
        userRevision: saved?.view.revision ?? null,
        view: captured.view,
        captureId: pending.captureId,
      };
    const roots = project.cad?.roots.filter((root) => root.current !== null) ?? [];
    const root = saved
      ? roots.find((root) => root.rootId === saved.view.rootId)
      : (roots.find(
          (root) =>
            root.elementId === project.onshapeSource?.elementId &&
            root.configuration === (project.onshapeSource.configuration ?? "default"),
        ) ?? (roots.length === 1 ? roots[0] : undefined));
    let view = saved?.view ?? null;
    if (root?.current && view?.snapshotId !== root.current.snapshotId) {
      view = yield* store
        .withPinned(root.current.snapshotId, (manifest) =>
          Effect.succeed(saved ? rebaseCadView(saved.view, manifest) : initialCadView(manifest)),
        )
        .pipe(Effect.orElseSucceed(() => null));
    } else if (!root) view = null;
    return {
      threadId,
      userRevision: saved?.view.revision ?? null,
      view,
      captureId: null,
      ...(root && !view ? { unavailableRootId: root.rootId } : {}),
    };
  });
  const watch = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* engine.subscribeDomainEvents;
        const project = yield* projectFor(threadId);
        return Stream.concat(
          Stream.fromEffect(state(threadId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (event) =>
                (event.aggregateId === threadId &&
                  (event.type === "thread.cad-user-view-set" ||
                    event.type === "thread.cad-capture-recorded" ||
                    event.type === "thread.cad-presentation-settled")) ||
                (event.aggregateId === project.id && event.type === "project.cad-state-set"),
            ),
            Stream.mapEffect(() => state(threadId)),
          ),
        ).pipe(
          Stream.zipLatestWith(viewing.watchActivity(threadId), (panel, activity) => ({
            ...panel,
            ...activity,
          })),
          Stream.changesWith(
            (left, right) =>
              left.agentControlling === right.agentControlling &&
              left.agentActivityTurnId === right.agentActivityTurnId &&
              left.userRevision === right.userRevision &&
              left.captureId === right.captureId &&
              left.unavailableRootId === right.unavailableRootId &&
              left.view?.snapshotId === right.view?.snapshotId,
          ),
        );
      }),
    );
  const scene = (threadId: ThreadId, snapshotId: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const project = yield* projectFor(threadId);
        const historical = (yield* query
          .getCommandReadModel()
          .pipe(Effect.mapError(unavailable))).cadComments?.some(
          (c) => c.threadId === threadId && c.snapshotId === snapshotId,
        );
        if (
          sceneCount >= 64 ||
          (!historical &&
            !project.cad?.roots.some(
              (root) =>
                root.current?.snapshotId === snapshotId || root.rollback?.snapshotId === snapshotId,
            ))
        )
          return yield* unavailable();
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            sceneCount++;
          }),
          () =>
            Effect.sync(() => {
              sceneCount--;
            }),
        );
        const ticket = {
          sceneId: yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
          token: yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        };
        const ready = yield* Deferred.make<CadPanelSceneTicket, CadViewError>();
        const cancel = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        yield* store
          .withPinned(snapshotId, (manifest, readAsset) =>
            Effect.gen(function* () {
              if (manifest.projectId !== project.id) return yield* unavailable();
              yield* Effect.acquireRelease(
                Effect.sync(() =>
                  scenes.set(ticket.sceneId, {
                    cancel,
                    released,
                    ticket,
                    manifest,
                    readAsset: (hash) => readAsset(hash).pipe(Effect.mapError(unavailable)),
                  }),
                ),
                () =>
                  Effect.sync(() => {
                    scenes.delete(ticket.sceneId);
                  }),
              );
              const currentProject = yield* projectFor(threadId);
              if (currentProject.cad?.operation?.kind === "cleanup") return yield* unavailable();
              yield* Deferred.succeed(ready, ticket);
              return yield* Deferred.await(cancel);
            }),
          )
          .pipe(
            Effect.catch(() => Deferred.fail(ready, unavailable())),
            Effect.ensuring(Deferred.succeed(released, undefined)),
            Effect.forkScoped,
          );
        return Stream.concat(Stream.succeed(yield* Deferred.await(ready)), Stream.never);
      }),
    );
  const read = (ticket: CadPanelSceneTicket) =>
    Effect.gen(function* () {
      const scene = scenes.get(ticket.sceneId);
      if (!scene || scene.ticket.token !== ticket.token) return yield* unavailable();
      return scene;
    });
  const releaseProject = Effect.fn("CadPanel.releaseProject")(function* (projectId: ProjectId) {
    const targets = [...scenes.values()].filter((scene) => scene.manifest.projectId === projectId);
    for (const scene of targets) yield* Deferred.succeed(scene.cancel, undefined);
    for (const scene of targets) yield* Deferred.await(scene.released);
  });
  return CadPanel.of({ watch, scene, read, releaseProject });
});
export const layer = Layer.effect(CadPanel, make);
