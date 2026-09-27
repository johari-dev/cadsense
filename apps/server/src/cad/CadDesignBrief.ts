import {
  CADSENSE_DESIGN_BRIEF_DEFAULT_PATH,
  CADSENSE_PROJECT_FILE_NAME,
} from "@cadsense/contracts";
import { parseCadsenseProjectFile } from "@cadsense/shared/cadsenseProjectFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/** Largest brief injected into review instructions. Longer files are cut here with a note. */
export const CAD_DESIGN_BRIEF_MAX_BYTES = 16 * 1024;

/** A designer-written brief read from the project workspace. See CadDesignBrief.md. */
export interface CadDesignBrief {
  /** Workspace-relative path the brief was read from. */
  readonly path: string;
  /** Size of the file on disk, before trimming and truncation. */
  readonly bytes: number;
  /** Trimmed markdown, cut at CAD_DESIGN_BRIEF_MAX_BYTES with a truncation note. */
  readonly content: string;
}

/** Trim the brief and cap it at the byte limit, telling the agent when content was cut. */
function capDesignBrief(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw).trim();
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= CAD_DESIGN_BRIEF_MAX_BYTES) return text;
  // Streaming decode drops a UTF-8 sequence split by the cut instead of emitting U+FFFD.
  const kept = new TextDecoder()
    .decode(encoded.subarray(0, CAD_DESIGN_BRIEF_MAX_BYTES), { stream: true })
    .trimEnd();
  return `${kept}\n\n[Design brief truncated at ${CAD_DESIGN_BRIEF_MAX_BYTES / 1024} KiB; the file is ${raw.byteLength} bytes.]`;
}

/**
 * Read the project's design brief: `designBrief` from cadsense.json, else DESIGN.md at the
 * workspace root. A missing or empty file means no brief. Every other problem (a path outside the
 * workspace, an unreadable file) is logged and also yields null, so a turn never fails because of
 * the brief. Called on each Codex turn, at Claude session start, and by cad_context.
 */
export const readCadDesignBrief = Effect.fn("readCadDesignBrief")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.make;
  const projectFile = yield* fileSystem
    .readFileString(path.join(workspaceRoot, CADSENSE_PROJECT_FILE_NAME))
    .pipe(
      Effect.map(parseCadsenseProjectFile),
      Effect.orElseSucceed(() => null),
    );
  const configuredPath = projectFile?.designBrief;
  const resolved = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot,
      relativePath: configuredPath ?? CADSENSE_DESIGN_BRIEF_DEFAULT_PATH,
    })
    .pipe(
      Effect.tapError(() =>
        Effect.logWarning("Ignoring the cadsense.json designBrief path outside the workspace.", {
          workspaceRoot,
          designBrief: configuredPath,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  if (!resolved) return null;
  const raw = yield* fileSystem.readFile(resolved.absolutePath).pipe(
    Effect.tapError((cause) =>
      cause.reason._tag === "NotFound" && configuredPath === undefined
        ? Effect.void
        : Effect.logWarning("Could not read the project design brief.", {
            path: resolved.relativePath,
            cause,
          }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!raw) return null;
  const content = capDesignBrief(raw);
  return content.length === 0
    ? null
    : ({ path: resolved.relativePath, bytes: raw.byteLength, content } satisfies CadDesignBrief);
});
