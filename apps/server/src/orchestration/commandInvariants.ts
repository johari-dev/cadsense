import {
  onshapeProjectSourceIdentity,
  hasCadSource,
  isCadThreadRunActive,
  type OnshapeProjectSource,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
} from "@cadsense/contracts";
import { normalizeProjectPathForComparison } from "@cadsense/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function requireProjectCadIdle(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly includeRuns?: boolean;
  // The command links the project's CAD source, so a project without one is checked too.
  readonly linksSource?: boolean;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (!project || (!hasCadSource(project) && !input.linksSource)) return Effect.void;
  if (project.cad?.operation)
    return Effect.fail(
      invariantError(input.command.type, "A CAD operation is active for this project."),
    );
  if (
    input.includeRuns &&
    ((project.cad?.pendingPresentations?.length ?? 0) > 0 ||
      input.readModel.threads.some(
        (thread) => thread.projectId === input.projectId && isCadThreadRunActive(thread),
      ))
  )
    return Effect.fail(
      invariantError(input.command.type, "An agent run is active for this project."),
    );
  return Effect.void;
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireActiveProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  return requireProject(input).pipe(
    Effect.filterOrFail(
      (project) => project.deletedAt === null,
      () =>
        invariantError(
          input.command.type,
          `Project '${input.projectId}' is deleted for command '${input.command.type}'.`,
        ),
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

/** The folder and, for a local CAD project, the workspace-relative CAD file a project would hold. */
export interface ProjectPlace {
  readonly workspaceRoot: string;
  readonly filePath?: string | undefined;
  readonly exceptProjectId?: ProjectId | undefined;
}

/**
 * The active project that `place` would collide with, if any. Projects in one folder coexist only
 * when both review a CAD file and the files differ, so a project without a file (a plain folder
 * project, or an Onshape project's managed folder) keeps its folder to itself. Files compare with
 * the folder's case rule: case-insensitive on Windows drive and UNC paths.
 */
export function findConflictingProject<
  T extends Pick<OrchestrationProject, "id" | "workspaceRoot" | "deletedAt" | "localCadSource">,
>(projects: ReadonlyArray<T>, place: ProjectPlace): T | undefined {
  const folder = normalizeProjectPathForComparison(place.workspaceRoot);
  const file = (filePath: string) =>
    normalizeProjectPathForComparison(`${place.workspaceRoot}/${filePath}`);
  return projects.find(
    (project) =>
      project.deletedAt === null &&
      project.id !== place.exceptProjectId &&
      normalizeProjectPathForComparison(project.workspaceRoot) === folder &&
      (place.filePath === undefined ||
        project.localCadSource === undefined ||
        file(project.localCadSource.filePath) === file(place.filePath)),
  );
}

export function requireNoConflictingProject(
  input: ProjectPlace & {
    readonly readModel: OrchestrationReadModel;
    readonly command: OrchestrationCommand;
  },
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const existingProject = findConflictingProject(input.readModel.projects, input);
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      existingProject.localCadSource && input.filePath !== undefined
        ? `Active project '${existingProject.id}' already reviews '${input.filePath}' in '${input.workspaceRoot}'.`
        : `Active project '${existingProject.id}' already exists for workspace root '${input.workspaceRoot}'.`,
    ),
  );
}

export function requireActiveOnshapeProjectSourceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly source: OnshapeProjectSource;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const sourceIdentity = onshapeProjectSourceIdentity(input.source);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      project.onshapeSource !== undefined &&
      onshapeProjectSourceIdentity(project.onshapeSource) === sourceIdentity &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for this Onshape source.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Thread deletion is a soft delete and a draft keeps its client-minted id
  // across retries, so only a live row blocks creation. Projectors reset the
  // thread's rows when the id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
