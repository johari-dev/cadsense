// @effect-diagnostics nodeBuiltinImport:off
// Removal needs lstat to reject a replaced workspace symlink before recursive deletion.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type { ProjectId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

const MANAGED_WORKSPACE_DIRECTORY_PATTERN = /^project-[0-9a-f]{64}$/;

export interface ManagedWorkspaceAllocatorShape {
  readonly remove: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void, ManagedWorkspaceRemovalError>;
  readonly resolve: (projectId: ProjectId) => Effect.Effect<string>;
  readonly provision: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void, PlatformError.PlatformError>;
}
export class ManagedWorkspaceRemovalError extends Schema.TaggedErrorClass<ManagedWorkspaceRemovalError>()(
  "ManagedWorkspaceRemovalError",
  {},
) {}

export class ManagedWorkspaceAllocator extends Context.Service<
  ManagedWorkspaceAllocator,
  ManagedWorkspaceAllocatorShape
>()("@cadsense/server/workspace/ManagedWorkspaceAllocator") {}

/** Project IDs are intentionally unrestricted strings, so only their digest may become a path. */
export function managedWorkspaceDirectoryName(projectId: ProjectId): string {
  return `project-${NodeCrypto.createHash("sha256").update(projectId, "utf8").digest("hex")}`;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const managedRoot = path.resolve(config.managedWorkspacesDir);

  const resolve: ManagedWorkspaceAllocatorShape["resolve"] = (projectId) => {
    const workspaceRoot = path.resolve(managedRoot, managedWorkspaceDirectoryName(projectId));
    const relative = path.relative(managedRoot, workspaceRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return Effect.die("Managed workspace escaped its environment-owned root.");
    }
    return Effect.succeed(workspaceRoot);
  };

  const provision: ManagedWorkspaceAllocatorShape["provision"] = Effect.fn(
    "ManagedWorkspaceAllocator.provision",
  )(function* (input) {
    const expectedWorkspaceRoot = yield* resolve(input.projectId);
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const relative = path.relative(managedRoot, workspaceRoot);
    if (
      workspaceRoot !== expectedWorkspaceRoot ||
      path.isAbsolute(relative) ||
      !MANAGED_WORKSPACE_DIRECTORY_PATTERN.test(relative)
    ) {
      return yield* Effect.die("Refused to provision an unexpected managed workspace path.");
    }
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
  });

  const remove = Effect.fn("ManagedWorkspaceAllocator.remove")(function* (input: {
    projectId: ProjectId;
    workspaceRoot: string;
  }) {
    const expected = yield* resolve(input.projectId);
    if (
      path.resolve(input.workspaceRoot) !== expected ||
      !MANAGED_WORKSPACE_DIRECTORY_PATTERN.test(path.relative(managedRoot, expected))
    )
      return yield* new ManagedWorkspaceRemovalError();
    yield* Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.lstat(expected).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat) return;
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Unexpected managed workspace");
        const [canonicalRoot, canonicalTarget] = await Promise.all([
          NodeFSP.realpath(managedRoot),
          NodeFSP.realpath(expected),
        ]);
        if (
          path.dirname(canonicalTarget) !== canonicalRoot ||
          path.basename(canonicalTarget) !== path.basename(expected)
        )
          throw new Error("Managed workspace escaped its root");
        await NodeFSP.rm(canonicalTarget, { recursive: true, force: false });
      },
      catch: () => new ManagedWorkspaceRemovalError(),
    });
  });
  return ManagedWorkspaceAllocator.of({ resolve, provision, remove });
});

export const layer = Layer.effect(ManagedWorkspaceAllocator, make);
