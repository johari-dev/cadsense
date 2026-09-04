import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OnshapeConnectionId,
  OnshapeConnectionSummary,
  OnshapeDocumentId,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  OnshapeWorkspaceProvisionError,
  OnshapeWorkspaceReactor,
} from "../orchestration/Services/OnshapeWorkspaceReactor.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import { OnshapeConnections } from "./OnshapeConnections.ts";
import { make } from "./OnshapeProjects.ts";

const now = "2026-09-04T00:00:00.000Z";
const projectId = ProjectId.make("onshape-project");
const connectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001");
const otherConnectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000002");
const connection = OnshapeConnectionSummary.make({
  connectionId,
  name: "Onshape",
  host: "https://cad.onshape.com",
  verifiedAt: now,
  updatedAt: now,
});
const source = OnshapeProjectSource.make({
  connectionId,
  host: connection.host,
  documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
  configuration: "",
});
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "FRC intake",
  workspaceRoot: "C:/cadsense/managed-workspaces/project-hash",
  defaultModelSelection: null,
  onshapeSource: source,
  createdAt: now,
  updatedAt: now,
};

const unsupported = () => Effect.die("Unused test service method.");

const makeHarness = Effect.fn(function* (options?: {
  readonly connections?: ReadonlyArray<OnshapeConnectionSummary>;
  readonly project?: OrchestrationProjectShell;
  readonly dispatchConflict?: boolean;
  readonly workspaceFailure?: boolean;
}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const resolveCount = yield* Ref.make(0);
  const drainedSequences = yield* Ref.make<ReadonlyArray<number>>([]);

  const dependencies = Layer.mergeAll(
    Layer.succeed(
      OnshapeConnections,
      OnshapeConnections.of({
        list: () =>
          Effect.succeed({
            connections: options?.connections ?? [connection],
            catalogUpdatedAt: connection.updatedAt,
          }),
        create: unsupported,
        rename: unsupported,
        replaceCredentials: unsupported,
        remove: unsupported,
      }),
    ),
    Layer.succeed(
      ManagedWorkspaceAllocator,
      ManagedWorkspaceAllocator.of({
        resolve: (id) =>
          Ref.update(resolveCount, (count) => count + 1).pipe(
            Effect.as(`C:/cadsense/managed-workspaces/${id}`),
          ),
        provision: unsupported,
      }),
    ),
    Layer.succeed(
      OnshapeWorkspaceReactor,
      OnshapeWorkspaceReactor.of({
        start: () => Effect.void,
        drainThrough: (sequence) =>
          Ref.update(drainedSequences, (current) => [...current, sequence]).pipe(
            Effect.andThen(
              options?.workspaceFailure === true
                ? Effect.fail(new OnshapeWorkspaceProvisionError({ projectId }))
                : Effect.void,
            ),
          ),
      }),
    ),
    Layer.succeed(
      OrchestrationEngineService,
      OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(commands, (current) => [...current, command]).pipe(
            Effect.andThen(
              options?.dispatchConflict === true
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "Onshape source already exists.",
                    }),
                  )
                : Effect.succeed({ sequence: 1 }),
            ),
          ),
        subscribeDomainEvents: unsupported(),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.succeed(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getCommandReadModel: () => unsupported(),
        getSnapshot: () => unsupported(),
        getShellSnapshot: () => unsupported(),
        listPendingOnshapeProjects: () => unsupported(),
        getArchivedShellSnapshot: () => unsupported(),
        searchThreads: () => unsupported(),
        getSnapshotSequence: () => unsupported(),
        getCounts: () => unsupported(),
        getActiveProjectByWorkspaceRoot: () => unsupported(),
        getProjectShellById: () => Effect.succeed(Option.fromNullishOr(options?.project)),
        getFirstActiveThreadIdByProjectId: () => unsupported(),
        getThreadShellById: () => unsupported(),
        getThreadDetailById: () => unsupported(),
        getThreadDetailSnapshot: () => unsupported(),
      }),
    ),
  );

  return {
    projects: yield* make.pipe(Effect.provide(dependencies)),
    commands,
    resolveCount,
    drainedSequences,
  };
});

it.layer(NodeServices.layer)("OnshapeProjects", (it) => {
  it.effect("creates from a validated local URL without an Onshape transport", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.projects.create({
        projectId,
        title: "FRC intake",
        connectionId,
        url: "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
      });

      assert.strictEqual(result.projectId, projectId);
      assert.strictEqual(yield* Ref.get(harness.resolveCount), 1);
      assert.deepStrictEqual(yield* Ref.get(harness.drainedSequences), [1]);
      const command = (yield* Ref.get(harness.commands))[0];
      assert.strictEqual(command?.type, "project.onshape.create");
      if (command?.type !== "project.onshape.create") return;
      assert.strictEqual(command.onshapeSource.documentId, "05760c4d8b40fba37db8fa48");
      assert.strictEqual(command.workspaceRoot, `C:/cadsense/managed-workspaces/${projectId}`);
    }),
  );

  it.effect("fails before allocating a workspace when the connection or URL is invalid", () =>
    Effect.gen(function* () {
      const missingConnection = yield* makeHarness({ connections: [] });
      const missingError = yield* Effect.flip(
        missingConnection.projects.create({
          projectId,
          title: "FRC intake",
          connectionId,
          url: "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
        }),
      );
      assert.strictEqual(missingError._tag, "OnshapeConnectionNotFoundError");
      assert.strictEqual(yield* Ref.get(missingConnection.resolveCount), 0);

      const mismatchedHost = yield* makeHarness();
      const hostError = yield* Effect.flip(
        mismatchedHost.projects.create({
          projectId,
          title: "FRC intake",
          connectionId,
          url: "https://team.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
        }),
      );
      assert.strictEqual(hostError._tag, "OnshapeProjectHostMismatchError");
      assert.strictEqual(yield* Ref.get(mismatchedHost.resolveCount), 0);
    }),
  );

  it.effect("does not await workspace provisioning when the source conflicts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ dispatchConflict: true });
      const error = yield* Effect.flip(
        harness.projects.create({
          projectId,
          title: "FRC intake",
          connectionId,
          url: "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
        }),
      );

      assert.strictEqual(error._tag, "OnshapeProjectConflictError");
      assert.deepStrictEqual(yield* Ref.get(harness.drainedSequences), []);
    }),
  );

  it.effect("reports a workspace provisioning failure after the create event is accepted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workspaceFailure: true });
      const error = yield* Effect.flip(
        harness.projects.create({
          projectId,
          title: "FRC intake",
          connectionId,
          url: "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
        }),
      );

      assert.strictEqual(error._tag, "OnshapeProjectOperationError");
      assert.deepStrictEqual(yield* Ref.get(harness.drainedSequences), [1]);
    }),
  );

  it.effect("rebinds an existing project only to a connection on the same host", () =>
    Effect.gen(function* () {
      const compatible = OnshapeConnectionSummary.make({
        ...connection,
        connectionId: otherConnectionId,
        name: "Replacement",
      });
      const harness = yield* makeHarness({ connections: [connection, compatible], project });
      yield* harness.projects.setConnection({ projectId, connectionId: otherConnectionId });
      const command = (yield* Ref.get(harness.commands))[0];
      assert.strictEqual(command?.type, "project.onshape.connection.set");
      if (command?.type !== "project.onshape.connection.set") return;
      assert.strictEqual(command.projectId, projectId);
      assert.strictEqual(command.connectionId, otherConnectionId);

      const otherHost = OnshapeConnectionSummary.make({
        ...compatible,
        host: "https://team.onshape.com",
      });
      const mismatch = yield* makeHarness({ connections: [otherHost], project });
      const error = yield* Effect.flip(
        mismatch.projects.setConnection({ projectId, connectionId: otherConnectionId }),
      );
      assert.strictEqual(error._tag, "OnshapeProjectHostMismatchError");
    }),
  );
});
