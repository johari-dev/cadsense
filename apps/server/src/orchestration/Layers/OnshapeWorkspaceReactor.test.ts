import {
  CommandId,
  CorrelationId,
  EventId,
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerActivation } from "../../serverActivation.ts";
import { ManagedWorkspaceAllocator } from "../../workspace/ManagedWorkspaceAllocator.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OnshapeWorkspaceReactor } from "../Services/OnshapeWorkspaceReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OnshapeWorkspaceReactorLive } from "./OnshapeWorkspaceReactor.ts";

const now = "2026-09-04T00:00:00.000Z";
const projectId = ProjectId.make("onshape-workspace-reactor-project");
const workspaceRoot = "C:/cadsense/managed-workspaces/project-hash";
const source = OnshapeProjectSource.make({
  connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
  host: "https://cad.onshape.com",
  documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
  configuration: "",
  managedWorkspaceReady: false,
});
const createdEvent = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-onshape-project-created-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`command-onshape-project-created-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`command-onshape-project-created-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title: "FRC intake",
    workspaceRoot,
    defaultModelSelection: null,
    onshapeSource: source,
    createdAt: now,
    updatedAt: now,
  },
});

const unsupported = () => Effect.die("Unused test service method.");

function snapshotLayer(projects: ReadonlyArray<OrchestrationProjectShell> = []) {
  return Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getCommandReadModel: () => unsupported(),
      getSnapshot: () => unsupported(),
      getShellSnapshot: () => unsupported(),
      listPendingOnshapeProjects: () => Effect.succeed(projects),
      getArchivedShellSnapshot: () => unsupported(),
      searchThreads: () => unsupported(),
      getSnapshotSequence: () => unsupported(),
      getCounts: () => unsupported(),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    }),
  );
}

const makeEngine = Effect.fn(function* (options?: { readonly failReady?: boolean }) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const latestSequence = yield* Ref.make(0);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Ref.update(commands, (current) => [...current, command]).pipe(
        Effect.andThen(
          options?.failReady === true && command.type === "project.onshape.workspace.ready"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "readiness write unavailable",
                }),
              )
            : Effect.succeed({ sequence: 100 }),
        ),
      ),
    streamDomainEvents: Stream.fromPubSub(events),
    subscribeDomainEvents: PubSub.subscribe(events),
    latestSequence: Ref.get(latestSequence),
  };
  return {
    engine,
    commands,
    latestSequence,
    publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
  };
});

it.effect("provisions a live project event before completing its receipt", () =>
  Effect.gen(function* () {
    const event = createdEvent(1);
    const engine = yield* makeEngine();
    const provisions = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer()),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: (input) =>
              Ref.update(provisions, (current) => [...current, input.workspaceRoot]),
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        const receipt = yield* Effect.forkChild(reactor.drainThrough(1));
        yield* engine.publish(event);
        yield* Fiber.join(receipt);

        assert.deepStrictEqual(yield* Ref.get(provisions), [workspaceRoot]);
        assert.strictEqual(
          (yield* Ref.get(engine.commands))[0]?.type,
          "project.onshape.workspace.ready",
        );
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("buffers project creation across the activation handoff", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const engine = yield* makeEngine();
    const provisions = yield* Ref.make(0);
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer()),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(Layer.succeed(ServerActivation, Deferred.await(activation))),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () => Ref.update(provisions, (count) => count + 1),
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        yield* engine.publish(createdEvent(1));
        const receipt = yield* Effect.forkChild(reactor.drainThrough(1));
        yield* Deferred.succeed(activation, undefined);
        yield* Fiber.join(receipt);
        assert.strictEqual(yield* Ref.get(provisions), 1);
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("does not delete a project when shutdown interrupts provisioning", () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine();
    const provisionStarted = yield* Deferred.make<void>();
    const neverFinish = yield* Deferred.make<void>();
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer()),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () =>
              Deferred.succeed(provisionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(neverFinish)),
              ),
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        yield* engine.publish(createdEvent(1));
        yield* Deferred.await(provisionStarted);
      }),
    ).pipe(Effect.provide(layer));

    assert.deepStrictEqual(yield* Ref.get(engine.commands), []);
  }),
);

it.effect("leaves a provisioned project pending when readiness persistence fails", () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine({ failReady: true });
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer()),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () => Effect.void,
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        const receipt = yield* Effect.forkChild(reactor.drainThrough(1));
        yield* engine.publish(createdEvent(1));
        const error = yield* Effect.flip(Fiber.join(receipt));
        assert.strictEqual(error._tag, "OnshapeWorkspaceProvisionError");
      }),
    ).pipe(Effect.provide(layer));

    const commands = yield* Ref.get(engine.commands);
    assert.strictEqual(commands.length, 3);
    assert.isFalse(commands.some((command) => command.type === "project.delete"));
  }),
);

it.effect("deletes a failed live project and fails its provisioning receipt", () =>
  Effect.gen(function* () {
    const event = createdEvent(1);
    const engine = yield* makeEngine();
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer()),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () => Effect.die("disk unavailable"),
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        const receipt = yield* Effect.forkChild(reactor.drainThrough(1));
        yield* engine.publish(event);
        const error = yield* Effect.flip(Fiber.join(receipt));

        assert.strictEqual(error._tag, "OnshapeWorkspaceProvisionError");
        assert.strictEqual((yield* Ref.get(engine.commands))[0]?.type, "project.delete");
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("reconciles a pending workspace during startup", () =>
  Effect.gen(function* () {
    const pendingProject: OrchestrationProjectShell = {
      id: projectId,
      title: "FRC intake",
      workspaceRoot,
      defaultModelSelection: null,
      onshapeSource: source,
      createdAt: now,
      updatedAt: now,
    };
    const engine = yield* makeEngine();
    const provisions = yield* Ref.make(0);
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer([pendingProject])),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () => Ref.update(provisions, (count) => count + 1),
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* OnshapeWorkspaceReactor;
        yield* reactor.start();
        assert.strictEqual(yield* Ref.get(provisions), 1);
        assert.strictEqual(
          (yield* Ref.get(engine.commands))[0]?.type,
          "project.onshape.workspace.ready",
        );
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("fails startup without deleting a pending project when reconciliation fails", () =>
  Effect.gen(function* () {
    const pendingProject: OrchestrationProjectShell = {
      id: projectId,
      title: "FRC intake",
      workspaceRoot,
      defaultModelSelection: null,
      onshapeSource: source,
      createdAt: now,
      updatedAt: now,
    };
    const engine = yield* makeEngine();
    const layer = OnshapeWorkspaceReactorLive.pipe(
      Layer.provide(snapshotLayer([pendingProject])),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine.engine)),
      Layer.provide(
        Layer.succeed(
          ManagedWorkspaceAllocator,
          ManagedWorkspaceAllocator.of({
            remove: () => Effect.die("Unexpected removal"),
            resolve: () => Effect.succeed(workspaceRoot),
            provision: () => Effect.die("disk unavailable"),
          }),
        ),
      ),
    );

    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* OnshapeWorkspaceReactor;
          yield* reactor.start();
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.deepStrictEqual(yield* Ref.get(engine.commands), []);
  }),
);
