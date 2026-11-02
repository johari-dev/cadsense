import type { ProviderRuntimeEvent } from "@cadsense/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@cadsense/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@cadsense/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import * as ServerConfig from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import type { DailyCounter } from "../src/telemetry/AnalyticsEvents.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const codexInstanceId = ProviderInstanceId.make("codex");

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
}

/**
 * Analytics layer that keeps counted counters in memory, in order, so tests can assert on them.
 * `AnalyticsService.layerTest` discards them.
 */
const makeRecordingAnalytics = Effect.gen(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<DailyCounter>>([]);
  const layer = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      count: (counter, by = 1) =>
        Ref.update(recorded, (current) => [
          ...current,
          ...Array.from({ length: by }, () => counter),
        ]),
      reach: () => Effect.void,
      sendFeedback: () => Effect.void,
      flush: Effect.void,
    }),
  );
  return { layer, get: Ref.get(recorded) } as const;
});

const makeIntegrationFixture = (options?: { readonly analytics?: Layer.Layer<AnalyticsService> }) =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness();

    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: harness.adapter,
    });

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
    );

    const shared = Layer.mergeAll(
      directoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
      ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
      options?.analytics ?? AnalyticsService.layerTest,
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    ).pipe(Layer.provide(SqlitePersistenceMemory));

    const layer = makeProviderServiceLive().pipe(Layer.provide(shared));

    return {
      cwd,
      harness,
      layer,
    } satisfies IntegrationFixture;
  });

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* Effect.sleep("50 millis");
    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);
    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

it.live("replays typed runtime fixture events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-typed"), {
        threadId: ThreadId.make("thread-integration-typed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnTextFixture.map((event) => event.type),
      );
      assert.deepEqual(
        observedEvents.map((event) => event.providerInstanceId),
        codexTurnTextFixture.map(() => codexInstanceId),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replays file-changing fixture turn events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-tools"), {
        threadId: ThreadId.make("thread-integration-tools"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("runs multi-turn tool/approval flow", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-multi"), {
        threadId: ThreadId.make("thread-integration-multi"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const firstTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        firstTurnEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );

      const secondTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        secondTurnEvents.map((event) => event.type),
        codexTurnApprovalFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("counts each session start and each turn under its provider", () =>
  Effect.gen(function* () {
    const analytics = yield* makeRecordingAnalytics;
    const fixture = yield* makeIntegrationFixture({ analytics: analytics.layer });
    const threadId = ThreadId.make("thread-integration-runtime-mode");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const startSession = (runtimeMode: "approval-required" | "full-access") =>
        provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: fixture.cwd,
          runtimeMode,
        });

      yield* startSession("approval-required");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "supervised turn",
        response: { events: codexTurnTextFixture },
      });

      // Toggling the mode restarts the session, so it counts as a second start.
      yield* startSession("full-access");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "full access turn",
        response: { events: codexTurnTextFixture },
      });

      const recorded = yield* analytics.get;

      assert.deepEqual(
        recorded.filter((counter) => counter.startsWith("agent_")),
        [
          "agent_sessions_started",
          "agent_turns_codex",
          "agent_sessions_started",
          "agent_turns_codex",
        ],
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("counts a turn the provider ends as failed and a turn it refuses to start", () =>
  Effect.gen(function* () {
    const analytics = yield* makeRecordingAnalytics;
    const fixture = yield* makeIntegrationFixture({ analytics: analytics.layer });
    const threadId = ThreadId.make("thread-integration-failed-turn");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      const failedTurn = codexTurnTextFixture.map((event) =>
        event.type === "turn.completed"
          ? { ...event, payload: { state: "failed", errorMessage: "Sandbox command failed." } }
          : event,
      );
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "this turn fails",
        response: { events: failedTurn },
      });
      // Nothing is queued for this turn, so the test adapter rejects it.
      const refused = yield* provider
        .sendTurn({ threadId, input: "this turn is refused", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterValidationError");

      const recorded = yield* analytics.get;
      // Runtime events are counted on their own fiber, so only the totals are fixed.
      assert.deepEqual(recorded.filter((counter) => counter.startsWith("agent_")).toSorted(), [
        "agent_sessions_started",
        "agent_turns_codex",
        "agent_turns_failed",
        "agent_turns_send_failed",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
