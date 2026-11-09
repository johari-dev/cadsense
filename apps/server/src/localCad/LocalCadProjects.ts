import {
  CommandId,
  LocalCadError,
  type LocalCadFilesListInput,
  type LocalCadFilesListResult,
  type LocalCadProjectCreateInput,
  type LocalCadProjectCreateResult,
  type LocalCadProjectSetFileInput,
  type LocalCadSourceCheckInput,
  type LocalCadSourceCheckResult,
  type ModelSelection,
  type OrchestrationProject,
  type ProjectId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { CadUserOperations } from "../cad/CadUserOperations.ts";
import { findConflictingProject, type ProjectPlace } from "../orchestration/commandInvariants.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { localCadElementId, resolveLocalCadFile, scanLocalCadFiles } from "./LocalCadFiles.ts";
import { LocalCadImport } from "./LocalCadImport.ts";

export interface LocalCadProjectCreate extends LocalCadProjectCreateInput {
  readonly defaultModelSelection?: ModelSelection | null;
}

/** User RPCs for local CAD projects. See LocalCad.md for the flow. */
export class LocalCadProjects extends Context.Service<
  LocalCadProjects,
  {
    /** Lists STEP and IGES files in a folder that may not be a project yet. */
    readonly listFiles: (
      input: LocalCadFilesListInput,
    ) => Effect.Effect<LocalCadFilesListResult, LocalCadError>;
    /**
     * Creates a project that reviews a CAD file and starts importing it. A folder can hold one
     * project per CAD file. If a project already reviews this file, it is reused, so the result's
     * project ID can differ from the requested one. A folder with a plain or Onshape project fails.
     */
    readonly create: (
      input: LocalCadProjectCreate,
    ) => Effect.Effect<LocalCadProjectCreateResult, LocalCadError>;
    /**
     * Points an existing folder project at a CAD file and starts importing it. Used by the CAD
     * panel's file prompt, so it turns a plain folder project into a local CAD project. Fails with
     * `file-in-use` when another project in the folder already reviews the file.
     */
    readonly setFile: (
      input: LocalCadProjectSetFileInput,
    ) => Effect.Effect<LocalCadProjectCreateResult, LocalCadError>;
    /**
     * Whether a root's file changed on disk since its current snapshot, so the CAD panel can offer
     * Sync. Never fails: anything it cannot compare is "unavailable".
     */
    readonly checkSource: (
      input: LocalCadSourceCheckInput,
    ) => Effect.Effect<LocalCadSourceCheckResult>;
  }
>()("@cadsense/server/localCad/LocalCadProjects") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const operations = yield* CadUserOperations;
  const localImport = yield* LocalCadImport;
  const workspacePaths = yield* WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const failed = () => new LocalCadError({ reason: "operation-failed" });
  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | WorkspacePaths>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(WorkspacePaths, workspacePaths),
    );
  const normalizeFolder = (workspaceRoot: string) =>
    workspacePaths
      .normalizeWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError(() => new LocalCadError({ reason: "folder-not-found" })));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => CommandId.make(`server:local-cad-${tag}:${id}`)),
      Effect.mapError(failed),
    );

  const listFiles = Effect.fn("LocalCadProjects.listFiles")(function* (
    input: LocalCadFilesListInput,
  ) {
    const workspaceRoot = yield* normalizeFolder(input.workspaceRoot);
    const scan = yield* withFiles(scanLocalCadFiles(workspaceRoot));
    return { workspaceRoot, ...scan };
  });

  /** The error for a place another project holds: its Onshape folder, its plain folder, or its file. */
  const conflictError = (project: Pick<OrchestrationProject, "onshapeSource" | "localCadSource">) =>
    new LocalCadError({
      reason: project.onshapeSource
        ? "onshape-project"
        : project.localCadSource
          ? "file-in-use"
          : "folder-in-use",
    });

  /**
   * The active project that `place` collides with, from the latest model. After a failed dispatch
   * this tells a lost race (another project took the file first) from a busy project.
   */
  const conflictFor = Effect.fn("LocalCadProjects.conflictFor")(function* (place: ProjectPlace) {
    const model = yield* query.getCommandReadModel().pipe(Effect.mapError(failed));
    return findConflictingProject(model.projects, place);
  });

  /** Starts importing a project's file. The project is usable without it; the panel offers Sync. */
  const startImport = (projectId: ProjectId, filePath: string) =>
    operations
      .start({
        projectId,
        kind: "sync",
        root: {
          elementId: localCadElementId(filePath),
          kind: "assembly",
          configuration: "default",
        },
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("Could not start the local CAD import", { projectId, error }),
        ),
      );

  const create = Effect.fn("LocalCadProjects.create")(function* (input: LocalCadProjectCreate) {
    const workspaceRoot = yield* normalizeFolder(input.workspaceRoot);
    const file = yield* withFiles(resolveLocalCadFile({ workspaceRoot, filePath: input.filePath }));
    const place = { workspaceRoot, filePath: file.relativePath };
    // A project that already reviews this file is the one to open. Any other conflict is the
    // folder's plain or Onshape project, which keeps the folder to itself.
    const existing = (yield* conflictFor(place)) ?? null;
    if (existing && !existing.localCadSource) return yield* conflictError(existing);
    let projectId = existing?.id ?? input.projectId;
    if (!existing) {
      const created = yield* engine
        .dispatch({
          type: "project.local-cad.create",
          commandId: yield* commandId("project-create"),
          projectId,
          title: input.title,
          workspaceRoot,
          defaultModelSelection: input.defaultModelSelection ?? null,
          localCadSource: { filePath: file.relativePath },
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!created) {
        // Another create for this file or folder won the race.
        const winner = yield* conflictFor(place);
        if (!winner) return yield* failed();
        if (!winner.localCadSource) return yield* conflictError(winner);
        projectId = winner.id;
      }
    }
    yield* startImport(projectId, file.relativePath);
    return { projectId };
  });

  const setFile = Effect.fn("LocalCadProjects.setFile")(function* (
    input: LocalCadProjectSetFileInput,
  ) {
    const project = yield* query.getProjectShellById(input.projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) return yield* new LocalCadError({ reason: "project-not-found" });
    if (project.value.onshapeSource) return yield* new LocalCadError({ reason: "onshape-project" });
    const { workspaceRoot } = project.value;
    const file = yield* withFiles(resolveLocalCadFile({ workspaceRoot, filePath: input.filePath }));
    const place = { workspaceRoot, filePath: file.relativePath, exceptProjectId: input.projectId };
    const taken = yield* conflictFor(place);
    if (taken) return yield* conflictError(taken);
    yield* engine
      .dispatch({
        type: "project.local-cad.set",
        commandId: yield* commandId("set"),
        projectId: input.projectId,
        localCadSource: { filePath: file.relativePath },
      })
      .pipe(
        Effect.catch(() =>
          // A project that took the file since the check above, or else an active run or import.
          conflictFor(place).pipe(
            Effect.flatMap((winner) =>
              Effect.fail(winner ? conflictError(winner) : new LocalCadError({ reason: "busy" })),
            ),
          ),
        ),
      );
    yield* startImport(input.projectId, file.relativePath);
    return { projectId: input.projectId };
  });

  const checkSource = Effect.fn("LocalCadProjects.checkSource")(function* (
    input: LocalCadSourceCheckInput,
  ) {
    const project = yield* query
      .getProjectShellById(input.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return { status: "unavailable" as const };
    return { status: yield* localImport.sourceStatus(project.value, input.rootId) };
  });

  return LocalCadProjects.of({ listFiles, create, setFile, checkSource });
});

export const layer = Layer.effect(LocalCadProjects, make);
