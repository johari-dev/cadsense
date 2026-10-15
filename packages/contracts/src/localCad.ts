import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Extensions a local CAD project can import, lowercase with the dot. */
export const LOCAL_CAD_FILE_EXTENSIONS = [".step", ".stp", ".iges", ".igs"] as const;

export const MAX_LOCAL_CAD_PATH_LENGTH = 1024;

/** Workspace-relative path with forward slashes, as the server resolved it. */
export const LocalCadFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_LOCAL_CAD_PATH_LENGTH),
);
export type LocalCadFilePath = typeof LocalCadFilePath.Type;

/** The CAD file a folder project reviews. Its presence is what makes the project CAD-capable. */
export const LocalCadProjectSource = Schema.Struct({
  filePath: LocalCadFilePath,
});
export type LocalCadProjectSource = typeof LocalCadProjectSource.Type;

export const LocalCadFilesListInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LOCAL_CAD_PATH_LENGTH)),
});
export type LocalCadFilesListInput = typeof LocalCadFilesListInput.Type;

export const LocalCadFileEntry = Schema.Struct({
  path: LocalCadFilePath,
  byteLength: NonNegativeInt,
  modifiedAt: IsoDateTime,
});
export type LocalCadFileEntry = typeof LocalCadFileEntry.Type;

export const LocalCadFilesListResult = Schema.Struct({
  /** Normalized absolute folder, which is what a project created from this listing will use. */
  workspaceRoot: TrimmedNonEmptyString,
  files: Schema.Array(LocalCadFileEntry),
  /** True when the scan stopped at its entry or depth limit before seeing the whole folder. */
  truncated: Schema.Boolean,
});
export type LocalCadFilesListResult = typeof LocalCadFilesListResult.Type;

export const LocalCadProjectCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LOCAL_CAD_PATH_LENGTH)),
  filePath: LocalCadFilePath,
});
export type LocalCadProjectCreateInput = typeof LocalCadProjectCreateInput.Type;

export const LocalCadProjectCreateResult = Schema.Struct({
  /** The requested ID, or the existing folder project's ID when the CAD file was attached to it. */
  projectId: ProjectId,
});
export type LocalCadProjectCreateResult = typeof LocalCadProjectCreateResult.Type;

/**
 * Links a CAD file to an existing folder project and imports it. `filePath` is workspace-relative
 * or absolute (a native file picker returns absolute paths); either way it must be in the folder.
 */
export const LocalCadProjectSetFileInput = Schema.Struct({
  projectId: ProjectId,
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LOCAL_CAD_PATH_LENGTH)),
});
export type LocalCadProjectSetFileInput = typeof LocalCadProjectSetFileInput.Type;

export const LocalCadErrorReason = Schema.Literals([
  "folder-not-found",
  "file-not-found",
  "outside-folder",
  "unsupported-file",
  "onshape-project",
  "project-not-found",
  "busy",
  "operation-failed",
]);
export type LocalCadErrorReason = typeof LocalCadErrorReason.Type;

export class LocalCadError extends Schema.TaggedErrorClass<LocalCadError>()("LocalCadError", {
  reason: LocalCadErrorReason,
}) {
  override get message(): string {
    switch (this.reason) {
      case "folder-not-found":
        return "That folder does not exist.";
      case "file-not-found":
        return "That CAD file is no longer in the folder.";
      case "outside-folder":
        return "The CAD file must be inside the project folder.";
      case "unsupported-file":
        return "Choose a STEP or IGES file.";
      case "onshape-project":
        return "That folder belongs to an Onshape project.";
      case "project-not-found":
        return "That project no longer exists.";
      case "busy":
        return "CAD is busy in that project. Wait for agent runs and imports to finish.";
      case "operation-failed":
        return "Could not save the local CAD change.";
    }
  }
}
