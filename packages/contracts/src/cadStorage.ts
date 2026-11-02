import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import { CadSnapshotId } from "./cad.ts";

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

/** Longest thumbnail data URL a client may upload, in characters: about 60 KB of image. */
export const CAD_THUMBNAIL_MAX_DATA_URL_LENGTH = 80_000;
/**
 * A snapshot's sidebar and home preview image, captured once by the CAD panel. WebP where the
 * browser encodes it, else JPEG.
 */
export const CadThumbnailSaveInput = Schema.Struct({
  snapshotId: CadSnapshotId,
  image: Schema.String.check(
    Schema.isMaxLength(CAD_THUMBNAIL_MAX_DATA_URL_LENGTH),
    Schema.isPattern(/^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
  ),
});
export type CadThumbnailSaveInput = typeof CadThumbnailSaveInput.Type;
