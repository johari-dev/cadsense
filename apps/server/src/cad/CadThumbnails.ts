import { CadUserOperationError, type CadThumbnailSaveInput } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import { CAD_THUMBNAIL_EXTENSIONS, CadSnapshotStore } from "./CadSnapshotStore.ts";

/**
 * Snapshot thumbnails live at `<stateDir>/cad/thumbnails/<snapshotId>.<extension>`, one per
 * snapshot, and the snapshot store removes them with their snapshot. The CAD panel captures
 * each once and saves it with `cad.thumbnail.save`; the sidebar and home preview load it
 * through a `cad-thumbnail` asset URL.
 */
export const cadThumbnailPaths = (path: Path.Path, stateDir: string, snapshotId: string) =>
  CAD_THUMBNAIL_EXTENSIONS.map((extension) =>
    path.join(stateDir, "cad", "thumbnails", `${snapshotId}.${extension}`),
  );

export const saveCadThumbnail = Effect.fn("saveCadThumbnail")(function* (
  input: CadThumbnailSaveInput,
) {
  const store = yield* CadSnapshotStore;
  // The input schema already limits the data URL to a WebP or JPEG base64 payload.
  const bytes = Encoding.decodeBase64(input.image.slice(input.image.indexOf(",") + 1));
  if (Result.isFailure(bytes))
    return yield* new CadUserOperationError({ reason: "operation-failed" });
  yield* store.putThumbnail(input.snapshotId, bytes.success).pipe(
    Effect.mapError(
      (error) =>
        new CadUserOperationError({
          reason:
            error.reason === "disk-space"
              ? "disk-space"
              : error.reason === "unavailable"
                ? "not-found"
                : "operation-failed",
        }),
    ),
  );
});
