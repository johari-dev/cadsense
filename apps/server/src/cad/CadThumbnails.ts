import { CadUserOperationError, type CadThumbnailSaveInput } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  CAD_SNAPSHOT_IMAGES,
  CadSnapshotStore,
  type CadSnapshotImageKind,
} from "./CadSnapshotStore.ts";

/**
 * A snapshot's preview images live at `<stateDir>/cad/thumbnails/<snapshotId>.<extension>` and
 * `<stateDir>/cad/backdrops/<snapshotId>.webp`, one of each per snapshot, and the snapshot store
 * removes them with their snapshot. The CAD panel captures each once and saves it with
 * `cad.thumbnail.save`. The sidebar loads the thumbnail through a `cad-thumbnail` asset URL, and
 * the new thread view loads the backdrop through a `cad-backdrop` one.
 */
export const cadThumbnailPaths = (
  path: Path.Path,
  stateDir: string,
  snapshotId: string,
  kind: CadSnapshotImageKind = "thumbnail",
) =>
  CAD_SNAPSHOT_IMAGES[kind].extensions.map((extension) =>
    path.join(stateDir, "cad", CAD_SNAPSHOT_IMAGES[kind].directory, `${snapshotId}.${extension}`),
  );

export const saveCadThumbnail = Effect.fn("saveCadThumbnail")(function* (
  input: CadThumbnailSaveInput,
) {
  const store = yield* CadSnapshotStore;
  // The input schema already limits the data URL to a base64 payload in a format its kind takes.
  const bytes = Encoding.decodeBase64(input.image.slice(input.image.indexOf(",") + 1));
  if (Result.isFailure(bytes))
    return yield* new CadUserOperationError({ reason: "operation-failed" });
  yield* store.putThumbnail(input.snapshotId, bytes.success, input.kind).pipe(
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
