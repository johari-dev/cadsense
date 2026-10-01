import { CADSENSE_PROJECT_FILE_NAME, type CadReviewIgnoreMatch } from "@cadsense/contracts";
import { parseCadsenseProjectFile } from "@cadsense/shared/cadsenseProjectFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Read a project's cadsense.json `reviewIgnore` entries. Called on every hierarchy read,
 * publication, and turn start so edits apply without a restart. A missing file yields no
 * entries; an invalid file is logged and also yields none, matching how other readers treat it
 * as absent.
 */
export const readCadReviewIgnore = Effect.fn("readCadReviewIgnore")(function* (
  workspaceRoot: string,
): Effect.fn.Return<ReadonlyArray<CadReviewIgnoreMatch>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(workspaceRoot, CADSENSE_PROJECT_FILE_NAME);
  const contents = yield* fs.readFileString(file).pipe(Effect.option);
  if (contents._tag === "None") return [];
  const parsed = parseCadsenseProjectFile(contents.value);
  if (parsed === null) {
    yield* Effect.logWarning("Ignoring invalid cadsense.json; CAD review ignore list is off", {
      file,
    });
    return [];
  }
  return parsed.reviewIgnore ?? [];
});
