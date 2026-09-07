import { CadUserOperationError, type ProjectId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CadProjectQuiescence } from "./CadUserOperations.ts";

export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const liveness = yield* ThreadBackgroundLivenessService;
  const busy = () => new CadUserOperationError({ reason: "busy" });
  const read = Effect.fn(function* (projectId: ProjectId) {
    const model = yield* query.getCommandReadModel().pipe(Effect.mapError(busy));
    const project = model.projects.find((entry) => entry.id === projectId);
    if (!project?.cad?.operation || project.deletedAt !== null) return yield* busy();
    // Include archived/deleted threads: an earlier ordinary stop may still await native exit.
    const threads = model.threads.filter((entry) => entry.projectId === projectId);
    if (
      threads.some(
        (thread) =>
          (thread.turnAdmission?.pending.length ?? 0) > 0 ||
          thread.session?.status === "starting" ||
          thread.session?.status === "running" ||
          thread.session?.activeTurnId != null ||
          thread.latestTurn?.state === "running" ||
          liveness.getThreadBackgroundLiveness(thread.id) === "working",
      )
    )
      return yield* busy();
    return {
      operationId: project.cad.operation.operationId,
      threads: new Set(threads.map((entry) => entry.id)),
    };
  });
  const confirm = Effect.fn("CadProjectQuiescence.confirm")(function* (projectId: ProjectId) {
    const before = yield* read(projectId);
    const sessions = yield* providers.listSessions();
    const threadIds = new Set(
      sessions
        .filter((session) => before.threads.has(session.threadId))
        .map((session) => session.threadId),
    );
    for (const threadId of threadIds)
      yield* providers.stopIdleSession({ threadId }).pipe(Effect.mapError(busy));
    const after = yield* read(projectId);
    if (after.operationId !== before.operationId) return yield* busy();
    if ((yield* providers.listSessions()).some((session) => after.threads.has(session.threadId)))
      return yield* busy();
  });
  return CadProjectQuiescence.of({ confirm });
});
export const layer = Layer.effect(CadProjectQuiescence, make);
