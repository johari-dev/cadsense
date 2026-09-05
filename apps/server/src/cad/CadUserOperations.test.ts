import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CadUserOperationError,
  OnshapeProjectSource,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OnshapeCadRoots } from "../onshape/OnshapeCadRoots.ts";
import { OnshapeSnapshotAcquisition } from "../onshape/OnshapeSnapshotAcquisition.ts";
import { CadSnapshotStore, CadSnapshotStoreError } from "./CadSnapshotStore.ts";
import { CadProjectQuiescence, make } from "./CadUserOperations.ts";

const unused = () => Effect.die("Unexpected test operation");
const projectId = ProjectId.make("cad-user-operations");
const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  workspaceType: "m",
  workspaceId: "b".repeat(24),
  configuration: "",
});
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "CAD",
  workspaceRoot: "C:/cad",
  onshapeSource: source,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
  defaultModelSelection: null,
};
const harness = Effect.fn(function* (options?: {
  busy?: boolean;
  diskFull?: boolean;
  holdQuiescence?: boolean;
}) {
  const calls = yield* Ref.make<string[]>([]);
  const commands = yield* Ref.make<OrchestrationCommand[]>([]);
  const settled = yield* Deferred.make<OrchestrationCommand>();
  const quiescing = yield* Deferred.make<void>();
  const reserve = Effect.fn(function* () {
    yield* Ref.update(calls, (values) => [...values, "reserve-space"]);
    if (options?.diskFull) return yield* new CadSnapshotStoreError({ reason: "disk-space" });
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      subscribeDomainEvents: unused(),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (values) => [...values, command]);
          if (command.type === "project.cad.operation.reserve" && options?.busy)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Project is busy",
            });
          if (
            command.type === "project.cad.operation.complete" ||
            command.type === "project.cad.operation.end"
          )
            yield* Deferred.succeed(settled, command);
          return { sequence: 1 };
        }),
    }),
    Layer.succeed(ProjectionSnapshotQuery, {
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getCommandReadModel: () =>
        Effect.succeed({
          snapshotSequence: 0,
          updatedAt: project.updatedAt,
          projects: [{ ...project, deletedAt: null }],
          threads: [],
        }),
      getSnapshot: unused,
      getShellSnapshot: unused,
      listPendingOnshapeProjects: unused,
      getArchivedShellSnapshot: unused,
      searchThreads: unused,
      getSnapshotSequence: unused,
      getCounts: unused,
      getActiveProjectByWorkspaceRoot: unused,
      getFirstActiveThreadIdByProjectId: unused,
      getThreadShellById: unused,
      getThreadDetailById: unused,
      getThreadDetailSnapshot: unused,
    }),
    Layer.succeed(CadSnapshotStore, {
      checkReserve: reserve,
      findGeometry: unused,
      putAsset: unused,
      publish: unused,
      load: unused,
      readAsset: unused,
      list: () => Effect.succeed([]),
      remove: unused,
      withPinned: unused,
      withAcquisition: unused,
    }),
    Layer.succeed(OnshapeCadRoots, {
      discover: (_source, beforeRequest) =>
        (beforeRequest ?? Effect.void).pipe(
          Effect.andThen(Ref.update(calls, (values) => [...values, "remote"])),
          Effect.as({ microversionId: source.workspaceId, roots: [], sourceElement: null }),
        ),
    }),
    Layer.succeed(OnshapeSnapshotAcquisition, { acquire: unused }),
    Layer.succeed(CadProjectQuiescence, {
      confirm: () =>
        Ref.update(calls, (values) => [...values, "quiesce"]).pipe(
          Effect.andThen(Deferred.succeed(quiescing, undefined)),
          Effect.andThen(options?.holdQuiescence ? Effect.never : Effect.void),
        ),
    }),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  return { service, calls, commands, settled, quiescing };
});

it.layer(NodeServices.layer)("User-only CAD operations", (it) => {
  it.effect(
    "does not discover until explicitly started, then reserves and confirms idle before network",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        assert.deepEqual(yield* Ref.get(h.calls), []);
        const accepted = yield* h.service.start({ projectId, kind: "discover" });
        const completed = yield* Deferred.await(h.settled);
        assert.equal(completed.type, "project.cad.operation.complete");
        assert.equal("operationId" in completed && completed.operationId, accepted.operationId);
        assert.deepEqual(yield* Ref.get(h.calls), [
          "reserve-space",
          "quiesce",
          "reserve-space",
          "remote",
        ]);
      }),
  );
  it.effect("denied admission never performs local shutdown or remote requests", () =>
    Effect.gen(function* () {
      const h = yield* harness({ busy: true });
      assert.deepEqual(
        yield* h.service.start({ projectId, kind: "discover" }).pipe(Effect.flip),
        new CadUserOperationError({ reason: "busy" }),
      );
      assert.deepEqual(yield* Ref.get(h.calls), []);
    }),
  );
  it.effect("low disk fails the accepted operation without contacting Onshape", () =>
    Effect.gen(function* () {
      const h = yield* harness({ diskFull: true });
      yield* h.service.start({ projectId, kind: "discover" });
      const result = yield* Deferred.await(h.settled);
      assert.equal(result.type, "project.cad.operation.end");
      assert.equal("status" in result && result.status, "failed");
      assert.include("reason" in result ? result.reason : "", "2 GiB");
      assert.deepEqual(yield* Ref.get(h.calls), ["reserve-space"]);
    }),
  );
  it.effect(
    "cancellation waits for the matching operation's terminal receipt before returning",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ holdQuiescence: true });
        const started = yield* h.service.start({ projectId, kind: "discover" });
        yield* Deferred.await(h.quiescing);
        yield* h.service.cancel(projectId, started.operationId);
        const result = yield* Deferred.await(h.settled);
        assert.equal("status" in result && result.status, "cancelled");
        assert.deepEqual(yield* Ref.get(h.calls), ["reserve-space", "quiesce"]);
      }),
  );
});
