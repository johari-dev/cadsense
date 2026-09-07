import {
  CadViewError,
  CadViewState,
  CadUpdateViewInput,
  CadCaptureInput,
  CadRenderError,
  CommandId,
  type CadViewerSession,
  type CadContextResult,
  type CadHierarchyResult,
  type CadSnapshotManifest,
  type OrchestrationCommand,
  type ThreadId,
  type TurnId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { CadCaptureArtifacts, type CadCaptureDelivery } from "./CadCaptureArtifacts.ts";
import { findCadSession, readCadSession, readCadUserView } from "./CadSessionPersistence.ts";
import { initialCadView, rebaseCadView, updateCadView, indexCadSnapshot } from "./CadViewState.ts";
import { readCadHierarchy } from "./CadHierarchy.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const unavailable = () => new CadViewError({ reason: "capability-unavailable" });
const conflict = () => new CadViewError({ reason: "revision-conflict" });
const decodeView = Schema.decodeUnknownEffect(CadViewState);
const decodeUpdate = Schema.decodeUnknownEffect(CadUpdateViewInput);
const decodeCapture = Schema.decodeUnknownEffect(CadCaptureInput);
export interface CadAgentTools {
  readonly context: () => Effect.Effect<typeof CadContextResult.Type, CadViewError>;
  readonly hierarchy: (input: unknown) => Effect.Effect<CadHierarchyResult, CadViewError>;
  readonly updateView: (input: unknown) => Effect.Effect<CadViewState, CadViewError>;
  readonly capture: (input: unknown) => Effect.Effect<CadCaptureDelivery, CadViewError>;
}
export interface CadViewingShape {
  /** childKey is issued by the trusted app adapter, never a model-authored argument. */
  readonly resolveContext: (
    threadId: ThreadId,
    childKey?: string,
  ) => Effect.Effect<string, CadViewError>;
  /** Enclose the trusted native run/child lifetime, not individual tool calls. No CAD is loaded until a tool runs. */
  readonly withActivation: <A, E, R>(
    contextId: string,
    use: (tools: CadAgentTools) => Effect.Effect<A, E, R>,
    turnId?: TurnId,
  ) => Effect.Effect<A, E | CadViewError, R>;
  readonly saveUserView: (
    threadId: ThreadId,
    expectedRevision: number | null,
    view: unknown,
  ) => Effect.Effect<CadViewState, CadViewError>;
  readonly getUserView: (threadId: ThreadId) => Effect.Effect<CadViewState | null, CadViewError>;
}
export class CadViewing extends Context.Service<CadViewing, CadViewingShape>()(
  "@cadsense/server/cad/CadViewing",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const store = yield* CadSnapshotStore;
  const crypto = yield* Crypto.Crypto;
  const artifacts = yield* Effect.serviceOption(CadCaptureArtifacts);
  const active = new Set<string>();
  const db = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(unavailable));
  const commandId = crypto.randomUUIDv4.pipe(
    Effect.map(CommandId.make),
    Effect.mapError(unavailable),
  );
  const dispatch = (command: OrchestrationCommand) =>
    engine
      .dispatch(command)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestrationCommandInvariantError" &&
          error.detail === "CAD revision conflict."
            ? conflict()
            : unavailable(),
        ),
      );
  const projectFor = Effect.fn("CadViewing.projectFor")(function* (threadId: ThreadId) {
    const thread = yield* query.getThreadShellById(threadId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(thread)) return yield* unavailable();
    const project = yield* query
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(project) ||
      !project.value.onshapeSource ||
      project.value.cad?.enabled === false ||
      project.value.cad?.operation
    )
      return yield* unavailable();
    return project.value;
  });
  const resolveContext = Effect.fn("CadViewing.resolveContext")(function* (
    threadId: ThreadId,
    childKey?: string,
  ) {
    yield* projectFor(threadId);
    const existing = yield* db(findCadSession(threadId, childKey ?? null));
    if (existing) return existing.contextId;
    const contextId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
    yield* dispatch({
      type: "thread.cad.context.ensure",
      commandId: yield* commandId,
      threadId,
      contextId,
      childKey: childKey ?? null,
    });
    const session = yield* db(findCadSession(threadId, childKey ?? null));
    if (!session) return yield* unavailable();
    return session.contextId;
  });
  const getUserView = (threadId: ThreadId) =>
    db(readCadUserView(threadId)).pipe(Effect.map((row) => row?.view ?? null));
  const saveUserView = Effect.fn("CadViewing.saveUserView")(function* (
    threadId: ThreadId,
    expectedRevision: number | null,
    input: unknown,
  ) {
    const view = yield* decodeView(input).pipe(
      Effect.mapError(() => new CadViewError({ reason: "invalid-operation" })),
    );
    yield* projectFor(threadId);
    yield* store
      .withPinned(view.snapshotId, (snapshot) =>
        Effect.gen(function* () {
          if (snapshot.rootId !== view.rootId) return yield* unavailable();
          const ids = indexCadSnapshot(snapshot).nodes;
          if (
            [
              ...Object.keys(view.visibility),
              ...view.isolatedOccurrenceIds,
              ...(view.camera.fit ?? []),
            ].some((id) => !ids.has(id))
          )
            return yield* new CadViewError({ reason: "invalid-operation" });
          yield* dispatch({
            type: "thread.cad.user-view.set",
            commandId: yield* commandId,
            threadId,
            expectedRevision,
            view,
          });
        }),
      )
      .pipe(Effect.mapError((error) => (error._tag === "CadViewError" ? error : unavailable())));
    return view;
  });
  const withActivation: CadViewingShape["withActivation"] = (contextId, use, turnId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const activationScope = yield* Scope.Scope;
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            if (active.has(contextId)) return yield* unavailable();
            active.add(contextId);
          }),
          () =>
            Effect.sync(() => {
              active.delete(contextId);
            }),
        );
        const session = yield* db(readCadSession(contextId));
        if (!session) return yield* unavailable();
        const fifo = yield* Semaphore.make(1);
        let currentSession: CadViewerSession = session;
        let open = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
          }),
        );
        type Binding = {
          snapshot: CadSnapshotManifest;
          scope: Scope.Closeable;
          readAsset: (sha256: string) => Effect.Effect<Uint8Array, CadRenderError>;
        };
        let binding: Binding | null = null;
        const bind = Effect.fn("CadViewing.bind")(function* (snapshotId: string) {
          if (binding?.snapshot.snapshotId === snapshotId) return binding;
          const scope = yield* Scope.make();
          yield* Scope.addFinalizer(activationScope, Scope.close(scope, Exit.void));
          const ready = yield* Deferred.make<Omit<Binding, "scope">, CadViewError>();
          yield* store
            .withPinned(snapshotId, (snapshot, readAsset) =>
              Deferred.succeed(ready, {
                snapshot,
                readAsset: (hash) =>
                  readAsset(hash).pipe(
                    Effect.mapError(() => new CadRenderError({ reason: "unavailable" })),
                  ),
              }).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(
              Effect.catch(() => Deferred.fail(ready, unavailable())),
              Effect.forkIn(scope),
            );
          const result = yield* Deferred.await(ready).pipe(
            Effect.tapError(() => Scope.close(scope, Exit.void)),
          );
          return { ...result, scope };
        });
        const persist = Effect.fn("CadViewing.persist")(function* (view: CadViewState) {
          yield* dispatch({
            type: "thread.cad.view.set",
            commandId: yield* commandId,
            threadId: session.threadId,
            contextId,
            expectedRevision: currentSession.revision,
            view,
          });
          currentSession = { ...currentSession, revision: view.revision, view };
        });
        const availableRoots = Effect.fn("CadViewing.availableRoots")(function* () {
          const project = yield* projectFor(session.threadId);
          return {
            project,
            roots: project.cad?.roots.filter((root) => root.current !== null) ?? [],
          };
        });
        const initialize = Effect.fn("CadViewing.initialize")(function* () {
          if (!open) return yield* unavailable();
          if (binding && currentSession.view) return { binding, state: currentSession.view };
          const { project, roots } = yield* availableRoots();
          const saved = currentSession.view ?? (yield* getUserView(session.threadId));
          const selected = saved
            ? roots.find((root) => root.rootId === saved.rootId)
            : project.onshapeSource?.elementId
              ? roots.find(
                  (root) =>
                    root.elementId === project.onshapeSource?.elementId &&
                    root.configuration === (project.onshapeSource.configuration ?? "default"),
                )
              : roots.length === 1
                ? roots[0]
                : undefined;
          if (!selected?.current) return null;
          const next = yield* bind(selected.current.snapshotId).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (!next) return null;
          const revision =
            currentSession.revision === null
              ? 0
              : currentSession.view?.snapshotId !== next.snapshot.snapshotId
                ? currentSession.revision + 1
                : currentSession.revision;
          const state = saved
            ? { ...rebaseCadView(saved, next.snapshot), revision }
            : initialCadView(next.snapshot, revision);
          if (!currentSession.view || currentSession.view.snapshotId !== state.snapshotId)
            yield* persist(state);
          binding = next;
          return { binding: next, state };
        });
        const context: CadAgentTools["context"] = () =>
          fifo.withPermits(1)(
            Effect.gen(function* () {
              const initialized = yield* initialize();
              const state = initialized?.state ?? null;
              const { project, roots } = yield* availableRoots();
              return {
                state,
                revision: state?.revision ?? currentSession.revision ?? 0,
                roots: roots.map((root) => ({
                  rootId: root.rootId,
                  kind: root.kind,
                  name:
                    project.cad?.catalog?.roots.find((item) => item.elementId === root.elementId)
                      ?.name ?? (root.kind === "assembly" ? "Assembly" : "Part Studio"),
                })),
              };
            }),
          );
        const hierarchy: CadAgentTools["hierarchy"] = (input) =>
          fifo.withPermits(1)(
            Effect.gen(function* () {
              const initialized = yield* initialize();
              if (!initialized) return yield* unavailable();
              const { binding, state } = initialized;
              return yield* readCadHierarchy(indexCadSnapshot(binding.snapshot), state, input);
            }),
          );
        const updateView: CadAgentTools["updateView"] = (input) =>
          fifo.withPermits(1)(
            Effect.gen(function* () {
              let initialized = yield* initialize();
              const { roots } = yield* availableRoots();
              // Load only roots explicitly requested by the validated batch, never every cached root.
              const update = yield* decodeUpdate(input).pipe(
                Effect.mapError(() => new CadViewError({ reason: "invalid-operation" })),
              );
              if (
                update.expectedRevision !==
                (initialized?.state.revision ?? currentSession.revision ?? 0)
              )
                return yield* conflict();
              const candidates: Binding[] = [];
              const result = yield* Effect.exit(
                Effect.gen(function* () {
                  if (!initialized) {
                    const first = update.operations[0];
                    if (first?.type !== "select-root") return yield* unavailable();
                    const root = roots.find((root) => root.rootId === first.rootId);
                    if (!root?.current) return yield* unavailable();
                    const candidate = yield* bind(root.current.snapshotId);
                    candidates.push(candidate);
                    initialized = {
                      binding: candidate,
                      state: initialCadView(candidate.snapshot, currentSession.revision ?? 0),
                    };
                  }
                  const snapshots = new Map([
                    [initialized.binding.snapshot.rootId, initialized.binding.snapshot],
                  ]);
                  for (const operation of update.operations)
                    if (operation.type === "select-root" && !snapshots.has(operation.rootId)) {
                      const root = roots.find((root) => root.rootId === operation.rootId);
                      if (!root?.current) return yield* unavailable();
                      const candidate = yield* bind(root.current.snapshotId);
                      candidates.push(candidate);
                      snapshots.set(root.rootId, candidate.snapshot);
                    }
                  const state = yield* updateCadView(initialized.state, update, snapshots);
                  yield* persist(state);
                  const next =
                    candidates.find(
                      (candidate) => candidate.snapshot.snapshotId === state.snapshotId,
                    ) ?? initialized.binding;
                  if (next !== initialized.binding)
                    yield* Scope.close(initialized.binding.scope, Exit.void);
                  binding = next;
                  return state;
                }),
              );
              for (const candidate of candidates)
                if (candidate !== binding) yield* Scope.close(candidate.scope, Exit.void);
              return yield* result;
            }),
          );
        const capture: CadAgentTools["capture"] = (input) =>
          fifo.withPermits(1)(
            Effect.gen(function* () {
              const requested = yield* decodeCapture(input).pipe(
                Effect.mapError(() => new CadViewError({ reason: "invalid-operation" })),
              );
              const initialized = yield* initialize();
              if (!initialized || turnId === undefined || Option.isNone(artifacts))
                return yield* unavailable();
              if (initialized.state.revision !== requested.expectedRevision)
                return yield* conflict();
              return yield* artifacts.value.capture({
                sessionId: contextId,
                runId: turnId,
                threadId: session.threadId,
                turnId,
                manifest: initialized.binding.snapshot,
                state: initialized.state,
                readAsset: initialized.binding.readAsset,
              });
            }),
          );
        return yield* use({ context, hierarchy, updateView, capture });
      }),
    );
  return CadViewing.of({ resolveContext, withActivation, saveUserView, getUserView });
});
export const layer = Layer.effect(CadViewing, make);
