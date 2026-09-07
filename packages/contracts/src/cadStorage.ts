import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

const choices = { deleteCad: Schema.Boolean, deleteWorkspace: Schema.Boolean };
export const CadStorageInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("remove"), projectId: ProjectId, ...choices }),
  Schema.Struct({
    kind: Schema.Literal("cleanup"),
    projectId: ProjectId,
    removedAt: IsoDateTime,
    ...choices,
  }),
  Schema.Struct({
    kind: Schema.Literals(["restore", "retry"]),
    projectId: ProjectId,
    removedAt: IsoDateTime,
  }),
]);
export type CadStorageInput = typeof CadStorageInput.Type;
export const CadStorageEntry = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  removedAt: IsoDateTime,
  ...choices,
  cleanupPending: Schema.Boolean,
  byteLength: NonNegativeInt,
});
export type CadStorageEntry = typeof CadStorageEntry.Type;
