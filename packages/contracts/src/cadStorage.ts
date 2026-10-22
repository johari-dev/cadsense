import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

// `deleteWorkspace` applies only to an Onshape project's server-managed workspace. A local CAD
// project's folder belongs to the user and is never deleted.
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
  source: Schema.Literals(["onshape", "local"]),
  removedAt: IsoDateTime,
  ...choices,
  cleanupPending: Schema.Boolean,
  byteLength: NonNegativeInt,
});
export type CadStorageEntry = typeof CadStorageEntry.Type;
