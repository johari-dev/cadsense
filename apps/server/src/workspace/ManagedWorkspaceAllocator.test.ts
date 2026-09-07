// @effect-diagnostics nodeBuiltinImport:off
// Junction fixtures must use the Windows-capable native symlink type.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeFSP from "node:fs/promises";

import * as ServerConfig from "../config.ts";
import {
  ManagedWorkspaceAllocator,
  layer,
  managedWorkspaceDirectoryName,
} from "./ManagedWorkspaceAllocator.ts";

it.effect("hashes unrestricted project ids and provisions only the resolved managed path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cadsense-managed-workspace-",
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
      const testLayer = Layer.merge(layer.pipe(Layer.provide(configLayer)), configLayer);
      const program = Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const allocator = yield* ManagedWorkspaceAllocator;
        const projectId = ProjectId.make("../../outside/with\\separators");
        const workspaceRoot = yield* allocator.resolve(projectId);

        assert.match(managedWorkspaceDirectoryName(projectId), /^project-[0-9a-f]{64}$/);
        assert.strictEqual(path.dirname(workspaceRoot), path.resolve(config.managedWorkspacesDir));

        yield* allocator.provision({ projectId, workspaceRoot });
        assert.isTrue(yield* fileSystem.exists(workspaceRoot));

        const refused = yield* Effect.exit(
          allocator.provision({ projectId, workspaceRoot: config.managedWorkspacesDir }),
        );
        assert.strictEqual(refused._tag, "Failure");
        assert.isTrue(yield* fileSystem.exists(workspaceRoot));
      });
      const removal = Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const allocator = yield* ManagedWorkspaceAllocator;
        const projectId = ProjectId.make("delete-fixture");
        const workspaceRoot = yield* allocator.resolve(projectId);
        yield* allocator.provision({ projectId, workspaceRoot });
        yield* fileSystem.writeFileString(path.join(workspaceRoot, "fixture.txt"), "test");
        const siblingId = ProjectId.make("keep-fixture");
        const siblingRoot = yield* allocator.resolve(siblingId);
        yield* allocator.provision({ projectId: siblingId, workspaceRoot: siblingRoot });
        yield* fileSystem.writeFileString(path.join(siblingRoot, "keep.txt"), "preserved");
        assert.equal(
          (yield* allocator
            .remove({ projectId, workspaceRoot: config.managedWorkspacesDir })
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.isTrue(yield* fileSystem.exists(workspaceRoot));
        yield* allocator.remove({ projectId, workspaceRoot });
        assert.equal(
          yield* fileSystem.readFileString(path.join(siblingRoot, "keep.txt")),
          "preserved",
        );
        yield* Effect.promise(() => NodeFSP.symlink(siblingRoot, workspaceRoot, "junction"));
        assert.equal(
          (yield* allocator.remove({ projectId, workspaceRoot }).pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(siblingRoot, "keep.txt")),
          "preserved",
        );
        yield* Effect.promise(() => NodeFSP.unlink(workspaceRoot));
        assert.isFalse(yield* fileSystem.exists(workspaceRoot));
        yield* allocator.remove({ projectId, workspaceRoot });
      });

      yield* program.pipe(Effect.provide(testLayer));
      yield* removal.pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
