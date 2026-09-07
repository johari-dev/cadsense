import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CadSnapshotManifest,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CadSnapshotStore, CadSnapshotStoreError } from "./CadSnapshotStore.ts";
import { initialCadView } from "./CadViewState.ts";
import { CadViewing, make } from "./CadViewing.ts";
import { makeCadProviderTools } from "../provider/CadProviderTools.ts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, EnvironmentId } from "@cadsense/contracts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ClaudeCadCapabilities from "../provider/ClaudeCadCapabilities.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { CadRenderBroker, type CadRenderRequest } from "./CadRenderBroker.ts";
import { CadCaptureArtifacts, make as makeArtifacts } from "./CadCaptureArtifacts.ts";
import { readLatestCadCapture, readCadUserView } from "./CadSessionPersistence.ts";
import { make as makePresentation } from "./CadPresentation.ts";
import { make as makePanel } from "./CadPanel.ts";
import { CadPanel } from "./CadPanel.ts";
import { make as makeStorage } from "./CadStorage.ts";
import { CadProjectQuiescence } from "./CadUserOperations.ts";
import { CadUserOperationError } from "@cadsense/contracts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Option from "effect/Option";
import { make as makeRenderBroker } from "./CadRenderBroker.ts";
import { releaseCompletedCadRuns } from "./CadRenderLifecycle.ts";

const now = "2026-09-05T00:00:00Z";
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
it.effect(
  "recalls project facts in a fresh thread and withholds obsolete component bindings after sync",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
      VALUES('memory-source',${threadId},NULL,'user','We call this assembly the carriage.',0,${now},${now})`;
      const contextId = yield* h.service.resolveContext(threadId);
      yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          const context = yield* tools.context();
          assert.deepEqual(context.overview, { occurrences: 1, parts: 0, assemblies: 1 });
          const found = yield* tools.search({ query: "intake" });
          const target = {
            rootId: snapshot.rootId,
            snapshotId: found.snapshotId,
            occurrenceId: found.entries[0]!.occurrenceId,
          };
          const input = {
            key: "carriage",
            quote: "We call this assembly the carriage.",
            expectedRevision: 0,
            change: { type: "remember", kind: "name", target },
          };
          assert.equal(
            (yield* tools
              .memory({
                ...input,
                change: { ...input.change, target: { ...target, occurrenceId: "f".repeat(64) } },
              })
              .pipe(Effect.flip)).reason,
            "invalid-operation",
          );
          const saved = yield* tools.memory(input);
          assert.equal(saved.entries[0]?.targetStatus, "current");
          yield* tools.updateView({
            expectedRevision: context.revision,
            operations: [{ type: "explode", amount: 0.5 }],
          });
          assert.equal((yield* tools.context()).memory.entries[0]?.targetStatus, "current");
        }),
      );
      const recreated = yield* h.recreate;
      const brief = yield* recreated.projectBrief(otherThreadId);
      assert.include(brief, "We call this assembly the carriage.");
      assert.notInclude(brief, snapshot.nodes[0]!.id);
      assert.equal(h.pins(), 0);
      const fresh = yield* recreated.resolveContext(otherThreadId);
      yield* recreated.withActivation(fresh, (tools) =>
        Effect.gen(function* () {
          const context = yield* tools.context();
          assert.equal(context.memory.entries[0]?.targetStatus, "current");
          assert.equal(context.memory.entries[0]?.sourceThreadId, threadId);
        }),
      );
      const next = {
        ...snapshot,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        root: { ...snapshot.root, microversionId: OnshapeWorkspaceId.make("e".repeat(24)) },
      };
      h.snapshots.set(next.snapshotId, next);
      const operationId = "00000000-0000-4000-8000-000000000098";
      yield* h.dispatch({
        type: "project.cad.operation.reserve",
        projectId,
        operationId,
        kind: "sync",
        root: {
          rootId: snapshot.rootId,
          elementId: snapshot.root.elementId,
          kind: "assembly",
          configuration: "default",
        },
      });
      yield* h.dispatch({
        type: "project.cad.operation.complete",
        projectId,
        operationId,
        result: {
          kind: "sync",
          snapshot: {
            snapshotId: next.snapshotId,
            microversionId: next.root.microversionId,
            createdAt: now,
            manifestBytes: 1,
            assetBytes: 0,
          },
        },
      });
      yield* recreated.withActivation(fresh, (tools) =>
        Effect.gen(function* () {
          const context = yield* tools.context();
          assert.equal(context.state?.snapshotId, next.snapshotId);
          assert.equal(context.memory.entries[0]?.quote, "We call this assembly the carriage.");
          assert.equal(context.memory.entries[0]?.targetStatus, "stale");
          assert.equal(context.memory.entries[0]?.targetName, "Intake");
          assert.isNull(context.memory.entries[0]?.target);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
it.effect(
  "returns a fitted capture pose that the agent can recenter and zoom without changing angle",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("custom-camera");
      yield* h.service.withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            const initial = yield* tools.context();
            const first = yield* tools.capture({ expectedRevision: initial.revision });
            assert.deepEqual(first.result.cameraPose, {
              position: [1, 1, 1],
              target: [0, 0, 0],
              up: [0, 0, 1],
              projection: "perspective",
              zoom: 1,
            });
            assert.equal((yield* tools.context()).revision, initial.revision);
            const pose: typeof first.result.cameraPose = {
              ...first.result.cameraPose,
              position: [1.2, 0.9, 1.05],
              target: [0.2, -0.1, 0.05],
              zoom: first.result.cameraPose.zoom * 2,
            };
            const updated = yield* tools.updateView({
              expectedRevision: initial.revision,
              operations: [{ type: "camera-pose", pose }],
            });
            assert.deepEqual(updated.camera, { kind: "pose", pose, fit: null });
            const second = yield* tools.capture({ expectedRevision: updated.revision });
            assert.deepEqual(second.result.cameraPose, pose);
            assert.deepEqual(h.renderRequests.at(-1)?.state.camera, updated.camera);
            const saved = yield* readLatestCadCapture(threadId, turnId);
            assert.deepEqual(saved?.record.cameraPose, second.result.cameraPose);
            assert.deepEqual(saved?.view.camera, updated.camera);
          }),
        turnId,
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("cancels a native in-flight capture before releasing its snapshot pin", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const h = yield* harness(false, false, false, { started, release });
    const tools = yield* makeCadProviderTools(threadId).pipe(
      Effect.provideService(CadViewing, h.service),
    );
    const turnId = TurnId.make("interrupted-native-capture");
    yield* tools.invoke(null, turnId, "cad_context", {});
    const capture = yield* tools
      .invoke(null, turnId, "cad_capture", { expectedRevision: 0 })
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    assert.equal(h.pins(), 1);
    yield* tools.end(null, turnId);
    assert.equal((yield* Fiber.join(capture))._tag, "Failure");
    assert.equal(h.pins(), 0);
    assert.isNull(yield* readLatestCadCapture(threadId, turnId));
    assert.equal(
      (yield* tools.invoke(null, turnId, "cad_context", {}).pipe(Effect.exit))._tag,
      "Failure",
    );
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
it.effect(
  "binds two Claude SDK agent identities through one-use capabilities without approval prompts",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const capabilities = yield* ClaudeCadCapabilities.ClaudeCadCapabilities;
      const providerSessionId = "claude-cad-session";
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("cad-test"),
            threadId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerSessionId,
            endpoint: "http://localhost/mcp",
            authorizationHeader: "Bearer test-only",
          }),
        ),
        () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      let sdkOptions: ClaudeOptions | undefined;
      const stopped = Promise.withResolvers<void>();
      const adapter = yield* makeClaudeAdapter(claudeSettings, {
        modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
        createQuery: ({ options }) => {
          sdkOptions = options;
          return {
            setModel: async () => {},
            setPermissionMode: async () => {},
            setMaxThinkingTokens: async () => {},
            close: () => stopped.resolve(),
            [Symbol.asyncIterator]: () => ({
              next: async (): Promise<IteratorResult<SDKMessage>> => {
                await stopped.promise;
                return { done: true, value: undefined };
              },
            }),
          };
        },
      }).pipe(Effect.provideService(CadViewing, h.service));
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "look at CAD" });
      assert.ok(sdkOptions?.canUseTool);
      const canUseTool = sdkOptions!.canUseTool!;
      const permit = (agentID: string, tool: string, input: Record<string, unknown>) =>
        Effect.promise(() =>
          canUseTool(`mcp__cadsense_cad__${tool}`, input, {
            signal: new AbortController().signal,
            toolUseID: `${agentID}-${tool}`,
            agentID,
          }),
        );
      const permits = yield* Effect.all(
        ["child-a", "child-b"].map((id) => permit(id, "cad_context", { agentID: "forged" })),
        { concurrency: "unbounded" },
      );
      const tokens: string[] = [];
      for (const permission of permits) {
        assert.equal(permission.behavior, "allow");
        if (permission.behavior !== "allow") return yield* Effect.die("CAD permission denied");
        const token = permission.updatedInput?.[ClaudeCadCapabilities.CLAUDE_CAD_CAPABILITY_FIELD];
        assert.isString(token);
        tokens.push(String(token));
      }
      assert.notEqual(tokens[0], tokens[1]);
      yield* Effect.all(
        tokens.map((token) => capabilities.consume(providerSessionId, token, "cad_context")),
        { concurrency: "unbounded" },
      );
      assert.equal(h.pins(), 2);
      const contexts =
        (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).cadSessions ?? [];
      assert.deepEqual(
        new Set(contexts.map((context) => context.childKey)),
        new Set(["claude:child-a", "claude:child-b"]),
      );
      yield* capabilities.consume(providerSessionId, tokens[0]!, "cad_context").pipe(Effect.flip);
      const late = yield* permit("child-a", "cad_capture", { expectedRevision: 0 });
      assert.equal(late.behavior, "allow");
      yield* adapter.stopSession(threadId);
      assert.equal(h.pins(), 0);
      assert.isFalse(yield* capabilities.available(providerSessionId));
      assert.deepEqual(sdkOptions!.settings, { permissions: { ask: ["mcp__cadsense_cad__*"] } });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          dependencies,
          ServerSettingsService.layerTest(),
          ClaudeCadCapabilities.layer.pipe(Layer.provide(NodeServices.layer)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
it.effect(
  "binds concurrent provider children to private viewers and revokes native session tools",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const scope = yield* Scope.make();
      const tools = yield* makeCadProviderTools(threadId).pipe(
        Effect.provideService(CadViewing, h.service),
        Effect.provideService(Scope.Scope, scope),
      );
      const turnId = TurnId.make("native-parent-turn");
      yield* Effect.all(
        [null, "child-a", "child-b"].map((key) => tools.invoke(key, turnId, "cad_context", {})),
        { concurrency: "unbounded" },
      );
      assert.equal(h.pins(), 3);
      yield* tools.invoke("child-a", turnId, "cad_update_view", {
        expectedRevision: 0,
        operations: [{ type: "explode", amount: 0.8 }],
        childKey: "child-b",
      });
      const untouched = yield* tools.invoke("child-b", turnId, "cad_capture", {
        expectedRevision: 0,
      });
      assert.isDefined(untouched.png);
      assert.equal(h.renderRequests[0]?.state.explosion, 0);
      yield* tools.end("child-a", TurnId.make("wrong-turn"));
      assert.equal(h.pins(), 3);
      yield* tools.end("child-a", turnId);
      assert.equal(h.pins(), 2);
      yield* tools.invoke(null, turnId, "cad_sync", {}).pipe(Effect.flip);
      yield* Scope.close(scope, Exit.void);
      assert.equal(h.pins(), 0);
      assert.equal(
        (yield* tools.invoke(null, turnId, "cad_context", {}).pipe(Effect.flip)).reason,
        "capability-unavailable",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
const decodeSnapshot = Schema.decodeUnknownEffect(CadSnapshotManifest);
const projectId = ProjectId.make("cad-viewing-project");
const threadId = ThreadId.make("cad-viewing-thread");
const otherThreadId = ThreadId.make("cad-other-thread");
const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  workspaceType: "m",
  workspaceId: "b".repeat(24),
  configuration: "default",
});
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000002",
  rootId: "1".repeat(64),
  projectId,
  createdAt: now,
  root: {
    host: source.host,
    documentId: source.documentId,
    elementId: "c".repeat(24),
    kind: "assembly",
    originalRevision: { kind: "m", id: source.workspaceId },
    microversionId: source.workspaceId,
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [
    {
      id: "2".repeat(64),
      parentId: null,
      occurrencePath: [],
      instanceId: null,
      name: "Intake",
      kind: "assembly",
      suppressed: false,
      defaultVisible: true,
      sourcePartKey: null,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  parts: [],
  assets: [],
  dependencies: [],
});
const dependencies = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-cad-viewing-" })),
  Layer.provideMerge(NodeServices.layer),
);
const unused = () => Effect.die("Unexpected store operation");
type TestCommand = {
  [K in OrchestrationCommand["type"]]: Omit<
    Extract<OrchestrationCommand, { type: K }>,
    "commandId"
  >;
}[OrchestrationCommand["type"]];
const harness = Effect.fn(function* (
  multiple = false,
  advanceDuringCapture = false,
  loseCaptureReceipt = false,
  renderGate?: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
) {
  const engine = yield* OrchestrationEngineService;
  let sequence = 0;
  const dispatch = (command: TestCommand) =>
    engine.dispatch({ ...command, commandId: CommandId.make(`cad-view-test-${++sequence}`) });
  yield* dispatch({
    type: "project.onshape.create",
    projectId,
    title: "CAD",
    workspaceRoot: "C:/cad-view-test",
    defaultModelSelection: null,
    onshapeSource: source,
    createdAt: now,
  });
  yield* dispatch({ type: "project.onshape.workspace.ready", projectId });
  for (const id of [threadId, otherThreadId])
    yield* dispatch({
      type: "thread.create",
      projectId,
      threadId: id,
      title: "CAD",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });
  const snapshots = new Map([[snapshot.snapshotId, snapshot]]);
  for (let index = 0; index < (multiple ? 2 : 1); index++) {
    const manifest =
      index === 0
        ? snapshot
        : yield* decodeSnapshot({
            ...snapshot,
            snapshotId: "00000000-0000-4000-8000-000000000003",
            rootId: "3".repeat(64),
            root: { ...snapshot.root, elementId: "d".repeat(24) },
          });
    snapshots.set(manifest.snapshotId, manifest);
    const operationId = `00000000-0000-4000-8000-00000000000${index + 4}`;
    yield* dispatch({
      type: "project.cad.operation.reserve",
      projectId,
      operationId,
      kind: "sync",
      root: {
        rootId: manifest.rootId,
        elementId: manifest.root.elementId,
        kind: manifest.root.kind,
        configuration: "default",
      },
    });
    yield* dispatch({
      type: "project.cad.operation.complete",
      projectId,
      operationId,
      result: {
        kind: "sync",
        snapshot: {
          snapshotId: manifest.snapshotId,
          microversionId: source.workspaceId,
          createdAt: now,
          manifestBytes: 1,
          assetBytes: 0,
        },
      },
    });
  }
  let pins = 0;
  const store = CadSnapshotStore.of({
    checkReserve: unused,
    findGeometry: unused,
    putAsset: unused,
    publish: unused,
    load: unused,
    readAsset: unused,
    list: unused,
    remove: unused,
    withAcquisition: (effect) => effect,
    withPinned: (id, use) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = snapshots.get(id);
          if (!manifest) return yield* new CadSnapshotStoreError({ reason: "unavailable" });
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              pins++;
            }),
            () =>
              Effect.sync(() => {
                pins--;
              }),
          );
          return yield* use(manifest, unused);
        }),
      ),
  });
  const renderRequests: CadRenderRequest[] = [];
  const renderedBytes = new Uint8Array([1, 2, 3]);
  const artifacts = yield* makeArtifacts.pipe(
    Effect.provideService(OrchestrationEngineService, {
      ...engine,
      dispatch: (command, options) =>
        engine.dispatch(command, options).pipe(
          Effect.flatMap((receipt) =>
            loseCaptureReceipt && command.type === "thread.cad.capture.record"
              ? Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "Test receipt failure after commit",
                  }),
                )
              : Effect.succeed(receipt),
          ),
        ),
    }),
    Effect.provideService(
      CadRenderBroker,
      CadRenderBroker.of({
        runsForThread: () => Effect.succeed([]),
        endRun: () => Effect.void,
        connect: () => Stream.empty,
        readJob: unused,
        readAsset: unused,
        complete: unused,
        fail: unused,
        capture: (input) =>
          Effect.gen(function* () {
            renderRequests.push(input);
            if (renderGate) {
              yield* Deferred.succeed(renderGate.started, undefined);
              yield* Deferred.await(renderGate.release);
            }
            if (advanceDuringCapture)
              yield* dispatch({
                type: "thread.cad.view.set",
                threadId,
                contextId: input.sessionId,
                expectedRevision: input.state.revision,
                view: { ...input.state, revision: input.state.revision + 1 },
              }).pipe(Effect.orDie);
            return {
              png: renderedBytes,
              receipt: {
                snapshotId: input.state.snapshotId,
                revision: input.state.revision,
                pose:
                  input.state.camera.kind === "pose" && input.state.camera.fit === null
                    ? input.state.camera.pose
                    : {
                        position: [1, 1, 1] as const,
                        target: [0, 0, 0] as const,
                        up: [0, 0, 1] as const,
                        projection: "perspective" as const,
                        zoom: 1,
                      },
              },
            };
          }),
      }),
    ),
  );
  const service = yield* make.pipe(
    Effect.provideService(CadSnapshotStore, store),
    Effect.provideService(CadCaptureArtifacts, artifacts),
  );
  const presentation = yield* makePresentation.pipe(Effect.provideService(CadSnapshotStore, store));
  return {
    service,
    panel: yield* makePanel.pipe(
      Effect.provideService(CadSnapshotStore, store),
      Effect.provideService(CadViewing, service),
    ),
    recreate: make.pipe(Effect.provideService(CadSnapshotStore, store)),
    pins: () => pins,
    dispatch,
    renderRequests,
    renderedBytes,
    presentation,
    recreatePresentation: makePresentation.pipe(Effect.provideService(CadSnapshotStore, store)),
    snapshots,
    store,
  };
});

const storageHarness = Effect.fn(function* () {
  const h = yield* harness();
  const failures = { cleanup: false, quiescence: false };
  const removedWorkspaces: string[] = [];
  const storage = yield* makeStorage.pipe(
    Effect.provideService(CadPanel, h.panel),
    Effect.provideService(CadProjectQuiescence, {
      confirm: () =>
        failures.quiescence
          ? Effect.fail(new CadUserOperationError({ reason: "busy" }))
          : Effect.void,
    }),
    Effect.provideService(ManagedWorkspaceAllocator, {
      resolve: () => Effect.succeed("C:/cad-view-test"),
      provision: () => Effect.void,
      remove: (input) =>
        Effect.sync(() => {
          removedWorkspaces.push(input.workspaceRoot);
        }),
    }),
    Effect.provideService(CadSnapshotStore, {
      ...h.store,
      list: () =>
        Effect.succeed(
          [...h.snapshots.values()].map((snapshot) => ({ ...snapshot, byteLength: 1 })),
        ),
      remove: (ids) =>
        Effect.gen(function* () {
          if (failures.cleanup || h.pins() > 0)
            return yield* new CadSnapshotStoreError({ reason: "busy" });
          for (const id of ids) h.snapshots.delete(id);
        }),
    }),
  );
  return { ...h, storage, failures, removedWorkspaces };
});

it.effect("keeps native descendant rendering alive until the thread becomes quiescent", () =>
  Effect.gen(function* () {
    yield* harness();
    const broker = yield* makeRenderBroker;
    const events = yield* Queue.unbounded<import("@cadsense/contracts").CadRenderEvent>();
    yield* broker.connect().pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    yield* Queue.take(events);
    const capture = yield* broker
      .capture({
        threadId,
        sessionId: "child",
        runId: "parent-turn",
        manifest: snapshot,
        state: initialCadView(snapshot),
        readAsset: unused,
      })
      .pipe(Effect.flip, Effect.forkChild);
    assert.equal((yield* Queue.take(events)).type, "capture");
    const query = yield* ProjectionSnapshotQuery;
    yield* releaseCompletedCadRuns(threadId).pipe(
      Effect.provideService(CadRenderBroker, broker),
      Effect.provideService(ProjectionSnapshotQuery, {
        ...query,
        getThreadShellById: (id) =>
          query
            .getThreadShellById(id)
            .pipe(
              Effect.map(
                Option.map((thread) => ({ ...thread, backgroundLiveness: "working" as const })),
              ),
            ),
      }),
    );
    assert.deepEqual(yield* broker.runsForThread(threadId), ["parent-turn"]);
    yield* releaseCompletedCadRuns(threadId).pipe(Effect.provideService(CadRenderBroker, broker));
    assert.equal((yield* Fiber.join(capture)).reason, "interrupted");
    assert.deepEqual(yield* broker.runsForThread(threadId), []);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("marks only the selected missing root unavailable in the panel", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.snapshots.delete(snapshot.snapshotId);
    const state = yield* h.panel.watch(threadId).pipe(Stream.runHead);
    assert.equal(state._tag, "Some");
    if (state._tag !== "Some") return yield* Effect.die("Missing panel state");
    assert.isNull(state.value.view);
    assert.equal(state.value.unavailableRootId, snapshot.rootId);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("keeps healthy roots usable when a selected snapshot disappears between runs", () =>
  Effect.gen(function* () {
    const h = yield* harness(true);
    const contextId = yield* h.service.resolveContext(threadId);
    yield* h.service.withActivation(contextId, (tools) =>
      tools.updateView({
        expectedRevision: 0,
        operations: [{ type: "select-root", rootId: snapshot.rootId }],
      }),
    );
    h.snapshots.delete(snapshot.snapshotId);
    yield* h.service.withActivation(contextId, (tools) =>
      Effect.gen(function* () {
        const context = yield* tools.context();
        assert.isNull(context.state);
        assert.equal(context.revision, 1);
        assert.lengthOf(context.roots, 2);
        assert.equal(
          (yield* tools.hierarchy({}).pipe(Effect.flip)).reason,
          "capability-unavailable",
        );
        const next = yield* tools.updateView({
          expectedRevision: context.revision,
          operations: [{ type: "select-root", rootId: "3".repeat(64) }],
        });
        assert.equal(next.revision, 2);
        assert.equal(next.rootId, "3".repeat(64));
        assert.equal((yield* tools.context()).state?.rootId, next.rootId);
      }),
    );
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("retains and restores Onshape projects without deleting threads or downloaded CAD", () =>
  Effect.gen(function* () {
    const h = yield* storageHarness();
    yield* h.storage.run({ kind: "remove", projectId, deleteCad: false, deleteWorkspace: false });
    const retained = yield* h.storage.watch.pipe(Stream.runHead);
    assert.equal(retained._tag, "Some");
    if (retained._tag !== "Some") return yield* Effect.die("Missing retained project");
    const entry = retained.value[0]!;
    assert.isFalse(entry.cleanupPending);
    assert.equal(h.snapshots.size, 1);
    const query = yield* ProjectionSnapshotQuery;
    assert.equal((yield* query.getThreadDetailById(threadId))._tag, "Some");
    yield* h.storage.run({ kind: "restore", projectId, removedAt: entry.removedAt });
    assert.equal((yield* query.getProjectShellById(projectId))._tag, "Some");
    assert.deepEqual(h.removedWorkspaces, []);
    assert.equal(
      (yield* h.storage
        .run({ kind: "retry", projectId, removedAt: entry.removedAt })
        .pipe(Effect.exit))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "releases visible scene pins before optional CAD cleanup and preserves capture images",
  () =>
    Effect.gen(function* () {
      const h = yield* storageHarness();
      const context = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("retained-capture");
      yield* h.service.withActivation(
        context,
        (tools) => tools.context().pipe(Effect.andThen(tools.capture({ expectedRevision: 0 }))),
        turnId,
      );
      assert.equal(
        (yield* h.storage
          .run({ kind: "remove", projectId, deleteCad: true, deleteWorkspace: true })
          .pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.equal(h.snapshots.size, 1);
      assert.deepEqual(h.removedWorkspaces, []);
      yield* h.presentation.settle(threadId);
      const capture = yield* readLatestCadCapture(threadId, turnId);
      const ready = yield* Deferred.make<void>();
      yield* h.panel.scene(threadId, snapshot.snapshotId).pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      assert.equal(h.pins(), 1);
      yield* h.storage.run({ kind: "remove", projectId, deleteCad: true, deleteWorkspace: false });
      assert.equal(h.pins(), 0);
      assert.equal(h.snapshots.size, 0);
      assert.deepEqual(h.removedWorkspaces, []);
      assert.isTrue(
        yield* (yield* FileSystem.FileSystem).exists(capture!.record.capture.artifact.path),
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "keeps failed cleanup durable and retryable, and refuses removal when native shutdown is unconfirmed",
  () =>
    Effect.gen(function* () {
      const h = yield* storageHarness();
      h.failures.quiescence = true;
      assert.equal(
        (yield* h.storage
          .run({ kind: "remove", projectId, deleteCad: true, deleteWorkspace: true })
          .pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.equal(
        (yield* (yield* ProjectionSnapshotQuery).getProjectShellById(projectId))._tag,
        "Some",
      );
      h.failures.quiescence = false;
      h.failures.cleanup = true;
      yield* h.storage.run({ kind: "remove", projectId, deleteCad: true, deleteWorkspace: true });
      const retained = yield* h.storage.watch.pipe(Stream.runHead);
      if (retained._tag !== "Some") return yield* Effect.die("Missing retained project");
      const entry = retained.value[0]!;
      assert.isTrue(entry.cleanupPending);
      assert.equal(
        (yield* h.storage
          .run({ kind: "restore", projectId, removedAt: entry.removedAt })
          .pipe(Effect.exit))._tag,
        "Failure",
      );
      h.failures.cleanup = false;
      yield* h.storage.run({ kind: "retry", projectId, removedAt: entry.removedAt });
      assert.deepEqual(h.removedWorkspaces, ["C:/cad-view-test"]);
      yield* h.storage.run({ kind: "restore", projectId, removedAt: entry.removedAt });
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("exposes actual CAD tool activity without marking an idle activation active", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const h = yield* harness(false, false, false, { started, release });
    const contextId = yield* h.service.resolveContext(threadId);
    const turnId = TurnId.make("cad-panel-activity");
    const read = () =>
      h.panel.watch(threadId).pipe(
        Stream.runHead,
        Effect.map((result) => {
          if (result._tag !== "Some") throw new Error("Missing panel state");
          return result.value;
        }),
      );
    const activation = yield* h.service
      .withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            assert.isFalse((yield* read()).agentControlling);
            yield* tools.capture({ expectedRevision: 0 });
          }),
        turnId,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const active = yield* read();
    assert.isTrue(active.agentControlling);
    assert.equal(active.agentActivityTurnId, turnId);
    yield* Fiber.interrupt(activation);
    const idle = yield* read();
    assert.isFalse(idle.agentControlling);
    assert.equal(idle.agentActivityTurnId, turnId);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "shows only captured private edits in the owning thread and preserves the final view",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const read = (id: ThreadId) =>
        h.panel.watch(id).pipe(
          Stream.runHead,
          Effect.map((result) => {
            assert.equal(result._tag, "Some");
            if (result._tag !== "Some") throw new Error("Missing panel state");
            return result.value;
          }),
        );
      yield* h.service.saveUserView(threadId, null, {
        ...initialCadView(snapshot),
        explosion: 0.2,
      });
      yield* h.service.saveUserView(otherThreadId, null, {
        ...initialCadView(snapshot),
        explosion: 0.8,
      });
      const contextId = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("panel-captured-view");
      yield* h.service.withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            const initial = yield* tools.context();
            yield* tools.updateView({
              expectedRevision: initial.revision,
              operations: [{ type: "explode", amount: 0.4 }],
            });
            assert.equal((yield* read(threadId)).view?.explosion, 0.2);
            yield* tools.capture({ expectedRevision: initial.revision + 1 });
            const presented = yield* read(threadId);
            assert.equal(presented.view?.explosion, 0.4);
            assert.isNotNull(presented.captureId);
            assert.equal(presented.userRevision, 0);
            yield* tools.updateView({
              expectedRevision: initial.revision + 1,
              operations: [{ type: "explode", amount: 0.6 }],
            });
            assert.equal((yield* read(threadId)).view?.explosion, 0.4);
            const other = yield* read(otherThreadId);
            assert.equal(other.view?.explosion, 0.8);
            assert.isNull(other.captureId);
          }),
        turnId,
      );
      assert.isTrue(yield* h.presentation.settle(threadId));
      const final = yield* read(threadId);
      assert.equal(final.view?.explosion, 0.4);
      assert.isNull(final.captureId);
      assert.equal(final.userRevision, 1);
      const thread = yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(threadId);
      assert.equal(thread._tag, "Some");
      if (thread._tag === "Some") {
        const cards = thread.value.activities.filter(
          (activity) => activity.kind === "cad.captured",
        );
        assert.equal(cards.length, 1);
        const capture = yield* readLatestCadCapture(threadId, turnId);
        assert.deepEqual(cards[0]?.payload, {
          captureId: capture!.record.capture.captureId,
          snapshotId: snapshot.snapshotId,
          revision: capture!.record.capture.revision,
        });
        assert.equal(cards[0]?.turnId, turnId);
      }
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("leases panel geometry only while its thread-scoped stream remains open", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const initial = yield* h.panel.watch(threadId).pipe(Stream.runHead);
    assert.equal(initial._tag, "Some");
    if (initial._tag !== "Some" || !initial.value.view)
      return yield* Effect.die("Missing default CAD view");
    assert.isNull(initial.value.userRevision);
    assert.isNull(initial.value.captureId);
    const ready = yield* Deferred.make<import("@cadsense/contracts").CadPanelSceneTicket>();
    const stream = yield* h.panel.scene(threadId, initial.value.view.snapshotId).pipe(
      Stream.tap((ticket) => Deferred.succeed(ready, ticket)),
      Stream.runDrain,
      Effect.forkChild,
    );
    const ticket = yield* Deferred.await(ready);
    assert.equal(h.pins(), 1);
    assert.equal((yield* h.panel.read(ticket)).manifest.snapshotId, initial.value.view.snapshotId);
    assert.equal(
      (yield* h.panel.read({ ...ticket, token: "forged" }).pipe(Effect.exit))._tag,
      "Failure",
    );
    yield* Fiber.interrupt(stream);
    assert.equal(h.pins(), 0);
    assert.equal((yield* h.panel.read(ticket).pipe(Effect.exit))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "retains a committed image when its receipt is uncertain and recovers its final view",
  () =>
    Effect.gen(function* () {
      const h = yield* harness(false, false, true);
      const contextId = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("uncertain-capture");
      yield* h.service.withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            yield* tools.context();
            yield* tools.updateView({
              expectedRevision: 0,
              operations: [{ type: "explode", amount: 0.3 }],
            });
            assert.equal(
              (yield* tools.capture({ expectedRevision: 1 }).pipe(Effect.flip)).reason,
              "capability-unavailable",
            );
          }),
        turnId,
      );
      const candidate = yield* readLatestCadCapture(threadId, turnId);
      assert.isNotNull(candidate);
      const fs = yield* FileSystem.FileSystem;
      assert.deepEqual(
        yield* fs.readFile(candidate!.record.capture.artifact.path),
        h.renderedBytes,
      );
      const recovered = yield* h.recreatePresentation;
      assert.isTrue(yield* recovered.settle(threadId));
      assert.equal((yield* readCadUserView(threadId))?.view.explosion, 0.3);
      assert.equal(h.pins(), 0);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("recovers only the latest durable capture and rejects an obsolete presentation", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const contextId = yield* h.service.resolveContext(threadId);
    const turnId = TurnId.make("recovered-presentation");
    const first = yield* h.service.withActivation(
      contextId,
      (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          const first = yield* tools.capture({ expectedRevision: 0 });
          yield* tools.updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 0.6 }],
          });
          yield* tools.capture({ expectedRevision: 1 });
          yield* tools.updateView({
            expectedRevision: 1,
            operations: [{ type: "explode", amount: 0.9 }],
          });
          return first;
        }),
      turnId,
    );
    yield* h
      .dispatch({
        type: "thread.cad.presentation.settle",
        threadId,
        captureId: first.result.captureId,
        expectedUserRevision: null,
        view: null,
      })
      .pipe(Effect.flip);
    const query = yield* ProjectionSnapshotQuery;
    assert.lengthOf(
      (yield* query.getCommandReadModel()).projects[0]!.cad!.pendingPresentations!,
      1,
    );
    const recovered = yield* h.recreatePresentation;
    assert.isTrue(yield* recovered.settle(threadId));
    assert.equal((yield* h.service.getUserView(threadId))?.explosion, 0.6);
    assert.isFalse(yield* recovered.settle(threadId));
    assert.deepEqual(
      (yield* query.getCommandReadModel()).projects[0]!.cad!.pendingPresentations,
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("preserves the user view and releases the lock when captured CAD is unavailable", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.saveUserView(threadId, null, { ...initialCadView(snapshot), explosion: 0.2 });
    const contextId = yield* h.service.resolveContext(threadId);
    yield* h.service.withActivation(
      contextId,
      (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          yield* tools.updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 0.7 }],
          });
          yield* tools.capture({ expectedRevision: 1 });
        }),
      TurnId.make("unavailable-presentation"),
    );
    h.snapshots.clear();
    assert.isTrue(yield* h.presentation.settle(threadId));
    const user = yield* readCadUserView(threadId);
    assert.equal(user?.view.explosion, 0.2);
    assert.equal(user?.view.revision, 0);
    yield* h.dispatch({ type: "project.cad.enabled.set", projectId, enabled: false });
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "promotes the final view before releasing the project lock and never overwrites later user changes",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("presentation-turn");
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      liveness.recordTaskLiveness({
        threadId,
        taskId: "child",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      yield* h.service.withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            yield* tools.context();
            yield* tools.updateView({
              expectedRevision: 0,
              operations: [{ type: "explode", amount: 0.4 }],
            });
            yield* tools.capture({ expectedRevision: 1 });
          }),
        turnId,
      );
      assert.isFalse(yield* h.presentation.settle(threadId));
      liveness.clearThreadLiveness(threadId);
      yield* h
        .dispatch({
          type: "project.cad.operation.reserve",
          projectId,
          operationId: "00000000-0000-4000-8000-000000000009",
          kind: "discover",
          root: null,
        })
        .pipe(Effect.flip);
      const engine = yield* OrchestrationEngineService;
      const subscription = yield* engine.subscribeDomainEvents;
      const observed = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((event) => event.type === "project.cad-state-set"),
        Stream.take(1),
        Stream.mapEffect(() => readCadUserView(threadId)),
        Stream.runCollect,
        Effect.forkChild,
      );
      assert.isTrue(yield* h.presentation.settle(threadId));
      const views = yield* Fiber.join(observed);
      assert.equal(views[0]?.view.explosion, 0.4);
      assert.equal(views[0]?.view.revision, 0);
      yield* h.dispatch({ type: "project.cad.enabled.set", projectId, enabled: true });
      const user = yield* h.service.getUserView(threadId);
      assert.isNotNull(user);
      yield* h.service.saveUserView(threadId, 0, { ...user!, revision: 1, explosion: 0.9 });
      assert.isFalse(yield* h.presentation.settle(threadId));
      assert.equal((yield* h.service.getUserView(threadId))?.explosion, 0.9);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("removes an uncommitted image when the durable capture is rejected", () =>
  Effect.gen(function* () {
    const h = yield* harness(false, true);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const contextId = yield* h.service.resolveContext(threadId);
    const turnId = TurnId.make("rejected-capture");
    yield* h.service.withActivation(
      contextId,
      (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          assert.equal(
            (yield* tools.capture({ expectedRevision: 0 }).pipe(Effect.flip)).reason,
            "capability-unavailable",
          );
        }),
      turnId,
    );
    assert.isNull(yield* readLatestCadCapture(threadId, turnId));
    assert.deepEqual(yield* fs.readDirectory(config.attachmentsDir), []);
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "captures an exact revision into a durable artifact and immutable per-run candidate",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const fs = yield* FileSystem.FileSystem;
      const contextId = yield* h.service.resolveContext(threadId);
      const turnId = TurnId.make("cad-capture-turn");
      const captured = yield* h.service.withActivation(
        contextId,
        (tools) =>
          Effect.gen(function* () {
            yield* tools.context();
            yield* tools.updateView({
              expectedRevision: 0,
              operations: [{ type: "explode", amount: 0.25 }],
            });
            assert.equal(
              (yield* tools.capture({ expectedRevision: 0 }).pipe(Effect.flip)).reason,
              "revision-conflict",
            );
            assert.equal(h.renderRequests.length, 0);
            const delivery = yield* tools.capture({ expectedRevision: 1 });
            assert.equal(delivery.result.revision, 1);
            assert.deepEqual(delivery.png, h.renderedBytes);
            assert.equal(h.renderRequests[0]?.sessionId, contextId);
            assert.equal(h.renderRequests[0]?.runId, turnId);
            assert.isNull(yield* h.service.getUserView(threadId));
            yield* tools.updateView({
              expectedRevision: 1,
              operations: [{ type: "explode", amount: 0.8 }],
            });
            const candidate = yield* readLatestCadCapture(threadId, turnId);
            assert.equal(candidate?.record.capture.captureId, delivery.result.captureId);
            assert.equal(candidate?.view.explosion, 0.25);
            assert.equal(candidate?.view.camera.kind, "pose");
            assert.isNull(yield* readLatestCadCapture(otherThreadId, turnId));
            return delivery;
          }),
        turnId,
      );
      assert.equal(h.pins(), 0);
      assert.deepEqual(yield* fs.readFile(captured.result.artifact.path), h.renderedBytes);
      const candidate = yield* readLatestCadCapture(threadId, turnId);
      assert.equal(candidate?.view.revision, 1);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("releases snapshot pins and permits a new activation after native-run interruption", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const contextId = yield* h.service.resolveContext(threadId);
    const ready = yield* Deferred.make<void>();
    const run = yield* h.service
      .withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(ready);
    assert.equal(h.pins(), 1);
    yield* Fiber.interrupt(run);
    assert.equal(h.pins(), 0);
    yield* h.service.withActivation(contextId, (tools) => tools.context());
    assert.equal(h.pins(), 0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "rejects overlapping activations and expires tools when their owning activation ends",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      const expired = yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          yield* tools.context();
          assert.equal(h.pins(), 1);
          const overlap = yield* h.service
            .withActivation(contextId, () => Effect.die("Overlapping activation was admitted"))
            .pipe(Effect.flip);
          assert.equal(overlap.reason, "capability-unavailable");
          return tools;
        }),
      );
      assert.equal(h.pins(), 0);
      for (const operation of [
        expired.context().pipe(Effect.flip),
        expired.hierarchy({}).pipe(Effect.flip),
        expired
          .updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 1 }],
          })
          .pipe(Effect.flip),
      ]) {
        assert.equal((yield* operation).reason, "capability-unavailable");
      }
      assert.equal(h.pins(), 0);
      yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.explosion, 0);
          assert.equal(h.pins(), 1);
        }),
      );
      assert.equal(h.pins(), 0);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "persists private state, rejects stale/invalid batches, and releases activation pins",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const contextId = yield* h.service.resolveContext(threadId);
      assert.equal(h.pins(), 0);
      yield* h.service.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.revision, 0);
          assert.equal(h.pins(), 1);
          const updated = yield* tools.updateView({
            expectedRevision: 0,
            operations: [{ type: "explode", amount: 0.5 }],
          });
          assert.equal(updated.revision, 1);
          assert.equal(
            (yield* tools
              .updateView({ expectedRevision: 0, operations: [{ type: "explode", amount: 1 }] })
              .pipe(Effect.flip)).reason,
            "revision-conflict",
          );
          yield* tools
            .updateView({
              expectedRevision: 1,
              operations: [
                { type: "explode", amount: 1 },
                { type: "hide", occurrenceIds: ["f".repeat(64)] },
              ],
            })
            .pipe(Effect.flip);
          assert.equal((yield* tools.context()).state?.explosion, 0.5);
        }),
      );
      assert.equal(h.pins(), 0);
      const restarted = yield* h.recreate;
      assert.equal(yield* restarted.resolveContext(threadId), contextId);
      yield* restarted.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.explosion, 0.5);
        }),
      );
      const query = yield* ProjectionSnapshotQuery;
      assert.isUndefined((yield* query.getSnapshot()).cadSessions);
      assert.equal("cadSessions" in (yield* query.getShellSnapshot()), false);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "keeps native child and other-thread viewers independent with no initial ambiguous root",
  () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const primary = yield* h.service.resolveContext(threadId);
      const child = yield* h.service.resolveContext(threadId, "trusted-child");
      const other = yield* h.service.resolveContext(otherThreadId);
      assert.notEqual(primary, child);
      assert.notEqual(primary, other);
      yield* h.service.withActivation(primary, (tools) =>
        Effect.gen(function* () {
          const context = yield* tools.context();
          assert.isNull(context.state);
          assert.lengthOf(context.roots, 2);
          assert.equal(h.pins(), 0);
          const view = yield* tools.updateView({
            expectedRevision: 0,
            operations: [
              { type: "select-root", rootId: snapshot.rootId },
              { type: "explode", amount: 0.75 },
            ],
          });
          assert.equal(view.revision, 1);
        }),
      );
      for (const id of [child, other])
        yield* h.service.withActivation(id, (tools) =>
          Effect.gen(function* () {
            assert.isNull((yield* tools.context()).state);
          }),
        );
      assert.equal(h.pins(), 0);
      yield* h.service.saveUserView(threadId, null, initialCadView(snapshot));
      assert.isNull(yield* h.service.getUserView(otherThreadId));
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
