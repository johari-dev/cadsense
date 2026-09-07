import {
  isCadThreadRunActive,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread, requireActiveProject, requireProjectCadIdle } from "./commandInvariants.ts";

type CadCommand = Exclude<
  Extract<OrchestrationCommand, { type: `thread.cad.${string}` }>,
  { type: "thread.cad.presentation.settle" }
>;
export const decideCadPresentation = Effect.fn("decideCadPresentation")(function* (
  command: Extract<OrchestrationCommand, { type: "thread.cad.presentation.settle" }>,
  readModel: OrchestrationReadModel,
) {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  const project = yield* requireActiveProject({ readModel, command, projectId: thread.projectId });
  const pending = project.cad?.pendingPresentations?.find((item) => item.threadId === thread.id);
  if (
    !pending ||
    pending.captureId !== command.captureId ||
    !project.cad ||
    isCadThreadRunActive(thread)
  )
    return yield* fail("CAD presentation is not ready to settle.");
  if (command.view) {
    const revision =
      readModel.cadUserViews?.find((item) => item.threadId === thread.id)?.revision ?? null;
    if (
      revision !== command.expectedUserRevision ||
      command.view.revision !== (revision === null ? 0 : revision + 1)
    )
      return yield* fail("CAD revision conflict.");
    const root = project.cad.roots.find((item) => item.rootId === command.view?.rootId);
    if (
      command.view.rootId !== pending.rootId ||
      root?.current?.snapshotId !== command.view.snapshotId
    )
      return yield* fail("CAD capability unavailable.");
  }
  return {
    project,
    cad: {
      ...project.cad,
      pendingPresentations:
        project.cad.pendingPresentations?.filter((item) => item.threadId !== thread.id) ?? [],
    },
  };
});
export const decideCadSession = Effect.fn("decideCadSession")(function* (
  command: CadCommand,
  readModel: OrchestrationReadModel,
) {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  const project = yield* requireActiveProject({ readModel, command, projectId: thread.projectId });
  if (thread.deletedAt !== null || !project.onshapeSource || project.cad?.enabled === false)
    return yield* fail("CAD capability unavailable.");
  yield* requireProjectCadIdle({
    readModel,
    command,
    projectId: project.id,
    includeRuns: command.type === "thread.cad.user-view.set",
  });
  if (command.type === "thread.cad.context.ensure") {
    const existing = readModel.cadSessions?.find(
      (session) => session.threadId === thread.id && session.childKey === command.childKey,
    );
    if (existing)
      return { type: "thread.cad-context-ensured" as const, payload: { session: existing } };
    if (readModel.cadSessions?.some((session) => session.contextId === command.contextId))
      return yield* fail("CAD context identity conflict.");
    return {
      type: "thread.cad-context-ensured" as const,
      payload: {
        session: {
          contextId: command.contextId,
          threadId: thread.id,
          childKey: command.childKey,
          revision: null,
        },
      },
    };
  }
  if (command.type === "thread.cad.capture.record") {
    const session = readModel.cadSessions?.find(
      (item) => item.contextId === command.contextId && item.threadId === thread.id,
    );
    if (!session || session.revision !== command.capture.revision)
      return yield* fail("CAD revision conflict.");
    const root = project.cad?.roots.find((item) => item.rootId === command.capture.rootId);
    if (
      !root ||
      ![root.current?.snapshotId, root.rollback?.snapshotId].includes(command.capture.snapshotId)
    )
      return yield* fail("CAD capability unavailable.");
    return {
      type: "thread.cad-capture-recorded" as const,
      payload: {
        threadId: thread.id,
        contextId: command.contextId,
        turnId: command.turnId,
        capture: command.capture,
        cameraPose: command.cameraPose,
      },
    };
  }
  const lineage = project.cad?.roots.find((root) => root.rootId === command.view.rootId);
  if (
    !lineage ||
    (lineage.current?.snapshotId !== command.view.snapshotId &&
      lineage.rollback?.snapshotId !== command.view.snapshotId)
  )
    return yield* fail("CAD capability unavailable.");
  if (command.type === "thread.cad.view.set") {
    const session = readModel.cadSessions?.find(
      (item) => item.contextId === command.contextId && item.threadId === thread.id,
    );
    if (!session) return yield* fail("CAD capability unavailable.");
    if (
      session.revision !== command.expectedRevision ||
      (session.revision === null
        ? command.view.revision !== 0 && command.view.revision !== 1
        : command.view.revision !== session.revision + 1)
    )
      return yield* fail("CAD revision conflict.");
    return {
      type: "thread.cad-view-set" as const,
      payload: { threadId: thread.id, contextId: session.contextId, view: command.view },
    };
  }
  const revision =
    readModel.cadUserViews?.find((item) => item.threadId === thread.id)?.revision ?? null;
  if (
    revision !== command.expectedRevision ||
    command.view.revision !== (revision === null ? 0 : revision + 1)
  )
    return yield* fail("CAD revision conflict.");
  return {
    type: "thread.cad-user-view-set" as const,
    payload: { threadId: thread.id, view: command.view },
  };
});
