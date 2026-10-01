// @effect-diagnostics nodeBuiltinImport:off
// The folder scan needs Dirent types to skip symlinks without a stat per entry.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import {
  LOCAL_CAD_FILE_EXTENSIONS,
  LocalCadError,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeWorkspaceId,
  type CadCatalog,
  type CadSnapshotRoot,
  type LocalCadFileEntry,
  type ProjectId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import type { LocalCadFormat } from "./LocalCadTessellation.ts";

/** Snapshot `host` for local files. Onshape hosts are URLs, so this cannot collide. */
export const LOCAL_CAD_HOST = "local";
export const MAX_LOCAL_CAD_FILE_BYTES = 512 * 1024 * 1024;

const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_ENTRIES = 20_000;
const SCAN_MAX_FILES = 500;

const id24 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

/** The catalog element for one file: a hash of its workspace-relative path. */
export const localCadElementId = (filePath: string) =>
  OnshapeElementId.make(id24(`local-cad-file:${filePath}`));

/** A file revision: a hash of its bytes, so an unchanged file keeps its comment revision. */
export const localCadMicroversionId = (bytes: Uint8Array) => OnshapeWorkspaceId.make(id24(bytes));

/** The identity fields `snapshotRootId` hashes, for one file in one project. See LocalCad.md. */
export const localCadRootIdentity = (projectId: ProjectId, filePath: string) => {
  const documentId = id24(`local-cad-project:${projectId}`);
  return {
    host: LOCAL_CAD_HOST,
    documentId: OnshapeDocumentId.make(documentId),
    originalRevision: { kind: "w", id: OnshapeWorkspaceId.make(documentId) },
    elementId: localCadElementId(filePath),
    configuration: "default",
  } satisfies Pick<
    CadSnapshotRoot,
    "host" | "documentId" | "originalRevision" | "elementId" | "configuration"
  >;
};

export const localCadFormat = (filePath: string): LocalCadFormat | null => {
  const lower = filePath.toLowerCase();
  if (!LOCAL_CAD_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null;
  return lower.endsWith(".iges") || lower.endsWith(".igs") ? "iges" : "step";
};

/**
 * Resolves a CAD file chosen inside a project folder. Rejects paths that leave the folder,
 * including through symlinks, files that are not STEP or IGES, and files that do not exist.
 */
export const resolveLocalCadFile = Effect.fn("resolveLocalCadFile")(function* (input: {
  readonly workspaceRoot: string;
  readonly filePath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const resolved = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.filePath,
    })
    .pipe(Effect.mapError(() => new LocalCadError({ reason: "outside-folder" })));
  const format = localCadFormat(resolved.relativePath);
  if (format === null) return yield* new LocalCadError({ reason: "unsupported-file" });
  const notFound = () => new LocalCadError({ reason: "file-not-found" });
  const realRoot = yield* fileSystem
    .realPath(input.workspaceRoot)
    .pipe(Effect.mapError(() => new LocalCadError({ reason: "folder-not-found" })));
  const realFile = yield* fileSystem
    .realPath(resolved.absolutePath)
    .pipe(Effect.mapError(notFound));
  const relativeToRoot = path.relative(realRoot, realFile);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  )
    return yield* new LocalCadError({ reason: "outside-folder" });
  const info = yield* fileSystem.stat(realFile).pipe(Effect.mapError(notFound));
  if (info.type !== "File") return yield* notFound();
  return {
    absolutePath: realFile,
    relativePath: resolved.relativePath,
    format,
    byteLength: Number(info.size),
  };
});

/**
 * Lists STEP and IGES files under a folder, breadth first and sorted by path. Skips hidden
 * directories, node_modules, and symlinks, and stops at fixed depth, entry, and file limits.
 */
export const scanLocalCadFiles = Effect.fn("scanLocalCadFiles")(function* (workspaceRoot: string) {
  const path = yield* Path.Path;
  const files: LocalCadFileEntry[] = [];
  let visited = 0;
  let truncated = false;
  let frontier = [""];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth > SCAN_MAX_DEPTH) {
      truncated = true;
      break;
    }
    const next: string[] = [];
    for (const relativeDir of frontier) {
      const entries = yield* Effect.tryPromise(() =>
        NodeFSP.readdir(path.join(workspaceRoot, relativeDir), { withFileTypes: true }),
      ).pipe(
        // The root must be readable. A subdirectory we cannot read is skipped.
        Effect.catch((cause) =>
          relativeDir === ""
            ? Effect.fail(new LocalCadError({ reason: "folder-not-found" }))
            : Effect.logDebug("Skipping unreadable folder in CAD scan", { cause }).pipe(
                Effect.as([]),
              ),
        ),
      );
      for (const entry of entries) {
        if (++visited > SCAN_MAX_ENTRIES || files.length >= SCAN_MAX_FILES) {
          truncated = true;
          break;
        }
        const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") next.push(relativePath);
        } else if (entry.isFile() && localCadFormat(entry.name) !== null) {
          const info = yield* Effect.tryPromise(() =>
            NodeFSP.stat(path.join(workspaceRoot, relativePath)),
          ).pipe(Effect.option);
          if (info._tag === "Some")
            files.push({
              path: relativePath,
              byteLength: info.value.size,
              modifiedAt: info.value.mtime.toISOString(),
            });
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, truncated };
});

/** The catalog for a local project: one root per CAD file, named by its relative path. */
export const localCadCatalog = (
  files: readonly LocalCadFileEntry[],
  defaultFilePath: string,
): Omit<CadCatalog, "refreshedAt"> => ({
  // Changes whenever a file is added, removed, or rewritten.
  microversionId: OnshapeWorkspaceId.make(
    id24(JSON.stringify(files.map((file) => [file.path, file.byteLength, file.modifiedAt]))),
  ),
  roots: files.map((file) => ({
    elementId: localCadElementId(file.path),
    name: file.path,
    kind: "assembly",
  })),
  sourceElement: {
    elementId: localCadElementId(defaultFilePath),
    status: files.some((file) => file.path === defaultFilePath) ? "available" : "missing",
  },
});
