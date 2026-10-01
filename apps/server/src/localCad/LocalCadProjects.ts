import {
  CommandId,
  LocalCadError,
  type LocalCadFilesListInput,
  type LocalCadFilesListResult,
  type LocalCadProjectCreateInput,
  type LocalCadProjectCreateResult,
  type ModelSelection,
} from "@cadsense/contracts";
import { normalizeProjectPathForComparison } from "@cadsense/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CadUserOperations } from "../cad/CadUserOperations.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { localCadElementId, resolveLocalCadFile, scanLocalCadFiles } from "./LocalCadFiles.ts";

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
     * Points a folder project at a CAD file and starts importing it. Reuses the folder's existing
     * project when there is one, so the result's project ID can differ from the requested one.
     */
    readonly create: (
      input: LocalCadProjectCreate,
    ) => Effect.Effect<LocalCadProjectCreateResult, LocalCadError>;
  }
>()("@cadsense/server/localCad/LocalCadProjects") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const operations = yield* CadUserOperations;
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

  const create = Effect.fn("LocalCadProjects.create")(function* (input: LocalCadProjectCreate) {
    const workspaceRoot = yield* normalizeFolder(input.workspaceRoot);
    const file = yield* withFiles(resolveLocalCadFile({ workspaceRoot, filePath: input.filePath }));
    const model = yield* query.getCommandReadModel().pipe(Effect.mapError(failed));
    const folder = normalizeProjectPathForComparison(workspaceRoot);
    const existing = model.projects.find(
      (project) =>
        project.deletedAt === null &&
        normalizeProjectPathForComparison(project.workspaceRoot) === folder,
    );
    if (existing?.onshapeSource) return yield* new LocalCadError({ reason: "onshape-project" });
    const projectId = existing?.id ?? input.projectId;
    if (!existing)
      yield* engine
        .dispatch({
          type: "project.create",
          commandId: yield* commandId("project-create"),
          projectId,
          title: input.title,
          workspaceRoot,
          defaultModelSelection: input.defaultModelSelection ?? null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(failed));
    // The only invariant an existing folder project can fail here is an active run or import.
    yield* engine
      .dispatch({
        type: "project.local-cad.set",
        commandId: yield* commandId("set"),
        projectId,
        localCadSource: { filePath: file.relativePath },
      })
      .pipe(Effect.mapError(() => new LocalCadError({ reason: "busy" })));
    // The project is usable without the first import, and the panel and settings offer Sync.
    yield* operations
      .start({
        projectId,
        kind: "sync",
        root: {
          elementId: localCadElementId(file.relativePath),
          kind: "assembly",
          configuration: "default",
        },
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not start the first local CAD import", { projectId, error }),
        ),
      );
    return { projectId };
  });

  return LocalCadProjects.of({ listFiles, create });
});

export const layer = Layer.effect(LocalCadProjects, make);
