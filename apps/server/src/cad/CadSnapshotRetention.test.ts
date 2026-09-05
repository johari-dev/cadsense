import {
  initialCadProjectState,
  OnshapeElementId,
  OnshapeWorkspaceId,
  ProjectId,
  type OrchestrationReadModel,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CadSnapshotStore, CadSnapshotStoreError } from "./CadSnapshotStore.ts";
import { pruneCadSnapshots } from "./CadSnapshotRetention.ts";

const unused = () => Effect.die("Unexpected test operation");
const projectId = ProjectId.make("retained-project");
const otherId = ProjectId.make("other-project");
const now = "2026-09-05T00:00:00Z";
const metadata = (snapshotId: string) => ({
  snapshotId,
  microversionId: OnshapeWorkspaceId.make("a".repeat(24)),
  createdAt: now,
  manifestBytes: 1,
  assetBytes: 0,
});
const model: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: now,
  threads: [],
  projects: [
    {
      id: projectId,
      title: "CAD",
      workspaceRoot: "C:/cad",
      defaultModelSelection: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      cad: {
        ...initialCadProjectState(),
        roots: [
          {
            rootId: "1".repeat(64),
            elementId: OnshapeElementId.make("a".repeat(24)),
            configuration: "default",
            kind: "assembly",
            current: metadata("current"),
            rollback: metadata("rollback"),
            lastOutcome: null,
          },
        ],
      },
    },
  ],
};
const run = (input: { operating?: boolean; pinned?: boolean; targetOnly?: boolean }) => {
  const removed: string[] = [];
  const protectedIds: string[] = [];
  const query = ProjectionSnapshotQuery.of({
    getCommandReadModel: () =>
      Effect.succeed(
        input.operating
          ? {
              ...model,
              projects: model.projects.map((project) => ({
                ...project,
                cad: {
                  ...project.cad!,
                  operation: { operationId: "active", kind: "sync", root: null, startedAt: now },
                },
              })),
            }
          : model,
      ),
    getProjectShellById: unused,
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
  });
  const store = CadSnapshotStore.of({
    checkReserve: unused,
    findGeometry: unused,
    putAsset: unused,
    publish: unused,
    load: unused,
    readAsset: unused,
    withPinned: unused,
    withAcquisition: (effect) => effect,
    list: () =>
      Effect.succeed(
        ["current", "rollback", "obsolete", "other"].map((snapshotId) => ({
          snapshotId,
          projectId: snapshotId === "other" ? otherId : projectId,
          rootId: "root",
          createdAt: now,
          byteLength: 1,
        })),
      ),
    remove: (ids, protectedSnapshots) =>
      Effect.gen(function* () {
        protectedIds.push(...protectedSnapshots);
        if (input.pinned) return yield* new CadSnapshotStoreError({ reason: "busy" });
        removed.push(...ids);
      }),
  });
  return {
    removed,
    protectedIds,
    effect: pruneCadSnapshots(input.targetOnly ? projectId : undefined).pipe(
      Effect.provideService(CadSnapshotStore, store),
      Effect.provideService(ProjectionSnapshotQuery, query),
    ),
  };
};

it.effect("retains current and rollback even for removed projects whose data was kept", () =>
  Effect.gen(function* () {
    const h = run({ targetOnly: true });
    yield* h.effect;
    assert.deepEqual(h.removed, ["obsolete"]);
    assert.deepEqual(h.protectedIds, ["current", "rollback"]);
  }),
);
it.effect("does not collect a project's publication while its operation is still reserved", () =>
  Effect.gen(function* () {
    const h = run({ operating: true });
    yield* h.effect;
    assert.deepEqual(h.removed, ["other"]);
  }),
);
it.effect("defers collection when a snapshot remains actively pinned", () =>
  Effect.gen(function* () {
    const h = run({ pinned: true });
    assert.equal((yield* h.effect.pipe(Effect.flip))._tag, "CadSnapshotStoreError");
    assert.deepEqual(h.removed, []);
  }),
);
