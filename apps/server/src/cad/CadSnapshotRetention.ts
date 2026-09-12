import type { ProjectId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";

/** Current and rollback pointers own retention. The store independently fences active pins and acquisitions. */
export const pruneCadSnapshots = Effect.fn("pruneCadSnapshots")(function* (projectId?: ProjectId) {
  const store = yield* CadSnapshotStore;
  const query = yield* ProjectionSnapshotQuery;
  // Enumerate first: a concurrently published snapshot cannot become a deletion candidate.
  const stored = yield* store.list();
  const model = yield* query.getCommandReadModel();
  const protectedIds = model.projects.flatMap(
    (project) =>
      project.cad?.roots.flatMap((root) =>
        [root.current?.snapshotId, root.rollback?.snapshotId].filter(
          (id): id is string => id !== undefined,
        ),
      ) ?? [],
  );
  for (const comment of model.cadComments ?? []) {
    const thread = model.threads.find((t) => t.id === comment.threadId && t.deletedAt === null);
    if (thread && model.projects.some((p) => p.id === thread.projectId && p.deletedAt === null))
      protectedIds.push(comment.snapshotId);
  }
  const protectedSet = new Set(protectedIds);
  const operatingProjects = new Set(
    model.projects.filter((project) => project.cad?.operation).map((project) => project.id),
  );
  const obsolete = stored.filter(
    (snapshot) =>
      (projectId === undefined || snapshot.projectId === projectId) &&
      !operatingProjects.has(snapshot.projectId) &&
      !protectedSet.has(snapshot.snapshotId),
  );
  if (obsolete.length > 0)
    yield* store.remove(
      obsolete.map((snapshot) => snapshot.snapshotId),
      protectedIds,
    );
});
