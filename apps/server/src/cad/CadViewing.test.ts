import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CadChecksResult,
  CadDiffResult,
  CadSnapshotManifest,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OnshapeProjectSource,
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
import { CadComments } from "./CadComments.ts";
import { makeCadProviderTools } from "../provider/CadProviderTools.ts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, EnvironmentId } from "@cadsense/contracts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { cadReviewInstructions } from "../provider/CadReviewInstructions.ts";
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
import { CadRenderError, CadUserOperationError } from "@cadsense/contracts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import { make as makeRenderBroker } from "./CadRenderBroker.ts";
import { releaseCompletedCadRuns } from "./CadRenderLifecycle.ts";

const now = "2026-09-05T00:00:00Z";
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
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

it.effect("shows agent CAD control while a comment tool renders", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const h = yield* harness(false, false, false, undefined, {
      activate: () =>
        Effect.succeed({
          invoke: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ result: { ok: true } }),
            ),
        }),
      watch: () => Stream.empty,
      review: () => Effect.die("unused"),
      learnings: () => Stream.empty,
      removeLearning: () => Effect.die("unused"),
    });
    const tools = yield* makeCadProviderTools(threadId).pipe(
      Effect.provideService(CadViewing, h.service),
    );
    const turnId = TurnId.make("comment-activity");
    const controlling = () =>
      h.service.watchActivity(threadId).pipe(
        Stream.runHead,
        Effect.map((state) => Option.getOrThrow(state)),
      );
    const inspect = yield* tools
      .invoke(null, turnId, "cad_comment_inspect", {})
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    assert.deepEqual(yield* controlling(), {
      agentControlling: true,
      agentActivityTurnId: turnId,
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(inspect);
    assert.deepEqual(yield* controlling(), {
      agentControlling: false,
      agentActivityTurnId: turnId,
    });
    yield* tools.end(null, turnId);
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
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-claude-cad-" });
      yield* fs.writeFileString(
        `${workspaceRoot}/cadsense.json`,
        '{ "reviewIgnore": [{ "name": "*bolt*" }] }',
      );
      const h = yield* harness(false, false, false, undefined, undefined, workspaceRoot);
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
      assert.deepEqual(sdkOptions!.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: cadReviewInstructions({
          learnings: [],
          ignored: [{ name: "*bolt*" }],
        }),
      });
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
it.effect("reads the project design brief for Claude instructions and cad_context", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-cad-brief-" });
    const brief = "The elevator motor rides on the moving stage by design.";
    yield* fs.writeFileString(`${workspaceRoot}/DESIGN.md`, `\n${brief}\n`);
    const h = yield* harness(false, false, false, undefined, undefined, workspaceRoot);
    const contextId = yield* h.service.resolveContext(threadId);
    yield* h.service.withActivation(
      contextId,
      (tools) =>
        Effect.gen(function* () {
          assert.deepEqual((yield* tools.context()).designBrief, {
            path: "DESIGN.md",
            bytes: brief.length + 2,
          });
        }),
      TurnId.make("design-brief"),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("cad-test"),
          threadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: "claude-brief-session",
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
    yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: workspaceRoot });
    const systemPrompt = sdkOptions?.systemPrompt;
    if (typeof systemPrompt !== "object" || Array.isArray(systemPrompt))
      return yield* Effect.die("Claude session started without a preset system prompt");
    assert.include(systemPrompt.append, "Project design brief (DESIGN.md)");
    assert.include(systemPrompt.append, brief);
    yield* adapter.stopSession(threadId);
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
  comments?: CadComments["Service"],
  /** Defaults to a path that does not exist, so the project has no cadsense.json. */
  workspaceRoot = "C:/cad-view-test",
) {
  const engine = yield* OrchestrationEngineService;
  let sequence = 0;
  const dispatch = (command: TestCommand) =>
    engine.dispatch({ ...command, commandId: CommandId.make(`cad-view-test-${++sequence}`) });
  yield* dispatch({
    type: "project.onshape.create",
    projectId,
    title: "CAD",
    workspaceRoot,
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
  const assets = new Map<string, Uint8Array>();
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
          return yield* use(manifest, (sha256) => {
            const bytes = assets.get(sha256);
            return bytes ? Effect.succeed(bytes) : unused();
          });
        }),
      ),
  });
  const renderRequests: CadRenderRequest[] = [];
  const renderedBytes = new Uint8Array([1, 2, 3]);
  let renderFailure: CadRenderError["reason"] | null = null;
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
            if (renderFailure) return yield* new CadRenderError({ reason: renderFailure });
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
    comments ? Effect.provideService(CadComments, comments) : (effect) => effect,
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
    failRenders: (reason: CadRenderError["reason"] | null) => {
      renderFailure = reason;
    },
    dispatch,
    renderRequests,
    renderedBytes,
    presentation,
    recreatePresentation: makePresentation.pipe(Effect.provideService(CadSnapshotStore, store)),
    snapshots,
    assets,
    store,
  };
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** JSON-only GLB with one 50 mm cube; cad_checks reads accessor bounds, never the binary chunk. */
/** A closed 5 cm cube with real triangles, so both bounds and exact interference can read it. */
const cubeGlb = (() => {
  const positions = new Float32Array(
    Array.from({ length: 8 }, (_, i) => [
      i & 1 ? 0.05 : 0,
      i & 2 ? 0.05 : 0,
      i & 4 ? 0.05 : 0,
    ]).flat(),
  );
  // Outward-wound faces: -Z, +Z, -Y, +Y, -X, +X.
  const indices = new Uint16Array([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3,
    7, 1, 7, 5,
  ]);
  const json = new TextEncoder().encode(
    encodeJson({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 8,
          type: "VEC3",
          min: [0, 0, 0],
          max: [0.05, 0.05, 0.05],
        },
        { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      ],
      buffers: [{ byteLength: positions.byteLength + indices.byteLength }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = positions.byteLength + indices.byteLength;
  const glb = new Uint8Array(20 + jsonLength + 8 + binLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(json, 20);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  glb.set(new Uint8Array(positions.buffer), 28 + jsonLength);
  glb.set(new Uint8Array(indices.buffer), 28 + jsonLength + positions.byteLength);
  return glb;
})();
const decodeRevision = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Int }));
const decodeChecks = Schema.decodeUnknownEffect(CadChecksResult);
it.effect("runs cad_checks over the pinned snapshot and caches part bounds per activation", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const partId = (value: number) => value.toString(16).padStart(64, "0");
    const glb = cubeGlb;
    let reads = 0;
    h.assets.set(partId(9), glb);
    const decorated = decodeSnapshot({
      ...snapshot,
      nodes: [
        ...snapshot.nodes,
        ...[
          {
            number: 5,
            name: "Block A",
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          {
            number: 6,
            name: "Block B",
            transform: [1, 0, 0, 0.04, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ].map((node) => ({
          id: partId(node.number),
          parentId: snapshot.nodes[0]!.id,
          occurrencePath: [String(node.number)],
          instanceId: String(node.number),
          name: node.name,
          kind: "part",
          suppressed: false,
          defaultVisible: true,
          transform: node.transform,
          sourcePartKey: partId(8),
        })),
      ],
      parts: [
        {
          geometryKey: partId(8),
          source: {
            host: source.host,
            documentId: source.documentId,
            documentMicroversion: source.workspaceId,
            documentVersion: null,
            elementId: "e".repeat(24),
            configuration: "default",
            fullConfiguration: "default",
            partId: "JHD",
            tessellationProfile: "test",
          },
          geometryRequired: true,
          metadata: {
            name: "Block",
            bodyType: "solid",
            isHidden: null,
            isMesh: null,
            partIdentity: null,
            configurationId: null,
            appearance: null,
            material: null,
          },
        },
      ],
      assets: [
        {
          geometryKey: partId(8),
          sha256: partId(9),
          byteLength: glb.length,
          format: "glb",
          relativePath: `${partId(9)}.glb`,
        },
      ],
    });
    h.snapshots.set(snapshot.snapshotId, yield* decorated);
    const store = h.store;
    const tools = yield* makeCadProviderTools(threadId).pipe(
      Effect.provideService(
        CadViewing,
        yield* make.pipe(
          Effect.provideService(CadSnapshotStore, {
            ...store,
            withPinned: (id, use) =>
              store.withPinned(id, (manifest, readAsset) =>
                use(manifest, (sha256) =>
                  Effect.sync(() => {
                    reads++;
                  }).pipe(Effect.andThen(readAsset(sha256))),
                ),
              ),
          }),
        ),
      ),
    );
    const turnId = TurnId.make("checks");
    const context = yield* decodeRevision(
      (yield* tools.invoke(null, turnId, "cad_context", {})).result,
    );
    const first = yield* decodeChecks(
      (yield* tools.invoke(null, turnId, "cad_checks", { expectedRevision: context.revision }))
        .result,
    );
    assert.deepEqual(
      first.findings.map((finding) => [
        finding.check,
        finding.occurrences.map((occurrence) => occurrence.name),
      ]),
      [["mesh-interference", ["Block A", "Block B"]]],
    );
    const interference = first.findings[0]!;
    if (interference.check === "mesh-interference")
      assert.closeTo(interference.intersectionVolume, 0.01 * 0.05 * 0.05, 1e-10);
    assert.equal(first.summary.partOccurrences, 2);
    assert.equal(first.summary.meshUnknown, 0);
    // One bounds read, cached for the activation, and one triangle read for this call.
    assert.equal(reads, 2);
    const leads = yield* decodeChecks(
      (yield* tools.invoke(null, turnId, "cad_checks", {
        expectedRevision: context.revision,
        checks: ["overlapping-bounds"],
      })).result,
    );
    const overlap = leads.findings[0]!;
    if (overlap.check === "overlapping-bounds")
      assert.deepEqual(
        overlap.overlapSize.map((value) => Number(value.toFixed(9))),
        [0.01, 0.05, 0.05],
      );
    assert.equal(reads, 2);
    const second = yield* decodeChecks(
      (yield* tools.invoke(null, turnId, "cad_checks", {
        expectedRevision: context.revision,
        checks: ["degenerate-geometry"],
      })).result,
    );
    assert.deepEqual(second.findings, []);
    assert.equal(reads, 2);
    assert.equal(
      (yield* tools
        .invoke(null, turnId, "cad_checks", { expectedRevision: context.revision + 1 })
        .pipe(Effect.flip)).reason,
      "revision-conflict",
    );
    yield* tools.close;
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

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

it.effect("tells the agent why a capture or view update failed", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const tools = yield* makeCadProviderTools(threadId).pipe(
      Effect.provideService(CadViewing, h.service),
    );
    const turnId = TurnId.make("tool-errors");
    const failure = (name: string, input: unknown) =>
      tools.invoke(null, turnId, name, input).pipe(Effect.flip);
    yield* tools.invoke(null, turnId, "cad_context", {});

    // Render failures are retryable and must not read as CAD being off.
    h.failRenders("busy");
    const busy = yield* failure("cad_capture", { expectedRevision: 0 });
    assert.equal(busy.reason, "render-busy");
    assert.include(busy.details, "Retry");
    h.failRenders("unavailable");
    assert.equal(
      (yield* failure("cad_capture", { expectedRevision: 0 })).reason,
      "render-unavailable",
    );
    h.failRenders(null);
    yield* tools.invoke(null, turnId, "cad_capture", { expectedRevision: 0 });

    const malformed = yield* failure("cad_update_view", {
      expectedRevision: 0,
      operations: [{ type: "camera-pose" }],
    });
    assert.equal(malformed.reason, "invalid-operation");
    assert.include(malformed.details, "pose");
    const unknown = yield* failure("cad_update_view", {
      expectedRevision: 0,
      operations: [{ type: "hide", occurrenceIds: ["f".repeat(64)] }],
    });
    assert.equal(unknown.reason, "invalid-operation");
    assert.include(unknown.details, "operations[0]");
    yield* tools.end(null, turnId);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "diffs the current snapshot against the retained snapshot earlier comments inspected",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const tools = yield* makeCadProviderTools(threadId).pipe(
        Effect.provideService(CadViewing, h.service),
      );
      const decodeDiff = Schema.decodeUnknownEffect(CadDiffResult);
      const firstTurn = TurnId.make("diff-first-review");
      // Nothing retained before the current snapshot: the agent must inspect the whole model.
      const first = yield* tools.invoke(null, firstTurn, "cad_diff", {}).pipe(Effect.flip);
      assert.equal(first.reason, "invalid-operation");
      assert.include(first.details, "first review");
      yield* tools.end(null, firstTurn);

      yield* h.dispatch({
        type: "thread.cad.comments.commit",
        threadId,
        expectedCatalogVersion: 0,
        comments: [
          {
            id: "finding-1",
            threadId,
            rootId: snapshot.rootId,
            snapshotId: snapshot.snapshotId,
            modelKey: "5".repeat(64),
            modelDescriptor: "descriptor",
            title: "Check the intake",
            body: "The intake mount looks unsupported.",
            severity: "concern",
            category: "structure",
            targets: [
              {
                kind: "part",
                label: "Intake",
                occurrenceId: snapshot.nodes[0]!.id,
                preciseLocationLimitation: "Whole part.",
              },
            ],
            link: null,
            state: "open",
            version: 0,
            number: 1,
            createdAt: now,
            turnId: firstTurn,
          },
        ],
        receipts: [],
      });
      const later = "2026-09-06T00:00:00Z";
      const revised = yield* decodeSnapshot({
        ...snapshot,
        snapshotId: "00000000-0000-4000-8000-000000000007",
        createdAt: later,
        root: { ...snapshot.root, microversionId: "e".repeat(24) },
        nodes: [
          { ...snapshot.nodes[0]!, name: "Intake v2" },
          {
            id: "4".repeat(64),
            parentId: snapshot.nodes[0]!.id,
            occurrencePath: ["bracket"],
            instanceId: "bracket",
            name: "Bracket",
            kind: "part",
            suppressed: false,
            defaultVisible: true,
            sourcePartKey: null,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ],
      });
      h.snapshots.set(revised.snapshotId, revised);
      const operationId = "00000000-0000-4000-8000-000000000008";
      yield* h.dispatch({
        type: "project.cad.operation.reserve",
        projectId,
        operationId,
        kind: "sync",
        root: {
          rootId: revised.rootId,
          elementId: revised.root.elementId,
          kind: revised.root.kind,
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
            snapshotId: revised.snapshotId,
            microversionId: revised.root.microversionId,
            createdAt: later,
            manifestBytes: 1,
            assetBytes: 0,
          },
        },
      });

      const turnId = TurnId.make("diff-second-review");
      const page = yield* decodeDiff(
        (yield* tools.invoke(null, turnId, "cad_diff", { limit: 1 })).result,
      );
      assert.equal(page.base.snapshotId, snapshot.snapshotId);
      assert.equal(page.target.snapshotId, revised.snapshotId);
      assert.equal(page.target.microversionId, revised.root.microversionId);
      assert.include(page.baseSelection, "rollback, comments; inspected by comment #1");
      assert.deepEqual(page.counts, {
        added: 1,
        removed: 0,
        modified: 1,
        moved: 0,
        geometryChanged: 0,
        renamed: 1,
        suppressionChanged: 0,
        visibilityChanged: 0,
        unchanged: 0,
      });
      assert.deepEqual(
        page.retainedSnapshots.map((item) => [
          item.snapshotId,
          item.retainedBy,
          item.commentNumbers,
        ]),
        [
          [revised.snapshotId, ["current"], []],
          [snapshot.snapshotId, ["rollback", "comments"], [1]],
        ],
      );
      assert.deepEqual(page.entries, [
        {
          status: "added",
          occurrencePath: ["bracket"],
          name: "Bracket",
          previousName: null,
          kind: "part",
          baseOccurrenceId: null,
          targetOccurrenceId: "4".repeat(64),
          changes: [],
        },
      ]);
      assert.equal(page.nextCursor, `${snapshot.snapshotId}:${revised.snapshotId}:1`);
      // Later pages reuse the cached diff and never rebind the pinned snapshot.
      const pinsBefore = h.pins();
      const rest = yield* decodeDiff(
        (yield* tools.invoke(null, turnId, "cad_diff", { cursor: page.nextCursor! })).result,
      );
      assert.equal(h.pins(), pinsBefore);
      assert.deepEqual(
        rest.entries.map((entry) => [
          entry.status,
          entry.previousName,
          entry.name,
          ...entry.changes,
        ]),
        [["modified", "Intake", "Intake v2", "renamed"]],
      );
      assert.isNull(rest.nextCursor);
      const same = yield* tools
        .invoke(null, turnId, "cad_diff", { baseSnapshotId: revised.snapshotId })
        .pipe(Effect.flip);
      assert.include(same.details, "same snapshot");
      const unknown = yield* tools
        .invoke(null, turnId, "cad_diff", {
          baseSnapshotId: "00000000-0000-4000-8000-0000000000ff",
        })
        .pipe(Effect.flip);
      assert.equal(unknown.reason, "invalid-operation");
      assert.include(unknown.details, snapshot.snapshotId);
      yield* tools.end(null, turnId);
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
              operations: [
                { type: "explode", amount: 0.25 },
                { type: "highlight", occurrenceIds: [snapshot.nodes[0]!.id] },
                { type: "ghost", occurrenceIds: [snapshot.nodes[0]!.id], opacity: 0.2 },
                { type: "section", planes: [{ normal: [1, 0, 0], constant: -0.1 }] },
              ],
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
              operations: [{ type: "explode", amount: 0.8 }, { type: "reset-inspection" }],
            });
            const candidate = yield* readLatestCadCapture(threadId, turnId);
            assert.equal(candidate?.record.capture.captureId, delivery.result.captureId);
            assert.equal(candidate?.view.explosion, 0.25);
            assert.deepEqual(candidate?.view.highlightedOccurrenceIds, [snapshot.nodes[0]!.id]);
            assert.equal(candidate?.view.ghost?.opacity, 0.2);
            assert.deepEqual(candidate?.view.sectionPlanes, [
              { normal: [1, 0, 0], constant: -0.1 },
            ]);
            assert.deepEqual(
              h.renderRequests[0]?.state.sectionPlanes,
              candidate?.view.sectionPlanes,
            );
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
            operations: [
              { type: "explode", amount: 0.5 },
              { type: "section", planes: [{ normal: [0, 0, 1], constant: 0.2 }] },
            ],
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
          assert.deepEqual((yield* tools.context()).state?.sectionPlanes, [
            { normal: [0, 0, 1], constant: 0.2 },
          ]);
        }),
      );
      assert.equal(h.pins(), 0);
      const restarted = yield* h.recreate;
      assert.equal(yield* restarted.resolveContext(threadId), contextId);
      yield* restarted.withActivation(contextId, (tools) =>
        Effect.gen(function* () {
          assert.equal((yield* tools.context()).state?.explosion, 0.5);
          assert.deepEqual((yield* tools.context()).state?.sectionPlanes, [
            { normal: [0, 0, 1], constant: 0.2 },
          ]);
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
