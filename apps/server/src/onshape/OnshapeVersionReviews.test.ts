// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeNetworkError,
  OnshapeProjectSource,
  OnshapeRateLimitError,
  OnshapeWorkspaceId,
  ProjectId,
  ThreadId,
  type OnshapeConnectionError,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OnshapeConnections } from "./OnshapeConnections.ts";
import {
  OnshapeVersionReviews,
  layer as versionReviewsLayer,
  planVersionReviews,
  versionReviewPrompt,
  versionReviewTitle,
  type OnshapeVersion,
} from "./OnshapeVersionReviews.ts";

const now = "2026-09-04T00:00:00.000Z";
const projectId = ProjectId.make("onshape-version-review-project");
const source = OnshapeProjectSource.make({
  connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
  host: "https://cad.onshape.com",
  documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
  configuration: "",
});
const version = (id: string, name: string, createdAt: string): OnshapeVersion => ({
  id: OnshapeWorkspaceId.make(id.padEnd(24, "0")),
  name,
  createdAt,
  description: null,
  creator: { name: "Ada" },
});
const start = version("a", "Start", "2026-09-01T00:00:00.000Z");
const v1 = version("b", "Bracket rev", "2026-09-02T00:00:00.000Z");
const v2 = version("c", "Gearbox check", "2026-09-03T00:00:00.000Z");
const unsupported = () => Effect.die("Unused test service method.");

describe("planVersionReviews", () => {
  it("records the newest version as the baseline on the first poll", () => {
    const plan = planVersionReviews({ cursor: null, versions: [v1, start] });
    assert.deepStrictEqual(plan, {
      baseline: { versionId: v1.id, createdAt: v1.createdAt },
      pending: [],
    });
    assert.deepStrictEqual(planVersionReviews({ cursor: null, versions: [] }), {
      baseline: null,
      pending: [],
    });
  });

  it("returns versions created after the cursor, oldest first, with their ordinals", () => {
    const plan = planVersionReviews({
      cursor: { versionId: start.id, createdAt: start.createdAt },
      versions: [v2, start, v1],
    });
    assert.deepStrictEqual(plan.pending, [
      { version: v1, ordinal: 1 },
      { version: v2, ordinal: 2 },
    ]);
  });

  it("still finds newer versions when the cursor version was deleted in Onshape", () => {
    const plan = planVersionReviews({
      cursor: { versionId: v1.id, createdAt: v1.createdAt },
      versions: [start, v2],
    });
    assert.deepStrictEqual(
      plan.pending.map((entry) => entry.version.id),
      [v2.id],
    );
  });

  it("breaks createdAt ties by id so a cursor never hides a sibling version", () => {
    const sibling = { ...v1, id: OnshapeWorkspaceId.make("d".padEnd(24, "0")) };
    const plan = planVersionReviews({
      cursor: { versionId: v1.id, createdAt: v1.createdAt },
      versions: [start, v1, sibling],
    });
    assert.deepStrictEqual(
      plan.pending.map((entry) => entry.version.id),
      [sibling.id],
    );
  });

  it("titles and prompts the review from the version metadata", () => {
    assert.strictEqual(versionReviewTitle(v2, 2), "Review v2: Gearbox check");
    const prompt = versionReviewPrompt({
      project: {
        id: projectId,
        title: "FRC intake",
        workspaceRoot: "/managed",
        defaultModelSelection: null,
        onshapeSource: source,
        createdAt: now,
        updatedAt: now,
      },
      version: { ...v2, description: "Swapped the 40T gear" },
    });
    assert.include(
      prompt,
      'Onshape version "Gearbox check" was created on 2026-09-03T00:00:00.000Z by Ada.',
    );
    assert.include(prompt, "Version note: Swapped the 40T gear.");
    assert.include(prompt, "Review this version of FRC intake and leave CAD comments.");
    assert.include(prompt, `https://cad.onshape.com/documents/${source.documentId}/v/${v2.id}`);
  });
});

interface Onshape {
  readonly versions: Ref.Ref<ReadonlyArray<OnshapeVersion>>;
  readonly failure: Ref.Ref<OnshapeConnectionError | null>;
  readonly requests: Ref.Ref<number>;
}

// Real engine and projections over a SQLite file, with Onshape replaced by a version list.
function makeLayer(baseDir: string, onshape: Onshape) {
  const persistence = makeSqlitePersistenceLive(NodePath.join(baseDir, "state.sqlite"));
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
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const connections = Layer.succeed(
    OnshapeConnections,
    OnshapeConnections.of({
      readJson: () =>
        Effect.gen(function* () {
          yield* Ref.update(onshape.requests, (count) => count + 1);
          const failure = yield* Ref.get(onshape.failure);
          if (failure) return yield* Effect.fail(failure);
          return yield* Ref.get(onshape.versions);
        }),
      readBinary: unsupported,
      list: unsupported,
      create: unsupported,
      rename: unsupported,
      replaceCredentials: unsupported,
      remove: unsupported,
    }),
  );
  return versionReviewsLayer.pipe(
    Layer.provideMerge(connections),
    Layer.provideMerge(orchestration),
  );
}

const createEnabledProject = Effect.fn(function* (enabled: boolean) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.onshape.create",
    commandId: CommandId.make("server:test:create"),
    projectId,
    title: "FRC intake",
    workspaceRoot: "/managed/frc-intake",
    defaultModelSelection: null,
    onshapeSource: source,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.onshape.workspace.ready",
    commandId: CommandId.make("server:test:ready"),
    projectId,
  });
  if (enabled) yield* setEnabled(true, "server:test:enable");
});

const setEnabled = (enabled: boolean, commandId: string) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    engine.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(commandId),
      projectId,
      onshapeAutoReviewVersions: enabled,
    }),
  );

const reviewThreads = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  return (yield* query.getShellSnapshot()).threads.filter(
    (thread) => thread.projectId === projectId,
  );
});

const withTempDir = <A, E, R>(use: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-version-reviews-")),
    ),
    use,
    (baseDir) => Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
  );

const makeOnshape = Effect.gen(function* () {
  return {
    versions: yield* Ref.make<ReadonlyArray<OnshapeVersion>>([start]),
    failure: yield* Ref.make<OnshapeConnectionError | null>(null),
    requests: yield* Ref.make(0),
  } satisfies Onshape;
});

describe("OnshapeVersionReviews", () => {
  it.effect("ignores projects without the setting", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const onshape = yield* makeOnshape;
        yield* Effect.gen(function* () {
          yield* createEnabledProject(false);
          const reviews = yield* OnshapeVersionReviews;
          yield* reviews.pollAll();
          yield* reviews.pollProject(projectId);
          assert.strictEqual(yield* Ref.get(onshape.requests), 0);
          assert.deepStrictEqual(yield* reviewThreads, []);
        }).pipe(Effect.provide(makeLayer(baseDir, onshape)));
      }),
    ),
  );

  it.effect(
    "baselines on the first poll, reviews each later version once, and survives a restart",
    () =>
      withTempDir((baseDir) =>
        Effect.gen(function* () {
          const onshape = yield* makeOnshape;
          yield* Effect.gen(function* () {
            yield* createEnabledProject(true);
            const reviews = yield* OnshapeVersionReviews;
            const query = yield* ProjectionSnapshotQuery;

            yield* reviews.pollAll();
            assert.strictEqual(yield* Ref.get(onshape.requests), 1);
            assert.deepStrictEqual(yield* reviewThreads, []);

            yield* Ref.set(onshape.versions, [start, v1, v2]);
            yield* reviews.pollAll();
            const threads = yield* reviewThreads;
            assert.deepStrictEqual(
              threads.map((thread) => thread.title),
              ["Review v1: Bracket rev", "Review v2: Gearbox check"],
            );
            const detail = yield* query.getThreadDetailById(
              ThreadId.make(`onshape-version-review:${projectId}:${v2.id}`),
            );
            assert.isTrue(Option.isSome(detail));
            if (Option.isSome(detail)) {
              assert.strictEqual(detail.value.messages.length, 1);
              assert.include(
                detail.value.messages[0]?.text ?? "",
                'Onshape version "Gearbox check"',
              );
              assert.strictEqual(detail.value.turnAdmission?.pending.length, 1);
            }

            yield* reviews.pollAll();
            assert.strictEqual((yield* reviewThreads).length, 2);
            assert.strictEqual(yield* Ref.get(onshape.requests), 3);
          }).pipe(Effect.provide(makeLayer(baseDir, onshape)), Effect.scoped);

          // A fresh server over the same state must not review v1 or v2 again.
          yield* Effect.gen(function* () {
            const reviews = yield* OnshapeVersionReviews;
            yield* reviews.pollAll();
            assert.strictEqual((yield* reviewThreads).length, 2);
            assert.strictEqual(yield* Ref.get(onshape.requests), 4);
          }).pipe(Effect.provide(makeLayer(baseDir, onshape)), Effect.scoped);
        }),
      ),
  );

  it.effect("keeps the cursor and backs off when Onshape fails, then retries later", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const onshape = yield* makeOnshape;
        yield* Effect.gen(function* () {
          yield* createEnabledProject(true);
          const reviews = yield* OnshapeVersionReviews;
          yield* reviews.pollAll();

          yield* Ref.set(onshape.versions, [start, v1]);
          yield* Ref.set(onshape.failure, new OnshapeRateLimitError({ retryAfterSeconds: 30 }));
          yield* reviews.pollAll();
          assert.deepStrictEqual(yield* reviewThreads, []);
          // Backing off: the next poll before the retry time makes no request at all.
          yield* Ref.set(onshape.failure, new OnshapeNetworkError());
          yield* reviews.pollAll();
          assert.strictEqual(yield* Ref.get(onshape.requests), 2);
        }).pipe(Effect.provide(makeLayer(baseDir, onshape)), Effect.scoped);

        // Restart clears the in-memory backoff; the durable cursor still points at the baseline.
        yield* Effect.gen(function* () {
          yield* Ref.set(onshape.failure, null);
          const reviews = yield* OnshapeVersionReviews;
          yield* reviews.pollAll();
          assert.deepStrictEqual(
            (yield* reviewThreads).map((thread) => thread.title),
            ["Review v1: Bracket rev"],
          );
        }).pipe(Effect.provide(makeLayer(baseDir, onshape)), Effect.scoped);
      }),
    ),
  );

  it.effect("polls when the setting turns on and re-baselines after it was off", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const onshape = yield* makeOnshape;
        yield* Effect.gen(function* () {
          yield* createEnabledProject(false);
          const reviews = yield* OnshapeVersionReviews;
          yield* reviews.start();
          const awaitRequests = (count: number) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200; attempt++) {
                if ((yield* Ref.get(onshape.requests)) >= count) return;
                yield* Effect.yieldNow;
              }
            });

          yield* setEnabled(true, "server:test:toggle-on");
          yield* awaitRequests(1);
          assert.strictEqual(yield* Ref.get(onshape.requests), 1);

          // Versions created while the setting is off are not reviewed on re-enable.
          yield* setEnabled(false, "server:test:toggle-off");
          yield* Ref.set(onshape.versions, [start, v1]);
          yield* setEnabled(true, "server:test:toggle-on-again");
          yield* awaitRequests(2);
          assert.deepStrictEqual(yield* reviewThreads, []);

          yield* Ref.set(onshape.versions, [start, v1, v2]);
          yield* reviews.pollProject(projectId);
          assert.deepStrictEqual(
            (yield* reviewThreads).map((thread) => thread.title),
            ["Review v2: Gearbox check"],
          );
        }).pipe(Effect.provide(makeLayer(baseDir, onshape)), Effect.scoped);
      }),
    ),
  );
});
