import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FileManagerRevealKind = Schema.Literals(["finder", "file-explorer", "files"]);
export type FileManagerRevealKind = typeof FileManagerRevealKind.Type;

export const OpenInFileManagerInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reveal: Schema.optional(Schema.Boolean),
});
export type OpenInFileManagerInput = typeof OpenInFileManagerInput.Type;

export class FileManagerSpawnError extends Schema.TaggedErrorClass<FileManagerSpawnError>()(
  "FileManagerSpawnError",
  {
    target: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open '${this.target}' in the file manager with '${[
      this.command,
      ...this.args,
    ].join(" ")}'`;
  }
}

export const FileManagerError = FileManagerSpawnError;
export type FileManagerError = typeof FileManagerError.Type;

export const isFileManagerError = Schema.is(FileManagerError);
